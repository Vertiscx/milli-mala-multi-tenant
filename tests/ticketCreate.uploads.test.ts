import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequest, createResponse } from 'node-mocks-http'
import {
  handleTicketUpload, handleTicketUploadHttp, MAX_UPLOAD_BYTES, UploadTooLargeError
} from '../src/services/ticketCreate/uploads.js'
import type { TenantConfig } from '../src/platform/types.js'
import type { TenantStore } from '../src/platform/tenant.js'

global.fetch = vi.fn() as unknown as typeof fetch
const fetchMock = global.fetch as ReturnType<typeof vi.fn>

const API_KEY = 'test-ticket-create-api-key-long-enough-1'
// Every byte value, so any text decoding of the body would show.
const FILE = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

function makeTenantConfig(brandId: string, overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    brand_id: brandId,
    name: 'Þjóðskrá',
    zendesk: { subdomain: 'test-subdomain' },
    services: {
      ticketCreate: {
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

function makeRequest(
  query: Record<string, string>,
  headers: Record<string, string> = { 'x-api-key': API_KEY, 'content-type': 'application/pdf' },
  file: Buffer = FILE
) {
  const readBody = vi.fn(async () => file)
  return { req: { query: new URLSearchParams(query), headers, readBody }, readBody }
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({ access_token: 'access-token-1', token_type: 'bearer', expires_in: 3600, scope: 'tickets:write', ...overrides })
  }
}

function uploadedResponse(token: string) {
  return {
    ok: true,
    status: 201,
    json: async () => ({
      upload: {
        token,
        attachment: { id: 1, file_name: 'umsókn.pdf', content_url: 'https://test-subdomain.zendesk.com/attachments/token/x' }
      }
    })
  }
}

describe('handleTicketUpload — request checks', () => {
  beforeEach(() => fetchMock.mockReset())

  it('rejects a request without brand_id', async () => {
    const { req } = makeRequest({ filename: 'umsókn.pdf' })
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('101')]))
    expect(result).toEqual({ status: 400, body: { error: 'Missing brand_id' } })
  })

  it('returns the neutral 400 for an unknown brand', async () => {
    const { req } = makeRequest({ brand_id: '999', filename: 'umsókn.pdf' })
    const result = await handleTicketUpload(req, makeStore([]))
    expect(result).toEqual({ status: 400, body: { error: 'Invalid request' } })
  })

  it('returns the neutral 400 when the tenant has no ticketCreate service', async () => {
    const { req } = makeRequest({ brand_id: '102', filename: 'umsókn.pdf' })
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('102', { services: {} })]))
    expect(result).toEqual({ status: 400, body: { error: 'Invalid request' } })
  })

  it('rejects a missing or wrong API key without reading the file', async () => {
    const store = makeStore([makeTenantConfig('103')])
    for (const headers of [{ 'content-type': 'application/pdf' }, { 'x-api-key': 'wrong-key', 'content-type': 'application/pdf' }]) {
      const { req, readBody } = makeRequest({ brand_id: '103', filename: 'umsókn.pdf' }, headers)
      const result = await handleTicketUpload(req, store)
      expect(result).toEqual({ status: 401, body: { error: 'Invalid or missing API key' } })
      expect(readBody).not.toHaveBeenCalled()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['without an extension', 'umsokn'],
    ['only an extension', '.pdf'],
    ['ending in a dot', 'umsokn.'],
    ['containing a slash', 'skjol/umsokn.pdf'],
    ['containing a backslash', 'skjol\\umsokn.pdf'],
    ['containing a control character', 'ums\nokn.pdf'],
    ['too long', `${'a'.repeat(252)}.pdf`]
  ])('rejects a filename that is %s', async (_label, filename) => {
    const query: Record<string, string> = { brand_id: '104' }
    if (filename !== undefined) query.filename = filename
    const { req, readBody } = makeRequest(query)
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('104')]))
    expect(result).toEqual({ status: 400, body: { error: 'Invalid or missing filename' } })
    expect(readBody).not.toHaveBeenCalled()
  })

  it('accepts a filename with Icelandic letters and spaces', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(uploadedResponse('tok1'))
    const { req } = makeRequest({ brand_id: '105', filename: 'Umsókn um þjónustu – æðri ö.pdf' })
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('105')]))
    expect(result.status).toBe(201)
  })

  it.each([
    ['missing', undefined],
    ['not a MIME type', 'pdf'],
    ['containing a control character', 'application/pdf\r\nX-Injected: 1']
  ])('rejects a Content-Type that is %s', async (_label, contentType) => {
    const headers: Record<string, string> = { 'x-api-key': API_KEY }
    if (contentType !== undefined) headers['content-type'] = contentType
    const { req, readBody } = makeRequest({ brand_id: '106', filename: 'umsókn.pdf' }, headers)
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('106')]))
    expect(result).toEqual({ status: 400, body: { error: 'Invalid or missing Content-Type header' } })
    expect(readBody).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', ''],
    ['containing other characters', 'abc&filename=x.pdf'],
    ['too long', 'a'.repeat(256)]
  ])('rejects a token that is %s', async (_label, token) => {
    const { req, readBody } = makeRequest({ brand_id: '107', filename: 'umsókn.pdf', token })
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('107')]))
    expect(result).toEqual({ status: 400, body: { error: 'Invalid token' } })
    expect(readBody).not.toHaveBeenCalled()
  })

  it('returns 413 without reading the file when Content-Length is over the limit', async () => {
    const { req, readBody } = makeRequest(
      { brand_id: '108', filename: 'umsókn.pdf' },
      { 'x-api-key': API_KEY, 'content-type': 'application/pdf', 'content-length': String(MAX_UPLOAD_BYTES + 1) }
    )
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('108')]))
    expect(result).toEqual({ status: 413, body: { error: 'File too large' } })
    expect(readBody).not.toHaveBeenCalled()
  })

  it('returns 413 when the body turns out to be over the limit while reading', async () => {
    const { req } = makeRequest({ brand_id: '109', filename: 'umsókn.pdf' })
    req.readBody.mockRejectedValueOnce(new UploadTooLargeError())
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('109')]))
    expect(result).toEqual({ status: 413, body: { error: 'File too large' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an empty file', async () => {
    const { req } = makeRequest({ brand_id: '110', filename: 'umsókn.pdf' }, undefined, Buffer.alloc(0))
    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('110')]))
    expect(result).toEqual({ status: 400, body: { error: 'Empty file' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('handleTicketUpload — uploading', () => {
  beforeEach(() => fetchMock.mockReset())

  it('sends the file bytes unchanged to Zendesk and returns only the token', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(uploadedResponse('6bk3gql82em5nmf'))
    const { req } = makeRequest({ brand_id: '200', filename: 'umsókn.pdf' })

    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('200')]))

    expect(result).toEqual({ status: 201, body: { success: true, token: '6bk3gql82em5nmf' } })

    const [tokenUrl] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe('https://test-subdomain.zendesk.com/oauth/tokens')

    const [uploadUrl, init] = fetchMock.mock.calls[1]
    const url = new URL(uploadUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://test-subdomain.zendesk.com/api/v2/uploads')
    expect(url.searchParams.get('filename')).toBe('umsókn.pdf')
    expect(url.searchParams.has('token')).toBe(false)
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer access-token-1', 'Content-Type': 'application/pdf' }
    })
    expect(Buffer.compare(init.body, FILE)).toBe(0)
  })

  it('passes token through so the file is added to an earlier upload', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(uploadedResponse('earlier1'))
    const { req } = makeRequest({ brand_id: '201', filename: 'mynd.png', token: 'earlier1' })

    const result = await handleTicketUpload(req, makeStore([makeTenantConfig('201')]))

    expect(result.body.token).toBe('earlier1')
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('token')).toBe('earlier1')
  })

  it('reuses the cached OAuth token on a second upload', async () => {
    const store = makeStore([makeTenantConfig('202')])
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(uploadedResponse('a1'))
    await handleTicketUpload(makeRequest({ brand_id: '202', filename: 'a.pdf' }).req, store)

    fetchMock.mockResolvedValueOnce(uploadedResponse('a2'))
    await handleTicketUpload(makeRequest({ brand_id: '202', filename: 'b.pdf' }).req, store)

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries once with a fresh token after a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse({ access_token: 'stale-token' }))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' })
      .mockResolvedValueOnce(tokenResponse({ access_token: 'fresh-token' }))
      .mockResolvedValueOnce(uploadedResponse('t2'))

    const result = await handleTicketUpload(makeRequest({ brand_id: '203', filename: 'a.pdf' }).req, makeStore([makeTenantConfig('203')]))

    expect(result).toEqual({ status: 201, body: { success: true, token: 't2' } })
    expect(fetchMock.mock.calls[3][1].headers).toMatchObject({ Authorization: 'Bearer fresh-token' })
    expect(Buffer.compare(fetchMock.mock.calls[3][1].body, FILE)).toBe(0)
  })
})

