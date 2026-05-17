import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleCases } from '../src/cases.js'
import type { TenantConfig } from '../src/types.js'

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
    pdf: {
      companyName: 'Test Company',
      locale: 'is-IS',
      includeInternalNotes: false
    },
    ...overrides
  }
}

function goproTenantConfig(): TenantConfig {
  return makeTenantConfig({
    endpoints: {
      gopro: {
        type: 'gopro',
        baseUrl: 'https://api.gopro.test',
        username: 'guser',
        password: 'gpass'
      }
    }
  })
}

const KEY = { 'x-api-key': 'test-malaskra-key' }
const NS_CREATE = { onesystems: { caseTemplate: 'T', kennitala: '1234567890' } }
const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>

// getTicket → getTicketComments → getUsersMany prelude (no attachments).
function mockTicketPrelude(brandId: number | undefined = 360001234567) {
  fetchMock()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ticket: { id: 123, subject: 'Test', brand_id: brandId } })
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ comments: [{ id: 1, body: 'Hi', public: true, author_id: 7 }] })
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ users: [{ id: 7, name: 'Agent', email: 'agent@example.com' }] })
    })
}

describe('handleCases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // (1) auth → GW-06 { ok:false, outcome:'auth', error }
  it('rejects requests without API key → 401 { ok:false, outcome:auth }', async () => {
    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: {},
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(401)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('auth')
    expect(typeof result.body.error).toBe('string')
  })

  // (2) validation: ticket_id missing
  it('rejects missing ticket_id → 400 { ok:false, outcome:validation }', async () => {
    const result = await handleCases({
      body: { case_number: 'C-1' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('validation')
    expect(String(result.body.error)).toContain('ticket_id')
  })

  // (3) XOR both
  it('rejects both create and case_number → 400 validation ~exactly one', async () => {
    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1', create: NS_CREATE },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('validation')
    expect(String(result.body.error)).toContain('exactly one')
  })

  // (4) XOR neither
  it('rejects neither create nor case_number → 400 validation', async () => {
    const result = await handleCases({
      body: { ticket_id: 123 },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('validation')
    expect(String(result.body.error)).toContain('exactly one')
  })

  // (5) bad case_number
  it('rejects bad case_number "../x" → 400 validation', async () => {
    const result = await handleCases({
      body: { ticket_id: 123, case_number: '../x' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('validation')
  })

  // (6) NEW — namespaced create parsing: missing create.onesystems.caseTemplate
  it('rejects missing create.onesystems.caseTemplate → 400 validation', async () => {
    const result = await handleCases({
      body: { ticket_id: 123, create: { onesystems: { kennitala: '1234567890' } } },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('validation')
    expect(String(result.body.error)).toContain('create.onesystems')
  })

  // (7) brand_mismatch + fail-closed variant — clean envelope, no leak
  it('rejects ticket with mismatched brand_id → 403 { ok:false, outcome:brand_mismatch }', async () => {
    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ticket: { id: 123, brand_id: 999999 } })
    })
    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(403)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('brand_mismatch')
    expect(typeof result.body.error).toBe('string')
    expect(result.body.ticket_id).toBeUndefined()
    expect(result.body.doc_system).toBeUndefined()
  })

  it('rejects ticket with undefined brand_id (fail-closed) → 403 brand_mismatch', async () => {
    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ticket: { id: 123, subject: 'No brand' } })
    })
    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(403)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('brand_mismatch')
  })

  // (8) gopro_create_unsupported — NO CreateCaseUid fetch
  it('namespaced create against GoPro → 422 gopro_create_unsupported, no CreateCaseUid', async () => {
    mockTicketPrelude()
    const result = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY,
      tenantConfig: goproTenantConfig(),
      docEndpoint: 'gopro'
    })
    expect(result.status).toBe(422)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('gopro_create_unsupported')
    const urls = fetchMock().mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('CreateCaseUid'))).toBe(false)
  })

  // (9) create_failed — no caseNumber
  it('createCase fetch fails → 502 create_failed, no caseNumber', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })

    const result = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(502)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('create_failed')
    expect(result.body.caseNumber).toBeUndefined()
  })

  // (10) orphan_case — stamp (setTicketCustomField) fails
  it('create OK then setTicketCustomField fails → 207 orphan_case + caseNumber', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'err' })

    const result = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(207)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('orphan_case')
    expect(result.body.caseNumber).toBe('OS-1')
    expect(typeof result.body.error).toBe('string')
    expect(result.body.created_case_number).toBeUndefined()
  })

  // (11) orphan_case — upload (postToCase) fails
  it('create OK, stamp OK, then AddDocument2 fails → 207 orphan_case + caseNumber', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-2' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upload boom' })

    const result = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(207)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('orphan_case')
    expect(result.body.caseNumber).toBe('OS-2')
  })

  // (12) case_number path upload fail → generic 500, NOT a GW-06 outcome
  it('case_number path upload fail → 500 { error,duration_ms } no ok/outcome/caseNumber, no CreateCaseUid', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upload boom' })

    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-7' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
    expect(typeof result.body.duration_ms).toBe('number')
    expect(result.body.ok).toBeUndefined()
    expect(result.body.outcome).toBeUndefined()
    expect(result.body.caseNumber).toBeUndefined()
    const urls = fetchMock().mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('CreateCaseUid'))).toBe(false)
  })

  // (13) documented — create path happy
  it('happy namespaced create path → 200 { ok:true, outcome:documented, caseNumber }, CreateCaseUid fetched', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-9' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const result = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.outcome).toBe('documented')
    expect(result.body.caseNumber).toBe('OS-9')
    expect(result.body.success).toBeUndefined()
    expect(result.body.case_number).toBeUndefined()
    const urls = fetchMock().mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('CreateCaseUid'))).toBe(true)
  })

  // (14) documented — case_number path happy
  it('happy case_number path → 200 documented caseNumber, no CreateCaseUid', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-9' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.outcome).toBe('documented')
    expect(result.body.caseNumber).toBe('C-9')
    expect(result.body.case_number).toBeUndefined()
    const urls = fetchMock().mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('CreateCaseUid'))).toBe(false)
  })

  // (15) LOCKED ORDER — CreateCaseUid < PUT /tickets/ < AddDocument2
  it('locked order: CreateCaseUid before PUT /tickets/ before AddDocument2', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-O' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const result = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(200)

    const calls = fetchMock().mock.calls
    const urls = calls.map(c => String(c[0]))
    const iCreate = urls.findIndex(u => u.includes('CreateCaseUid'))
    const iStamp = calls.findIndex(
      (c) => String(c[0]).includes('/tickets/123.json') && (c[1] as any)?.method === 'PUT'
    )
    const iUpload = urls.findIndex(u => u.includes('AddDocument2'))
    expect(iCreate).toBeGreaterThanOrEqual(0)
    expect(iStamp).toBeGreaterThanOrEqual(0)
    expect(iUpload).toBeGreaterThanOrEqual(0)
    expect(iCreate).toBeLessThan(iStamp)
    expect(iStamp).toBeLessThan(iUpload)
  })

  // (16) error-leak
  it('does not leak internal error messages → 500 generic', async () => {
    fetchMock().mockRejectedValueOnce(new Error('Secret database info'))
    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
    expect(JSON.stringify(result.body)).not.toContain('database')
  })

  // (G3) audit-correctness: enriched persisted audit entry on /v1/cases
  function captureAuditStore() {
    const entries: Record<string, unknown>[] = []
    return {
      store: {
        put: async (_k: string, v: string) => { entries.push(JSON.parse(v)) }
      },
      entries
    }
  }

  it('documented (create) → audit entry: outcome=documented, source=created, intent=create, last_status=OK, last_export present', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-9' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const audit = captureAuditStore()
    const result = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems',
      auditStore: audit.store as never
    })
    expect(result.status).toBe(200)
    const e = audit.entries[0] as { event: string; outcome: string; intent: string; last_status: string; last_export: string; destination: { case_number_source: string } }
    expect(e.event).toBe('ticket_archived')
    expect(e.outcome).toBe('documented')
    expect(e.destination.case_number_source).toBe('created')
    expect(e.intent).toBe('create')
    expect(e.last_status).toBe('OK')
    expect(typeof e.last_export).toBe('string')
    expect(e.last_export.length).toBeGreaterThan(0)
  })

  it('documented (case_number) → audit entry: outcome=documented, source=provided, intent=case_number', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const audit = captureAuditStore()
    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-9' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems',
      auditStore: audit.store as never
    })
    expect(result.status).toBe(200)
    const e = audit.entries[0] as { outcome: string; intent: string; destination: { case_number_source: string } }
    expect(e.outcome).toBe('documented')
    expect(e.destination.case_number_source).toBe('provided')
    expect(e.intent).toBe('case_number')
  })

  it('forced orphan_case → 207 unchanged AND persisted audit entry event=orphan_case, distinguishable from documented', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'err' })

    const audit = captureAuditStore()
    const result = await handleCases({
      body: { ticket_id: 123, create: NS_CREATE },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems',
      auditStore: audit.store as never
    })
    expect(result.status).toBe(207)
    expect(result.body.ok).toBe(false)
    expect(result.body.outcome).toBe('orphan_case')
    expect(result.body.caseNumber).toBe('OS-1')
    const e = audit.entries[0] as { event: string; outcome: string; last_status: string; destination: { case_number: string } }
    expect(e.event).toBe('orphan_case')
    expect(e.outcome).toBe('orphan_case')
    expect(e.last_status).toBe('ORPHAN')
    expect(e.destination.case_number).toBe('OS-1')
    // distinguishable from a true documented success
    expect(e.event).not.toBe('ticket_archived')
  })
})
