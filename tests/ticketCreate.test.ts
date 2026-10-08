import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequest, createResponse } from 'node-mocks-http'
import { handleTicketCreate, handleTicketCreateHttp } from '../src/services/ticketCreate/handler.js'
import type { TenantConfig } from '../src/platform/types.js'
import type { TenantStore } from '../src/platform/tenant.js'

global.fetch = vi.fn() as unknown as typeof fetch
const fetchMock = global.fetch as ReturnType<typeof vi.fn>

const API_KEY = 'test-ticket-create-api-key-long-enough-1'
const ALLOWED_GROUP = 30629764322322
const ALLOWED_FORM = 30304658151442

// A tenant without archive — like Þjóðskrá, ticket creation is its only service.
function makeTenantConfig(brandId: string, overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    brand_id: brandId,
    name: 'Þjóðskrá',
    zendesk: { subdomain: 'test-subdomain' },
    services: {
      ticketCreate: {
        apiKey: API_KEY,
        oauth: { clientId: 'test-client-id', clientSecret: 'test-client-secret-that-is-long-enough' },
        allowedGroupIds: [ALLOWED_GROUP],
        allowedFormIds: [ALLOWED_FORM]
      }
    },
    ...overrides
  }
}

function makeStore(tenants: TenantConfig[]): TenantStore {
  const map = new Map(tenants.map(t => [t.brand_id, t]))
  return { get: async (brandId: string) => map.get(brandId) ?? null }
}

function makeRequest(
  ticket: Record<string, unknown>,
  headers: Record<string, string> = { 'x-api-key': API_KEY, 'idempotency-key': 'submission-1' }
) {
  return { body: { ticket } as Record<string, unknown>, headers }
}

function baseTicket(brandId: string, extra: Record<string, unknown> = {}) {
  return {
    brand_id: brandId,
    subject: 'Umsókn',
    requester: { name: 'Jón Jónsson', email: 'jon@example.is' },
    comment: { html_body: '<p>Halló</p>' },
    ...extra
  }
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({ access_token: 'access-token-1', token_type: 'bearer', expires_in: 3600, scope: 'tickets:write', ...overrides })
  }
}

function createdResponse(id: number) {
  return { ok: true, status: 201, json: async () => ({ ticket: { id } }) }
}

function sentTicket(callIndex: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body).ticket
}

