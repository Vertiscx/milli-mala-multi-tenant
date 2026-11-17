/**
 * The archive service's Zendesk client in OAuth mode (Client Credentials
 * grant), the createZendeskClient factory, and the archive fetch step
 * end to end for an OAuth tenant.
 *
 * Each test uses its own brand_id: the token cache is module-level and
 * keyed by brand, so distinct brands keep tests independent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ZendeskClient, createZendeskClient, ZENDESK_ARCHIVE_OAUTH_SCOPE } from '../src/platform/zendesk.js'
import { fetchTicketInfo } from '../src/services/archive/pipeline/fetch.js'
import type { TenantConfig } from '../src/platform/types.js'

global.fetch = vi.fn() as unknown as typeof fetch
const fetchMock = global.fetch as ReturnType<typeof vi.fn>

const SUB = 'test-subdomain'
const TOKEN_URL = `https://${SUB}.zendesk.com/oauth/tokens`
const API = `https://${SUB}.zendesk.com/api/v2`
// Fake values only.
const CLIENT_ID = 'milli-mala-archive-test'
const CLIENT_SECRET = 'cS7xK2mN9pQ4vR6jL8cY1bT3fH5gA0eDzZ'

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

function tokenResponse(token: string, expiresIn = 1800) {
  return json({ access_token: token, token_type: 'bearer', expires_in: expiresIn, scope: ZENDESK_ARCHIVE_OAUTH_SCOPE })
}

function oauthClient(brandId: string) {
  return new ZendeskClient(SUB, { brandId, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
}

function calls(): { url: string; init: RequestInit }[] {
  return fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, init: (init ?? {}) as RequestInit }))
}

function authOf(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.Authorization
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('ZendeskClient — OAuth mode', () => {
  it('fetches a client-credentials token with the archive scope and sends it as Bearer', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(json({ ticket: { id: 1 } }))

    const client = oauthClient('oauth-1')
    expect(client.auth).toBeUndefined()
    await client.getTicket(1)

    const [tokenCall, apiCall] = calls()
    expect(tokenCall.url).toBe(TOKEN_URL)
    expect(tokenCall.init.method).toBe('POST')
    expect((tokenCall.init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(tokenCall.init.body as string)
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'tickets:read tickets:write users:read'
    })
    expect(apiCall.url).toBe(`${API}/tickets/1.json`)
    expect(authOf(apiCall.init)).toBe('Bearer tok-1')
  })

  it('reuses a cached token across clients of the same brand', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-2'))
      .mockResolvedValue(json({ ticket: { id: 1 } }))

    await oauthClient('oauth-2').getTicket(1)
    await oauthClient('oauth-2').getTicket(2)

    expect(calls().filter(c => c.url === TOKEN_URL)).toHaveLength(1)
    expect(calls().slice(1).map(c => authOf(c.init))).toEqual(['Bearer tok-2', 'Bearer tok-2'])
  })

  it('never shares a token between brands', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-3a'))
      .mockResolvedValueOnce(json({ ticket: { id: 1 } }))
      .mockResolvedValueOnce(tokenResponse('tok-3b'))
      .mockResolvedValueOnce(json({ ticket: { id: 1 } }))

    await oauthClient('oauth-3a').getTicket(1)
    await oauthClient('oauth-3b').getTicket(1)

    expect(authOf(calls()[1].init)).toBe('Bearer tok-3a')
    expect(authOf(calls()[3].init)).toBe('Bearer tok-3b')
  })

  describe('token expiry', () => {
    afterEach(() => { vi.useRealTimers() })

    it('fetches a new token once the cached one is within a minute of expiry', async () => {
      vi.useFakeTimers()
      fetchMock
        .mockResolvedValueOnce(tokenResponse('tok-4a', 300))
        .mockResolvedValueOnce(json({ ticket: { id: 1 } }))
        .mockResolvedValueOnce(json({ ticket: { id: 1 } }))
        .mockResolvedValueOnce(tokenResponse('tok-4b', 300))
        .mockResolvedValueOnce(json({ ticket: { id: 1 } }))

      const client = oauthClient('oauth-4')
      await client.getTicket(1)
      vi.advanceTimersByTime(239_000) // 300 s lifetime − 60 s buffer, not yet reached
      await client.getTicket(1)
      vi.advanceTimersByTime(2_000)
      await client.getTicket(1)

      expect(calls().map(c => c.url === TOKEN_URL ? 'token' : authOf(c.init))).toEqual([
        'token', 'Bearer tok-4a', 'Bearer tok-4a', 'token', 'Bearer tok-4b'
      ])
    })
  })

  it('retries a read once with a fresh token after a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-5a'))
      .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
      .mockResolvedValueOnce(tokenResponse('tok-5b'))
      .mockResolvedValueOnce(json({ ticket: { id: 7 } }))

    const ticket = await oauthClient('oauth-5').getTicket(7)

    expect(ticket).toEqual({ id: 7 })
    expect(calls().map(c => c.url === TOKEN_URL ? 'token' : authOf(c.init))).toEqual([
      'token', 'Bearer tok-5a', 'token', 'Bearer tok-5b'
    ])
  })

  it('caches the refreshed token after a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-6a'))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(tokenResponse('tok-6b'))
      .mockResolvedValue(json({ ticket: { id: 1 } }))

    await oauthClient('oauth-6').getTicket(1)
    await oauthClient('oauth-6').getTicket(1)

    expect(authOf(calls()[4].init)).toBe('Bearer tok-6b')
    expect(calls().filter(c => c.url === TOKEN_URL)).toHaveLength(2)
  })

  it('retries only once: a second 401 is thrown', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-7a'))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(tokenResponse('tok-7b'))
      .mockResolvedValueOnce(json({}, 401))

    await expect(oauthClient('oauth-7').getTicket(1)).rejects.toThrow('Zendesk API error: 401')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('retries a write after a 401 with the same method and body', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-8a'))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(tokenResponse('tok-8b'))
      .mockResolvedValueOnce(json({ ticket: { id: 9 } }))

    await oauthClient('oauth-8').setTicketCustomField(9, 555, 'X')

    const [, first, , retry] = calls()
    for (const c of [first, retry]) {
      expect(c.url).toBe(`${API}/tickets/9.json`)
      expect(c.init.method).toBe('PUT')
      expect(JSON.parse(c.init.body as string)).toEqual({ ticket: { custom_fields: [{ id: 555, value: 'X' }] } })
    }
    expect(authOf(retry.init)).toBe('Bearer tok-8b')
  })

  it('does not retry other errors', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-9'))
      .mockResolvedValueOnce(json({}, 403))

    await expect(oauthClient('oauth-9').getTicket(1)).rejects.toThrow('Zendesk API error: 403')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws, without calling the API, when the token request fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_client' }, 401))

    await expect(oauthClient('oauth-10').getTicket(1)).rejects.toThrow('Zendesk OAuth token request failed: 401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when the token response has no access_token', async () => {
    fetchMock.mockResolvedValueOnce(json({ token_type: 'bearer' }))

    await expect(oauthClient('oauth-11').getTicket(1)).rejects.toThrow('Zendesk OAuth token response had no access_token')
  })

  it('caches briefly when expires_in is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'tok-12' }))
      .mockResolvedValue(json({ ticket: { id: 1 } }))

    await oauthClient('oauth-12').getTicket(1)
    await oauthClient('oauth-12').getTicket(1)

    expect(calls().filter(c => c.url === TOKEN_URL)).toHaveLength(1)
  })

  it('downloads attachments with no Authorization header', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3) })

    const result = await oauthClient('oauth-13').fetchAttachments([{
      id: 1, body: '', html_body: '', public: true, author_id: 1, created_at: '',
      attachments: [{ id: 1, file_name: 'a.pdf', content_url: `https://${SUB}.zendesk.com/attachments/token/x/?name=a.pdf`, content_type: 'application/pdf', size: 3 }]
    }] as never)

    expect(result).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no token fetched either
    expect(authOf(calls()[0].init)).toBeUndefined()
  })
})

describe('ZendeskClient — Basic mode is unchanged', () => {
  it('does not retry a 401', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401))

    const client = new ZendeskClient(SUB, 'test-token', 'test@example.com')
    await expect(client.getTicket(1)).rejects.toThrow('Zendesk API error: 401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still sends Basic auth on attachment downloads', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3) })

    const client = new ZendeskClient(SUB, 'test-token', 'test@example.com')
    await client.fetchAttachments([{
      id: 1, body: '', html_body: '', public: true, author_id: 1, created_at: '',
      attachments: [{ id: 1, file_name: 'a.pdf', content_url: `https://${SUB}.zendesk.com/attachments/token/x/?name=a.pdf`, content_type: 'application/pdf', size: 3 }]
    }] as never)

    expect(authOf(calls()[0].init)).toBe(`Basic ${client.auth}`)
  })
})

function tenant(brandId: string, zendesk: Partial<TenantConfig['zendesk']>): TenantConfig {
  return {
    brand_id: brandId,
    name: 'T',
    zendesk: { subdomain: SUB, webhookSecret: 'w', ...zendesk },
    services: {}
  }
}

describe('createZendeskClient', () => {
  it('builds an OAuth client when the tenant has zendesk.oauth', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-20'))
      .mockResolvedValueOnce(json({ ticket: { id: 1 } }))

    const client = createZendeskClient(tenant('factory-1', { oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } }))
    expect(client.auth).toBeUndefined()
    await client.getTicket(1)
    expect(authOf(calls()[1].init)).toBe('Bearer tok-20')
  })

  it('builds a Basic client when the tenant has email and apiToken', () => {
    const client = createZendeskClient(tenant('factory-2', { email: 'a@b.is', apiToken: 'tkn' }))
    expect(client.auth).toBe(Buffer.from('a@b.is/token:tkn').toString('base64'))
  })

  it('throws when the tenant has neither', () => {
    expect(() => createZendeskClient(tenant('factory-3', {})))
      .toThrow('Zendesk credentials missing: need oauth, or email and apiToken')
  })
})

describe('fetchTicketInfo — OAuth tenant end to end', () => {
  it('reads the ticket, comments and authors with Bearer and downloads attachments without auth', async () => {
    const brandId = 'e2e-oauth'
    const attachmentUrl = `https://${SUB}.zendesk.com/attachments/token/abc/?name=skjal.pdf`
    fetchMock.mockImplementation(async (url: string) => {
      if (url === TOKEN_URL) return tokenResponse('tok-e2e')
      if (url === `${API}/tickets/42.json`) return json({ ticket: { id: 42, brand_id: brandId, subject: 'S' } })
      if (url === `${API}/tickets/42/comments.json`) {
        return json({ comments: [{
          id: 1, author_id: 5, body: 'b', html_body: 'b', public: true, created_at: 'x',
          attachments: [{ id: 9, file_name: 'skjal.pdf', content_url: attachmentUrl, content_type: 'application/pdf', size: 4 }]
        }] })
      }
      if (url === `${API}/users/show_many.json?ids=5`) return json({ users: [{ id: 5, name: 'Anna', email: 'anna@example.is' }] })
      if (url === attachmentUrl) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) }
      throw new Error(`unexpected ${url}`)
    })

    const result = await fetchTicketInfo(
      tenant(brandId, { oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } }),
      42
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.info.attachments).toHaveLength(1)
    expect(result.info.failedAttachments).toEqual([])
    expect(result.info.userMap).toEqual({ 5: 'Anna' })
    expect(result.info.solvingAgentEmail).toBe('anna@example.is')

    const byUrl = new Map(calls().map(c => [c.url, authOf(c.init)]))
    expect(byUrl.get(`${API}/tickets/42.json`)).toBe('Bearer tok-e2e')
    expect(byUrl.get(`${API}/tickets/42/comments.json`)).toBe('Bearer tok-e2e')
    expect(byUrl.get(`${API}/users/show_many.json?ids=5`)).toBe('Bearer tok-e2e')
    expect(byUrl.has(attachmentUrl)).toBe(true)
    expect(byUrl.get(attachmentUrl)).toBeUndefined()
    expect(calls().filter(c => c.url === TOKEN_URL)).toHaveLength(1)
  })
})
