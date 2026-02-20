import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleAttachments } from '../src/attachments.js'
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
        appKey: 'test-key'
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

describe('handleAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should reject requests without API key', async () => {
    const result = await handleAttachments({
      body: { ticket_id: 123, case_number: 'C-100' },
      headers: {},
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(401)
    expect(result.body.error).toBe('Invalid or missing API key')
  })

  it('should reject requests with wrong API key', async () => {
    const result = await handleAttachments({
      body: { ticket_id: 123, case_number: 'C-100' },
      headers: { 'x-api-key': 'wrong-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(401)
  })

  it('should reject missing ticket_id', async () => {
    const result = await handleAttachments({
      body: { case_number: 'C-100' },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(400)
    expect(result.body.error).toContain('ticket_id')
  })

  it('should reject missing case_number', async () => {
    const result = await handleAttachments({
      body: { ticket_id: 123 },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(400)
    expect(result.body.error).toContain('case_number')
  })

  it('should reject ticket with mismatched brand_id', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      // getTicket — returns ticket belonging to a different brand
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: { id: 123, brand_id: 999999 } })
      })

    const result = await handleAttachments({
      body: { ticket_id: 123, case_number: 'C-100' },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(403)
    expect(result.body.error).toContain('does not belong to this brand')
  })

  it('should reject ticket with undefined brand_id (fail-closed)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      // getTicket — brand_id missing from response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: { id: 123, subject: 'Test' } })
      })

    const result = await handleAttachments({
      body: { ticket_id: 123, case_number: 'C-100' },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(403)
    expect(result.body.error).toContain('brand_id unavailable')
  })

  it('should return success with 0 attachments when ticket has none', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      // getTicket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: { id: 123, brand_id: 360001234567 } })
      })
      // getTicketComments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: [{ id: 1, body: 'No files here', public: true }] })
      })

    const result = await handleAttachments({
      body: { ticket_id: 123, case_number: 'C-100' },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(200)
    expect(result.body.success).toBe(true)
    expect(result.body.attachments_forwarded).toBe(0)
  })

  it('should fetch and forward attachments to OneSystems', async () => {
    const fakeFileBuffer = Buffer.from('fake-pdf-content')

    ;(global.fetch as ReturnType<typeof vi.fn>)
      // getTicket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: { id: 123, brand_id: 360001234567 } })
      })
      // getTicketComments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          comments: [{
            id: 1,
            body: 'See attached',
            public: true,
            attachments: [{
              file_name: 'report.pdf',
              content_type: 'application/pdf',
              size: 1024,
              content_url: 'https://test.zendesk.com/attachments/token/abc/report.pdf'
            }]
          }]
        })
      })
      // fetchAttachments -> download the file
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => fakeFileBuffer.buffer
      })
      // OneSystems auth
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ token: 'os-token' })
      })
      // OneSystems upload
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true })
      })

    const result = await handleAttachments({
      body: { ticket_id: 123, case_number: 'C-100' },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(200)
    expect(result.body.success).toBe(true)
    expect(result.body.attachments_total).toBe(1)
    expect(result.body.attachments_forwarded).toBe(1)
    expect(result.body.doc_system).toBe('onesystems')
    expect(result.body.brand_id).toBe('360001234567')
  })

  it('should forward attachments to GoPro when docEndpoint points to gopro', async () => {
    const tenantConfig = makeTenantConfig({
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: 'https://api.onesystems.test',
          appKey: 'test-key'
        },
        gopro: {
          type: 'gopro',
          baseUrl: 'https://api.gopro.test',
          username: 'guser',
          password: 'gpass'
        }
      }
    })

    const fakeFileBuffer = Buffer.from('fake-content')

    ;(global.fetch as ReturnType<typeof vi.fn>)
      // getTicket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: { id: 200, brand_id: 360001234567 } })
      })
      // getTicketComments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          comments: [{
            id: 1,
            body: 'Attached',
            attachments: [{
              file_name: 'doc.pdf',
              content_type: 'application/pdf',
              size: 512,
              content_url: 'https://test.zendesk.com/attachments/token/xyz/doc.pdf'
            }]
          }]
        })
      })
      // download attachment
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => fakeFileBuffer.buffer
      })
      // GoPro auth
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'gopro-token'
      })
      // GoPro upload
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ succeeded: true, identifier: 'doc-1' })
      })

    const result = await handleAttachments({
      body: { ticket_id: 200, case_number: 'GP-200' },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig,
      docEndpoint: 'gopro'
    })

    expect(result.status).toBe(200)
    expect(result.body.success).toBe(true)
    expect(result.body.doc_system).toBe('gopro')
    expect(result.body.attachments_forwarded).toBe(1)

    // Verify GoPro endpoints were called
    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(calledUrls.some(u => u.includes('gopro.test'))).toBe(true)
  })

  it('should report partial failures without crashing', async () => {
    const fakeFileBuffer = Buffer.from('data')

    ;(global.fetch as ReturnType<typeof vi.fn>)
      // getTicket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: { id: 300, brand_id: 360001234567 } })
      })
      // getTicketComments - two attachments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          comments: [{
            id: 1,
            body: 'Files',
            attachments: [
              { file_name: 'a.pdf', content_type: 'application/pdf', size: 100, content_url: 'https://test.zendesk.com/att/a' },
              { file_name: 'b.pdf', content_type: 'application/pdf', size: 200, content_url: 'https://test.zendesk.com/att/b' }
            ]
          }]
        })
      })
      // download attachment a
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => fakeFileBuffer.buffer })
      // download attachment b
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => fakeFileBuffer.buffer })
      // OneSystems auth
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'tok' }) })
      // Upload a - success
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
      // Upload b - fails
      .mockResolvedValueOnce({ ok: false, text: async () => 'Server error' })

    const result = await handleAttachments({
      body: { ticket_id: 300, case_number: 'C-300' },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(200)
    expect(result.body.success).toBe(false)
    expect(result.body.attachments_forwarded).toBe(1)
    expect(result.body.errors).toHaveLength(1)
    expect((result.body.errors as any[])[0].filename).toBe('b.pdf')
  })

  it('should not leak internal error messages', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Secret database info'))

    const result = await handleAttachments({
      body: { ticket_id: 123, case_number: 'C-100' },
      headers: { 'x-api-key': 'test-malaskra-key' },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
    expect(JSON.stringify(result.body)).not.toContain('database')
  })
})
