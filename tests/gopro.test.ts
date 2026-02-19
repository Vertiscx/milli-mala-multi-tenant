import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GoProClient } from '../src/gopro.js'

// Mock fetch globally
global.fetch = vi.fn() as unknown as typeof fetch

describe('GoProClient', () => {
  let client: GoProClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new GoProClient('https://api.gopro.test', 'testuser', 'testpass', {
      tokenTtlMs: 25 * 60 * 1000
    })
  })

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      expect(client.baseUrl).toBe('https://api.gopro.test')
      expect(client.username).toBe('testuser')
      expect(client.password).toBe('testpass')
      expect(client.tokenTtlMs).toBe(25 * 60 * 1000)
      expect(client.token).toBeNull()
      expect(client.tokenExpiry).toBeNull()
    })

    it('should use defaults when no options provided', () => {
      const basic = new GoProClient('https://api.test.com', 'user', 'pass')
      expect(basic.tokenTtlMs).toBe(25 * 60 * 1000)
    })
  })

  describe('authenticate', () => {
    it('should call authenticate endpoint and store token', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => '"gopro-test-token"'
      })

      await client.authenticate()

      expect(client.token).toBe('gopro-test-token')
      expect(client.tokenExpiry).toBeGreaterThan(Date.now())
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.gopro.test/v2/Authenticate',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'testuser', password: 'testpass' })
        })
      )
    })

    it('should throw on auth failure', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401
      })

      await expect(client.authenticate()).rejects.toThrow('GoPro auth failed: 401')
    })
  })

  describe('ensureAuthenticated', () => {
    it('should authenticate when no token exists', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => '"fresh-token"'
      })

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

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => 'new-token'
      })

      await client.ensureAuthenticated()
      expect(client.token).toBe('new-token')
    })
  })

  describe('uploadDocument', () => {
    beforeEach(() => {
      client.token = 'valid-token'
      client.tokenExpiry = Date.now() + 60 * 1000
    })

    it('should upload with JSON body and Authorization header', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ succeeded: true, identifier: 'doc-1' })
      })

      const pdfBuffer = Buffer.from('fake pdf content')
      await client.uploadDocument({
        caseNumber: 'CASE-123',
        filename: 'ticket-456.pdf',
        pdfBuffer,
        metadata: { ticketId: 456, subject: 'Test ticket' }
      })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.gopro.test/v2/Documents/Create',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer valid-token'
          })
        })
      )

      const callBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
      expect(callBody.caseNumber).toBe('CASE-123')
      expect(callBody.subject).toBe('Test ticket')
      expect(callBody.fileName).toBe('ticket-456.pdf')
      expect(callBody.content).toBe(pdfBuffer.toString('base64'))
    })

    it('should upload each file separately when attachments provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ succeeded: true, identifier: 'doc-1' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ succeeded: true, identifier: 'doc-2' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ succeeded: true, identifier: 'doc-3' }) })

      await client.uploadDocument({
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
      expect(JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body).fileName).toBe('ticket.pdf')
      expect(JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body).fileName).toBe('doc.docx')
      expect(JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[2][1].body).fileName).toBe('img.png')
    })

    it('should authenticate before uploading if token is missing', async () => {
      client.token = null
      client.tokenExpiry = null

      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => 'new-token'
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ succeeded: true, identifier: 'doc-1' })
        })

      await client.uploadDocument({
        caseNumber: 'CASE-1',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf')
      })

      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://api.gopro.test/v2/Authenticate')
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('https://api.gopro.test/v2/Documents/Create')
    })

    it('should throw error on failed upload', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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

    it('should throw when succeeded is false', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ succeeded: false, message: 'Invalid case number' })
      })

      await expect(client.uploadDocument({
        caseNumber: 'BAD-CASE',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf')
      })).rejects.toThrow('GoPro upload rejected: Invalid case number')
    })

    it('should return single result for single file', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ succeeded: true, identifier: 'doc-99' })
      })

      const result = await client.uploadDocument({
        caseNumber: 'CASE-1',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf')
      }) as Record<string, unknown>

      expect(result.identifier).toBe('doc-99')
    })
  })
})
