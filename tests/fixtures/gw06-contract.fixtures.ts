/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  GW-06 CANONICAL CONTRACT FIXTURES — Tier 2a cross-repo seam lock     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * THE single, framework-agnostic fixture set embodying GW-06: the app's
 * authoritative `POST /v1/cases` wire contract.
 *
 * SOURCE OF TRUTH (every value below is DERIVED FROM, not from the gateway
 * implementation — sourcing from src/cases.ts would be circular and would
 * prove nothing):
 *   • /Users/brynjolfur/dev/malaskra_v3/.planning/GATEWAY-CHANGES.md §GW-06
 *     (the named canonical wire contract — line cites are GATEWAY-CHANGES.md
 *     line numbers, prefixed `GW-06 L<n>`).
 *   • .planning/phases/03-g3-post-v1-cases/03-CONTEXT.md
 *     ("AUTHORITATIVE CONTRACT — GW-06" block + both RESOLVED DECISION
 *     blocks) for the HTTP-status interpretation and the infra-500
 *     non-outcome exception (cites prefixed `CTX L<n>`).
 *
 * CROSS-REPO CONTRACT: the gateway test asserts handleCases PRODUCES exactly
 * these. malaskra_v3's A1 (built later) must vendor a byte-identical copy and
 * assert its tolerant zod `.passthrough()` union PARSES every RESPONSE
 * fixture and REJECTS every invalid REQUEST fixture. Both repos testing the
 * identical fixture set = the seam proven without wiring the systems.
 *
 * NO test-framework imports — plain TS data only.
 */

// ── FROZEN 7-code outcome enum ───────────────────────────────────────────
// GW-06 L85-89: "7-code outcome enum (LOCKED, verbatim, exact order)":
//   documented | create_failed | orphan_case | validation | auth |
//   brand_mismatch | gopro_create_unsupported
// CTX L65-66 restates the same LOCKED order. readonly tuple = order-pinned.
export const GW06_OUTCOMES = [
  'documented',
  'create_failed',
  'orphan_case',
  'validation',
  'auth',
  'brand_mismatch',
  'gopro_create_unsupported'
] as const

export type Gw06Outcome = (typeof GW06_OUTCOMES)[number]

// ─────────────────────────────────────────────────────────────────────────
//  REQUEST FIXTURES
//  GW-06 L45-64: request body. "Exactly one of create / case_number MUST be
//  present." `create` is backend-namespaced (`create.onesystems`,
//  GW-06 L54 + L59-61; CTX L53-56). Flat `create` (no `.onesystems`) is
//  therefore invalid by construction.
// ─────────────────────────────────────────────────────────────────────────

/** Shared identity fields — GW-06 L51-53 (brand_id, ticket_id, doc_endpoint). */
const BASE = {
  brand_id: '360001234567',
  ticket_id: 123,
  doc_endpoint: 'onesystems'
} as const

export interface CasesRequestFixture {
  readonly label: string
  /** GW-06 line(s) the fixture derives from. */
  readonly derivedFrom: string
  readonly valid: boolean
  /** Expected gateway rejection outcome when `valid: false`. */
  readonly expectInvalidOutcome?: Gw06Outcome
  readonly body: Record<string, unknown>
}

/** VALID — create path. GW-06 L54 + L59-61: create.onesystems.{caseTemplate,kennitala}. */
export const REQ_VALID_CREATE: CasesRequestFixture = {
  label: 'valid create (backend-namespaced onesystems)',
  derivedFrom: 'GW-06 L54, L59-61; CTX L53-56',
  valid: true,
  body: {
    ...BASE,
    create: { onesystems: { caseTemplate: 'STANDARD', kennitala: '1234567890' } }
  }
}

/** VALID — document into an existing case. GW-06 L56, L62. */
export const REQ_VALID_CASE_NUMBER: CasesRequestFixture = {
  label: 'valid case_number (document into existing case)',
  derivedFrom: 'GW-06 L56, L62',
  valid: true,
  body: { ...BASE, case_number: 'OS-2024-0007' }
}

/** INVALID — neither create nor case_number. GW-06 L47, L63 → validation. */
export const REQ_INVALID_NEITHER: CasesRequestFixture = {
  label: 'invalid: neither create nor case_number',
  derivedFrom: 'GW-06 L47, L63; CTX L56',
  valid: false,
  expectInvalidOutcome: 'validation',
  body: { ...BASE }
}

/** INVALID — both create and case_number. GW-06 L47, L63 → validation. */
export const REQ_INVALID_BOTH: CasesRequestFixture = {
  label: 'invalid: both create and case_number',
  derivedFrom: 'GW-06 L47, L63; CTX L56',
  valid: false,
  expectInvalidOutcome: 'validation',
  body: {
    ...BASE,
    create: { onesystems: { caseTemplate: 'STANDARD', kennitala: '1234567890' } },
    case_number: 'OS-2024-0007'
  }
}

