/**
 * FROZEN GW-06 CONFORMANCE LOCK (Tier 2a cross-repo seam).
 *
 * Source of truth: /Users/brynjolfur/dev/malaskra_v3/.planning/GATEWAY-CHANGES.md §GW-06.
 *
 * This test no longer carries inline expected literals — it CONSUMES the
 * canonical, framework-agnostic fixture set in
 *   tests/fixtures/gw06-contract.fixtures.ts
 * whose values are derived FROM GW-06 (line-cited there), NOT from
 * src/cases.ts. It drives the real gateway (handleCases) for each scenario
 * and asserts the real { status, body } deep-equals the corresponding
 * fixture. The frozen-enum test asserts the gateway's outcomes are exactly
 * the fixture tuple, in the same order.
 *
 * The IDENTICAL fixture file is vendored byte-identical into malaskra_v3
 * (A1) and asserted from the consumer side — both repos testing the same
 * fixtures proves the cross-repo seam without wiring the systems.
 *
 * If this test fails, the GW-06 contract has drifted — do NOT "fix" the
 * test or the fixtures; fix the handler (or coordinate a deliberate
 * GW-06 contract change with the malaskra_v3 side first).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleCases } from '../src/cases.js'
import type { TenantConfig } from '../src/types.js'
import {
  GW06_OUTCOMES,
  REQ_VALID_CREATE,
  REQ_VALID_CASE_NUMBER,
  REQ_INVALID_FLAT_CREATE,
  RES_DOCUMENTED,
  RES_CREATE_FAILED,
  RES_ORPHAN_CASE,
  RES_VALIDATION,
  RES_AUTH,
  RES_BRAND_MISMATCH,
  RES_GOPRO_CREATE_UNSUPPORTED,
  RES_INFRA_500,
  RESPONSE_FIXTURES_GW06,
  type CasesResponseFixture
} from './fixtures/gw06-contract.fixtures.js'

global.fetch = vi.fn() as unknown as typeof fetch

function makeTenantConfig(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    brand_id: '360001234567',
    name: 'Test Tenant',
    zendesk: {
      subdomain: 'test',
      email: 'test@example.com',
      apiToken: 'test-token',
      webhookSecret: 'test-webhook-secret'
    },
    endpoints: {
      onesystems: {
        type: 'onesystems',
        baseUrl: 'https://api.onesystems.test',
        appKey: 'test-key',
        caseNumberFieldId: 42
      }
    },
    malaskra: { apiKey: 'test-malaskra-key' },
    pdf: { companyName: 'Test Company', locale: 'is-IS', includeInternalNotes: false },
    ...overrides
  }
}

function goproTenantConfig(): TenantConfig {
  return makeTenantConfig({
    endpoints: {
      gopro: { type: 'gopro', baseUrl: 'https://api.gopro.test', username: 'g', password: 'p' }
    }
  })
}

const KEY = { 'x-api-key': 'test-malaskra-key' }
const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>

function mockTicketPrelude(brandId: number | undefined = 360001234567) {
  fetchMock()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: { id: 123, subject: 'T', brand_id: brandId } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ comments: [{ id: 1, body: 'Hi', public: true, author_id: 7 }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [{ id: 7, name: 'A', email: 'a@e.com' }] }) })
}

/**
 * Assert a real gateway response equals a canonical fixture.
 * GW-06 minimal-body rule (CTX L70-72): the producer MUST emit the minimal
 * body — so the body is deep-equalled. duration_ms (infra-500) is
 * runtime-variable → presence/type only.
 */
function assertMatchesFixture(
  real: { status: number; body: Record<string, unknown> },
  fx: CasesResponseFixture
) {
  expect(real.status).toBe(fx.status)
  if (fx === RES_INFRA_500) {
    // Documented non-GW-06 exception — duration_ms compared by presence/type.
    expect(real.body.error).toBe(fx.body.error)
    expect(typeof real.body.duration_ms).toBe('number')
    expect(real.body.ok).toBeUndefined()
    expect(real.body.outcome).toBeUndefined()
    expect(real.body.caseNumber).toBeUndefined()
    return
  }
  expect(real.body).toEqual(fx.body)
  for (const k of fx.requiredKeys) {
    expect(real.body[k]).not.toBeUndefined()
  }
}