describe('handleTicketUpload — failures', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchMock.mockReset()
    logSpy = vi.spyOn(console, 'log')
  })

  afterEach(() => logSpy.mockRestore())

  it('returns 502 when the OAuth token request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'nope' })
    const result = await handleTicketUpload(makeRequest({ brand_id: '300', filename: 'a.pdf' }).req, makeStore([makeTenantConfig('300')]))
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk authentication failed' } })
  })

  it('returns 502 when the token refresh after a 401 fails', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'oauth down' })
    const result = await handleTicketUpload(makeRequest({ brand_id: '301', filename: 'a.pdf' }).req, makeStore([makeTenantConfig('301')]))
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk authentication failed' } })
  })

  it.each([
    [413, 413, 'File too large'],
    [422, 422, 'Upload rejected by Zendesk validation'],
    [400, 502, 'Zendesk upload failed'],
    [403, 502, 'Zendesk upload failed'],
    [503, 502, 'Zendesk upload failed']
  ])('maps a Zendesk %i to %i', async (zendeskStatus, status, error) => {
    const brandId = `31${zendeskStatus}`
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: false, status: zendeskStatus, text: async () => JSON.stringify({ error: 'Something' }) })
    const result = await handleTicketUpload(makeRequest({ brand_id: brandId, filename: 'a.pdf' }).req, makeStore([makeTenantConfig(brandId)]))
    expect(result).toEqual({ status, body: { error } })
  })

  it('returns 502 when Zendesk\'s success body has no token', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ upload: {} }) })
    const result = await handleTicketUpload(makeRequest({ brand_id: '302', filename: 'a.pdf' }).req, makeStore([makeTenantConfig('302')]))
    expect(result).toEqual({ status: 502, body: { error: 'Zendesk upload failed' } })
  })

  it('returns a generic 500 if the upload call itself throws', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('network blip'))
    const result = await handleTicketUpload(makeRequest({ brand_id: '303', filename: 'a.pdf' }).req, makeStore([makeTenantConfig('303')]))
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
  })

  it('never logs the filename, on success or on a Zendesk error that echoes it', async () => {
    const store = makeStore([makeTenantConfig('304')])
    const filename = 'Jón Jónsson 0101302989.pdf'
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(uploadedResponse('t'))
    await handleTicketUpload(makeRequest({ brand_id: '304', filename }).req, store)

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ error: 'RecordInvalid', details: { base: [{ description: `${filename} is invalid` }] } })
    })
    await handleTicketUpload(makeRequest({ brand_id: '304', filename }).req, store)

    const logs = logSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(logs).toContain('"zendesk_error":"RecordInvalid"')
    for (const value of ['Jón', '0101302989']) expect(logs).not.toContain(value)
  })
})

