import { validateCaseNumber } from '../../../platform/tenant.js'
import type { HandlerResult, EndpointConfig, ZendeskTicket } from '../../../platform/types.js'

/**
 * Resolve the case number: custom-field lookup via ep.caseNumberFieldId,
 * else ZD-${ticketId} fallback. Returns the exact 400 HandlerResult on
 * an invalid case_number — NEVER throws.
 */
export function resolveCaseNumber(
  ep: EndpointConfig,
  ticket: ZendeskTicket,
  ticketId: number
): { ok: true; caseNumber: string } | { ok: false; result: HandlerResult } {
  let caseNumber: string | undefined
  if (ep.caseNumberFieldId && ticket.custom_fields) {
    const field = ticket.custom_fields.find(f => f.id === ep.caseNumberFieldId)
    if (field?.value) caseNumber = String(field.value)
  }
  if (!caseNumber) caseNumber = `ZD-${ticketId}`

  // Sanitize case_number (SYN-MUT-28-3)
  const caseNumberError = validateCaseNumber(caseNumber)
  if (caseNumberError) {
    return { ok: false, result: { status: 400, body: { error: caseNumberError } } }
  }

  return { ok: true, caseNumber }
}

/**
 * Webhook-create input extractor (CONF-01/CONF-02) — consumed by Phase 6.
 * Reads the case template from the trigger-stamped `malaskra_snidmat`
 * custom field (ep.templateFieldId) and the kennitala from
 * ep.kennitalaFieldId. Pure: never throws, never invents values. Values
 * are trimmed; whitespace-only or missing fields yield an absent property.
 * Both values pass through raw — the OneSystems client normalizes the
 * kennitala downstream.
 */
export function resolveCreateInputs(
  ep: EndpointConfig,
  ticket: ZendeskTicket
): { template?: string; kennitala?: string } {
  const lookup = (fieldId: number | null | undefined): string | undefined => {
    if (!fieldId) return undefined
    const field = ticket.custom_fields?.find(f => f.id === fieldId)
    if (field?.value === undefined || field?.value === null) return undefined
    const trimmed = String(field.value).trim()
    return trimmed === '' ? undefined : trimmed
  }

  const template = lookup(ep.templateFieldId)
  const kennitala = lookup(ep.kennitalaFieldId)
  return {
    ...(template !== undefined ? { template } : {}),
    ...(kennitala !== undefined ? { kennitala } : {})
  }
}

/**
 * Read the RAW case-number custom-field value — the same 4-line lookup
 * resolveCaseNumber performs, WITHOUT the ZD- fallback. Used by the
 * webhook create-engage gate (Phase 6) to detect an EMPTY field.
 * resolveCaseNumber itself is deliberately left NOT using this helper
 * (regression constraint: its behavior stays byte-identical).
 */
export function readCaseNumberField(
  ep: EndpointConfig,
  ticket: ZendeskTicket
): string | undefined {
  // `!= null` (not truthiness) so the configured-check matches the stamp
  // guard in the create branch — a single predicate for "configured"
  // (LO-05; a theoretical fieldId of 0 counts as configured in BOTH).
  if (ep.caseNumberFieldId != null && ticket.custom_fields) {
    const field = ticket.custom_fields.find(f => f.id === ep.caseNumberFieldId)
    // WR-02: TRIM before returning (mirrors resolveCreateInputs) — a
    // whitespace-only field is ABSENT, so it engages the loud-fail gate /
    // create path instead of silently archiving the documentation under a
    // whitespace "case reference". The outer truthiness check is kept so
    // falsy values (0/false/'') stay "absent" exactly as before — widening
    // it would let resolveCaseNumber's truthiness re-open a ZD- hole.
    // GoPro is unaffected: the gate only consumes this value when the
    // client is createCase-capable.
    if (field?.value) {
      const trimmed = String(field.value).trim()
      if (trimmed !== '') return trimmed
    }
  }
  return undefined
}
