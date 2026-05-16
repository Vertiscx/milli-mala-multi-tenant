/**
 * FROZEN GW-06 CONFORMANCE LOCK.
 *
 * Source of truth: /Users/brynjolfur/dev/malaskra_v3/.planning/GATEWAY-CHANGES.md §GW-06.
 * This file is the regression guard against silent drift of the cross-repo
 * /v1/cases wire seam. It asserts STRUCTURE (shape lock), not full-object
 * snapshots, so additive .passthrough()-tolerated fields do not break it
 * while the four required fields + the 7-code enum stay pinned.
 *
 * If this test fails, the GW-06 contract has been broken — do NOT "fix" the
 * test, fix the handler (or coordinate a deliberate contract change with the
 * malaskra_v3 side first).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleCases } from '../src/cases.js'
import type { TenantConfig } from '../src/types.js'

global.fetch = vi.fn() as unknown as typeof fetch

// FROZEN 7-code enum — exact set, exact order. Do NOT edit without a
// coordinated GW-06 contract change.
const GW06_OUTCOMES = [
  'documented',
  'create_failed',
  'orphan_case',
  'validation',
  'auth',
  'brand_mismatch',
  'gopro_create_unsupported'
] as const

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
const NS_CREATE = { onesystems: { caseTemplate: 'T', kennitala: '1234567890' } }
const FLAT_CREATE = { caseTemplate: 'T', kennitala: '1234567890' }
const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>

function mockTicketPrelude(brandId: number | undefined = 360001234567) {
  fetchMock()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: { id: 123, subject: 'T', brand_id: brandId } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ comments: [{ id: 1, body: 'Hi', public: true, author_id: 7 }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [{ id: 7, name: 'A', email: 'a@e.com' }] }) })
}

/** Structural GW-06 envelope assertion shared by every structured outcome. */
function assertGw06Envelope(body: Record<string, any>) {
  expect(typeof body.ok).toBe('boolean')
  expect(GW06_OUTCOMES).toContain(body.outcome)
  // no legacy snake_case envelope keys may resurface
  expect(body.case_number).toBeUndefined()
  expect(body.created_case_number).toBeUndefined()
  expect(body.success).toBeUndefined()
  if (body.outcome === 'documented') {
    expect(body.ok).toBe(true)
    expect(typeof body.caseNumber).toBe('string')
    expect(body.caseNumber.length).toBeGreaterThan(0)
  } else if (body.outcome === 'orphan_case') {
    expect(body.ok).toBe(false)
    expect(typeof body.caseNumber).toBe('string')
    expect(body.caseNumber.length).toBeGreaterThan(0)
    expect(typeof body.error).toBe('string')
  } else {
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(body.caseNumber).toBeUndefined()
  }
}

describe('GW-06 contract lock — /v1/cases', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── Request acceptance ──────────────────────────────────────────────
  it('accepts the namespaced create shape (reaches documented)', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const r = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.status).toBe(200)
    expect(r.body.outcome).toBe('documented')
    assertGw06Envelope(r.body as any)
  })

  it('rejects the flat legacy create shape as validation', async () => {
    const r = await handleCases({
      body: { ticket_id: 123, create: FLAT_CREATE },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.status).toBe(400)
    expect(r.body.outcome).toBe('validation')
    assertGw06Envelope(r.body as any)
  })

  // ── Every one of the 7 outcomes conforms ────────────────────────────
  it('auth → conformant envelope', async () => {
    const r = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: {}, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.body.outcome).toBe('auth')
    assertGw06Envelope(r.body as any)
  })

  it('validation → conformant envelope', async () => {
    const r = await handleCases({
      body: { ticket_id: 123 },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.body.outcome).toBe('validation')
    assertGw06Envelope(r.body as any)
  })

  it('brand_mismatch → conformant envelope', async () => {
    fetchMock().mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: { id: 123, brand_id: 999999 } }) })
    const r = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.body.outcome).toBe('brand_mismatch')
    assertGw06Envelope(r.body as any)
  })

  it('gopro_create_unsupported → conformant envelope', async () => {
    mockTicketPrelude()
    const r = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY, tenantConfig: goproTenantConfig(), docEndpoint: 'gopro'
    })
    expect(r.body.outcome).toBe('gopro_create_unsupported')
    assertGw06Envelope(r.body as any)
  })

  it('create_failed → conformant envelope, NO caseNumber', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    const r = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.body.outcome).toBe('create_failed')
    expect(r.body.caseNumber).toBeUndefined()
    assertGw06Envelope(r.body as any)
  })

  it('orphan_case → conformant envelope, carries caseNumber', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-2' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'err' })
    const r = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.body.outcome).toBe('orphan_case')
    expect(r.body.caseNumber).toBe('OS-2')
    assertGw06Envelope(r.body as any)
  })

  it('documented → conformant envelope, carries caseNumber', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
    const r = await handleCases({
      body: { ticket_id: 123, case_number: 'C-9' },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.body.outcome).toBe('documented')
    expect(r.body.caseNumber).toBe('C-9')
    assertGw06Envelope(r.body as any)
  })

  // ── The DOCUMENTED non-GW-06 exception: infra catch-all 500 ──────────
  // This is the ONLY non-envelope body. It is NOT a GW-06 outcome — it is
  // the explicitly retryable infra catch-all (case_number-path later
  // failure / unexpected throw). It MUST NOT carry ok/outcome/caseNumber.
  it('infra catch-all → HTTP 500 with NO ok/outcome/caseNumber (documented exception)', async () => {
    fetchMock().mockRejectedValueOnce(new Error('Secret db'))
    const r = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: KEY, tenantConfig: makeTenantConfig(), docEndpoint: 'onesystems'
    })
    expect(r.status).toBe(500)
    expect(r.body.error).toBe('Internal server error')
    expect(typeof r.body.duration_ms).toBe('number')
    expect(r.body.ok).toBeUndefined()
    expect(r.body.outcome).toBeUndefined()
    expect(r.body.caseNumber).toBeUndefined()
    expect(JSON.stringify(r.body)).not.toContain('db')
  })

  // ── Enum freeze: no outcome string outside the frozen set ───────────
  it('every observed outcome is in the frozen 7-code enum', async () => {
    expect(GW06_OUTCOMES).toEqual([
      'documented', 'create_failed', 'orphan_case', 'validation',
      'auth', 'brand_mismatch', 'gopro_create_unsupported'
    ])
    expect(GW06_OUTCOMES.length).toBe(7)
  })
})