/** INVALID — flat create (no `.onesystems` namespace). GW-06 L54, L59-61. */
export const REQ_INVALID_FLAT_CREATE: CasesRequestFixture = {
  label: 'invalid: flat create (create without .onesystems)',
  derivedFrom: 'GW-06 L54, L59-61; CTX L53-56',
  valid: false,
  expectInvalidOutcome: 'validation',
  body: { ...BASE, create: { caseTemplate: 'STANDARD', kennitala: '1234567890' } }
}

/** INVALID — create.onesystems missing caseTemplate. GW-06 L54. */
export const REQ_INVALID_CREATE_NO_TEMPLATE: CasesRequestFixture = {
  label: 'invalid: create missing caseTemplate',
  derivedFrom: 'GW-06 L54',
  valid: false,
  expectInvalidOutcome: 'validation',
  body: { ...BASE, create: { onesystems: { kennitala: '1234567890' } } }
}

/** INVALID — create.onesystems missing kennitala. GW-06 L54. */
export const REQ_INVALID_CREATE_NO_KENNITALA: CasesRequestFixture = {
  label: 'invalid: create missing kennitala',
  derivedFrom: 'GW-06 L54',
  valid: false,
  expectInvalidOutcome: 'validation',
  body: { ...BASE, create: { onesystems: { caseTemplate: 'STANDARD' } } }
}

export const REQUEST_FIXTURES = [
  REQ_VALID_CREATE,
  REQ_VALID_CASE_NUMBER,
  REQ_INVALID_NEITHER,
  REQ_INVALID_BOTH,
  REQ_INVALID_FLAT_CREATE,
  REQ_INVALID_CREATE_NO_TEMPLATE,
  REQ_INVALID_CREATE_NO_KENNITALA
] as const

// ─────────────────────────────────────────────────────────────────────────
//  RESPONSE FIXTURES
//  GW-06 L66-99: response contract. Success body GW-06 L70-72; error/partial
//  body GW-06 L76-78; orphan_case carries caseNumber GW-06 L80-83 +
//  CTX L62-64. HTTP statuses are NOT mandated by GW-06 (GW-06 governs JSON
//  body + enum only) — the transport statuses below come from CTX L74-83
//  ("Retain sensible transport statuses … the app discriminates on body
//  ok/outcome, not status"). The infra-500 is the documented NON-GW-06
//  exception per CTX L80-83 + CTX L85-98.
//
//  SHAPE-MATCHER NOTE: per envelope the REQUIRED keys are listed in
//  `requiredKeys`. The app's zod union uses `.passthrough()` so EXTRA keys
//  are tolerated app-side — but the GATEWAY MUST EMIT THE MINIMAL GW-06 BODY
//  (CTX L70-72: "Prefer the minimal GW-06 body"). The gateway test therefore
//  deep-equals the full `body` (no extra keys allowed from the producer);
//  the app test only needs key-presence + type per `requiredKeys`.
// ─────────────────────────────────────────────────────────────────────────

export interface CasesResponseFixture {
  readonly label: string
  readonly derivedFrom: string
  /** Transport status (CTX L74-83). App keys off body, not status. */
  readonly status: number
  /** Minimal GW-06 body the gateway MUST emit (exact deep-equal). */
  readonly body: Record<string, unknown>
  /** Keys the app's tolerant parser MUST find present (+typed). */
  readonly requiredKeys: readonly string[]
  /** True only for the documented infra-500 non-GW-06 exception. */
  readonly isGw06Outcome: boolean
}

/** documented — GW-06 L70-72 success body; status 200 per CTX L76. */
export const RES_DOCUMENTED: CasesResponseFixture = {
  label: 'documented (success)',
  derivedFrom: 'GW-06 L70-72; CTX L60, L76',
  status: 200,
  body: { ok: true, outcome: 'documented', caseNumber: 'OS-2024-0007' },
  requiredKeys: ['ok', 'outcome', 'caseNumber'],
  isGw06Outcome: true
}

/** create_failed — GW-06 L76-78 + L94; status 502 per CTX L76-79. No caseNumber (nothing minted, GW-06 L94 / CTX L114). */
export const RES_CREATE_FAILED: CasesResponseFixture = {
  label: 'create_failed (no case exists — safe to retry)',
  derivedFrom: 'GW-06 L76-78, L94; CTX L61, L76-79, L114',
  status: 502,
  body: { ok: false, outcome: 'create_failed', error: 'Case creation failed' },
  requiredKeys: ['ok', 'outcome', 'error'],
  isGw06Outcome: true
}