describe('handleTicketUploadHttp', () => {
  beforeEach(() => fetchMock.mockReset())

  // node-mocks-http emits the body as soon as send() is called, while a real
  // IncomingMessage holds it until a listener is attached. The handler only
  // reads the body after its checks, so send once those have run.
  const sendLater = (req: ReturnType<typeof createRequest>, body: Buffer) =>
    setTimeout(() => req.send(body), 0)

  it('reads the raw body as bytes and returns 201 with the token', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(uploadedResponse('http1'))
    const req = createRequest({
      method: 'POST',
      url: `/v1/tickets/uploads?brand_id=400&filename=${encodeURIComponent('umsókn.pdf')}`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/pdf' }
    })
    const res = createResponse()

    const promise = handleTicketUploadHttp(req, res, makeStore([makeTenantConfig('400')]))
    sendLater(req, FILE)
    await promise

    expect(res._getStatusCode()).toBe(201)
    expect(JSON.parse(res._getData())).toEqual({ success: true, token: 'http1' })
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('filename')).toBe('umsókn.pdf')
    expect(Buffer.compare(fetchMock.mock.calls[1][1].body, FILE)).toBe(0)
  })

  it('returns 500 with brand_id in the log line when something unexpected throws', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const failingStore: TenantStore = { get: async () => { throw new Error('store down') } }
    const req = createRequest({
      method: 'POST',
      url: '/v1/tickets/uploads?brand_id=402&filename=a.pdf',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/pdf' }
    })
    const res = createResponse()

    await handleTicketUploadHttp(req, res, failingStore)

    expect(res._getStatusCode()).toBe(500)
    expect(JSON.parse(res._getData())).toEqual({ error: 'Internal server error' })
    const line = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('HTTP handler error'))
    logSpy.mockRestore()
    expect(line).toContain('"brand_id":"402"')
  })

  it('returns 413 when the body is over the limit', async () => {
    const req = createRequest({
      method: 'POST',
      url: '/v1/tickets/uploads?brand_id=401&filename=a.pdf',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/pdf' }
    })
    const res = createResponse()

    const promise = handleTicketUploadHttp(req, res, makeStore([makeTenantConfig('401')]))
    sendLater(req, Buffer.alloc(MAX_UPLOAD_BYTES + 1))
    await promise

    expect(res._getStatusCode()).toBe(413)
    expect(JSON.parse(res._getData())).toEqual({ error: 'File too large' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
