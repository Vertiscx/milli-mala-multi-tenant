/**
 * WorkPoint end-to-end through the real webhook pipeline (mocked fetch only).
 *
 * Proves the duck-typed createCase seam picks up WorkpointClient with no
 * ep.type branching in the pipeline, and that the ticket requester's name
 * reaches WorkPoint as clientName.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import { handleWebhook } from '../src/services/archive/webhook.js'
import type { TenantConfig } from '../src/platform/types.js'

global.fetch = vi.fn() as unknown as typeof fetch

const WP = 'https://zendesk-wp.test'
const SECRET = 'test-webhook-secret'

function tenant(): TenantConfig {
  return {
    brand_id: '360001234567',
    name: 'Háskóli Íslands (test)',
    zendesk: { subdomain: 'test', email: 'test@example.com', apiToken: 'test-token', webhookSecret: SECRET },
    services: {
      archive: {
        endpoints: {
          workpoint: {
            type: 'workpoint',
            baseUrl: WP,
            appKey: 'test-key',
            clientId: 'hi',
            caseNumberFieldId: 7777,
            templateFieldId: 100,
            kennitalaFieldId: 200
          }
        },
        malaskra: { apiKey: 'test-malaskra-key' },
        pdf: { companyName: 'Test Company', locale: 'is-IS', includeInternalNotes: false }
      }
    }
  }
}

function request(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body)
  const ts = new Date().toISOString()
  const sig = createHmac('sha256', SECRET).update(ts + rawBody).digest('base64')
  return {
    body,
    rawBody,
    headers: { 'x-zendesk-webhook-signature': sig, 'x-zendesk-webhook-signature-timestamp': ts },
    tenantConfig: tenant(),
    docEndpoint: 'workpoint'
  }
}

const ticket = (caseNumber: string | null) => ({
  id: 123,
  subject: 'Umsókn um styrk',
  status: 'closed',
  created_at: '2026-11-01T00:00:00Z',
  brand_id: 360001234567,
  requester_id: 55,
  custom_fields: [
    { id: 7777, value: caseNumber },
    { id: 100, value: '12' },
    { id: 200, value: '010190-2989' }
  ]
})

type Call = { label: string; url: string; method: string; body?: string }

function router(t: object, opts: { usersFail?: boolean } = {}): Call[] {
  const calls: Call[] = []
  ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const record = (label: string) => calls.push({ label, url, method, ...(init?.body !== undefined ? { body: String(init.body) } : {}) })

    if (url.includes('/comments.json')) {
      record('comments')
      return { ok: true, json: async () => ({ comments: [{ id: 1, body: 'Halló', public: true, author_id: 100 }] }) }
    }
    if (url.includes('/users/show_many.json')) {
      record('users')
      if (opts.usersFail) return { ok: false, status: 500, text: async () => 'down' }
      return {
        ok: true,
        json: async () => ({
          users: [
            { id: 100, name: 'Test Agent', email: 'agent@hi.is' },
            { id: 55, name: 'Þórdís Ævarsdóttir', email: 'thordis@example.is' }
          ]
        })
      }
    }
    if (/\/tickets\/123\.json$/.test(url) && method === 'GET') {
      record('getTicket')
      return { ok: true, json: async () => ({ ticket: t }) }
    }
    if (/\/tickets\/123\.json$/.test(url) && method === 'PUT') {
      record('ticketPut')
      return { ok: true, json: async () => ({ ticket: {} }) }
    }
    if (url === `${WP}/api/login/hi`) {
      record('wpLogin')
      return { ok: true, json: async () => ({ token: 'wp-token' }) }
    }
    if (url === `${WP}/api/createcase/hi`) {
      record('wpCreate')
      return { ok: true, json: async () => ({ caseNumber: 'WP-2026-7' }) }
    }
    if (url === `${WP}/api/adddocument/hi`) {
      record('wpUpload')
      return { ok: true, json: async () => ({ message: 'Document uploaded successfully' }) }
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  })
  return calls
}

describe('WorkPoint through the webhook pipeline', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('empty case-number field → creates a WorkPoint case with the requester as clientName, then uploads', async () => {
    const calls = router(ticket(null))
    const result = await handleWebhook(request({ ticket_id: 123 }))

    expect(result.status).toBe(200)
    expect(result.body.case_number).toBe('WP-2026-7')

    const create = calls.find(c => c.label === 'wpCreate')!
    expect(JSON.parse(create.body!)).toEqual({
      clientIdentifier: '0101902989',
      clientName: 'Þórdís Ævarsdóttir',
      caseTemplate: '12',
      caseName: 'Umsókn um styrk',
      externalId: 'ticket_123',
      user: 'agent@hi.is'
    })

    const labels = calls.map(c => c.label)
    expect(labels.indexOf('wpCreate')).toBeLessThan(labels.indexOf('wpUpload'))
    const upload = JSON.parse(calls.find(c => c.label === 'wpUpload')!.body!)
    expect(upload).toMatchObject({ caseNumber: 'WP-2026-7', fileName: 'ticket-123.pdf', user: 'agent@hi.is' })
  })

  it('requester is fetched in the same users batch as comment authors (no extra Zendesk call)', async () => {
    const calls = router(ticket(null))
    await handleWebhook(request({ ticket_id: 123 }))
    const users = calls.filter(c => c.label === 'users')
    expect(users).toHaveLength(1)
    expect(decodeURIComponent(users[0].url)).toMatch(/ids=.*\b100\b.*\b55\b|ids=.*\b55\b.*\b100\b/)
  })

  it('user lookup fails → still creates the case, with an empty clientName and the Zendesk fallback user', async () => {
    const calls = router(ticket(null), { usersFail: true })
    const result = await handleWebhook(request({ ticket_id: 123 }))

    expect(result.status).toBe(200)
    const create = JSON.parse(calls.find(c => c.label === 'wpCreate')!.body!)
    expect(create.clientName).toBe('')
    expect(create.user).toBe('Zendesk')
  })

  it('populated case-number field → no create, uploads into the existing case', async () => {
    const calls = router(ticket('WP-OLD-1'))
    const result = await handleWebhook(request({ ticket_id: 123 }))

    expect(result.status).toBe(200)
    expect(calls.some(c => c.label === 'wpCreate')).toBe(false)
    expect(JSON.parse(calls.find(c => c.label === 'wpUpload')!.body!).caseNumber).toBe('WP-OLD-1')
  })
})