/** orphan_case — GW-06 L80-83 + L95 (MUST carry caseNumber); status 207 per CTX L76, L88. */
export const RES_ORPHAN_CASE: CasesResponseFixture = {
  label: 'orphan_case (created but post step failed — caseNumber surfaced)',
  derivedFrom: 'GW-06 L80-83, L95; CTX L62-64, L76, L85-89',
  status: 207,
  body: {
    ok: false,
    outcome: 'orphan_case',
    error: 'Upload to case failed after creation',
    caseNumber: 'OS-2024-0099'
  },
  requiredKeys: ['ok', 'outcome', 'error', 'caseNumber'],
  isGw06Outcome: true
}

/** validation — GW-06 L76-78 + L96; status 400 per CTX L76. */
export const RES_VALIDATION: CasesResponseFixture = {
  label: 'validation (request body invalid)',
  derivedFrom: 'GW-06 L76-78, L96; CTX L76',
  status: 400,
  body: { ok: false, outcome: 'validation', error: 'Provide exactly one of create or case_number' },
  requiredKeys: ['ok', 'outcome', 'error'],
  isGw06Outcome: true
}

/** auth — GW-06 L76-78 + L97; status 401 per CTX L76. */
export const RES_AUTH: CasesResponseFixture = {
  label: 'auth (x-api-key mismatch)',
  derivedFrom: 'GW-06 L76-78, L97; CTX L76',
  status: 401,
  body: { ok: false, outcome: 'auth', error: 'Invalid or missing API key' },
  requiredKeys: ['ok', 'outcome', 'error'],
  isGw06Outcome: true
}

/** brand_mismatch — GW-06 L76-78 + L98; status 403 per CTX L76. */
export const RES_BRAND_MISMATCH: CasesResponseFixture = {
  label: 'brand_mismatch (fail-closed brand cross-check failed)',
  derivedFrom: 'GW-06 L76-78, L98; CTX L76',
  status: 403,
  body: { ok: false, outcome: 'brand_mismatch', error: 'Ticket does not belong to this brand' },
  requiredKeys: ['ok', 'outcome', 'error'],
  isGw06Outcome: true
}

/** gopro_create_unsupported — GW-06 L76-78 + L64 + L99; status 422 per CTX L76. */
export const RES_GOPRO_CREATE_UNSUPPORTED: CasesResponseFixture = {
  label: 'gopro_create_unsupported (doc_endpoint gopro + create)',
  derivedFrom: 'GW-06 L64, L76-78, L99; CTX L57, L76',
  status: 422,
  body: {
    ok: false,
    outcome: 'gopro_create_unsupported',
    error: 'Case creation not supported for this doc system'
  },
  requiredKeys: ['ok', 'outcome', 'error'],
  isGw06Outcome: true
}

/**
 * DOCUMENTED NON-GW-06 EXCEPTION — infra catch-all HTTP 500.
 * CTX L80-83: "The ONLY status the app keys off is the generic infra HTTP
 * 500 ({ error, duration_ms }, no ok/outcome — NOT a GW-06 outcome)".
 * CTX L85-98 RESOLVED DECISION: the case_number-path upload failure (nothing
 * minted, retry-safe) propagates here, EXACTLY mirroring webhook.ts:73-76 /
 * attachments.ts:159-160. It MUST NOT carry ok/outcome/caseNumber and is
 * explicitly NOT one of the 7 codes (no 8th code invented).
 * `duration_ms` is runtime-variable → compared by presence/type only.
 */
export const RES_INFRA_500: CasesResponseFixture = {
  label: 'infra catch-all 500 (NOT a GW-06 outcome — retryable)',
  derivedFrom: 'CTX L80-83, L85-98 (NOT GW-06; documented exception)',
  status: 500,
  body: { error: 'Internal server error', duration_ms: 0 /* presence/type only */ },
  requiredKeys: ['error', 'duration_ms'],
  isGw06Outcome: false
}

/** The 7 GW-06 structured outcomes, in frozen GW06_OUTCOMES order. */
export const RESPONSE_FIXTURES_GW06 = [
  RES_DOCUMENTED,
  RES_CREATE_FAILED,
  RES_ORPHAN_CASE,
  RES_VALIDATION,
  RES_AUTH,
  RES_BRAND_MISMATCH,
  RES_GOPRO_CREATE_UNSUPPORTED
] as const

/** All response fixtures including the documented non-GW-06 infra-500. */
export const RESPONSE_FIXTURES_ALL = [
  ...RESPONSE_FIXTURES_GW06,
  RES_INFRA_500
] as const
