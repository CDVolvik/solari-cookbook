import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { Solari } from '@solarisdk/browser'
import { auditSite } from './audit.js'
import { startFixture, type Fixture } from './fixture.js'
import { renderJson, renderMarkdown, summarise } from './report.js'
import type { AuditReport, Site, SiteResult } from './types.js'

const { values } = parseArgs({
  options: {
    sites: { type: 'string', default: 'sites.example.json' },
    demo: { type: 'boolean', default: false },
    submit: { type: 'boolean', default: false },
    stealth: { type: 'boolean', default: false },
    dwell: { type: 'string', default: '3000' },
    timeout: { type: 'string', default: '30000' },
    concurrency: { type: 'string', default: '1' },
    out: { type: 'string', default: 'reports' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(`
lead-path-auditor — does this form actually deliver a lead?

  npm run audit -- [options]

  --demo               add two sandbox-hosted demo forms, one of which silently
                       drops the lead, and submit to them
  --sites <file>       site registry (default: sites.example.json)
  --submit             also submit to registry sites that set "submit": true
  --stealth            stealth fingerprinting for sites that filter datacenter
                       traffic (paid Solari feature; free keys get HTTP 402)
  --dwell <ms>         time on the filled form before submitting (default: 3000)
  --timeout <ms>       per-page navigation timeout (default: 30000)
  --concurrency <n>    sites audited in parallel (default: 1, because every
                       browser and the demo sandbox each hold a session slot)
  --out <dir>          report directory (default: reports)

Registry sites are never submitted to unless you pass --submit AND the site
sets "submit": true. That double opt-in is deliberate: a synthetic lead landing
in a real client's inbox reads like a real customer. The --demo forms are
exempt because they live in a sandbox we own and throw away.
`)
  process.exit(0)
}

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error('SOLARI_API_KEY is not set. Get a key at https://console.getsolari.com')
  process.exit(2)
}

type Task = { site: Site; submit: boolean }

const registry: Site[] = JSON.parse(await readFile(path.resolve(values.sites!), 'utf8'))
const tasks: Task[] = registry.map((site) => ({
  site,
  submit: Boolean(values.submit) && site.submit === true,
}))

let fixture: Fixture | undefined
if (values.demo) {
  console.log('starting sandbox fixture…')
  fixture = await startFixture(apiKey)
  console.log(`fixture at ${fixture.urlFor('/good')}`)
  tasks.unshift(
    {
      site: { name: 'demo-good', url: fixture.urlFor('/good'), submit: true },
      submit: true,
    },
    {
      site: { name: 'demo-silent', url: fixture.urlFor('/silent'), submit: true },
      submit: true,
    },
  )
}

const live = tasks.filter((t) => t.submit)
console.log(
  live.length > 0
    ? `LIVE — will submit to: ${live.map((t) => t.site.name).join(', ')}`
    : 'DRY RUN — forms will be located and filled, nothing submitted',
)

const solari = new Solari({ apiKey })
const results: SiteResult[] = []

try {
  const queue = [...tasks]
  const workers = Array.from(
    { length: Math.min(Math.max(1, Number(values.concurrency)), queue.length) },
    async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        const result = await auditSite(solari, task.site, {
          submit: task.submit,
          stealth: Boolean(values.stealth),
          dwellMs: Number(values.dwell),
          pageTimeoutMs: Number(values.timeout),
          deliveredCheck: fixture ? fixture.seen : undefined,
        })
        results.push(result)
        console.log(`${result.verdict.padEnd(15)} ${result.site} — ${result.detail}`)
      }
    },
  )
  await Promise.all(workers)
} finally {
  // Required in Node: the client holds a loopback proxy open for the
  // connection-retry path, and that handle keeps the event loop alive.
  await solari.close()
  await fixture?.stop()
}

// Keep report order stable regardless of which worker finished first.
const order = new Map(tasks.map((t, i) => [t.site.name, i]))
results.sort((a, b) => (order.get(a.site) ?? 0) - (order.get(b.site) ?? 0))

const report: AuditReport = {
  startedAt: new Date().toISOString(),
  dryRun: live.length === 0,
  results,
}

const outDir = path.resolve(values.out!)
await mkdir(outDir, { recursive: true })
const stamp = report.startedAt.replace(/[:.]/g, '-')
await writeFile(path.join(outDir, `audit-${stamp}.md`), renderMarkdown(report))
await writeFile(path.join(outDir, `audit-${stamp}.json`), renderJson(report))

const s = summarise(results)
console.log(`\n${s.total} audited · ${s.broken} broken · ${s.silentFailures} silent`)
console.log(`reports written to ${outDir}`)

process.exit(s.broken > 0 ? 1 : 0)
