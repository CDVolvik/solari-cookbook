import type { AuditReport, SiteResult, Verdict } from './types.js'

const MARK: Record<Verdict, string> = {
  delivered: 'OK',
  confirmed: 'OK?',
  filled: '--',
  submitted: '??',
  'silent-failure': 'FAIL',
  'no-form': 'FAIL',
  blocked: 'WARN',
  error: 'ERR',
}

/** Verdicts that mean a real lead would not have reached a human. */
const BROKEN: ReadonlySet<Verdict> = new Set<Verdict>([
  'silent-failure',
  'no-form',
  'error',
])

export function summarise(results: SiteResult[]) {
  return {
    total: results.length,
    broken: results.filter((r) => BROKEN.has(r.verdict)).length,
    silentFailures: results.filter((r) => r.verdict === 'silent-failure').length,
    blocked: results.filter((r) => r.verdict === 'blocked').length,
  }
}

export function renderMarkdown(report: AuditReport): string {
  const { results } = report
  const lines: string[] = ['# Lead path audit', '']

  lines.push(
    `Run: ${report.startedAt} · mode: ${report.dryRun ? 'dry-run (no submissions)' : 'live submissions'}`,
    '',
  )

  if (results.length === 0) {
    lines.push('No sites audited. Check the registry passed to `--sites`.', '')
    return lines.join('\n')
  }

  const s = summarise(results)
  lines.push(
    `${s.total} site(s) · ${s.broken} broken · ${s.silentFailures} silent failure(s) · ${s.blocked} blocked`,
    '',
    '| Site | Verdict | Detail | Filled | Dwell | Session |',
    '| --- | --- | --- | --- | --- | --- |',
  )

  for (const r of results) {
    lines.push(
      `| ${r.site} | ${MARK[r.verdict]} ${r.verdict} | ${r.detail} | ${
        r.filled.join(', ') || '—'
      } | ${r.dwellMs}ms | ${r.sessionId ?? '—'} |`,
    )
  }

  const silent = results.filter((r) => r.verdict === 'silent-failure')
  if (silent.length > 0) {
    lines.push(
      '',
      '## Silent failures',
      '',
      'These forms told the visitor the message was sent. Nothing arrived.',
      '',
    )
    for (const r of silent) {
      lines.push(`- **${r.site}** (${r.url}) — token \`${r.token}\` never reached the sink.`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

export function renderJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2) + '\n'
}
