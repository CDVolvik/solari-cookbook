import { Solari } from '@solarisdk/browser'
import {
  buildFillPlan,
  countHoneypots,
  computeVerdict,
  didConfirm,
  makeSyntheticLead,
  type FieldDescriptor,
} from './form.js'
import type { Site, SiteResult } from './types.js'

export type AuditOptions = {
  /** When false, the form is located and filled but never submitted. */
  submit: boolean
  /**
   * Stealth fingerprinting, and the residential proxy that depends on it, are
   * paid Solari features — a free key gets HTTP 402 at session create. Off by
   * default so the tool runs on any account; turn it on for sites that filter
   * datacenter traffic.
   */
  stealth: boolean
  /**
   * Time to sit on the filled form before submitting.
   *
   * Not cosmetic. R21's own lead endpoint rejects anything faster than 2.5s as
   * a bot — and returns `{ok: true}` while sending nothing. An auditor that
   * submits instantly measures a form that never ran.
   */
  dwellMs: number
  /** Resolves a token to "did this actually arrive". */
  deliveredCheck?: (token: string) => Promise<boolean>
  pageTimeoutMs: number
}

type Collected = { formFound: boolean; fields: FieldDescriptor[] }

export async function auditSite(
  solari: Solari,
  site: Site,
  opts: AuditOptions,
): Promise<SiteResult> {
  const started = Date.now()
  const lead = makeSyntheticLead(site.name)
  const willSubmit = opts.submit

  const base: SiteResult = {
    site: site.name,
    url: site.url,
    verdict: 'error',
    detail: '',
    filled: [],
    honeypots: 0,
    dwellMs: 0,
    token: lead.token,
    elapsedMs: 0,
  }

  // `proxy` and `captcha` both require stealth — a proxied request from an
  // obviously-automated browser is the pairing that gets blocked.
  const stealth = opts.stealth || Boolean(site.proxy)

  let browser: Awaited<ReturnType<Solari['launch']>> | undefined
  let failure: unknown

  for (let attempt = 0; attempt < 6 && !browser; attempt++) {
    try {
      browser = await solari.launch({
        ...(stealth ? { stealth: true } : {}),
        ...(site.proxy ? { proxy: site.proxy } : {}),
        recording: true,
      })
    } catch (err) {
      failure = err
      // 429 is the plan's concurrent-session cap being full right now, which
      // says nothing about this site. Wait for a slot rather than burning the
      // row — the fixture sandbox holds one of those slots too.
      if ((err as { status?: number }).status !== 429) break
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  if (!browser) {
    // Returned rather than thrown: one site that cannot start a session must
    // not take down the rest of the run.
    base.verdict = 'error'
    base.detail = launchFailure(failure)
    return finish(base, started)
  }
  base.sessionId = browser.id

  const submitStatuses: number[] = []

  try {
    const page = await browser.newPage()
    page.on('response', (res: { status(): number; request(): { method(): string } }) => {
      if (res.request().method() !== 'GET') submitStatuses.push(res.status())
    })

    try {
      await page.goto(site.url, {
        timeout: opts.pageTimeoutMs,
        waitUntil: 'domcontentloaded',
      })
    } catch (err) {
      base.verdict = 'blocked'
      base.detail = `navigation failed: ${errText(err)}`
      return finish(base, started)
    }

    // Everything below runs in the browser. It deliberately declares no named
    // functions: tsx compiles with esbuild's keepNames, which wraps named
    // bindings in a `__name` helper that does not exist on the page, and
    // page.evaluate ships this source across as text.
    // Cast: the query only ever selects input/textarea/select, but the value
    // crosses the browser boundary as JSON and comes back with `tag: string`.
    const { formFound, fields } = (await page.evaluate(
      (formSelector: string | null) => {
        const forms = Array.from(document.querySelectorAll(formSelector ?? 'form'))
        forms.sort(
          (a, b) =>
            b.querySelectorAll('input, textarea, select').length +
            (b.querySelector('textarea') ? 2 : 0) -
            (a.querySelectorAll('input, textarea, select').length +
              (a.querySelector('textarea') ? 2 : 0)),
        )

        const form = forms[0]
        if (!form) return { formFound: false, fields: [] }

        form.setAttribute('data-slpa-form', '1')

        const fields = []
        const elements = Array.from(form.querySelectorAll('input, textarea, select'))

        for (let i = 0; i < elements.length; i++) {
          const el = elements[i] as HTMLElement
          el.setAttribute('data-slpa-field', String(i))
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)

          fields.push({
            selector: '[data-slpa-field="' + i + '"]',
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || undefined,
            name: el.getAttribute('name') || undefined,
            id: el.id || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            autocomplete: el.getAttribute('autocomplete') || undefined,
            required: el.hasAttribute('required'),
            visible:
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity) !== 0 &&
              rect.width > 1 &&
              rect.height > 1 &&
              rect.bottom > 0 &&
              rect.right > 0,
          })
        }

        return { formFound: true, fields }
      },
      site.formSelector ?? null,
    )) as Collected

    if (!formFound) {
      base.verdict = 'no-form'
      base.detail = 'no form element on the page'
      return finish(base, started)
    }

    base.honeypots = countHoneypots(fields)
    const plan = buildFillPlan(fields, lead)
    if (plan.length === 0) {
      base.verdict = 'no-form'
      base.detail = `form present but no fillable fields (${fields.length} inspected)`
      return finish(base, started)
    }

    for (const step of plan) {
      await page.fill(step.selector, step.value)
    }
    base.filled = plan.map((s) => s.role)

    const textBefore: string = await page.innerText('body')

    if (!willSubmit) {
      base.verdict = 'filled'
      base.detail = `dry run — ${plan.length} field(s) fillable, submit not clicked`
      return finish(base, started)
    }

    await page.waitForTimeout(opts.dwellMs)
    base.dwellMs = opts.dwellMs

    const button = page.locator(
      '[data-slpa-form="1"] button[type="submit"], [data-slpa-form="1"] input[type="submit"], [data-slpa-form="1"] button:not([type])',
    )
    if ((await button.count()) === 0) {
      base.verdict = 'no-form'
      base.detail = 'form has no submit control'
      return finish(base, started)
    }

    await button.first().click()
    // No reliable navigation signal: some forms POST and redirect, others swap
    // the DOM in place. Settle, then read what the visitor would see.
    await page.waitForTimeout(4000)

    const textAfter: string = await page.innerText('body')
    const formGone = (await page.locator('[data-slpa-form="1"]').count()) === 0
    const confirmed = didConfirm(textBefore, textAfter, formGone)

    base.submitStatus = submitStatuses[submitStatuses.length - 1]

    let delivered: boolean | null = null
    if (opts.deliveredCheck) delivered = await opts.deliveredCheck(lead.token)

    base.verdict = computeVerdict({
      reachable: true,
      formFound: true,
      submitted: true,
      confirmed,
      delivered,
    })
    base.detail = describe(base.submitStatus, confirmed, delivered)
    return finish(base, started)
  } catch (err) {
    base.verdict = 'error'
    base.detail = errText(err)
    return finish(base, started)
  } finally {
    // rrweb batches events and flushes on a timer. Closing immediately ships a
    // near-empty replay, which looks like a recording and is not one.
    await new Promise((r) => setTimeout(r, 2000))
    await browser.close()
    const events = await replayEvents(solari, browser.id)
    if (events !== null) base.replayEvents = events
  }
}

