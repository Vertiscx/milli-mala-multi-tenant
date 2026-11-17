import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkpointClient, WORKPOINT_DEFAULT_TOKEN_TTL_MS } from '../src/services/archive/workpoint.js'

global.fetch = vi.fn() as unknown as typeof fetch
const fetchMock = global.fetch as ReturnType<typeof vi.fn>

const BASE = 'https://zendesk-wp.test'
const KEY = 'test-app-key'

function ok(json: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) })
}
function fail(status: number, json: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => json, text: async () => JSON.stringify(json) })
}
const call = (i: number) => fetchMock.mock.calls[i] as [string, RequestInit & { headers: Record<string, string> }]
const body = (i: number) => JSON.parse(call(i)[1].body as string)

function authed(opts: { user?: string } = {}) {
  const c = new WorkpointClient(BASE, KEY, 'hi', opts)
  c.token = 'valid-token'
  c.tokenExpiry = Date.now() + 60_000
  return c
}

beforeEach(() => { fetchMock.mockReset() })
afterEach(() => { vi.useRealTimers() })

// ─── Authentication ───────────────────────────────────────────────────

describe('WorkpointClient.authenticate', () => {
  it('POSTs { key } to /api/login/<clientId> and stores the token', async () => {
    ok({ token: 'tok-1' })
    const c = new WorkpointClient(BASE, KEY, 'hi')
    await c.authenticate()

    expect(call(0)[0]).toBe(`${BASE}/api/login/hi`)
    expect(call(0)[1].method).toBe('POST')
    expect(body(0)).toEqual({ key: KEY })
    expect(c.token).toBe('tok-1')
  })

  it('URL-encodes the client ID', async () => {
    ok({ token: 'tok-1' })
    await new WorkpointClient(BASE, KEY, 'a/b c').authenticate()
    expect(call(0)[0]).toBe(`${BASE}/api/login/a%2Fb%20c`)
  })

  it('throws on a non-2xx login without leaking the key', async () => {
    fail(401, { error: 'Invalid key' })
    const err = await new WorkpointClient(BASE, KEY, 'hi').authenticate().catch(e => e as Error)
    expect(err.message).toBe('WorkPoint auth failed: 401')
    expect(err.message).not.toContain(KEY)
  })

  it('treats a 200 without a token as a failed login', async () => {
    ok({})
    const c = new WorkpointClient(BASE, KEY, 'hi')
    await expect(c.authenticate()).rejects.toThrow('no token')
    expect(c.token).toBeNull()
  })

  it('defaults to a 20-minute token TTL (Spektra tokens die at 25)', () => {
    expect(WORKPOINT_DEFAULT_TOKEN_TTL_MS).toBe(20 * 60 * 1000)
    expect(new WorkpointClient(BASE, KEY, 'hi').tokenTtlMs).toBe(WORKPOINT_DEFAULT_TOKEN_TTL_MS)
  })

  it('reuses the token inside the TTL and logs in again after it', async () => {
    vi.useFakeTimers()
    const c = new WorkpointClient(BASE, KEY, 'hi')
    ok({ token: 'tok-1' })
    await c.ensureAuthenticated()
    await c.ensureAuthenticated()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(WORKPOINT_DEFAULT_TOKEN_TTL_MS + 1)
    ok({ token: 'tok-2' })
    await c.ensureAuthenticated()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(c.token).toBe('tok-2')
  })
})

// ─── Upload ───────────────────────────────────────────────────────────

