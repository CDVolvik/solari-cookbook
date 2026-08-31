/** A site to audit. Only `name` and `url` are required. */
export type Site = {
  name: string
  url: string
  /** CSS selector for the form, when discovery needs help. */
  formSelector?: string
  /** Residential egress country, e.g. "us". Implies stealth. */
  proxy?: string
  /** Opt in to actually clicking submit for THIS site. Default false. */
  submit?: boolean
}

/**
 * Outcomes are ordered by how far the lead travelled. `silent-failure` is the
 * one this tool exists to find: the form said thank-you and nothing arrived.
 */
export type Verdict =
  | "no-form"
  | "blocked"
  | "filled"
  | "submitted"
  | "confirmed"
  | "delivered"
  | "silent-failure"
  | "error"

export type SiteResult = {
  site: string
  url: string
  verdict: Verdict
  detail: string
  /** Roles that were actually filled, e.g. ["name","email","message"]. */
  filled: string[]
  /** Honeypot fields found and deliberately left empty. */
  honeypots: number
  /** Time spent on the form before submitting, in ms. */
  dwellMs: number
  /** Status of the response to the submit, when one was observed. */
  submitStatus?: number
  /** Solari session id, for pulling the replay later. */
  sessionId?: string
  /** rrweb events in the downloaded replay, when recording was retrieved. */
  replayEvents?: number
  /** Token embedded in the synthetic lead, for delivery matching. */
  token: string
  elapsedMs: number
}

export type AuditReport = {
  startedAt: string
  dryRun: boolean
  results: SiteResult[]
}