describe('handleTicketCreate — request checks', () => {
  beforeEach(() => fetchMock.mockReset())

  it('rejects a body that is not a JSON object', async () => {
    const store = makeStore([makeTenantConfig('101')])
    const result = await handleTicketCreate({ body: null as unknown as Record<string, unknown>, headers: {} }, store)
    expect(result).toEqual({ status: 400, body: { error: 'Missing ticket' } })
  })

  it('rejects a request with no ticket object', async () => {
    const store = makeStore([makeTenantConfig('101')])
    const result = await handleTicketCreate({ body: {}, headers: {} }, store)
    expect(result).toEqual({ status: 400, body: { error: 'Missing ticket' } })
  })

  it('rejects a ticket without brand_id', async () => {
    const store = makeStore([makeTenantConfig('101')])
    const result = await handleTicketCreate(makeRequest({ subject: 'x' }), store)
    expect(result).toEqual({ status: 400, body: { error: 'Missing ticket.brand_id' } })
  })

  it('returns the neutral 400 for an unknown brand', async () => {
    const store = makeStore([])
    const result = await handleTicketCreate(makeRequest(baseTicket('999')), store)
    expect(result).toEqual({ status: 400, body: { error: 'Invalid request' } })
  })

  it('returns the neutral 400 when the tenant has no ticketCreate service', async () => {
    const store = makeStore([makeTenantConfig('102', { services: {} })])
    const result = await handleTicketCreate(makeRequest(baseTicket('102')), store)
    expect(result).toEqual({ status: 400, body: { error: 'Invalid request' } })
  })

  it('rejects a missing API key', async () => {
    const store = makeStore([makeTenantConfig('103')])
    const result = await handleTicketCreate(makeRequest(baseTicket('103'), { 'idempotency-key': 'k' }), store)
    expect(result).toEqual({ status: 401, body: { error: 'Invalid or missing API key' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a wrong API key', async () => {
    const store = makeStore([makeTenantConfig('104')])
    const result = await handleTicketCreate(
      makeRequest(baseTicket('104'), { 'x-api-key': 'wrong-key', 'idempotency-key': 'k' }), store
    )
    expect(result.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'k'.repeat(256)],
    ['containing a control character', 'abc\ndef']
  ])('rejects an Idempotency-Key that is %s', async (_label, key) => {
    const store = makeStore([makeTenantConfig('105')])
    const headers: Record<string, string> = { 'x-api-key': API_KEY }
    if (key !== undefined) headers['idempotency-key'] = key
    const result = await handleTicketCreate(makeRequest(baseTicket('105'), headers), store)
    expect(result).toEqual({ status: 400, body: { error: 'Invalid or missing Idempotency-Key header' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('handleTicketCreate — creating the ticket', () => {
  beforeEach(() => fetchMock.mockReset())

  it('creates the ticket with the right URL, headers and body, and returns 201 with the new ID', async () => {
    const store = makeStore([makeTenantConfig('200')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(5555))

    const result = await handleTicketCreate(
      makeRequest(baseTicket('200', { group_id: ALLOWED_GROUP, ticket_form_id: ALLOWED_FORM, priority: 'normal' })),
      store
    )

    expect(result).toEqual({
      status: 201,
      body: { success: true, ticket_id: 5555, brand_id: '200', dropped_fields: [] }
    })

    const [tokenUrl] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe('https://test-subdomain.zendesk.com/oauth/tokens')

    const [createUrl, init] = fetchMock.mock.calls[1]
    expect(createUrl).toBe('https://test-subdomain.zendesk.com/api/v2/tickets.json')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer access-token-1', 'Content-Type': 'application/json', 'Idempotency-Key': 'submission-1' }
    })
    expect(sentTicket(1)).toEqual({
      subject: 'Umsókn',
      requester: { name: 'Jón Jónsson', email: 'jon@example.is' },
      comment: { html_body: '<p>Halló</p>' },
      group_id: ALLOWED_GROUP,
      ticket_form_id: ALLOWED_FORM,
      priority: 'normal',
      brand_id: 200
    })
  })

  it('always sends the tenant\'s own brand as a number, even if brand_id arrived as a string', async () => {
    const store = makeStore([makeTenantConfig('30303665547154')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(1))

    await handleTicketCreate(makeRequest(baseTicket('30303665547154')), store)
    expect(sentTicket(1).brand_id).toBe(30303665547154)
  })

  it('accepts allowed group and form IDs given as digit strings and sends them as numbers', async () => {
    const store = makeStore([makeTenantConfig('201')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(1))

    await handleTicketCreate(
      makeRequest(baseTicket('201', { group_id: String(ALLOWED_GROUP), ticket_form_id: String(ALLOWED_FORM) })), store
    )
    expect(sentTicket(1)).toMatchObject({ group_id: ALLOWED_GROUP, ticket_form_id: ALLOWED_FORM })
  })

  it('drops a group_id that is not on the tenant\'s list but still creates the ticket', async () => {
    const store = makeStore([makeTenantConfig('202')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(2))

    const result = await handleTicketCreate(makeRequest(baseTicket('202', { group_id: 11111 })), store)
    expect(result.status).toBe(201)
    expect(result.body.dropped_fields).toEqual(['group_id'])
    expect(sentTicket(1)).not.toHaveProperty('group_id')
  })

  // Each case gets its own brand: the OAuth token cache is per brand, so a
  // shared brand would skip the token call from the second case on.
  it.each([
    ['not on the list', '2031', 22222],
    ['not an integer', '2032', 'abc'],
    ['an object', '2033', { id: ALLOWED_FORM }]
  ])('drops a ticket_form_id that is %s', async (_label, brandId, formId) => {
    const store = makeStore([makeTenantConfig(brandId)])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(3))

    const result = await handleTicketCreate(makeRequest(baseTicket(brandId, { ticket_form_id: formId })), store)
    expect(result.status).toBe(201)
    expect(result.body.dropped_fields).toEqual(['ticket_form_id'])
    expect(sentTicket(1)).not.toHaveProperty('ticket_form_id')
  })

  it('always drops assignee, requester/submitter/organization IDs and comment.author_id', async () => {
    const store = makeStore([makeTenantConfig('204')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(4))

    const result = await handleTicketCreate(makeRequest(baseTicket('204', {
      assignee_id: 1, requester_id: 2, submitter_id: 3, organization_id: 4,
      comment: { html_body: '<p>Halló</p>', author_id: 5 }
    })), store)

    expect(result.status).toBe(201)
    expect(result.body.dropped_fields).toEqual([
      'assignee_id', 'requester_id', 'submitter_id', 'organization_id', 'comment.author_id'
    ])
    const sent = sentTicket(1)
    for (const name of ['assignee_id', 'requester_id', 'submitter_id', 'organization_id']) {
      expect(sent).not.toHaveProperty(name)
    }
    expect(sent.comment).toEqual({ html_body: '<p>Halló</p>' })
  })

  it('reuses a cached token on a second request', async () => {
    const store = makeStore([makeTenantConfig('205')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(5))
    await handleTicketCreate(makeRequest(baseTicket('205')), store)

    fetchMock.mockResolvedValueOnce(createdResponse(6))
    await handleTicketCreate(makeRequest(baseTicket('205')), store)

    // token + create, then create only
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries once with a fresh token after a 401, keeping the same Idempotency-Key', async () => {
    const store = makeStore([makeTenantConfig('206')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse({ access_token: 'stale-token' }))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' })
      .mockResolvedValueOnce(tokenResponse({ access_token: 'fresh-token' }))
      .mockResolvedValueOnce(createdResponse(7))

    const result = await handleTicketCreate(makeRequest(baseTicket('206')), store)

    expect(result.status).toBe(201)
    expect(result.body.ticket_id).toBe(7)
    expect(fetchMock.mock.calls[3][1].headers).toMatchObject({
      Authorization: 'Bearer fresh-token', 'Idempotency-Key': 'submission-1'
    })
  })

  it('returns 201 with ticket_id null if Zendesk\'s success body has no ticket ID', async () => {
    const store = makeStore([makeTenantConfig('207')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => { throw new SyntaxError('not json') } })

    const result = await handleTicketCreate(makeRequest(baseTicket('207')), store)
    expect(result).toEqual({ status: 201, body: { success: true, ticket_id: null, brand_id: '207', dropped_fields: [] } })
  })
})

describe('handleTicketCreate — failures', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchMock.mockReset()
    logSpy = vi.spyOn(console, 'log')
  })

  afterEach(() => logSpy.mockRestore())

  function loggedLines(): string {
    return logSpy.mock.calls.map(c => String(c[0])).join('\n')
  }

  it('returns 502 when the OAuth token request fails', async () => {
    const store = makeStore([makeTenantConfig('300')])
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => { throw new Error('unreadable') } })

    const result = await handleTicketCreate(makeRequest(baseTicket('300')), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk authentication failed' } })
  })

  it('returns 502 when the token refresh after a 401 fails', async () => {
    const store = makeStore([makeTenantConfig('301')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'oauth down' })

    const result = await handleTicketCreate(makeRequest(baseTicket('301')), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk authentication failed' } })
  })

  it('returns 409 when Zendesk reports the Idempotency-Key was used with a different request', async () => {
    const store = makeStore([makeTenantConfig('302')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'IdempotentRequestError' }) })

    const result = await handleTicketCreate(makeRequest(baseTicket('302')), store)
    expect(result).toEqual({ status: 409, body: { error: 'Idempotency-Key already used with a different request' } })
  })

  it('returns 502 on a Zendesk validation error and logs the field names but never the submitted values', async () => {
    const store = makeStore([makeTenantConfig('303')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({
          error: 'RecordInvalid',
          details: { requester: [{ description: 'Requester: Email: jon@example.is is not properly formatted' }] }
        })
      })

    const result = await handleTicketCreate(makeRequest(baseTicket('303')), store)

    expect(result).toEqual({ status: 502, body: { error: 'Zendesk ticket creation failed' } })
    const logs = loggedLines()
    expect(logs).toContain('"zendesk_error":"RecordInvalid"')
    expect(logs).toContain('"zendesk_error_fields":["requester"]')
    expect(logs).not.toContain('jon@example.is')
    expect(logs).not.toContain('Jón Jónsson')
  })

  it('returns 502 for a non-JSON Zendesk error body', async () => {
    const store = makeStore([makeTenantConfig('304')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => '<html>Service Unavailable</html>' })

    const result = await handleTicketCreate(makeRequest(baseTicket('304')), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk ticket creation failed' } })
  })

  it('returns 502 when Zendesk\'s error is not a plain code and has no details', async () => {
    const store = makeStore([makeTenantConfig('305')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => JSON.stringify({ error: { title: 'Forbidden' } }) })

    const result = await handleTicketCreate(makeRequest(baseTicket('305')), store)
    expect(result.status).toBe(502)
  })

  it('returns 502 even if reading the error body itself fails', async () => {
    const store = makeStore([makeTenantConfig('306')])
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => { throw new Error('stream consumed') } })

    const result = await handleTicketCreate(makeRequest(baseTicket('306')), store)
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk ticket creation failed' } })
  })

  it('returns a generic 500 if the create call itself throws', async () => {
    const store = makeStore([makeTenantConfig('307')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('network blip'))

    const result = await handleTicketCreate(makeRequest(baseTicket('307')), store)
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
  })

  it('never logs the subject, message body or requester on a successful create', async () => {
    const store = makeStore([makeTenantConfig('308')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(8))

    await handleTicketCreate(makeRequest(baseTicket('308')), store)
    const logs = loggedLines()
    for (const value of ['Umsókn', 'Halló', 'Jón Jónsson', 'jon@example.is']) {
      expect(logs).not.toContain(value)
    }
  })
})

describe('handleTicketCreateHttp', () => {
  beforeEach(() => fetchMock.mockReset())

  it('returns 201 for a valid request', async () => {
    const store = makeStore([makeTenantConfig('400')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(createdResponse(9))

    const req = createRequest({
      method: 'POST', url: '/v1/tickets/create',
      headers: { 'x-api-key': API_KEY, 'idempotency-key': 'submission-9' }
    })
    const res = createResponse()

    const promise = handleTicketCreateHttp(req, res, store)
    req.send(JSON.stringify({ ticket: baseTicket('400') }))
    await promise

    expect(res._getStatusCode()).toBe(201)
    expect(JSON.parse(res._getData())).toEqual({ success: true, ticket_id: 9, brand_id: '400', dropped_fields: [] })
  })

  it('returns 400 for an invalid JSON body', async () => {
    const req = createRequest({ method: 'POST', url: '/v1/tickets/create', headers: {} })
    const res = createResponse()

    const promise = handleTicketCreateHttp(req, res, makeStore([]))
    req.send('not valid json{')
    await promise

    expect(res._getStatusCode()).toBe(400)
    expect(JSON.parse(res._getData())).toEqual({ error: 'Invalid JSON body' })
  })

  it('returns 500 when the request body exceeds the size cap', async () => {
    const req = createRequest({ method: 'POST', url: '/v1/tickets/create', headers: {} })
    const res = createResponse()

    const promise = handleTicketCreateHttp(req, res, makeStore([]))
    req.send('x'.repeat(1024 * 1024 + 1))
    await promise

    expect(res._getStatusCode()).toBe(500)
    expect(JSON.parse(res._getData())).toEqual({ error: 'Internal server error' })
  })
})
