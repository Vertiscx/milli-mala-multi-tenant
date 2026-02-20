import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import { handleWebhook, verifyWebhookSignature, isTimestampFresh } from '../src/webhook.js'
import type { TenantConfig } from '../src/types.js'

// Mock fetch globally
global.fetch = vi.fn() as unknown as typeof fetch

function makeSignature(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('base64')
}

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

describe('verifyWebhookSignature', () => {
  it('should return true for valid signature', () => {
    const body = '{"ticket_id":123}'
    const timestamp = '2025-01-01T00:00:00Z'
    const secret = 'my-secret'
    const sig = makeSignature(body, timestamp, secret)

    expect(verifyWebhookSignature(body, timestamp, sig, secret)).toBe(true)
  })

  it('should return false for invalid signature', () => {
    expect(verifyWebhookSignature('body', '12345', 'wrong-sig', 'secret')).toBe(false)
  })

  it('should return false when timestamp is missing', () => {
    expect(verifyWebhookSignature('body', '', 'sig', 'secret')).toBe(false)
  })

  it('should return false when signature is missing', () => {
    expect(verifyWebhookSignature('body', '12345', '', 'secret')).toBe(false)
  })

  it('should return false when secret is missing', () => {
    expect(verifyWebhookSignature('body', '12345', 'sig', '')).toBe(false)
  })
})

describe('isTimestampFresh', () => {
  it('should accept a current timestamp', () => {
    expect(isTimestampFresh(new Date().toISOString())).toBe(true)
  })

  it('should accept a timestamp within tolerance', () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    expect(isTimestampFresh(twoMinAgo)).toBe(true)
  })

  it('should reject a timestamp older than 5 minutes', () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    expect(isTimestampFresh(tenMinAgo)).toBe(false)
  })

  it('should reject a timestamp far in the future', () => {
    const tenMinFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    expect(isTimestampFresh(tenMinFuture)).toBe(false)
  })

  it('should reject an invalid timestamp', () => {
    expect(isTimestampFresh('not-a-date')).toBe(false)
  })

  it('should reject an empty timestamp', () => {
    expect(isTimestampFresh('')).toBe(false)
  })
})

