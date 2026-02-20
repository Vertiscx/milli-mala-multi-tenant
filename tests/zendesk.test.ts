import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ZendeskClient } from '../src/zendesk.js'

// Mock fetch globally
global.fetch = vi.fn() as unknown as typeof fetch

describe('ZendeskClient', () => {
  let client: ZendeskClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new ZendeskClient('test-subdomain', 'test-token', 'test@example.com')
  })

  describe('constructor', () => {
    it('should build baseUrl from subdomain', () => {
      expect(client.baseUrl).toBe('https://test-subdomain.zendesk.com/api/v2')
    })

    it('should create base64 auth string', () => {
      const expectedAuth = Buffer.from('test@example.com/token:test-token').toString('base64')
      expect(client.auth).toBe(expectedAuth)
    })
  })

  describe('getTicket', () => {
    it('should fetch ticket data successfully', async () => {
      const mockTicket = {
        id: 123,
        subject: 'Test ticket',
        description: 'Test description',
        status: 'open'
      }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: mockTicket })
      })

      const result = await client.getTicket(123)

      expect(result).toEqual(mockTicket)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test-subdomain.zendesk.com/api/v2/tickets/123.json',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': expect.stringContaining('Basic')
          })
        })
      )
    })

    it('should throw error on failed request', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      })

      await expect(client.getTicket(999)).rejects.toThrow('Zendesk API error')
    })
  })

  describe('getTicketComments', () => {
    it('should fetch all ticket comments', async () => {
      const mockComments = [
        { id: 1, body: 'First comment', public: true },
        { id: 2, body: 'Second comment', public: false }
      ]

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: mockComments })
      })

      const result = await client.getTicketComments(123)

      expect(result).toEqual(mockComments)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test-subdomain.zendesk.com/api/v2/tickets/123/comments.json',
        expect.any(Object)
      )
    })

    it('should handle empty comments', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: [] })
      })

      const result = await client.getTicketComments(123)

      expect(result).toEqual([])
    })
  })

  describe('getUsersMany', () => {
    it('should fetch multiple users by ID', async () => {
      const mockUsers = [
        { id: 1, name: 'Agent One', email: 'agent1@test.com' },
        { id: 2, name: 'Agent Two', email: 'agent2@test.com' }
      ]

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: mockUsers })
      })

      const result = await client.getUsersMany([1, 2])

      expect(result).toEqual(mockUsers)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test-subdomain.zendesk.com/api/v2/users/show_many.json?ids=1,2',
        expect.any(Object)
      )
    })

    it('should return empty array for empty input', async () => {
      const result = await client.getUsersMany([])
      expect(result).toEqual([])
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  describe('fetchAttachments', () => {
    it('should extract and download all attachments from comments', async () => {
      const mockComments = [
        {
          id: 1,
          attachments: [
            {
              id: 101,
              file_name: 'doc1.pdf',
              content_url: 'https://test-subdomain.zendesk.com/attachments/101',
              content_type: 'application/pdf',
              size: 100
            }
          ]
        },
        {
          id: 2,
          attachments: [
            {
              id: 102,
              file_name: 'image.png',
              content_url: 'https://test-subdomain.zendesk.com/attachments/102',
              content_type: 'image/png',
              size: 200
            }
          ]
        }
      ]

      // Mock attachment downloads
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(100)
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(200)
        })

      const result = await client.fetchAttachments(mockComments as any)

      expect(result).toHaveLength(2)
      expect(result[0].filename).toBe('doc1.pdf')
      expect(result[0].contentType).toBe('application/pdf')
      expect(result[0].data).toBeInstanceOf(Buffer)
      expect(result[1].filename).toBe('image.png')
    })

    it('should handle comments without attachments', async () => {
      const mockComments = [
        { id: 1, attachments: [] },
        { id: 2 } // No attachments key
      ]

      const result = await client.fetchAttachments(mockComments as any)

      expect(result).toEqual([])
    })

    it('should block SSRF via domain spoofing (evil-zendesk.com)', async () => {
      const mockComments = [
        {
          id: 1,
          attachments: [
            {
              id: 201,
              file_name: 'ssrf.pdf',
              content_url: 'https://evil-zendesk.com/steal-data',
              content_type: 'application/pdf',
              size: 100
            }
          ]
        }
      ]

      // fetch should never be called for this attachment
      const result = await client.fetchAttachments(mockComments as any)
      expect(result).toEqual([])
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('should block SSRF via non-HTTPS URLs', async () => {
      const mockComments = [
        {
          id: 1,
          attachments: [
            {
              id: 202,
              file_name: 'http.pdf',
              content_url: 'http://test-subdomain.zendesk.com/attachments/202',
              content_type: 'application/pdf',
              size: 100
            }
          ]
        }
      ]

      const result = await client.fetchAttachments(mockComments as any)
      expect(result).toEqual([])
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('should allow legitimate Zendesk subdomain URLs', async () => {
      const mockComments = [
        {
          id: 1,
          attachments: [
            {
              id: 203,
              file_name: 'legit.pdf',
              content_url: 'https://my-company.zendesk.com/attachments/203',
              content_type: 'application/pdf',
              size: 100
            }
          ]
        }
      ]

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100)
      })

      const result = await client.fetchAttachments(mockComments as any)
      expect(result).toHaveLength(1)
      expect(global.fetch).toHaveBeenCalled()
    })

    it('should allow zdassets.com URLs', async () => {
      const mockComments = [
        {
          id: 1,
          attachments: [
            {
              id: 204,
              file_name: 'asset.png',
              content_url: 'https://cdn.zdassets.com/files/asset.png',
              content_type: 'image/png',
              size: 50
            }
          ]
        }
      ]

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(50)
      })

      const result = await client.fetchAttachments(mockComments as any)
      expect(result).toHaveLength(1)
    })

    it('should skip failed attachment downloads gracefully', async () => {
      const mockComments = [
        {
          id: 1,
          attachments: [
            {
              id: 101,
              file_name: 'doc.pdf',
              content_url: 'https://test-subdomain.zendesk.com/attachments/101',
              content_type: 'application/pdf',
              size: 100
            }
          ]
        }
      ]

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404
      })

      // fetchAttachments silently skips failed downloads
      const result = await client.fetchAttachments(mockComments as any)
      expect(result).toEqual([])
    })
  })
})
