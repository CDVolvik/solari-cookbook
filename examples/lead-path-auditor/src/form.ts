/**
 * Pure form logic: what a field is, what to type into it, and what the page
 * said afterwards. No browser in here, so all of it is unit-testable.
 *
 * The patterns are bilingual on purpose. The fleet this was written for is
 * Puerto Rico small business, where a contact form is as likely to say
 * "nombre" and "mensaje" as "name" and "message".
 */

export type FieldDescriptor = {
  /** Selector that addresses this field uniquely. */
  selector: string
  tag: "input" | "textarea" | "select"
  type?: string
  name?: string
  id?: string
  placeholder?: string
  ariaLabel?: string
  autocomplete?: string
  required?: boolean
  /** False for display:none, zero-size, or off-canvas fields. */
  visible: boolean
}

export type FieldRole =
  | "name"
  | "email"
  | "phone"
  | "message"
  | "company"
  | "honeypot"
  | "unknown"
  | "skip"

/** The synthetic lead. `token` is what we later look for at the sink. */
export type SyntheticLead = {
  name: string
  email: string
  phone: string
  company: string
  message: string
  token: string
}

const NON_INPUT_TYPES = new Set([
  "submit",
  "button",
  "image",
  "reset",
  "file",
  "checkbox",
  "radio",
])

/** Names bots are supposed to fall for. Filling one marks you as a bot. */
const HONEYPOT_PATTERN =
  /honey|hp[-_]|leave[-_ ]?blank|do[-_ ]?not[-_ ]?fill|bot[-_ ]?(field|check)|_gotcha|nickname/i

const EMAIL_PATTERN = /e-?mail|correo/i
const PHONE_PATTERN =
  /phone|tel(?![a-z])|telefono|tel[eé]fono|celular|m[oó]vil|whatsapp/i
const MESSAGE_PATTERN =
  /message|mensaje|comment|comentario|inquiry|consulta|details|detalles|descripci[oó]n|how can we help/i
const COMPANY_PATTERN =
  /company|business|empresa|negocio|organiz|compa[nñ][ií]a/i
const NAME_PATTERN =
  /\bname\b|nombre|apellido|fullname|firstname|lastname|fname|lname/i

function haystack(f: FieldDescriptor): string {
  return [f.name, f.id, f.placeholder, f.ariaLabel, f.autocomplete]
    .filter(Boolean)
    .join(" ")
}

/**
 * Classify one field. Order matters: honeypots are checked before anything
 * else so a hidden field named "email" is never filled, and company is checked
 * before name so "company name" does not read as a person.
 */
export function classifyField(f: FieldDescriptor): FieldRole {
  const type = f.type?.toLowerCase()

  if (f.tag === "input" && type && NON_INPUT_TYPES.has(type)) return "skip"
  if (type === "hidden" || !f.visible) return "honeypot"

  const text = haystack(f)
  if (HONEYPOT_PATTERN.test(text)) return "honeypot"

  if (type === "email" || EMAIL_PATTERN.test(text)) return "email"
  if (type === "tel" || PHONE_PATTERN.test(text)) return "phone"
  if (f.tag === "textarea" || MESSAGE_PATTERN.test(text)) return "message"
  if (COMPANY_PATTERN.test(text)) return "company"
  if (NAME_PATTERN.test(text)) return "name"

  return "unknown"
}

export type FillStep = { selector: string; role: FieldRole; value: string }

/**
 * Decide what to type where. Honeypots and non-inputs are dropped. Unknown
 * fields are filled only when the page marks them required, because a required
 * field we cannot name will otherwise block submission — but guessing at
 * optional ones just adds noise to somebody's inbox.
 */
export function buildFillPlan(
  fields: FieldDescriptor[],
  lead: SyntheticLead,
): FillStep[] {
  const steps: FillStep[] = []

  for (const field of fields) {
    const role = classifyField(field)
    if (role === "honeypot" || role === "skip") continue

    let value: string
    switch (role) {
      case "name":
        value = lead.name
        break
      case "email":
        value = lead.email
        break
      case "phone":
        value = lead.phone
        break
      case "company":
        value = lead.company
        break
      case "message":
        value = lead.message
        break
      case "unknown":
        if (!field.required) continue
        value = lead.token
        break
    }
    steps.push({ selector: field.selector, role, value })
  }

  return steps
}

export function countHoneypots(fields: FieldDescriptor[]): number {
  return fields.filter((f) => classifyField(f) === "honeypot").length
}

const CONFIRM_PATTERN =
  /thank you|thanks|gracias|success|received|recibi|we'?ll be in touch|se ha enviado|mensaje enviado|enviado con [eé]xito|submitted/i

/**
 * Did the page claim success? Deliberately generous — a false "confirmed" is
 * downgraded to `silent-failure` the moment the sink says nothing arrived,
 * which is a more useful finding than a false "submitted".
 */
export function looksConfirmed(pageText: string): boolean {
  return CONFIRM_PATTERN.test(pageText)
}

/**
 * Confirmation is a *change*, not a phrase. Plenty of pages carry the word
 * "gracias" in a testimonial or footer long before anyone submits anything, so
 * matching the post-submit text alone reports success on every one of them.
 * The form vanishing is accepted on its own — that is a redirect or a swap.
 */
export function didConfirm(
  textBefore: string,
  textAfter: string,
  formGone: boolean,
): boolean {
  if (formGone) return true
  return looksConfirmed(textAfter) && !looksConfirmed(textBefore)
}

export type VerdictInput = {
  reachable: boolean
  formFound: boolean
  submitted: boolean
  confirmed: boolean
  /** null when delivery was not checked at all. */
  delivered: boolean | null
}

/** The state machine, kept pure so the interesting transitions are testable. */
export function computeVerdict(o: VerdictInput): import("./types.js").Verdict {
  if (!o.reachable) return "blocked"
  if (!o.formFound) return "no-form"
  if (!o.submitted) return "filled"
  if (o.delivered === true) return "delivered"
  if (o.delivered === false && o.confirmed) return "silent-failure"
  if (o.confirmed) return "confirmed"
  return "submitted"
}

/**
 * Build the synthetic lead. Every field says "test" in both languages so that
 * anything which does land in a real inbox is unmistakable to the human who
 * opens it.
 */
export function makeSyntheticLead(
  siteName: string,
  now = new Date(),
): SyntheticLead {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)
  const token = `SLPA-${siteName.toUpperCase().replace(/[^A-Z0-9]/g, "")}-${stamp}`
  return {
    name: "Lead Path Auditor (TEST)",
    email: `audit+${token.toLowerCase()}@example.com`,
    phone: "7875550100",
    company: "Automated lead-path test",
    token,
    message: [
      `AUTOMATED TEST — PLEASE IGNORE / PRUEBA AUTOMATIZADA — FAVOR IGNORAR.`,
      `Reference: ${token}`,
      `This message verifies that this form still delivers. No reply needed.`,
    ].join("\n"),
  }
}