function launchFailure(err: unknown): string {
  const status = (err as { status?: number }).status
  if (status === 402) return 'session refused (402) — stealth and proxy need a paid Solari plan'
  if (status === 429) return 'no free session slot (429) — lower --concurrency or raise the plan cap'
  return `could not start a session: ${errText(err)}`
}

function describe(
  status: number | undefined,
  confirmed: boolean,
  delivered: boolean | null,
): string {
  const parts = [status ? `HTTP ${status}` : 'no submit response observed']
  parts.push(confirmed ? 'page confirmed' : 'no confirmation shown')
  if (delivered === true) parts.push('token arrived')
  if (delivered === false) parts.push('token never arrived')
  return parts.join(' · ')
}

/**
 * The replay uploads asynchronously AFTER the session is released, so the first
 * poll usually 404s on a perfectly good recording. Returns null if it never
 * shows up — a missing replay is not an audit failure.
 */
async function replayEvents(solari: Solari, sessionId: string): Promise<number | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const blob = await solari.sessions.downloadReplay(sessionId)
      // Decode, don't stringify: this is a Uint8Array, and its toString() is a
      // comma-separated list of byte values, which counts as exactly one line
      // no matter how long the recording is.
      //
      // Stored gzipped, but the HTTP client honours Content-Encoding and hands
      // back plain NDJSON. Do not decompress.
      const text = new TextDecoder().decode(blob)
      return text.split('\n').filter(Boolean).length
    } catch (err) {
      if ((err as { status?: number }).status === 404) continue
      return null
    }
  }
  return null
}

function finish(r: SiteResult, started: number): SiteResult {
  r.elapsedMs = Date.now() - started
  return r
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err)
}
