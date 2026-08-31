# lead-path-auditor

Checks whether a website's contact form still delivers a lead — not whether the
page loads, and not whether the form returns HTTP 200. Built on
[Solari](https://getsolari.com) cloud browsers and sandboxes.

## Why this exists

I run a small agency with about forty client sites. Every one has a contact
form that is supposed to put a lead in somebody's inbox. Over the past year I
have watched that path break four separate ways:

- A relay that ran forty times and sent two emails.
- A form endpoint returning 502 because the destination address was never
  configured in the environment.
- An email identity that failed verification, at which point the provider quietly
  stopped retrying it. Two months of leads went nowhere.
- A spam gate that rejects submissions completed in under 2.5 seconds — and
  answers `{"ok": true}` when it does. Fast automated checks always passed it.

Uptime monitoring was green through all four. It was measuring the wrong thing.
"The page loads" and "a lead reached a human" are different claims, and only one
of them is the product.

## What it does

For each site in a registry, it opens the real page in a cloud browser, finds
the lead form, fills it with a tagged synthetic lead, waits, submits, and then
asks a separate question: did that token actually arrive anywhere?

Verdicts, ordered by how far the lead travelled:

| Verdict | Meaning |
| --- | --- |
| `blocked` | Could not reach the page at all |
| `no-form` | Page loaded, no usable form on it |
| `filled` | Form found and fillable (dry run stops here) |
| `submitted` | Submitted, no confirmation shown |
| `confirmed` | Page said it worked; delivery not checked |
| `delivered` | The token arrived |
| **`silent-failure`** | **Page said it worked. Nothing arrived.** |

`silent-failure` is the row worth building the tool for. Everything else is
visible to any monitor you already own.

## Why Solari rather than a local Playwright script

Three reasons, and I would not have needed the third before I got burned by it.

1. **Stealth and residential egress.** A submission from a datacenter IP gets
   blocked or silently spam-filtered by the exact defensive layer you are trying
   to measure through. To find out what a visitor experiences you have to look
   like one. `stealth: true` plus `proxy: "us"` is one launch option each.
2. **Session recording.** When a client's form is broken, "trust me" is not a
   deliverable. The rrweb replay is DOM-level, so it stays small and greppable,
   and it shows exactly where the submission died.
3. **A sandbox with a public URL.** Delivery cannot be verified against
   localhost, because the browser doing the auditing runs on Solari's
   infrastructure, not on my laptop. `sandbox.previewUrl()` gives the sink a
   real public address. Browsers and sandboxes are the same API key.

## Quick start

```bash
npm install
cp .env.example .env          # then paste your key
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com

npm run audit -- --demo       # end-to-end, including a deliberately broken form
npm run audit                 # dry run against sites.example.json
npm test                      # 26 unit tests, no key needed
```

### The demo

`--demo` starts a sandbox that serves two contact forms. They are identical to a
visitor: same fields, same Spanish labels, same hidden honeypot, same
"Gracias, mensaje enviado" after you press send.

One of them records the lead. The other throws it away.

```
delivered       demo-good    — HTTP 200 · page confirmed · token arrived
silent-failure  demo-silent  — HTTP 200 · page confirmed · token never arrived
```

Both return 200. Both show a confirmation. A status-code check cannot tell them
apart, and neither can a human clicking through it once.

## Not submitting to other people's forms by accident

A synthetic lead landing in a real client's inbox reads like a real customer,
and somebody wastes a phone call on it. So submission takes two opt-ins: the
`--submit` flag *and* `"submit": true` on that specific site. Default is a dry
run that locates and fills the form without pressing anything.

The demo forms are exempt because they live in a sandbox this tool created and
kills on exit.

Everything typed into a form says it is a test, in English and Spanish, and
carries the run token so a human who receives one knows what it is within a
second of opening it.

Hidden fields are never filled. A honeypot is a field that only a bot would
complete, so filling one is how you get classified as a bot by the site you are
trying to measure.

## Three decisions worth defending

**Delivery is asserted against a sink, not against a status code.** The whole
premise is that HTTP 200 lies. If the tool trusted the response it would have
missed every one of the four failures above.

**Confirmation is a change in the page, not a phrase in it.** Plenty of sites
have the word "gracias" in a testimonial before you submit anything. Matching
post-submit text alone reports success on all of them, so `didConfirm` compares
before against after and accepts the form disappearing on its own.

**The dwell before submitting is configurable and defaults to 3 seconds.** This
looks like a magic number and is not. At least one endpoint in my fleet rejects
anything faster than 2.5 seconds as a bot and returns success anyway. A tool
that submits instantly measures a form that never ran.

## Known limits

- Form discovery picks the element with the most inputs. A page with a newsletter
  signup above the contact form can pick the wrong one; pass `formSelector` in
  the registry to override.
- Fields are filled with `fill()`, not keystroke by keystroke. A site doing
  behavioral keystroke analysis would see automation.
- Multi-step and modal forms are not handled.
- Delivery verification needs a sink the form's backend can reach. The demo runs
  one in a sandbox; against real sites you point it at a mailbox you control.
- Verdicts cap at `confirmed` when no delivery check is configured. That is
  deliberate — it will not claim a lead arrived when it does not know.

## Tests

`npm test` covers the parts that decide the outcome: field classification
including the Spanish and honeypot cases, the fill plan, the verdict state
machine, the before/after confirmation check, and report rendering. They need no
API key and no network. The browser interaction is integration and is not
covered by them.

## Built with AI assistance

I wrote this with Claude Code, which is the way I work day to day and the way
the challenge asked for. The design calls are mine and I will defend any of
them: the double opt-in on submission, asserting delivery separately from
confirmation, and the dwell default all come from production failures I had to
diagnose myself.

Built for the [Solari](https://getsolari.com) / Pinetree Research challenge.
MIT.
