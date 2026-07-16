import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ZendeskClient } from '../src/platform/zendesk.js'

// Mock fetch globally
global.fetch = vi.fn() as unknown as typeof fetch

describe('ZendeskClient write seam', () => {
  let client: ZendeskClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new ZendeskClient('test-subdomain', 'test-token', 'test@example.com')
  })

  const parsedBody = () =>
    JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)

  const mockOk = () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ticket: { id: 123 } })
    })
  }

  describe('setTicketCustomField', () => {
    it('issues PUT /tickets/{id}.json with the custom_fields envelope', async () => {
      mockOk()

      await client.setTicketCustomField(123, 555, 'X')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://test-subdomain.zendesk.com/api/v2/tickets/123.json',
        expect.objectContaining({ method: 'PUT' })
      )
      expect(parsedBody()).toEqual({
        ticket: { custom_fields: [{ id: 555, value: 'X' }] }
      })
    })

    it('sends Basic auth + json content-type headers', async () => {
      mockOk()

      await client.setTicketCustomField(123, 555, 'X')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': expect.stringContaining('Basic'),
            'Content-Type': 'application/json'
          })
        })
      )
    })

    it('passes value 42 through strictly', async () => {
      mockOk()
      await client.setTicketCustomField(1, 2, 42)
      const v = parsedBody().ticket.custom_fields[0].value
      expect(v).toBe(42)
    })

    it('passes value null through strictly', async () => {
      mockOk()
      await client.setTicketCustomField(1, 2, null)
      expect(parsedBody().ticket.custom_fields[0].value).toBeNull()
    })

    it('passes value true through strictly', async () => {
      mockOk()
      await client.setTicketCustomField(1, 2, true)
      expect(parsedBody().ticket.custom_fields[0].value).toBe(true)
    })

    it('resolves to undefined (void) on success', async () => {
      mockOk()
      const r = await client.setTicketCustomField(1, 2, 'X')
      expect(r).toBeUndefined()
    })

    it('throws /Zendesk API error/ on 403', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden'
      })

      await expect(
        client.setTicketCustomField(1, 2, 'X')
      ).rejects.toThrow(/Zendesk API error/)
    })
  })

  describe('requestWrite', () => {
    it('issues the given method/body and returns parsed JSON', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: 1 })
      })

      const r = await client.requestWrite('/tickets/9.json', 'POST', { a: 1 })

      expect(r).toEqual({ ok: 1 })
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test-subdomain.zendesk.com/api/v2/tickets/9.json',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ a: 1 })
        })
      )
    })

    it('throws /Zendesk API error/ on non-ok', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error'
      })

      await expect(
        client.requestWrite('/x.json', 'PUT', {})
      ).rejects.toThrow(/Zendesk API error: 500/)
    })
  })
})
