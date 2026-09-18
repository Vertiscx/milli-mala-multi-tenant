import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import { handleTicketUpdate } from '../src/services/ticketUpdate/handler.js'
import type { TenantConfig } from '../src/platform/types.js'
import type { TenantStore } from '../src/platform/tenant.js'

global.fetch = vi.fn() as unknown as typeof fetch

function makeSignature(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(timestamp + rawBody).digest('base64')
}

function makeTenantConfig(brandId: string, overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    brand_id: brandId,
    name: 'Test Tenant',
    zendesk: {
      subdomain: 'test-subdomain',
      email: 'test@example.com',
      apiToken: 'test-api-token-that-is-long-enough-1234',
      // Deliberately different from ticketUpdate.webhookSecret below — they
      // are two independent Zendesk webhook targets, each with its own
      // Zendesk-generated signing secret (see handler.ts module comment).
      webhookSecret: 'test-archive-webhook-secret-long-enough'
    },
    services: {
      ticketUpdate: {
        webhookSecret: 'test-ticket-update-webhook-secret-long!',
        oauth: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret-that-is-long-enough'
        }
      }
    },
    ...overrides
  }
}

function makeStore(tenants: TenantConfig[]): TenantStore {
  const map = new Map(tenants.map(t => [t.brand_id, t]))
  return { get: async (brandId: string) => map.get(brandId) ?? null }
}

function makeRequest(ticket: Record<string, unknown>, { secret = 'test-ticket-update-webhook-secret-long!', timestamp }: { secret?: string; timestamp?: string } = {}) {
  const body = { ticket }
  const rawBody = JSON.stringify(body)
  const ts = timestamp || new Date().toISOString()
  const sig = makeSignature(rawBody, ts, secret)
  return {
    body,
    rawBody,
    headers: {
      'x-zendesk-webhook-signature': sig,
      'x-zendesk-webhook-signature-timestamp': ts
    }
  }
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      access_token: 'access-token-1',
      token_type: 'bearer',
      expires_in: 3600,
      scope: 'tickets:write',
      ...overrides
    })
  }
}

