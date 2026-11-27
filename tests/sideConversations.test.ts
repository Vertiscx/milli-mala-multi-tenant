/**
 * Side conversations in the archive PDF (pdf.includeSideConversations):
 * the Zendesk client's list calls and pagination, the OAuth scope that is
 * requested only for tenants that opt in, the fetch step, the PDF
 * section, and tenant validation.
 *
 * Each OAuth test uses its own brand_id: the token cache is module-level
 * and keyed by brand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ZendeskClient,
  createZendeskClient,
  ZENDESK_ARCHIVE_OAUTH_SCOPE,
  ZENDESK_SIDE_CONVERSATIONS_SCOPE
} from '../src/platform/zendesk.js'
import { fetchTicketInfo } from '../src/services/archive/pipeline/fetch.js'
import { generateTicketPdf } from '../src/services/archive/pdf.js'
import { validateTenantConfig } from '../src/platform/tenant.js'
import type { TenantConfig, PdfConfig, SideConversationThread } from '../src/platform/types.js'

global.fetch = vi.fn() as unknown as typeof fetch
const fetchMock = global.fetch as ReturnType<typeof vi.fn>

const SUB = 'test-subdomain'
const API = `https://${SUB}.zendesk.com/api/v2`
const TOKEN_URL = `https://${SUB}.zendesk.com/oauth/tokens`
// Fake values only.
const CLIENT_ID = 'milli-mala-archive-test'
const CLIENT_SECRET = 'cS7xK2mN9pQ4vR6jL8cY1bT3fH5gA0eDzZ'

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

function urls(): string[] {
  return fetchMock.mock.calls.map(([url]) => url as string)
}

function tenant(brandId: string, includeSideConversations: boolean, oauth = false): TenantConfig {
  return {
    brand_id: brandId,
    name: 'Prófunarstofnun',
    zendesk: oauth
      ? { subdomain: SUB, webhookSecret: 'w', oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } }
      : { subdomain: SUB, webhookSecret: 'w', email: 'a@b.is', apiToken: 'tkn' },
    services: {
      archive: {
        endpoints: { onesystems: { type: 'onesystems', baseUrl: 'https://api.onesystems.test', appKey: 'k' } },
        malaskra: { apiKey: 'm' },
        pdf: { companyName: 'Prófunarstofnun', locale: 'is-IS', includeInternalNotes: false, includeSideConversations }
      }
    }
  }
}

const SIDE_CONVERSATION = {
  id: '8566255a-0e1e-11ee-9b5e-ef3c4f4e3f1a',
  subject: 'Fyrirspurn til fjarmala',
  state: 'closed',
  created_at: '2025-06-15T10:30:00Z',
  participants: [
    { user_id: 5, name: 'Anna', email: 'anna@example.is' },
    { user_id: null, name: null, email: 'fjarmal@example.is' }
  ]
}

const EVENTS = [
  {
    id: 'e1', type: 'create', created_at: '2025-06-15T10:30:00Z',
    actor: { user_id: 5, name: 'Anna', email: 'anna@example.is' },
    message: {
      subject: 'Fyrirspurn til fjarmala',
      body: 'Getid thid stadfest greidsluna?',
      html_body: '<p>Getid thid stadfest greidsluna?</p>',
      from: { user_id: 5, name: 'Anna', email: 'anna@example.is' },
      to: [{ user_id: null, name: null, email: 'fjarmal@example.is' }]
    }
  },
  {
    id: 'e2', type: 'reply', created_at: '2025-06-15T11:00:00Z',
    actor: { user_id: null, name: null, email: 'fjarmal@example.is' },
    message: {
      body: 'Greidslan er stadfest.',
      html_body: '<p>Greidslan er stadfest.</p>',
      from: { user_id: null, name: null, email: 'fjarmal@example.is' },
      to: [{ user_id: 5, name: 'Anna', email: 'anna@example.is' }]
    }
  },
  { id: 'e3', type: 'update', created_at: '2025-06-15T11:05:00Z', actor: { user_id: 5, name: 'Anna', email: 'anna@example.is' } }
]

beforeEach(() => {
  fetchMock.mockReset()
})

describe('ZendeskClient — side conversations', () => {
  const client = () => new ZendeskClient(SUB, 'test-token', 'test@example.com')

  it('lists a ticket\'s side conversations and follows next_page on the same API', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ side_conversations: [{ id: 'a' }], next_page: `${API}/tickets/7/side_conversations?page=2` }))
      .mockResolvedValueOnce(json({ side_conversations: [{ id: 'b' }], next_page: null }))

    const result = await client().getSideConversations(7)

    expect(result.map(s => s.id)).toEqual(['a', 'b'])
    expect(urls()).toEqual([
      `${API}/tickets/7/side_conversations`,
      `${API}/tickets/7/side_conversations?page=2`
    ])
  })

  it('lists one side conversation\'s events', async () => {
    fetchMock.mockResolvedValueOnce(json({ events: EVENTS, next_page: null }))
    const result = await client().getSideConversationEvents(7, SIDE_CONVERSATION.id)
    expect(result).toHaveLength(3)
    expect(urls()).toEqual([`${API}/tickets/7/side_conversations/${SIDE_CONVERSATION.id}/events`])
  })

  it('refuses a next_page outside the API base instead of following it or truncating', async () => {
    fetchMock.mockResolvedValueOnce(json({ side_conversations: [{ id: 'a' }], next_page: 'https://evil.example.com/api/v2/x' }))
    await expect(client().getSideConversations(7)).rejects.toThrow('next_page points outside the API base URL')
    expect(urls()).toHaveLength(1)
  })

  it('stops a next_page loop at the page limit', async () => {
    fetchMock.mockImplementation(async () => json({ side_conversations: [], next_page: `${API}/tickets/7/side_conversations?page=2` }))
    await expect(client().getSideConversations(7)).rejects.toThrow('pagination exceeded')
  })

  it('throws on a Zendesk error (e.g. no Collaboration add-on)', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
    await expect(client().getSideConversations(7)).rejects.toThrow('Zendesk API error: 403')
  })
})

describe('createZendeskClient — OAuth scope', () => {
  async function requestedScope(t: TenantConfig): Promise<string | null> {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'tok', expires_in: 1800 }))
      .mockResolvedValueOnce(json({ ticket: { id: 1 } }))
    await createZendeskClient(t).getTicket(1)
    const [tokenUrl, init] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe(TOKEN_URL)
    return new URLSearchParams((init as RequestInit).body as string).get('scope')
  }

  it('adds side_conversations:read only for a tenant that includes side conversations', async () => {
    expect(await requestedScope(tenant('scope-on', true, true)))
      .toBe(`${ZENDESK_ARCHIVE_OAUTH_SCOPE} ${ZENDESK_SIDE_CONVERSATIONS_SCOPE}`)
  })

  it('keeps the archive scope unchanged for a tenant that does not', async () => {
    expect(await requestedScope(tenant('scope-off', false, true))).toBe(ZENDESK_ARCHIVE_OAUTH_SCOPE)
  })
})

describe('fetchTicketInfo — side conversations', () => {
  function mockZendesk(brandId: string, sideConversationsResponse = json({ side_conversations: [SIDE_CONVERSATION], next_page: null })) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${API}/tickets/42.json`) return json({ ticket: { id: 42, brand_id: brandId, subject: 'S', status: 'solved', created_at: 'x' } })
      if (url === `${API}/tickets/42/comments.json`) return json({ comments: [{ id: 1, author_id: 5, body: 'b', public: true, created_at: 'x' }] })
      if (url === `${API}/users/show_many.json?ids=5`) return json({ users: [{ id: 5, name: 'Anna', email: 'anna@example.is' }] })
      if (url === `${API}/tickets/42/side_conversations`) return sideConversationsResponse
      if (url === `${API}/tickets/42/side_conversations/${SIDE_CONVERSATION.id}/events`) return json({ events: EVENTS, next_page: null })
      throw new Error(`unexpected ${url}`)
    })
  }

  it('fetches side conversations and their events when the tenant opts in', async () => {
    mockZendesk('111')
    const result = await fetchTicketInfo(tenant('111', true), 42)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.info.sideConversations).toHaveLength(1)
    expect(result.info.sideConversations[0].sideConversation.id).toBe(SIDE_CONVERSATION.id)
    expect(result.info.sideConversations[0].events).toHaveLength(3)
  })

  it('never calls the side conversations API when the tenant has it off', async () => {
    mockZendesk('222')
    const result = await fetchTicketInfo(tenant('222', false), 42)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.info.sideConversations).toEqual([])
    expect(urls().some(u => u.includes('side_conversations'))).toBe(false)
  })

  it('fails the fetch (no silent omission) when an opted-in tenant cannot read side conversations', async () => {
    mockZendesk('333', json({ error: 'Forbidden' }, 403))
    await expect(fetchTicketInfo(tenant('333', true), 42)).rejects.toThrow('Zendesk API error: 403')
  })
})

describe('generateTicketPdf — side conversations', () => {
  const ticket = { id: 42, subject: 'Test', status: 'solved', created_at: '2025-06-15T10:00:00Z' }
  const comments = [{ id: 1, body: 'Public comment', public: true, author_id: 1, created_at: '2025-06-15T10:00:00Z' }]
  const threads = [{ sideConversation: SIDE_CONVERSATION, events: EVENTS }] as SideConversationThread[]
  const pdfConfig = (includeSideConversations: boolean): PdfConfig =>
    ({ companyName: 'Test Company', locale: 'is-IS', includeInternalNotes: false, includeSideConversations })

  // jsPDF writes uncompressed content streams, so ASCII text is searchable.
  const text = (b: Buffer) => b.toString('latin1')

  it('renders the side conversation subject, participants and messages when on', async () => {
    const pdf = text(await generateTicketPdf(ticket, comments as any, { pdfConfig: pdfConfig(true), sideConversations: threads }))
    expect(pdf).toContain('Fyrirspurn til fjarmala')
    expect(pdf).toContain('fjarmal@example.is')
    // Message bodies are drawn word by word, so look for single words.
    expect(pdf).toContain('greidsluna?')
    expect(pdf).toContain('Greidslan')
  })

  it('leaves them out when off, even if they were passed', async () => {
    const pdf = text(await generateTicketPdf(ticket, comments as any, { pdfConfig: pdfConfig(false), sideConversations: threads }))
    expect(pdf).not.toContain('Fyrirspurn til fjarmala')
    expect(pdf).not.toContain('Greidslan')
  })

  it('adds no section when on but the ticket has no side conversations', async () => {
    const withNone = await generateTicketPdf(ticket, comments as any, { pdfConfig: pdfConfig(true), sideConversations: [] })
    const off = await generateTicketPdf(ticket, comments as any, { pdfConfig: pdfConfig(false) })
    expect(withNone.length).toBe(off.length)
  })

  it('renders messages oldest first regardless of API order', async () => {
    const reversed = [{ sideConversation: SIDE_CONVERSATION, events: [...EVENTS].reverse() }] as SideConversationThread[]
    const pdf = text(await generateTicketPdf(ticket, comments as any, { pdfConfig: pdfConfig(true), sideConversations: reversed }))
    expect(pdf.indexOf('greidsluna?')).toBeGreaterThan(-1)
    expect(pdf.indexOf('greidsluna?')).toBeLessThan(pdf.indexOf('Greidslan'))
  })
})

describe('validateTenantConfig — pdf.includeSideConversations', () => {
  // Same shape as tenant(), with fake secrets that pass the strength rules.
  function validTenant(brandId: string, includeSideConversations: boolean): TenantConfig {
    const t = tenant(brandId, includeSideConversations)
    t.zendesk = { subdomain: 'test', email: 'test@example.com', apiToken: 'aaT5kX9mR2vL7nQ8pW3jY6cB4fH1gD0e', webhookSecret: 'wS7xK2mN9pQ4vR6jL8cY1bT3fH5gA0eD' }
    t.services.archive!.endpoints.onesystems.appKey = 'oK3xR7mT9nQ2vL5jW8pY6cB4fH1gA0eS'
    t.services.archive!.malaskra.apiKey = 'mK7xR3nT9pQ2vL5jW8cY6bA4fH1gS0eD'
    return t
  }

  it('accepts true, false, and absent (absent means off)', () => {
    expect(() => validateTenantConfig(validTenant('v1', true))).not.toThrow()
    expect(() => validateTenantConfig(validTenant('v2', false))).not.toThrow()
    const absent = validTenant('v3', false)
    delete (absent.services.archive!.pdf as Partial<PdfConfig>).includeSideConversations
    expect(() => validateTenantConfig(absent)).not.toThrow()
  })

  it('refuses a non-boolean such as the string "false"', () => {
    const t = validTenant('v4', false)
    ;(t.services.archive!.pdf as unknown as Record<string, unknown>).includeSideConversations = 'false'
    expect(() => validateTenantConfig(t)).toThrow('pdf.includeSideConversations (must be true or false)')
  })
})
