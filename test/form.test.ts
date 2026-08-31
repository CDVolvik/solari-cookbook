import { describe, expect, it } from "vitest"
import {
  buildFillPlan,
  classifyField,
  computeVerdict,
  countHoneypots,
  didConfirm,
  makeSyntheticLead,
  type FieldDescriptor,
} from "../src/form.js"

const field = (over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  selector: '[data-slpa-field="0"]',
  tag: "input",
  visible: true,
  ...over,
})

const lead = makeSyntheticLead("demo", new Date("2026-08-31T12:00:00Z"))

describe("classifyField", () => {
  it("reads the input type first", () => {
    expect(classifyField(field({ type: "email" }))).toBe("email")
    expect(classifyField(field({ type: "tel" }))).toBe("phone")
  })

  it("handles Spanish field names", () => {
    expect(classifyField(field({ name: "correo" }))).toBe("email")
    expect(classifyField(field({ name: "telefono" }))).toBe("phone")
    expect(classifyField(field({ placeholder: "Su mensaje" }))).toBe("message")
    expect(classifyField(field({ name: "nombre" }))).toBe("name")
    expect(classifyField(field({ name: "empresa" }))).toBe("company")
  })

  it("treats a textarea as the message even when unnamed", () => {
    expect(classifyField(field({ tag: "textarea" }))).toBe("message")
  })

  it('prefers company over name so "company name" is not a person', () => {
    expect(classifyField(field({ name: "company_name" }))).toBe("company")
  })

  it("never fills a hidden or invisible field", () => {
    expect(classifyField(field({ type: "hidden", name: "email" }))).toBe(
      "honeypot",
    )
    expect(classifyField(field({ visible: false, name: "email" }))).toBe(
      "honeypot",
    )
  })

  it("recognises named honeypots that are still visible", () => {
    expect(classifyField(field({ name: "_gotcha" }))).toBe("honeypot")
    expect(classifyField(field({ id: "hp-email" }))).toBe("honeypot")
  })

  it("skips buttons and file pickers", () => {
    expect(classifyField(field({ type: "submit" }))).toBe("skip")
    expect(classifyField(field({ type: "file" }))).toBe("skip")
  })

  it("falls back to unknown", () => {
    expect(classifyField(field({ name: "referral_source" }))).toBe("unknown")
  })
})

describe("buildFillPlan", () => {
  it("fills the roles it recognises and leaves honeypots empty", () => {
    const plan = buildFillPlan(
      [
        field({ selector: "#n", name: "nombre" }),
        field({ selector: "#e", type: "email" }),
        field({ selector: "#trap", name: "website", visible: false }),
        field({ selector: "#m", tag: "textarea" }),
      ],
      lead,
    )

    expect(plan.map((s) => s.role)).toEqual(["name", "email", "message"])
    expect(plan.find((s) => s.selector === "#trap")).toBeUndefined()
  })

  it("fills an unknown field only when the page requires it", () => {
    const required = buildFillPlan(
      [field({ selector: "#x", name: "how_did_you_hear", required: true })],
      lead,
    )
    expect(required).toHaveLength(1)
    expect(required[0]!.value).toBe(lead.token)

    const optional = buildFillPlan(
      [field({ selector: "#x", name: "how_did_you_hear" })],
      lead,
    )
    expect(optional).toHaveLength(0)
  })

  it("counts honeypots for the report", () => {
    expect(
      countHoneypots([
        field({ visible: false }),
        field({ name: "_gotcha" }),
        field({ type: "email" }),
      ]),
    ).toBe(2)
  })
})

describe("computeVerdict", () => {
  const base = {
    reachable: true,
    formFound: true,
    submitted: false,
    confirmed: false,
    delivered: null,
  }

  it("reports what stopped it before the form", () => {
    expect(computeVerdict({ ...base, reachable: false })).toBe("blocked")
    expect(computeVerdict({ ...base, formFound: false })).toBe("no-form")
  })

  it("stops at filled in a dry run", () => {
    expect(computeVerdict(base)).toBe("filled")
  })

  it("calls a confirmed-but-undelivered form a silent failure", () => {
    expect(
      computeVerdict({
        ...base,
        submitted: true,
        confirmed: true,
        delivered: false,
      }),
    ).toBe("silent-failure")
  })

  it("trusts delivery over anything the page claimed", () => {
    expect(
      computeVerdict({
        ...base,
        submitted: true,
        confirmed: false,
        delivered: true,
      }),
    ).toBe("delivered")
  })

  it("does not overstate when delivery was never checked", () => {
    expect(computeVerdict({ ...base, submitted: true, confirmed: true })).toBe(
      "confirmed",
    )
    expect(computeVerdict({ ...base, submitted: true })).toBe("submitted")
  })
})

describe("didConfirm", () => {
  it("ignores a thank-you that was on the page all along", () => {
    const testimonial = "Gracias por su servicio — Maria"
    expect(didConfirm(testimonial, testimonial, false)).toBe(false)
  })

  it("accepts a confirmation that appeared after submitting", () => {
    expect(didConfirm("Contact us", "Thank you, we received it", false)).toBe(
      true,
    )
  })

  it("accepts the form disappearing", () => {
    expect(didConfirm("Contact us", "Contact us", true)).toBe(true)
  })
})

describe("makeSyntheticLead", () => {
  it("marks itself as a test in both languages", () => {
    expect(lead.message).toMatch(/PLEASE IGNORE/)
    expect(lead.message).toMatch(/FAVOR IGNORAR/)
  })

  it("carries the token everywhere delivery might be matched", () => {
    expect(lead.message).toContain(lead.token)
    expect(lead.email).toContain(lead.token.toLowerCase())
  })
})