describe('handleWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(body: Record<string, unknown>, { timestamp }: { timestamp?: string } = {}) {
    const rawBody = JSON.stringify(body)
    const ts = timestamp || new Date().toISOString()
    const sig = makeSignature(rawBody, ts, 'test-webhook-secret')
    return {
      body,
      rawBody,
      headers: {
        'x-zendesk-webhook-signature': sig,
        'x-zendesk-webhook-signature-timestamp': ts
      },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    }
  }

  it('should reject requests with invalid signature', async () => {
    const result = await handleWebhook({
      body: { ticket_id: 123 },
      rawBody: '{"ticket_id":123}',
      headers: {
        'x-zendesk-webhook-signature': 'invalid',
        'x-zendesk-webhook-signature-timestamp': '12345'
      },
      tenantConfig: makeTenantConfig(),
      docEndpoint: 'onesystems'
    })

    expect(result.status).toBe(401)
    expect(result.body.error).toBe('Invalid webhook signature')
  })

  it('should reject webhook with expired timestamp', async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const req = makeRequest({ ticket_id: 123 }, { timestamp: oldTimestamp })
    const result = await handleWebhook(req)

    expect(result.status).toBe(401)
    expect(result.body.error).toBe('Webhook timestamp expired')
  })

  it('should reject webhook with future timestamp', async () => {
    const futureTimestamp = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const req = makeRequest({ ticket_id: 123 }, { timestamp: futureTimestamp })
    const result = await handleWebhook(req)

    expect(result.status).toBe(401)
    expect(result.body.error).toBe('Webhook timestamp expired')
  })

  it('should reject missing ticket_id', async () => {
    const req = makeRequest({})
    const result = await handleWebhook(req)

    expect(result.status).toBe(400)
    expect(result.body.error).toContain('ticket_id')
  })

  it('should reject non-integer ticket_id', async () => {
    const req = makeRequest({ ticket_id: 'abc' })
    const result = await handleWebhook(req)

    expect(result.status).toBe(400)
  })

  it('should reject negative ticket_id', async () => {
    const req = makeRequest({ ticket_id: -5 })
    const result = await handleWebhook(req)

    expect(result.status).toBe(400)
  })

  it('should reject unknown doc_endpoint with 400', async () => {
    const req = makeRequest({ ticket_id: 123 })
    req.docEndpoint = 'sharepoint'
    const result = await handleWebhook(req)

    expect(result.status).toBe(400)
    expect(result.body.error).toContain('Unknown doc_endpoint')
  })

  it('should reject ticket with mismatched brand_id (brand cross-check)', async () => {
    const mockTicket = {
      id: 123,
      subject: 'Test ticket',
      status: 'closed',
      created_at: '2025-01-01T00:00:00Z',
      brand_id: 999999  // Different from tenant brand_id '360001234567'
    }

    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: mockTicket })
      })

    const req = makeRequest({ ticket_id: 123 })
    const result = await handleWebhook(req)

    expect(result.status).toBe(403)
    expect(result.body.error).toContain('does not belong to this brand')
  })

  it('should reject ticket with undefined brand_id (fail-closed)', async () => {
    const mockTicket = {
      id: 123,
      subject: 'Test ticket',
      status: 'closed',
      created_at: '2025-01-01T00:00:00Z'
      // brand_id intentionally omitted
    }

    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: mockTicket })
      })

    const req = makeRequest({ ticket_id: 123 })
    const result = await handleWebhook(req)

    expect(result.status).toBe(403)
    expect(result.body.error).toContain('brand_id unavailable')
  })

  it('should process valid webhook end-to-end', async () => {
    const mockTicket = {
      id: 123,
      subject: 'Test ticket',
      status: 'closed',
      created_at: '2025-01-01T00:00:00Z',
      brand_id: 360001234567
    }

    ;(global.fetch as ReturnType<typeof vi.fn>)
      // getTicket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: mockTicket })
      })
      // getTicketComments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: [{ id: 1, body: 'Hello', public: true, author_id: 100 }] })
      })
      // getUsersMany
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: [{ id: 100, name: 'Test Agent', email: 'agent@test.com' }] })
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

    const req = makeRequest({ ticket_id: 123 })
    const result = await handleWebhook(req)

    expect(result.status).toBe(200)
    expect(result.body.success).toBe(true)
    expect(result.body.ticket_id).toBe(123)
    expect(result.body.brand_id).toBe('360001234567')
    expect(result.body.case_number).toBe('ZD-123')
    expect(result.body.doc_endpoint).toBe('onesystems')
    expect(result.body.doc_system).toBe('onesystems')
    expect(result.body.duration_ms).toBeGreaterThanOrEqual(0)

    // Verify OneSystems was actually called (not consumed by getUsersMany)
    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(calledUrls.some(u => u.includes('onesystems.test'))).toBe(true)
  })

  it('should route to GoPro client when docEndpoint points to gopro', async () => {
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
          password: 'gpass',
          caseNumberFieldId: 8888
        }
      }
    })

    const mockTicket = {
      id: 200,
      subject: 'GoPro test',
      status: 'closed',
      created_at: '2025-01-01T00:00:00Z',
      brand_id: 360001234567,
      custom_fields: [{ id: 8888, value: 'GP-CASE-200' }]
    }

    ;(global.fetch as ReturnType<typeof vi.fn>)
      // getTicket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: mockTicket })
      })
      // getTicketComments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: [{ id: 1, body: 'Hello', public: true, author_id: 100 }] })
      })
      // getUsersMany
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: [{ id: 100, name: 'Test Agent', email: 'agent@test.com' }] })
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

    const rawBody = JSON.stringify({ ticket_id: 200 })
    const ts = new Date().toISOString()
    const sig = makeSignature(rawBody, ts, 'test-webhook-secret')
    const result = await handleWebhook({
      body: { ticket_id: 200 },
      rawBody,
      headers: {
        'x-zendesk-webhook-signature': sig,
        'x-zendesk-webhook-signature-timestamp': ts
      },
      tenantConfig,
      docEndpoint: 'gopro'
    })

    expect(result.status).toBe(200)
    expect(result.body.success).toBe(true)
    expect(result.body.doc_system).toBe('gopro')
    expect(result.body.case_number).toBe('GP-CASE-200')

    // Verify GoPro endpoints were called (not OneSystems)
    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(calledUrls.some(u => u.includes('gopro.test'))).toBe(true)
    expect(calledUrls.some(u => u.includes('onesystems.test'))).toBe(false)

    // Verify Authorization header on upload
    const uploadCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(c => c[0].includes('Documents/Create'))
    expect(uploadCall[1].headers['Authorization']).toBe('Bearer gopro-token')
  })

  it('should not leak internal error messages', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Internal database error with secret info'))

    const req = makeRequest({ ticket_id: 123 })
    const result = await handleWebhook(req)

    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
    expect(result.body.error).not.toContain('database')
  })
})
