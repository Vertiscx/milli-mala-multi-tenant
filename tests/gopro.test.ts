import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GoProClient } from '../src/services/archive/gopro.js'

// Mock fetch globally
global.fetch = vi.fn() as unknown as typeof fetch

const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>
const authOk = (token = 'gopro-test-token') => ({ ok: true, status: 200, headers: new Headers({ 'X-GoProToken': token }) })
const uploadOk = (id = 'doc-1') => ({ ok: true, status: 200, text: async () => JSON.stringify(id) })

describe('GoProClient', () => {
  let client: GoProClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new GoProClient('https://api.gopro.test', 'test-webkey', {
      tokenTtlMs: 25 * 60 * 1000
    })
  })

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      expect(client.baseUrl).toBe('https://api.gopro.test')
      expect(client.apiKey).toBe('test-webkey')
      expect(client.tokenTtlMs).toBe(25 * 60 * 1000)
      expect(client.token).toBeNull()
      expect(client.tokenExpiry).toBeNull()
    })

    it('should use defaults when no options provided', () => {
      const basic = new GoProClient('https://api.test.com', 'key')
      expect(basic.tokenTtlMs).toBe(25 * 60 * 1000)
      expect(basic.origin).toBe('Zendesk')
    })

    it('should accept a custom origin', () => {
      const custom = new GoProClient('https://api.test.com', 'key', { origin: 'Þjónustuborð' })
      expect(custom.origin).toBe('Þjónustuborð')
    })
  })

  describe('authenticate', () => {
    it('should send the WebKey in X-Api-Key and store the X-GoProToken header', async () => {
      fetchMock().mockResolvedValueOnce(authOk())

      await client.authenticate()

      expect(client.token).toBe('gopro-test-token')
      expect(client.tokenExpiry).toBeGreaterThan(Date.now())
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.gopro.test/Tickets/v1/Authenticate',
        expect.objectContaining({
          method: 'POST',
          headers: { 'X-Api-Key': 'test-webkey' }
        })
      )
    })

    it('should fall back to the token field in the body when the header is absent', async () => {
      fetchMock().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ token: 'body-token' })
      })

      await client.authenticate()
      expect(client.token).toBe('body-token')
    })

    it('should throw when the response carries no token', async () => {
      fetchMock().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => { throw new SyntaxError('not json') }
      })

      await expect(client.authenticate()).rejects.toThrow('GoPro auth failed: no token in response')
      expect(client.token).toBeNull()
    })

    it('should throw on auth failure', async () => {
      fetchMock().mockResolvedValueOnce({ ok: false, status: 401 })

      await expect(client.authenticate()).rejects.toThrow('GoPro auth failed: 401')
    })
  })

  describe('ensureAuthenticated', () => {
    it('should authenticate when no token exists', async () => {
      fetchMock().mockResolvedValueOnce(authOk('fresh-token'))

      await client.ensureAuthenticated()
      expect(client.token).toBe('fresh-token')
    })

    it('should skip auth when token is still valid', async () => {
      client.token = 'existing-token'
      client.tokenExpiry = Date.now() + 60 * 1000

      await client.ensureAuthenticated()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('should re-authenticate when token is expired', async () => {
      client.token = 'old-token'
      client.tokenExpiry = Date.now() - 1000

      fetchMock().mockResolvedValueOnce(authOk('new-token'))

      await client.ensureAuthenticated()
      expect(client.token).toBe('new-token')
    })
  })

  describe('uploadDocument', () => {
    beforeEach(() => {
      client.token = 'valid-token'
      client.tokenExpiry = Date.now() + 60 * 1000
    })

    it('should upload with Token and Gopro-Origin headers and the Swagger body (no subject)', async () => {
      fetchMock().mockResolvedValueOnce(uploadOk())

      const pdfBuffer = Buffer.from('fake pdf content')
      await client.uploadDocument({
        caseNumber: 'CASE-123',
        filename: 'ticket-456.pdf',
        pdfBuffer,
        metadata: { ticketId: 456, subject: 'Test ticket' }
      })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.gopro.test/Tickets/v1/Documents/Create',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Token': 'valid-token',
            'Gopro-Origin': 'foris'
          }
        })
      )

      const callBody = JSON.parse(fetchMock().mock.calls[0][1].body)
      expect(callBody).toEqual({
        caseNumber: 'CASE-123',
        origin: 'Zendesk',
        fileName: 'ticket-456.pdf',
        content: pdfBuffer.toString('base64')
      })
    })

    it('should never send the WebKey on upload', async () => {
      fetchMock().mockResolvedValueOnce(uploadOk())

      await client.uploadDocument({ caseNumber: 'C', filename: 'f.pdf', pdfBuffer: Buffer.from('x') })

      const headers = fetchMock().mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-Api-Key']).toBeUndefined()
      expect(JSON.stringify(fetchMock().mock.calls[0][1])).not.toContain('test-webkey')
    })

    it('should not send a subject (GoPro uses the file name as subject)', async () => {
      fetchMock().mockResolvedValueOnce(uploadOk())

      await client.uploadDocument({ caseNumber: 'C', filename: 'f.pdf', pdfBuffer: Buffer.from('x'), metadata: { subject: 'S' } })
      expect(JSON.parse(fetchMock().mock.calls[0][1].body)).not.toHaveProperty('subject')
    })

    it('should upload each file separately when attachments provided', async () => {
      fetchMock()
        .mockResolvedValueOnce(uploadOk('doc-1'))
        .mockResolvedValueOnce(uploadOk('doc-2'))
        .mockResolvedValueOnce(uploadOk('doc-3'))

      const result = await client.uploadDocument({
        caseNumber: 'CASE-1',
        filename: 'ticket.pdf',
        pdfBuffer: Buffer.from('pdf'),
        attachments: [
          { filename: 'doc.docx', data: Buffer.from('docx-data'), contentType: 'application/docx', size: 100 },
          { filename: 'img.png', data: Buffer.from('png-data'), contentType: 'image/png', size: 200 }
        ],
        metadata: {}
      })

      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(JSON.parse(fetchMock().mock.calls[0][1].body).fileName).toBe('ticket.pdf')
      expect(JSON.parse(fetchMock().mock.calls[1][1].body).fileName).toBe('doc.docx')
      expect(JSON.parse(fetchMock().mock.calls[2][1].body).fileName).toBe('img.png')
      expect(result).toEqual(['doc-1', 'doc-2', 'doc-3'])
    })

    it('should authenticate before uploading if token is missing', async () => {
      client.token = null
      client.tokenExpiry = null

      fetchMock()
        .mockResolvedValueOnce(authOk('new-token'))
        .mockResolvedValueOnce(uploadOk())

      await client.uploadDocument({
        caseNumber: 'CASE-1',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf')
      })

      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(fetchMock().mock.calls[0][0]).toBe('https://api.gopro.test/Tickets/v1/Authenticate')
      expect(fetchMock().mock.calls[1][0]).toBe('https://api.gopro.test/Tickets/v1/Documents/Create')
      expect(fetchMock().mock.calls[1][1].headers.Token).toBe('new-token')
    })

    it('should re-authenticate once and retry when the token is rejected with 401', async () => {
      fetchMock()
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
        .mockResolvedValueOnce(authOk('refreshed-token'))
        .mockResolvedValueOnce(uploadOk('doc-7'))

      const result = await client.uploadDocument({ caseNumber: 'C', filename: 'f.pdf', pdfBuffer: Buffer.from('x') })

      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(fetchMock().mock.calls[1][0]).toBe('https://api.gopro.test/Tickets/v1/Authenticate')
      expect(fetchMock().mock.calls[2][1].headers.Token).toBe('refreshed-token')
      expect(result).toBe('doc-7')
    })

    it('should fail when the retry after re-auth is still 401', async () => {
      fetchMock()
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
        .mockResolvedValueOnce(authOk('refreshed-token'))
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })

      await expect(client.uploadDocument({ caseNumber: 'C', filename: 'f.pdf', pdfBuffer: Buffer.from('x') }))
        .rejects.toThrow('GoPro upload failed: 401 - Unauthorized')
      expect(global.fetch).toHaveBeenCalledTimes(3)
    })

    it('should surface the 400 error message (e.g. unknown case number)', async () => {
      fetchMock().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"Message":"Case BAD-CASE does not exist"}'
      })

      await expect(client.uploadDocument({
        caseNumber: 'BAD-CASE',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf')
      })).rejects.toThrow('GoPro upload failed: 400 - {"Message":"Case BAD-CASE does not exist"}')
    })

    it('should throw error on failed upload', async () => {
      fetchMock().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server error'
      })

      await expect(client.uploadDocument({
        caseNumber: 'CASE-123',
        filename: 'ticket.pdf',
        pdfBuffer: Buffer.from('content')
      })).rejects.toThrow('GoPro upload failed: 500 - Server error')
    })

    it('should truncate huge upstream error bodies in thrown errors', async () => {
      fetchMock().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'x'.repeat(50_000)
      })

      const err = await client.uploadDocument({
        caseNumber: 'CASE-123',
        filename: 'ticket.pdf',
        pdfBuffer: Buffer.from('content')
      }).catch(e => e as Error)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain('GoPro upload failed: 500')
      expect(err.message.length).toBeLessThan(3000)
    })

    it('should return the document ID for a single file', async () => {
      fetchMock().mockResolvedValueOnce(uploadOk('doc-99'))

      const result = await client.uploadDocument({
        caseNumber: 'CASE-1',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf')
      })

      expect(result).toBe('doc-99')
    })

    it('should keep a non-JSON 200 body as plain text', async () => {
      fetchMock().mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'doc-plain' })

      const result = await client.uploadDocument({ caseNumber: 'C', filename: 'f.pdf', pdfBuffer: Buffer.from('x') })
      expect(result).toBe('doc-plain')
    })
  })

  describe('cases', () => {
    const jsonOk = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

    beforeEach(() => {
      client.token = 'valid-token'
      client.tokenExpiry = Date.now() + 60 * 1000
    })

    it('listTemplates: GET LookupTemplates with the Token header, no body', async () => {
      const templates = [{ id: 'tpl-1', type: 'General', category: 'Þjónusta', name: 'Almennt erindi' }]
      fetchMock().mockResolvedValueOnce(jsonOk(templates))

      expect(await client.listTemplates()).toEqual(templates)
      const [url, init] = fetchMock().mock.calls[0]
      expect(url).toBe('https://api.gopro.test/Tickets/v1/Cases/LookupTemplates')
      expect(init.method).toBe('GET')
      expect(init.headers).toEqual({ 'Token': 'valid-token', 'Gopro-Origin': 'foris' })
      expect(init.body).toBeUndefined()
    })

    it('findCaseByNumber: POST FindByCaseNumber and return the case', async () => {
      const found = { id: 'g', caseNumber: '202611-0037', name: 'Prufa', url: null }
      fetchMock().mockResolvedValueOnce(jsonOk(found))

      expect(await client.findCaseByNumber('202611-0037')).toEqual(found)
      expect(fetchMock().mock.calls[0][0]).toBe('https://api.gopro.test/Tickets/v1/Cases/FindByCaseNumber')
      expect(JSON.parse(fetchMock().mock.calls[0][1].body)).toEqual({ caseNumber: '202611-0037' })
    })

    it('findCaseByNumber: surfaces GoPro\'s not-found message', async () => {
      fetchMock().mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"message":"Case with number \'X\' not found"}' })

      await expect(client.findCaseByNumber('X')).rejects.toThrow("GoPro case lookup failed: 400 - {\"message\":\"Case with number 'X' not found\"}")
    })

    it('findCasesByKennitala: sends digits only', async () => {
      fetchMock().mockResolvedValueOnce(jsonOk([]))

      expect(await client.findCasesByKennitala('010190-2989')).toEqual([])
      expect(JSON.parse(fetchMock().mock.calls[0][1].body)).toEqual({ idNumber: '0101902989' })
    })

    it('findCasesByKennitala: refuses anything but a full 10-digit kennitala (GoPro would prefix-match)', async () => {
      await expect(client.findCasesByKennitala('0101')).rejects.toThrow('full 10-digit kennitala')
      await expect(client.findCasesByKennitala('')).rejects.toThrow('full 10-digit kennitala')
      expect(global.fetch).not.toHaveBeenCalled()
    })

    const templates = [
      { id: 'tpl-1', type: 'General', category: 'Þjónusta', name: 'Almennt erindi' },
      { id: 'tpl-2', type: 'General', category: '', name: 'Kvörtun' }
    ]

    it('createCase: names the case after its template, sends templateId and digits-only kennitala', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonOk(templates))
        .mockResolvedValueOnce(jsonOk({ id: 'g', caseNumber: '2026110012', name: 'Almennt erindi', url: 'https://x' }))

      const result = await client.createCase({ caseTemplate: 'tpl-1', kennitala: '010190 2989', caseName: 'Ticket #123 – Subject', externalId: 'ticket_123' })

      expect(result).toEqual({ caseNumber: '2026110012', caseTemplate: 'tpl-1' })
      expect(fetchMock().mock.calls[0][0]).toBe('https://api.gopro.test/Tickets/v1/Cases/LookupTemplates')
      expect(fetchMock().mock.calls[1][0]).toBe('https://api.gopro.test/Tickets/v1/Cases/Create')
      expect(JSON.parse(fetchMock().mock.calls[1][1].body)).toEqual({
        templateId: 'tpl-1',
        name: 'Almennt erindi',
        idNumber: '0101902989'
      })
    })

    it('createCase: matches the template GUID case-insensitively', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonOk([{ id: 'A0FB-1', category: '', name: 'Demo case template' }]))
        .mockResolvedValueOnce(jsonOk({ caseNumber: 'C-1' }))

      await client.createCase({ caseTemplate: 'a0fb-1', kennitala: '' })
      expect(JSON.parse(fetchMock().mock.calls[1][1].body).name).toBe('Demo case template')
    })

    it('createCase: template not in the list → falls back to the trimmed ticket subject', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonOk(templates))
        .mockResolvedValueOnce(jsonOk({ caseNumber: 'C-1' }))

      await client.createCase({ caseTemplate: 'tpl-unknown', kennitala: '', caseName: '  Ticket subject  ' })
      expect(JSON.parse(fetchMock().mock.calls[1][1].body).name).toBe('Ticket subject')
    })

    it('createCase: template lookup fails → falls back to a name from the external id, omits an empty kennitala', async () => {
      fetchMock()
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
        .mockResolvedValueOnce(jsonOk({ caseNumber: 'C-1' }))

      await client.createCase({ caseTemplate: 'tpl-1', kennitala: '', externalId: 'ticket_9' })
      expect(JSON.parse(fetchMock().mock.calls[1][1].body)).toEqual({ templateId: 'tpl-1', name: 'Zendesk ticket_9' })
    })

    it('createCase: throws when GoPro returns no case number', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonOk(templates))
        .mockResolvedValueOnce(jsonOk({ id: 'g' }))

      await expect(client.createCase({ caseTemplate: 'tpl-1', kennitala: '0101902989' }))
        .rejects.toThrow('GoPro createCase: missing case number in response')
    })

    it('createCase: surfaces a validation error naming the field', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonOk(templates))
        .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'TemplateId is required and must be a valid GUID' })

      await expect(client.createCase({ caseTemplate: 'bad', kennitala: '0101902989' }))
        .rejects.toThrow('GoPro createCase failed: 400 - TemplateId is required and must be a valid GUID')
    })

    it('case calls re-authenticate once on 401 and retry', async () => {
      fetchMock()
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' })
        .mockResolvedValueOnce(authOk('fresh-token'))
        .mockResolvedValueOnce(jsonOk([]))

      expect(await client.listTemplates()).toEqual([])
      expect(fetchMock().mock.calls[1][0]).toBe('https://api.gopro.test/Tickets/v1/Authenticate')
      expect(fetchMock().mock.calls[2][1].headers.Token).toBe('fresh-token')
    })
  })
})
