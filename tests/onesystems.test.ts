import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OneSystemsClient } from '../src/onesystems.js'

// Mock fetch globally
global.fetch = vi.fn() as unknown as typeof fetch

describe('OneSystemsClient', () => {
  let client: OneSystemsClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new OneSystemsClient('https://api.onesystems.test', 'test-app-key', {
      tokenTtlMs: 25 * 60 * 1000,
      user: 'test-user@example.com'
    })
  })

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      expect(client.baseUrl).toBe('https://api.onesystems.test')
      expect(client.appKey).toBe('test-app-key')
      expect(client.user).toBe('test-user@example.com')
      expect(client.tokenTtlMs).toBe(25 * 60 * 1000)
      expect(client.token).toBeNull()
      expect(client.tokenExpiry).toBeNull()
    })

    it('should use defaults when no options provided', () => {
      const basic = new OneSystemsClient('https://api.test.com', 'key')
      expect(basic.tokenTtlMs).toBe(25 * 60 * 1000)
      expect(basic.user).toBe('')
    })
  })

  describe('authenticate', () => {
    it('should call login endpoint and store token', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ token: 'my-test-token' })
      })

      await client.authenticate()

      expect(client.token).toBe('my-test-token')
      expect(client.tokenExpiry).toBeGreaterThan(Date.now())
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.onesystems.test/api/Authenticate/login',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appKey: 'test-app-key' })
        })
      )
    })

    it('should handle string token response', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => 'raw-string-token'
      })

      await client.authenticate()
      expect(client.token).toBe('raw-string-token')
    })

    it('should handle accessToken response format', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ accessToken: 'alt-token' })
      })

      await client.authenticate()
      expect(client.token).toBe('alt-token')
    })

    it('should throw on auth failure', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401
      })

      await expect(client.authenticate()).rejects.toThrow('OneSystems auth failed: 401')
    })
  })

  describe('ensureAuthenticated', () => {
    it('should authenticate when no token exists', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ token: 'fresh-token' })
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
        text: async () => JSON.stringify({ token: 'new-token' })
      })

      await client.ensureAuthenticated()
      expect(client.token).toBe('new-token')
    })
  })

  describe('uploadDocument', () => {
    beforeEach(() => {
      // Pre-authenticate to avoid auth fetch in upload tests
      client.token = 'valid-token'
      client.tokenExpiry = Date.now() + 60 * 1000
    })

    it('should upload PDF with correct multipart form fields', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true })
      })

      await client.uploadDocument({
        caseNumber: 'CASE-123',
        filename: 'ticket-456.pdf',
        pdfBuffer: Buffer.from('fake pdf content'),
        metadata: { ticketId: 456, subject: 'Test ticket' }
      })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.onesystems.test/api/OneRecord/AddDocument2',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer valid-token',
            'Accept': '*/*'
          })
        })
      )

      // Verify multipart body contains expected field names
      const callBody = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
      expect(callBody).toContain('name="CaseNumber"')
      expect(callBody).toContain('CASE-123')
      expect(callBody).toContain('name="User"')
      expect(callBody).toContain('test-user@example.com')
      expect(callBody).toContain('name="FileName"')
      expect(callBody).toContain('ticket-456.pdf')
      expect(callBody).toContain('name="FileArray"')
      expect(callBody).toContain('name="Date"')
      expect(callBody).toContain('name="XML"')
    })

    it('should use default user "Zendesk" when user is not set', async () => {
      const noUserClient = new OneSystemsClient('https://api.test.com', 'key')
      noUserClient.token = 'valid-token'
      noUserClient.tokenExpiry = Date.now() + 60 * 1000

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true })
      })

      await noUserClient.uploadDocument({
        caseNumber: 'CASE-1',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf')
      })

      const callBody = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
      expect(callBody).toContain('Zendesk')
    })

    it('should authenticate before uploading if token is missing', async () => {
      client.token = null
      client.tokenExpiry = null

      // First call: auth; second call: upload
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ token: 'new-token' })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true })
        })

      await client.uploadDocument({
        caseNumber: 'CASE-1',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf')
      })

      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://api.onesystems.test/api/Authenticate/login')
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('https://api.onesystems.test/api/OneRecord/AddDocument2')
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
      })).rejects.toThrow('OneSystems upload failed: 500 - Server error')
    })

    it('should include XML metadata when provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true })
      })

      await client.uploadDocument({
        caseNumber: 'CASE-1',
        filename: 'test.pdf',
        pdfBuffer: Buffer.from('pdf'),
        metadata: { xml: '<data>test</data>' }
      })

      const callBody = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
      expect(callBody).toContain('&lt;data&gt;test&lt;/data&gt;')
    })
  })
})