describe('handleTicketUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a request with no ticket object', async () => {
    const store = makeStore([makeTenantConfig('1')])
    const req = makeRequest({}, {})
    // Simulate a body with no `ticket` key at all
    const result = await handleTicketUpdate({ ...req, body: {} }, store)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('Missing ticket')
  })

  it('rejects a request with no ticket.brand_id', async () => {
    const store = makeStore([makeTenantConfig('1')])
    const req = makeRequest({ id: '123' })
    const result = await handleTicketUpdate(req, store)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('Missing ticket.brand_id')
  })

  it('returns a neutral 400 for an unknown tenant', async () => {
    const store = makeStore([])
    const req = makeRequest({ id: '123', brand_id: 'unknown' })
    const result = await handleTicketUpdate(req, store)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('Invalid request')
  })

  it('returns a neutral 400 when the tenant has no ticketUpdate service configured', async () => {
    const store = makeStore([makeTenantConfig('2', { services: {} })])
    const req = makeRequest({ id: '123', brand_id: '2' })
    const result = await handleTicketUpdate(req, store)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('Invalid request')
  })

  it('rejects an invalid signature', async () => {
    const store = makeStore([makeTenantConfig('3')])
    const req = makeRequest({ id: '123', brand_id: '3' }, { secret: 'wrong-secret' })
    const result = await handleTicketUpdate(req, store)
    expect(result.status).toBe(401)
    expect(result.body.error).toBe('Invalid webhook signature')
  })

  it('rejects a request signed with the archive webhook secret instead of the ticketUpdate one — they are independent Zendesk-generated secrets, never interchangeable', async () => {
    const store = makeStore([makeTenantConfig('3b')])
    const req = makeRequest({ id: '123', brand_id: '3b' }, { secret: 'test-archive-webhook-secret-long-enough' })
    const result = await handleTicketUpdate(req, store)
    expect(result.status).toBe(401)
    expect(result.body.error).toBe('Invalid webhook signature')
  })

  it('rejects a stale timestamp', async () => {
    const store = makeStore([makeTenantConfig('4')])
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const req = makeRequest({ id: '123', brand_id: '4' }, { timestamp: tenMinAgo })
    const result = await handleTicketUpdate(req, store)
    expect(result.status).toBe(401)
    expect(result.body.error).toBe('Webhook timestamp expired')
  })

  it('rejects a missing or non-numeric ticket.id', async () => {
    const store = makeStore([makeTenantConfig('5')])
    const req = makeRequest({ brand_id: '5', recipient: 'a@b.is' })
    const result = await handleTicketUpdate(req, store)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('Invalid or missing ticket.id')
  })

  it('rejects a payload with nothing to update besides id/brand_id', async () => {
    const store = makeStore([makeTenantConfig('6')])
    const req = makeRequest({ id: '123', brand_id: '6' })
    const result = await handleTicketUpdate(req, store)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('No fields to update')
  })

  it('fetches a token, calls update_many with the right URL/body/auth, and returns success', async () => {
    const store = makeStore([makeTenantConfig('7')])
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: { id: 123, recipient: 'endurhaefing@tr.is' } }) })

    const req = makeRequest({ id: '123', brand_id: '7', recipient: 'endurhaefing@tr.is' })
    const result = await handleTicketUpdate(req, store)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ success: true, ticket_id: 123, brand_id: '7', duration_ms: expect.any(Number) })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    const [tokenUrl] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(tokenUrl).toBe('https://test-subdomain.zendesk.com/oauth/tokens')

    const [updateUrl, updateInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(updateUrl).toBe('https://test-subdomain.zendesk.com/api/v2/tickets/123.json')
    expect(updateInit).toMatchObject({
      method: 'PUT',
      headers: { Authorization: 'Bearer access-token-1', 'Content-Type': 'application/json' }
    })
    expect(JSON.parse(updateInit.body)).toEqual({ ticket: { recipient: 'endurhaefing@tr.is' } })
  })

  it('reuses a cached token on a second request instead of re-fetching', async () => {
    const store = makeStore([makeTenantConfig('8')])
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    await handleTicketUpdate(makeRequest({ id: '1', brand_id: '8', recipient: 'a@b.is' }), store)

    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await handleTicketUpdate(makeRequest({ id: '2', brand_id: '8', recipient: 'a@b.is' }), store)

    // 2 calls for the first request (token + update) + 1 for the second (update only)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('retries once with a fresh token when Zendesk rejects the cached one with 401', async () => {
    const store = makeStore([makeTenantConfig('9')])
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(tokenResponse({ access_token: 'stale-token' }))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' })
      .mockResolvedValueOnce(tokenResponse({ access_token: 'fresh-token' }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    const result = await handleTicketUpdate(makeRequest({ id: '123', brand_id: '9', recipient: 'a@b.is' }), store)

    expect(result.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(4)
    const [, secondUpdateInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[3]
    expect(secondUpdateInit.headers.Authorization).toBe('Bearer fresh-token')
  })

  it('returns 502 when Zendesk still fails after the retry', async () => {
    const store = makeStore([makeTenantConfig('10')])
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' })
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })

    const result = await handleTicketUpdate(makeRequest({ id: '123', brand_id: '10', recipient: 'a@b.is' }), store)
    expect(result.status).toBe(502)
    expect(result.body.error).toBe('Zendesk ticket update failed')
  })

  it('returns 502 when the OAuth token request itself fails', async () => {
    const store = makeStore([makeTenantConfig('11')])
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'invalid_client' })

    const result = await handleTicketUpdate(makeRequest({ id: '123', brand_id: '11', recipient: 'a@b.is' }), store)
    expect(result.status).toBe(502)
    expect(result.body.error).toBe('Zendesk authentication failed')
  })
})