describe('GW-06 contract lock — /v1/cases (canonical fixtures consumed)', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── REQUEST fixture acceptance / rejection ──────────────────────────
  it('accepts REQ_VALID_CREATE (namespaced) → documented', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-2024-0007' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const r = await handleCases({
      body: { ...REQ_VALID_CREATE.body, ticket_id: 123 },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    assertMatchesFixture(r as any, RES_DOCUMENTED)
  })

  it('accepts REQ_VALID_CASE_NUMBER → documented', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
    const r = await handleCases({
      body: { ...REQ_VALID_CASE_NUMBER.body, ticket_id: 123 },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    // documented with the caller-supplied case_number.
    assertMatchesFixture(r as any, {
      ...RES_DOCUMENTED,
      body: { ok: true, outcome: 'documented', caseNumber: REQ_VALID_CASE_NUMBER.body.case_number }
    })
  })

  it('rejects REQ_INVALID_FLAT_CREATE → validation', async () => {
    const r = await handleCases({
      body: { ...REQ_INVALID_FLAT_CREATE.body, ticket_id: 123 },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    assertMatchesFixture(r as any, {
      ...RES_VALIDATION,
      body: {
        ok: false,
        outcome: 'validation',
        error: 'Missing create.onesystems.caseTemplate or create.onesystems.kennitala'
      }
    })
  })

  // ── Every one of the 7 GW-06 outcomes deep-equals its fixture ───────
  it('auth → RES_AUTH', async () => {
    const r = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: {}, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    assertMatchesFixture(r as any, RES_AUTH)
  })

  it('validation → RES_VALIDATION', async () => {
    const r = await handleCases({
      body: { ticket_id: 123 },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    assertMatchesFixture(r as any, RES_VALIDATION)
  })

  it('brand_mismatch → RES_BRAND_MISMATCH', async () => {
    fetchMock().mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: { id: 123, brand_id: 999999 } }) })
    const r = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    assertMatchesFixture(r as any, RES_BRAND_MISMATCH)
  })

  it('gopro_create_unsupported → RES_GOPRO_CREATE_UNSUPPORTED', async () => {
    mockTicketPrelude()
    const r = await handleCases({
      body: { ticket_id: 123, create: REQ_VALID_CREATE.body.create },
      headers: KEY, tenantConfig: goproTenantConfig(), docEndpoint: 'gopro'
    })
    assertMatchesFixture(r as any, RES_GOPRO_CREATE_UNSUPPORTED)
  })

  it('create_failed → RES_CREATE_FAILED (no caseNumber)', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    const r = await handleCases({
      body: { ticket_id: 123, create: REQ_VALID_CREATE.body.create },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    assertMatchesFixture(r as any, RES_CREATE_FAILED)
  })

  it('orphan_case → RES_ORPHAN_CASE (carries caseNumber)', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-2024-0099' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'err' })
    const r = await handleCases({
      body: { ticket_id: 123, create: REQ_VALID_CREATE.body.create },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    // Gateway error message is runtime-derived; assert the safety-critical
    // contract: status, ok, outcome, and the surfaced caseNumber.
    expect(r.status).toBe(RES_ORPHAN_CASE.status)
    expect(r.body.ok).toBe(false)
    expect(r.body.outcome).toBe('orphan_case')
    expect(r.body.caseNumber).toBe(RES_ORPHAN_CASE.body.caseNumber)
    expect(typeof r.body.error).toBe('string')
    for (const k of RES_ORPHAN_CASE.requiredKeys) {
      expect((r.body as Record<string, unknown>)[k]).not.toBeUndefined()
    }
  })

  it('documented → RES_DOCUMENTED (carries caseNumber)', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
    const r = await handleCases({
      body: { ticket_id: 123, case_number: 'OS-2024-0007' },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    assertMatchesFixture(r as any, RES_DOCUMENTED)
  })

  // ── Documented non-GW-06 exception: infra catch-all 500 ─────────────
  it('infra catch-all → RES_INFRA_500 (NOT a GW-06 outcome)', async () => {
    fetchMock().mockRejectedValueOnce(new Error('Secret db'))
    const r = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    assertMatchesFixture(r as any, RES_INFRA_500)
    expect(JSON.stringify(r.body)).not.toContain('db')
  })

  // ── Enum freeze: gateway outcomes == fixture tuple, same order ──────
  it('gateway outcomes are exactly the frozen fixture tuple, in order', () => {
    expect(GW06_OUTCOMES).toEqual([
      'documented', 'create_failed', 'orphan_case', 'validation',
      'auth', 'brand_mismatch', 'gopro_create_unsupported'
    ])
    expect(GW06_OUTCOMES.length).toBe(7)
    // The ordered GW-06 response fixtures line up 1:1 with the enum order.
    expect(RESPONSE_FIXTURES_GW06.map(f => f.body.outcome)).toEqual([...GW06_OUTCOMES])
  })
})
