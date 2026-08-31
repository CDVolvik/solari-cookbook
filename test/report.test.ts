import { describe, expect, it } from 'vitest'
import { renderMarkdown, summarise } from '../src/report.js'
import type { AuditReport, SiteResult, Verdict } from '../src/types.js'

const result = (site: string, verdict: Verdict): SiteResult => ({
  site,
  url: `https://${site}.example`,
  verdict,
  detail: 'detail',
  filled: ['name', 'email'],
  honeypots: 1,
  dwellMs: 3000,
  token: `SLPA-${site.toUpperCase()}`,
  elapsedMs: 1234,
})

const report = (results: SiteResult[]): AuditReport => ({
  startedAt: '2026-08-31T12:00:00.000Z',
  dryRun: false,
  results,
})

describe('summarise', () => {
  it('counts only the verdicts that mean a lead was lost', () => {
    const s = summarise([
      result('a', 'delivered'),
      result('b', 'silent-failure'),
      result('c', 'no-form'),
      result('d', 'blocked'),
    ])
    expect(s).toEqual({ total: 4, broken: 2, silentFailures: 1, blocked: 1 })
  })
})

describe('renderMarkdown', () => {
  it('says so plainly when there is nothing to audit', () => {
    const out = renderMarkdown(report([]))
    expect(out).toContain('No sites audited')
    expect(out).not.toContain('| Site |')
  })

  it('renders a row per site', () => {
    const out = renderMarkdown(report([result('alpha', 'delivered')]))
    expect(out).toContain('| alpha |')
    expect(out).toContain('delivered')
  })

  it('calls out silent failures separately', () => {
    const out = renderMarkdown(report([result('beta', 'silent-failure')]))
    expect(out).toContain('## Silent failures')
    expect(out).toContain('SLPA-BETA')
  })

  it('omits the silent-failure section when there are none', () => {
    const out = renderMarkdown(report([result('alpha', 'delivered')]))
    expect(out).not.toContain('## Silent failures')
  })
})
