import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequest, createResponse } from 'node-mocks-http'
import { handleUserUpdate, handleUserUpdateHttp } from '../src/services/userUpdate/handler.js'
import type { TenantConfig } from '../src/platform/types.js'
import type { TenantStore } from '../src/platform/tenant.js'

global.fetch = vi.fn() as unknown as typeof fetch
const fetchMock = global.fetch as ReturnType<typeof vi.fn>

const API_KEY = 'test-user-update-api-key-long-enough-1'
const USER_ID = 58071883686555

// A tenant without archive — userUpdate is its only service.
function makeTenantConfig(brandId: string, overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    brand_id: brandId,
    name: 'Þjóðskrá',
    zendesk: { subdomain: 'test-subdomain' },
    services: {
      userUpdate: {
        apiKey: API_KEY,
        oauth: { clientId: 'test-client-id', clientSecret: 'test-client-secret-that-is-long-enough' }
      }
    },
    ...overrides
  }
}

function makeStore(tenants: TenantConfig[]): TenantStore {
  const map = new Map(tenants.map(t => [t.brand_id, t]))
  return { get: async (brandId: string) => map.get(brandId) ?? null }
}

function makeRequest(user: Record<string, unknown>, headers: Record<string, string> = { 'x-api-key': API_KEY }) {
  return { body: { user } as Record<string, unknown>, headers }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const tokenResponse = (accessToken = 'access-token-1') =>
  json(200, { access_token: accessToken, token_type: 'bearer', expires_in: 1800, scope: 'users:read users:write' })

const endUser = (overrides: Record<string, unknown> = {}) =>
  ({ id: USER_ID, email: 'jon@example.is', role: 'end-user', name: 'Jón Jónsson', ...overrides })

const shownUser = (user = endUser()) => json(200, { user })
const searchResult = (users: unknown[]) => json(200, { users, count: users.length })
const updated = () => json(200, { user: endUser({ name: 'Jón Jónsson Jr.' }) })

function call(index: number): { url: URL; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = fetchMock.mock.calls[index]
  return { url: new URL(url), init }
}

function sentUser(index: number): Record<string, unknown> {
  return JSON.parse(call(index).init.body as string).user
}

describe('handleUserUpdate — request checks', () => {
  beforeEach(() => fetchMock.mockReset())

  it('rejects a body that is not a JSON object', async () => {
    const result = await handleUserUpdate({ body: null as unknown as Record<string, unknown>, headers: {} }, makeStore([]))
    expect(result).toEqual({ status: 400, body: { error: 'Missing user' } })
  })

  it('rejects a request with no user object', async () => {
    const result = await handleUserUpdate({ body: {}, headers: {} }, makeStore([]))
    expect(result).toEqual({ status: 400, body: { error: 'Missing user' } })
  })

  it('rejects a user without brand_id', async () => {
    const result = await handleUserUpdate(makeRequest({ id: USER_ID, name: 'x' }), makeStore([]))
    expect(result).toEqual({ status: 400, body: { error: 'Missing user.brand_id' } })
  })

  it('returns the neutral 400 for an unknown brand', async () => {
    const result = await handleUserUpdate(makeRequest({ brand_id: '999', id: USER_ID, name: 'x' }), makeStore([]))
    expect(result).toEqual({ status: 400, body: { error: 'Invalid request' } })
  })

  it('returns the neutral 400 when the tenant has no userUpdate service', async () => {
    const store = makeStore([makeTenantConfig('100', { services: {} })])
    const result = await handleUserUpdate(makeRequest({ brand_id: '100', id: USER_ID, name: 'x' }), store)
    expect(result).toEqual({ status: 400, body: { error: 'Invalid request' } })
  })

  it.each([
    ['missing', {}],
    ['wrong', { 'x-api-key': 'wrong-key' }]
  ])('rejects a %s API key without calling Zendesk', async (_label, headers) => {
    const store = makeStore([makeTenantConfig('101')])
    const result = await handleUserUpdate(makeRequest({ brand_id: '101', id: USER_ID, name: 'x' }, headers), store)
    expect(result).toEqual({ status: 401, body: { error: 'Invalid or missing API key' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['both', { id: USER_ID, email: 'jon@example.is' }],
    ['neither', {}]
  ])('requires exactly one of id or email (%s given)', async (_label, identity) => {
    const store = makeStore([makeTenantConfig('102')])
    const result = await handleUserUpdate(makeRequest({ brand_id: '102', ...identity, name: 'x' }), store)
    expect(result).toEqual({ status: 400, body: { error: 'Provide exactly one of user.id or user.email' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, 'abc', '0123', true])('rejects user.id %j', async (id) => {
    const store = makeStore([makeTenantConfig('103')])
    const result = await handleUserUpdate(makeRequest({ brand_id: '103', id, name: 'x' }), store)
    expect(result).toEqual({ status: 400, body: { error: 'Invalid user.id' } })
  })

  it.each(['not-an-email', 'two@at@signs', 'with space@example.is', `${'a'.repeat(250)}@x.is`, 42])(
    'rejects user.email %j', async (email) => {
      const store = makeStore([makeTenantConfig('104')])
      const result = await handleUserUpdate(makeRequest({ brand_id: '104', email, name: 'x' }), store)
      expect(result).toEqual({ status: 400, body: { error: 'Invalid user.email' } })
    })

  it('refuses a request whose only fields are dropped ones, without calling Zendesk', async () => {
    const store = makeStore([makeTenantConfig('105')])
    const result = await handleUserUpdate(makeRequest({ brand_id: '105', id: USER_ID, role: 'admin' }), store)
    expect(result).toEqual({ status: 400, body: { error: 'No fields to update', dropped_fields: ['role'] } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('handleUserUpdate — by id', () => {
  beforeEach(() => fetchMock.mockReset())

  it('reads the user, then updates it, and returns only the user ID', async () => {
    const store = makeStore([makeTenantConfig('200')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shownUser()).mockResolvedValueOnce(updated())

    const result = await handleUserUpdate(makeRequest({
      brand_id: '200', id: USER_ID, name: 'Jón Jónsson Jr.', phone: '+3546123456', user_fields: { svid: 'a' }
    }), store)

    expect(result).toEqual({ status: 200, body: { success: true, user_id: USER_ID, brand_id: '200', dropped_fields: [] } })

    expect(call(0).url.href).toBe('https://test-subdomain.zendesk.com/oauth/tokens')
    expect(new URLSearchParams(call(0).init.body as string).get('scope')).toBe('users:read users:write')

    expect(call(1).url.href).toBe(`https://test-subdomain.zendesk.com/api/v2/users/${USER_ID}.json`)
    expect(call(1).init.method).toBeUndefined()
    expect(call(1).init.headers).toMatchObject({ Authorization: 'Bearer access-token-1' })

    expect(call(2).url.href).toBe(`https://test-subdomain.zendesk.com/api/v2/users/${USER_ID}.json`)
    expect(call(2).init.method).toBe('PUT')
    expect(sentUser(2)).toEqual({ name: 'Jón Jónsson Jr.', phone: '+3546123456', user_fields: { svid: 'a' } })
  })

  it('accepts the ID as a digit string', async () => {
    const store = makeStore([makeTenantConfig('201')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shownUser()).mockResolvedValueOnce(updated())

    const result = await handleUserUpdate(makeRequest({ brand_id: '201', id: String(USER_ID), name: 'x' }), store)
    expect(result.status).toBe(200)
    expect(call(1).url.pathname).toBe(`/api/v2/users/${USER_ID}.json`)
  })

  it('returns 404 for an ID Zendesk does not know', async () => {
    const store = makeStore([makeTenantConfig('202')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(404, { error: 'RecordNotFound' }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '202', id: 1, name: 'x' }), store)
    expect(result).toEqual({ status: 404, body: { error: 'User not found' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['agent', 'admin'])('returns the same 404 for an %s, and never updates it', async (role) => {
    const brandId = `203${role}`
    const store = makeStore([makeTenantConfig(brandId)])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shownUser(endUser({ role })))

    const result = await handleUserUpdate(makeRequest({ brand_id: brandId, id: USER_ID, name: 'x' }), store)
    expect(result).toEqual({ status: 404, body: { error: 'User not found' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('handleUserUpdate — by email', () => {
  beforeEach(() => fetchMock.mockReset())

  it('searches by email, then updates the one exact match', async () => {
    const store = makeStore([makeTenantConfig('300')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResult([endUser()])).mockResolvedValueOnce(updated())

    const result = await handleUserUpdate(makeRequest({ brand_id: '300', email: 'jon@example.is', name: 'x' }), store)

    expect(result).toEqual({ status: 200, body: { success: true, user_id: USER_ID, brand_id: '300', dropped_fields: [] } })
    expect(call(1).url.pathname).toBe('/api/v2/users/search.json')
    expect(call(1).url.searchParams.get('query')).toBe('email:jon@example.is')
    expect(call(2).url.pathname).toBe(`/api/v2/users/${USER_ID}.json`)
    expect(sentUser(2)).toEqual({ name: 'x' })
  })

  it('matches the email regardless of letter case and ignores near-matches', async () => {
    const store = makeStore([makeTenantConfig('301')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResult([
        endUser({ id: 1, email: 'jon@example.is.other' }),
        endUser({ id: 2, email: 'stjon@example.is' }),
        endUser({ email: 'Jon@Example.IS' })
      ]))
      .mockResolvedValueOnce(updated())

    const result = await handleUserUpdate(makeRequest({ brand_id: '301', email: 'JON@example.is', name: 'x' }), store)
    expect(result.body.user_id).toBe(USER_ID)
    expect(call(2).url.pathname).toBe(`/api/v2/users/${USER_ID}.json`)
  })

  it('returns 404 when the search has no exact match', async () => {
    const store = makeStore([makeTenantConfig('302')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResult([endUser({ email: 'other@example.is' })]))

    const result = await handleUserUpdate(makeRequest({ brand_id: '302', email: 'jon@example.is', name: 'x' }), store)
    expect(result).toEqual({ status: 404, body: { error: 'User not found' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns 409 and updates nothing when the email matches more than one user', async () => {
    const store = makeStore([makeTenantConfig('303')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResult([endUser({ id: 1 }), endUser({ id: 2 })]))

    const result = await handleUserUpdate(makeRequest({ brand_id: '303', email: 'jon@example.is', name: 'x' }), store)
    expect(result).toEqual({ status: 409, body: { error: 'Email matches more than one user' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the same 404 for an email that belongs to an agent, and never updates it', async () => {
    const store = makeStore([makeTenantConfig('304')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResult([endUser({ role: 'agent' })]))

    const result = await handleUserUpdate(makeRequest({ brand_id: '304', email: 'jon@example.is', name: 'x' }), store)
    expect(result).toEqual({ status: 404, body: { error: 'User not found' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('handleUserUpdate — fields', () => {
  beforeEach(() => fetchMock.mockReset())

  it('drops every restricted field, reports them, and never sends brand_id, id or email', async () => {
    const store = makeStore([makeTenantConfig('400')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResult([endUser()])).mockResolvedValueOnce(updated())
    const restricted = {
      role: 'admin', custom_role_id: 1, organization_id: 2, organization: { name: 'x' }, suspended: true,
      verified: true, external_id: 'x', identities: [], moderator: true, ticket_restriction: 'organization',
      agent_brand_ids: [1], default_group_id: 3, only_private_comments: true, signature: 's', shared_phone_number: true
    }

    const result = await handleUserUpdate(makeRequest({
      brand_id: '400', email: 'jon@example.is', name: 'Nýtt nafn', notes: 'n', ...restricted
    }), store)

    expect(result.status).toBe(200)
    expect(result.body.dropped_fields).toEqual(Object.keys(restricted))
    expect(sentUser(2)).toEqual({ name: 'Nýtt nafn', notes: 'n' })
  })
})

describe('handleUserUpdate — tokens', () => {
  beforeEach(() => fetchMock.mockReset())

  it('reuses a cached token on a second request', async () => {
    const store = makeStore([makeTenantConfig('500')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shownUser()).mockResolvedValueOnce(updated())
    await handleUserUpdate(makeRequest({ brand_id: '500', id: USER_ID, name: 'a' }), store)

    fetchMock.mockResolvedValueOnce(shownUser()).mockResolvedValueOnce(updated())
    await handleUserUpdate(makeRequest({ brand_id: '500', id: USER_ID, name: 'b' }), store)

    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('retries the lookup once with a fresh token after a 401', async () => {
    const store = makeStore([makeTenantConfig('501')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse('stale-token'))
      .mockResolvedValueOnce(json(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(tokenResponse('fresh-token'))
      .mockResolvedValueOnce(shownUser())
      .mockResolvedValueOnce(updated())

    const result = await handleUserUpdate(makeRequest({ brand_id: '501', id: USER_ID, name: 'x' }), store)
    expect(result.status).toBe(200)
    expect(call(3).init.headers).toMatchObject({ Authorization: 'Bearer fresh-token' })
    expect(call(4).init.headers).toMatchObject({ Authorization: 'Bearer fresh-token' })
  })

  it('retries the update once with a fresh token after a 401', async () => {
    const store = makeStore([makeTenantConfig('502')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse('stale-token'))
      .mockResolvedValueOnce(shownUser())
      .mockResolvedValueOnce(json(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(tokenResponse('fresh-token'))
      .mockResolvedValueOnce(updated())

    const result = await handleUserUpdate(makeRequest({ brand_id: '502', id: USER_ID, name: 'x' }), store)
    expect(result.status).toBe(200)
    expect(call(4).init.method).toBe('PUT')
    expect(call(4).init.headers).toMatchObject({ Authorization: 'Bearer fresh-token' })
  })

  it('returns 502 when the OAuth token request fails', async () => {
    const store = makeStore([makeTenantConfig('503')])
    fetchMock.mockResolvedValueOnce(json(401, { error: 'invalid_client' }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '503', id: USER_ID, name: 'x' }), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk authentication failed' } })
  })

  it.each([
    ['lookup', [json(401, {}), json(500, { error: 'down' })]],
    ['update', [shownUser(), json(401, {}), json(500, { error: 'down' })]]
  ])('returns 502 when the token refresh after a 401 on the %s fails', async (_step, responses) => {
    const brandId = `504${_step}`
    const store = makeStore([makeTenantConfig(brandId)])
    fetchMock.mockResolvedValueOnce(tokenResponse())
    for (const r of responses) fetchMock.mockResolvedValueOnce(r)

    const result = await handleUserUpdate(makeRequest({ brand_id: brandId, id: USER_ID, name: 'x' }), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk authentication failed' } })
  })
})

describe('handleUserUpdate — Zendesk failures', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchMock.mockReset()
    logSpy = vi.spyOn(console, 'log')
  })

  afterEach(() => logSpy.mockRestore())

  const loggedLines = () => logSpy.mock.calls.map(c => String(c[0])).join('\n')

  it('returns 502 when the lookup fails', async () => {
    const store = makeStore([makeTenantConfig('600')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(500, { error: 'InternalError' }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '600', email: 'jon@example.is', name: 'x' }), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk user lookup failed' } })
  })

  it('returns 429 with Retry-After when the lookup is rate limited', async () => {
    const store = makeStore([makeTenantConfig('601')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(429, { error: 'TooManyRequests' }, { 'Retry-After': '30' }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '601', email: 'jon@example.is', name: 'x' }), store)
    expect(result).toEqual({ status: 429, body: { error: 'Too many requests' }, headers: { 'Retry-After': '30' } })
  })

  // Zendesk allows 5 updates of one user per minute; d3v answered the 6th
  // with 429 and Retry-After: 7 (2026-11-02).
  it('returns 429 with Zendesk\'s Retry-After when the user has been updated too often', async () => {
    const store = makeStore([makeTenantConfig('602')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shownUser())
      .mockResolvedValueOnce(json(429, { error: 'TooManyRequests' }, { 'Retry-After': '7' }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '602', id: USER_ID, name: 'x' }), store)
    expect(result).toEqual({ status: 429, body: { error: 'Too many updates for this user' }, headers: { 'Retry-After': '7' } })
  })

  it('does not pass on a Retry-After that is not a number of seconds', async () => {
    const store = makeStore([makeTenantConfig('603')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shownUser())
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '603', id: USER_ID, name: 'x' }), store)
    expect(result.status).toBe(429)
    expect(result.headers).toBeUndefined()
  })

  it('returns 422 when Zendesk rejects the change, logging field names but never the values', async () => {
    const store = makeStore([makeTenantConfig('604')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResult([endUser()]))
      .mockResolvedValueOnce(json(422, {
        error: 'RecordInvalid',
        details: { phone: [{ description: 'Phone: +3546123456 is invalid' }] }
      }))

    const result = await handleUserUpdate(makeRequest({
      brand_id: '604', email: 'jon@example.is', name: 'Jón Jónsson', phone: '+3546123456'
    }), store)

    expect(result).toEqual({ status: 422, body: { error: 'User rejected by Zendesk validation' } })
    const logs = loggedLines()
    expect(logs).toContain('"zendesk_error":"RecordInvalid"')
    expect(logs).toContain('"zendesk_error_fields":["phone"]')
    for (const value of ['+3546123456', 'jon@example.is', 'Jón Jónsson']) expect(logs).not.toContain(value)
  })

  it.each([400, 403, 500])('returns 502 for any other Zendesk %i on the update', async (status) => {
    const brandId = `605${status}`
    const store = makeStore([makeTenantConfig(brandId)])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shownUser()).mockResolvedValueOnce(json(status, { error: 'X' }))

    const result = await handleUserUpdate(makeRequest({ brand_id: brandId, id: USER_ID, name: 'x' }), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk user update failed' } })
  })

  it('returns 404 when a successful read by id has no usable user in its body', async () => {
    const store = makeStore([makeTenantConfig('610')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response('not json', { status: 200 }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '610', id: USER_ID, name: 'x' }), store)
    expect(result).toEqual({ status: 404, body: { error: 'User not found' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns 404 when a successful search has no users list in its body', async () => {
    const store = makeStore([makeTenantConfig('611')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(200, { count: 0 }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '611', email: 'jon@example.is', name: 'x' }), store)
    expect(result).toEqual({ status: 404, body: { error: 'User not found' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns 502 when Zendesk\'s error body is not JSON', async () => {
    const store = makeStore([makeTenantConfig('608')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shownUser())
      .mockResolvedValueOnce(new Response('<html>Service Unavailable</html>', { status: 503 }))

    const result = await handleUserUpdate(makeRequest({ brand_id: '608', id: USER_ID, name: 'x' }), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk user update failed' } })
  })

  it('returns a generic 500 if the update call itself throws after a successful lookup', async () => {
    const store = makeStore([makeTenantConfig('609')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shownUser())
      .mockRejectedValueOnce(new Error('network blip'))

    const result = await handleUserUpdate(makeRequest({ brand_id: '609', id: USER_ID, name: 'x' }), store)
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
  })

  it('returns a generic 500 if a Zendesk call itself throws', async () => {
    const store = makeStore([makeTenantConfig('606')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('network blip'))

    const result = await handleUserUpdate(makeRequest({ brand_id: '606', id: USER_ID, name: 'x' }), store)
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
  })

  it('never logs the email, name or phone on a successful update', async () => {
    const store = makeStore([makeTenantConfig('607')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResult([endUser()])).mockResolvedValueOnce(updated())

    await handleUserUpdate(makeRequest({
      brand_id: '607', email: 'jon@example.is', name: 'Jón Jónsson', phone: '+3546123456'
    }), store)
    const logs = loggedLines()
    for (const value of ['jon@example.is', 'Jón Jónsson', '+3546123456']) expect(logs).not.toContain(value)
  })
})

describe('handleUserUpdateHttp', () => {
  beforeEach(() => fetchMock.mockReset())

  function post(body: string, headers: Record<string, string> = { 'x-api-key': API_KEY }) {
    const req = createRequest({ method: 'POST', url: '/v1/users/update', headers })
    const res = createResponse()
    return { req, res, send: () => req.send(body) }
  }

  it('returns 200 for a valid request', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shownUser()).mockResolvedValueOnce(updated())
    const { req, res, send } = post(JSON.stringify({ user: { brand_id: '700', id: USER_ID, name: 'x' } }))

    const promise = handleUserUpdateHttp(req, res, makeStore([makeTenantConfig('700')]))
    send()
    await promise

    expect(res._getStatusCode()).toBe(200)
    expect(JSON.parse(res._getData())).toEqual({ success: true, user_id: USER_ID, brand_id: '700', dropped_fields: [] })
  })

  it('sends Retry-After as a response header on 429', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shownUser())
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': '7' }))
    const { req, res, send } = post(JSON.stringify({ user: { brand_id: '701', id: USER_ID, name: 'x' } }))

    const promise = handleUserUpdateHttp(req, res, makeStore([makeTenantConfig('701')]))
    send()
    await promise

    expect(res._getStatusCode()).toBe(429)
    expect(res.getHeader('Retry-After')).toBe('7')
  })

  it('returns 400 for an invalid JSON body', async () => {
    const { req, res, send } = post('not valid json{')
    const promise = handleUserUpdateHttp(req, res, makeStore([]))
    send()
    await promise

    expect(res._getStatusCode()).toBe(400)
    expect(JSON.parse(res._getData())).toEqual({ error: 'Invalid JSON body' })
  })

  it.each([
    ['JSON null', 'null', 'Missing user'],
    ['a user without brand_id', JSON.stringify({ user: { id: USER_ID, name: 'x' } }), 'Missing user.brand_id']
  ])('returns 400 for %s', async (_label, body, error) => {
    const { req, res, send } = post(body)
    const promise = handleUserUpdateHttp(req, res, makeStore([]))
    send()
    await promise

    expect(res._getStatusCode()).toBe(400)
    expect(JSON.parse(res._getData())).toEqual({ error })
  })

  it('returns 500 when the request body exceeds the size cap', async () => {
    const { req, res, send } = post('x'.repeat(1024 * 1024 + 1))
    const promise = handleUserUpdateHttp(req, res, makeStore([]))
    send()
    await promise

    expect(res._getStatusCode()).toBe(500)
    expect(JSON.parse(res._getData())).toEqual({ error: 'Internal server error' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 500 with brand_id in the log line when something unexpected throws', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const failingStore: TenantStore = { get: async () => { throw new Error('store down') } }
    const { req, res, send } = post(JSON.stringify({ user: { brand_id: '702', id: USER_ID, name: 'x' } }))

    const promise = handleUserUpdateHttp(req, res, failingStore)
    send()
    await promise

    expect(res._getStatusCode()).toBe(500)
    const line = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('HTTP handler error'))
    logSpy.mockRestore()
    expect(line).toContain('"brand_id":"702"')
  })
})
