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
const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>

// Mock the Zendesk getTicket + getTicketComments + getUsersMany prelude.
// No attachments → no downloads (postToCase still uploads the rendered PDF).
function mockTicketPrelude(brandId: number | undefined = 360001234567) {
  fetchMock()
    // getTicket
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ticket: { id: 123, subject: 'Test', brand_id: brandId } })
    })
    // getTicketComments
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ comments: [{ id: 1, body: 'Hi', public: true, author_id: 7 }] })
    })
    // getUsersMany
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ users: [{ id: 7, name: 'Agent', email: 'agent@example.com' }] })
    })
}

describe('handleCases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // (1) auth
  it('rejects requests without API key → 401 outcome=auth', async () => {
    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1' },
      headers: {},
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(401)
    expect(result.body.outcome).toBe('auth')
  })

  // (2) validation: ticket_id missing
  it('rejects missing ticket_id → 400 outcome=validation', async () => {
    const result = await handleCases({
      body: { case_number: 'C-1' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(400)
    expect(result.body.outcome).toBe('validation')
    expect(result.body.error).toContain('ticket_id')
  })

  // (3) XOR both
  it('rejects both create and case_number → 400 validation ~exactly one', async () => {
    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-1', create: { caseTemplate: 't', kennitala: '1' } },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(400)
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
    expect(result.body.outcome).toBe('validation')
  })

  // (6) brand_mismatch + fail-closed variant
  it('rejects ticket with mismatched brand_id → 403 outcome=brand_mismatch', async () => {
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
    expect(result.body.outcome).toBe('brand_mismatch')
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
    expect(result.body.outcome).toBe('brand_mismatch')
  })

  // (7) gopro_create_unsupported — NO CreateCaseUid fetch
  it('create against GoPro → 422 gopro_create_unsupported, no CreateCaseUid', async () => {
    mockTicketPrelude()
    const result = await handleCases({
      body: { ticket_id: 123, create: { caseTemplate: 'tpl', kennitala: '1234567890' } },
      headers: KEY,
      tenantConfig: goproTenantConfig(),
      docEndpoint: 'gopro'
    })
    expect(result.status).toBe(422)
    expect(result.body.outcome).toBe('gopro_create_unsupported')
    const urls = fetchMock().mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('CreateCaseUid'))).toBe(false)
  })

  // (8) create_failed — no created_case_number
  it('createCase fetch fails → 502 create_failed, no created_case_number', async () => {
    mockTicketPrelude()
    fetchMock()
      // OneSystems auth
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      // CreateCaseUid — fails
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })

    const result = await handleCases({
      body: { ticket_id: 123, create: { caseTemplate: 'tpl', kennitala: '1234567890' } },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(502)
    expect(result.body.outcome).toBe('create_failed')
    expect(result.body.created_case_number).toBeUndefined()
  })

  // (9) orphan_case — stamp (setTicketCustomField) fails
  it('create OK then setTicketCustomField fails → 207 orphan_case + created_case_number', async () => {
    mockTicketPrelude()
    fetchMock()
      // OneSystems auth
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      // CreateCaseUid OK
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-1' }) })
      // setTicketCustomField PUT /tickets/123.json — fails
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'err' })

    const result = await handleCases({
      body: { ticket_id: 123, create: { caseTemplate: 'tpl', kennitala: '1234567890' } },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(207)
    expect(result.body.outcome).toBe('orphan_case')
    expect(result.body.created_case_number).toBe('OS-1')
    expect(result.body.case_number).toBe('OS-1')
  })

  // (10) orphan_case — upload (postToCase) fails
  it('create OK, stamp OK, then AddDocument2 fails → 207 orphan_case + created_case_number', async () => {
    mockTicketPrelude()
    fetchMock()
      // OneSystems auth
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      // CreateCaseUid OK
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-2' }) })
      // setTicketCustomField OK
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      // AddDocument2 — fails
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upload boom' })

    const result = await handleCases({
      body: { ticket_id: 123, create: { caseTemplate: 'tpl', kennitala: '1234567890' } },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(207)
    expect(result.body.outcome).toBe('orphan_case')
    expect(result.body.created_case_number).toBe('OS-2')
  })

  // (11) NEW — case_number path upload fail → generic 500, nothing minted
  it('case_number path upload fail → 500 Internal server error, no created_case_number, not orphan_case, no CreateCaseUid', async () => {
    mockTicketPrelude()
    fetchMock()
      // OneSystems auth
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      // AddDocument2 — fails
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upload boom' })

    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-7' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
    expect(result.body.duration_ms).toBeDefined()
    expect(result.body.created_case_number).toBeUndefined()
    expect(result.body.outcome).toBeUndefined()
    const urls = fetchMock().mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('CreateCaseUid'))).toBe(false)
  })

  // (12) documented — create path happy
  it('happy create path → 200 documented success created=true, CreateCaseUid fetched', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      // CreateCaseUid OK
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-9' }) })
      // setTicketCustomField OK
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      // AddDocument2 OK
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const result = await handleCases({
      body: { ticket_id: 123, create: { caseTemplate: 'tpl', kennitala: '1234567890' } },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(200)
    expect(result.body.outcome).toBe('documented')
    expect(result.body.success).toBe(true)
    expect(result.body.created).toBe(true)
    expect(result.body.case_number).toBe('OS-9')
    const urls = fetchMock().mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('CreateCaseUid'))).toBe(true)
  })

  // (13) documented — case_number path happy
  it('happy case_number path → 200 documented, no CreateCaseUid', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      // AddDocument2 OK
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const result = await handleCases({
      body: { ticket_id: 123, case_number: 'C-9' },
      headers: KEY,
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })
    expect(result.status).toBe(200)
    expect(result.body.outcome).toBe('documented')
    expect(result.body.case_number).toBe('C-9')
    expect(result.body.created).toBe(false)
    const urls = fetchMock().mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('CreateCaseUid'))).toBe(false)
  })

  // (14) LOCKED ORDER — createCase < setTicketCustomField < postToCase
  it('locked order: CreateCaseUid before PUT /tickets/ before AddDocument2', async () => {
    mockTicketPrelude()
    fetchMock()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-O' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })

    const result = await handleCases({
      body: { ticket_id: 123, create: { caseTemplate: 'tpl', kennitala: '1234567890' } },
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

  // (15) error-leak
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
})