describe('WorkpointClient.uploadDocument', () => {
  const pdf = Buffer.from('%PDF-1.4 test')

  it('sends the PDF as JSON to /api/adddocument/<clientId>', async () => {
    ok({ message: 'Document uploaded successfully' })
    await authed({ user: 'agent@hi.is' }).uploadDocument({ caseNumber: 'WP-1', filename: 'ticket-42.pdf', pdfBuffer: pdf })

    const [url, init] = call(0)
    expect(url).toBe(`${BASE}/api/adddocument/hi`)
    expect(init.headers).toMatchObject({
      'Authorization': 'Bearer valid-token',
      'Content-Type': 'application/json'
    })
    const b = body(0)
    expect(b).toMatchObject({
      caseNumber: 'WP-1',
      user: 'agent@hi.is',
      fileName: 'ticket-42.pdf',
      base64: pdf.toString('base64')
    })
    expect(new Date(b.date).toISOString()).toBe(b.date)
    expect(Object.keys(b).sort()).toEqual(['base64', 'caseNumber', 'date', 'fileName', 'user'])
  })

  it("falls back to user 'Zendesk' when no agent is known", async () => {
    ok({})
    await authed().uploadDocument({ caseNumber: 'WP-1', filename: 'f.pdf', pdfBuffer: pdf })
    expect(body(0).user).toBe('Zendesk')
  })

  it('uploads PDF first, then one request per attachment', async () => {
    ok({}); ok({}); ok({})
    await authed().uploadDocument({
      caseNumber: 'WP-1',
      filename: 'ticket-42.pdf',
      pdfBuffer: pdf,
      attachments: [
        { filename: 'a.png', data: Buffer.from('A'), contentType: 'image/png' },
        { filename: 'b.docx', data: Buffer.from('B'), contentType: 'application/octet-stream' }
      ] as never
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect([0, 1, 2].map(i => body(i).fileName)).toEqual(['ticket-42.pdf', 'a.png', 'b.docx'])
    expect(body(2).base64).toBe(Buffer.from('B').toString('base64'))
  })

  it('throws with status and error text when the PDF upload fails', async () => {
    fail(400, { error: 'Missing required properties in body' })
    await expect(authed().uploadDocument({ caseNumber: 'WP-1', filename: 'f.pdf', pdfBuffer: pdf }))
      .rejects.toThrow('WorkPoint upload failed: 400 - {"error":"Missing required properties in body"}')
  })

  it('names the attachment when an attachment upload fails', async () => {
    ok({}); fail(500, { error: 'boom' })
    await expect(authed().uploadDocument({
      caseNumber: 'WP-1', filename: 'f.pdf', pdfBuffer: pdf,
      attachments: [{ filename: 'scan.tif', data: Buffer.from('x'), contentType: 'image/tiff' }] as never
    })).rejects.toThrow('WorkPoint attachment upload failed (scan.tif): 500')
  })

  it('logs in first when there is no token', async () => {
    ok({ token: 'tok-1' }); ok({})
    await new WorkpointClient(BASE, KEY, 'hi').uploadDocument({ caseNumber: 'WP-1', filename: 'f.pdf', pdfBuffer: pdf })
    expect(call(0)[0]).toBe(`${BASE}/api/login/hi`)
    expect(call(1)[1].headers.Authorization).toBe('Bearer tok-1')
  })
})

// ─── Create case ──────────────────────────────────────────────────────

describe('WorkpointClient.createCase', () => {
  it('POSTs the six wire fields to /api/createcase/<clientId>', async () => {
    ok({ caseNumber: 'WP-2026-001' })
    const result = await authed().createCase({
      caseTemplate: '12',
      kennitala: '010190-1234',
      clientName: 'Jón Jónsson',
      caseName: 'Umsókn um styrk',
      externalId: 'ticket_42',
      currentUser: 'agent@hi.is'
    })

    expect(call(0)[0]).toBe(`${BASE}/api/createcase/hi`)
    expect(body(0)).toEqual({
      clientIdentifier: '0101901234',
      clientName: 'Jón Jónsson',
      caseTemplate: '12',
      caseName: 'Umsókn um styrk',
      externalId: 'ticket_42',
      user: 'agent@hi.is'
    })
    expect(result).toEqual({ caseNumber: 'WP-2026-001', caseTemplate: '12' })
  })

  it('keeps Icelandic characters intact in the request body', async () => {
    ok({ caseNumber: 'WP-1' })
    await authed().createCase({ caseTemplate: '1', kennitala: '0101901234', clientName: 'Þórdís Ævarsdóttir', caseName: 'Ósk um aðstoð' })
    expect(body(0).clientName).toBe('Þórdís Ævarsdóttir')
    expect(body(0).caseName).toBe('Ósk um aðstoð')
  })

  it('fills defaults for optional fields', async () => {
    ok({ caseNumber: 'WP-1' })
    await authed().createCase({ caseTemplate: '1', kennitala: '0101901234' })
    const b = body(0)
    expect(b.clientName).toBe('')
    expect(b.user).toBe('Zendesk')
    expect(b.caseName).toMatch(/^ZendeskCase_\d+$/)
    expect(b.externalId).toMatch(/^ticket_\d+$/)
  })

  it('accepts a numeric caseNumber', async () => {
    ok({ caseNumber: 4711 })
    await expect(authed().createCase({ caseTemplate: '1', kennitala: '0101901234' }))
      .resolves.toEqual({ caseNumber: '4711', caseTemplate: '1' })
  })

  it('throws when a 200 response has no caseNumber', async () => {
    ok({ message: 'ok' })
    await expect(authed().createCase({ caseTemplate: '1', kennitala: '0101901234' }))
      .rejects.toThrow('missing case number')
  })

  it('throws on non-2xx without the token in the message', async () => {
    fail(404, { error: 'Client not found' })
    const err = await authed().createCase({ caseTemplate: '1', kennitala: '0101901234' }).catch(e => e as Error)
    expect(err.message).toBe('WorkPoint createCase failed: 404 - {"error":"Client not found"}')
    expect(err.message).not.toContain('valid-token')
  })
})
