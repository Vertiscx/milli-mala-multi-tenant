/**
 * PR-G1 risk-hardening tests for the extracted documentTicket pipeline.
 *
 * These lock RESEARCH.md Top risks red-on-regression:
 *  - #1 best-effort inner try/catch (audit failure -> 200, author failure -> 200)
 *  - #2 invalid case_number early-exit must be exact 400 (NOT a 500 throw)
 *  - #4 duration_ms parity (success body == persisted auditEntry)
 *
 * Every request uses the EXACT canonical signed-request construction from
 * tests/webhook.test.ts (real HMAC, fresh timestamp) so the HMAC + freshness
 * gate is genuinely PASSED — a request stuck at 401 would pass these tests
 * for the wrong reason, which is explicitly prohibited. Each test asserts
 * its expected non-gate status as a precondition before any best-effort
 * or contract assertion.
 *
 * This is a NEW file. tests/webhook.test.ts and all existing tests are
 * left byte-unchanged (the behavior-preserving proof).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import { handleWebhook } from '../src/webhook.js'
import type { TenantConfig, AuditStore } from '../src/types.js'

// Mock fetch globally (mirrors tests/webhook.test.ts)
global.fetch = vi.fn() as unknown as typeof fetch

function makeSignature(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('base64')
}

function makeTenantConfig(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    brand_id: '360001234567',
    name: 'Test Tenant',
    zendesk: {
      subdomain: 'test',
      email: 'test@example.com',
      apiToken: 'test-token',
      webhookSecret: 'test-webhook-secret'
    },
    endpoints: {
      onesystems: {
        type: 'onesystems',
        baseUrl: 'https://api.onesystems.test',
        appKey: 'test-key'
      }
    },
    malaskra: { apiKey: 'test-malaskra-key' },
    pdf: {
      companyName: 'Test Company',
      locale: 'is-IS',
      includeInternalNotes: false
    },
    ...overrides
  }
}

function makeRequest(
  body: Record<string, unknown>,
  {
    timestamp,
    tenantConfig = makeTenantConfig(),
    docEndpoint = 'onesystems',
    auditStore
  }: {
    timestamp?: string
    tenantConfig?: TenantConfig
    docEndpoint?: string
    auditStore?: AuditStore
  } = {}
) {
  const rawBody = JSON.stringify(body)
  const ts = timestamp || new Date().toISOString()
  const sig = makeSignature(rawBody, ts, 'test-webhook-secret')
  return {
    body,
    rawBody,
    headers: {
      'x-zendesk-webhook-signature': sig,
      'x-zendesk-webhook-signature-timestamp': ts
    },
    tenantConfig,
    docEndpoint,
    ...(auditStore ? { auditStore } : {})
  }
}

const baseTicket = {
  id: 123,
  subject: 'Test ticket',
  status: 'closed',
  created_at: '2025-01-01T00:00:00Z',
  brand_id: 360001234567
}

/** Mirror the fetch mock sequence from webhook.test.ts end-to-end test. */
function mockHappyFetchSequence(opts: { ticket?: object; usersReject?: boolean } = {}) {
  const ticket = opts.ticket ?? baseTicket
  const f = global.fetch as ReturnType<typeof vi.fn>
  f
    // getTicket
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket }) })
    // getTicketComments
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ comments: [{ id: 1, body: 'Hello', public: true, author_id: 100 }] })
    })
  if (opts.usersReject) {
    // getUsersMany rejects (author resolution failure)
    f.mockRejectedValueOnce(new Error('users endpoint down'))
  } else {
    // getUsersMany
    f.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ users: [{ id: 100, name: 'Test Agent', email: 'agent@test.com' }] })
    })
  }
  f
    // OneSystems auth
    .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os-token' }) })
    // OneSystems upload
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
}

describe('documentTicket extraction — risk hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('audit persistence failure still returns 200 (best-effort, not a 500)', async () => {
    mockHappyFetchSequence()
    const auditStore: AuditStore = {
      put: vi.fn().mockRejectedValue(new Error('KV unavailable')),
      get: vi.fn(),
      list: vi.fn()
    }
    const req = makeRequest({ ticket_id: 123 }, { auditStore })
    const result = await handleWebhook(req)

    // Precondition: gate passed, reached the expected non-gate status
    expect(result.status).toBe(200)
    expect(result.status).not.toBe(401)
    expect(result.body.error).toBeUndefined()

    // Best-effort: audit failure swallowed, request still succeeds
    expect(result.body.success).toBe(true)
    expect(auditStore.put).toHaveBeenCalled()
  })

  it('author resolution failure still proceeds with 200 and Zendesk fallback', async () => {
    mockHappyFetchSequence({ usersReject: true })
    const req = makeRequest({ ticket_id: 123 })
    const result = await handleWebhook(req)

    // Precondition: gate passed, reached the expected non-gate status
    expect(result.status).toBe(200)
    expect(result.status).not.toBe(401)
    expect(result.body.error).toBeUndefined()

    // Best-effort: getUsersMany rejection did not become a 500
    expect(result.body.success).toBe(true)
  })

  it('invalid case_number returns exact 400 (NOT a 500 throw)', async () => {
    const tenantConfig = makeTenantConfig({
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: 'https://api.onesystems.test',
          appKey: 'test-key',
          caseNumberFieldId: 7777
        }
      }
    })
    const badTicket = {
      ...baseTicket,
      custom_fields: [{ id: 7777, value: 'BAD..NUM' }]
    }
    const f = global.fetch as ReturnType<typeof vi.fn>
    f
      // getTicket
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: badTicket }) })
      // getTicketComments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: [{ id: 1, body: 'Hello', public: true, author_id: 100 }] })
      })
      // getUsersMany
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: [{ id: 100, name: 'Test Agent', email: 'agent@test.com' }] })
      })

    const req = makeRequest({ ticket_id: 123 }, { tenantConfig })
    const result = await handleWebhook(req)

    // Precondition: must be the 400 early-exit, NOT a 500 (locks RESEARCH risk #2)
    expect(result.status).toBe(400)
    // Exact contract shape #7 string equality
    expect(result.body.error).toBe('case_number contains invalid characters')
  })

  it('misconfigured endpoint throws (500) BEFORE invalid case_number 400 — precedence preserved', async () => {
    // Resolved endpoint is misconfigured (OneSystems with NO appKey) AND the
    // ticket carries an invalid custom-field case_number. Original handleWebhook
    // builds the doc client (throws -> outer catch -> 500) before
    // validateCaseNumber's 400. The fix restores that precedence.
    const tenantConfig = makeTenantConfig({
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: 'https://api.onesystems.test',
          caseNumberFieldId: 7777
          // appKey intentionally omitted -> createDocClient throws synchronously
        }
      }
    })
    const badTicket = {
      ...baseTicket,
      custom_fields: [{ id: 7777, value: 'BAD..NUM' }]
    }
    const f = global.fetch as ReturnType<typeof vi.fn>
    f
      // getTicket
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: badTicket }) })
      // getTicketComments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: [{ id: 1, body: 'Hello', public: true, author_id: 100 }] })
      })
      // getUsersMany
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: [{ id: 100, name: 'Test Agent', email: 'agent@test.com' }] })
      })

    const req = makeRequest({ ticket_id: 123 }, { tenantConfig })
    const result = await handleWebhook(req)

    // createDocClient throws -> 500, NOT the invalid-case_number 400
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
  })

  it('duration_ms parity: success body equals persisted auditEntry duration_ms', async () => {
    mockHappyFetchSequence()
    const captured: string[] = []
    const auditStore: AuditStore = {
      put: vi.fn(async (_key: string, value: string) => {
        captured.push(value)
      }),
      get: vi.fn(),
      list: vi.fn()
    }
    const req = makeRequest({ ticket_id: 123 }, { auditStore })
    const result = await handleWebhook(req)

    // Precondition: gate passed, reached the expected non-gate status
    expect(result.status).toBe(200)
    expect(result.status).not.toBe(401)
    expect(result.body.error).toBeUndefined()

    // duration_ms is a finite number >= 0
    const bodyDuration = result.body.duration_ms as number
    expect(typeof bodyDuration).toBe('number')
    expect(Number.isFinite(bodyDuration)).toBe(true)
    expect(bodyDuration).toBeGreaterThanOrEqual(0)

    // Persisted auditEntry duration_ms == success body duration_ms (single value)
    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0])
    expect(persisted.duration_ms).toBe(bodyDuration)
  })

  // ─── G4 gap: webhook FAILURE-path GW-01 post-back ────────────────────
  it('webhook failure path: upload throws → unchanged 500 AND GW-01 ❌ post-back fired', async () => {
    // Endpoint with field IDs so the failure post-back writes last_status.
    const tenantConfig = makeTenantConfig({
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: 'https://api.onesystems.test',
          appKey: 'test-key',
          lastStatusFieldId: 33
        }
      }
    })
    const f = global.fetch as ReturnType<typeof vi.fn>
    f
      // getTicket
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: baseTicket }) })
      // getTicketComments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: [{ id: 1, body: 'Hi', public: true, author_id: 100 }] })
      })
      // getUsersMany
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: [{ id: 100, name: 'A', email: 'a@test.com' }] })
      })
      // OneSystems auth
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      // OneSystems upload → FAILS (postToCase throws)
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upload boom' })
      // GW-01 failure post-back PUT /tickets/123.json
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })

    const req = makeRequest({ ticket_id: 123 }, { tenantConfig })
    const result = await handleWebhook(req)

    // 500 envelope unchanged (rethrow preserved)
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
    expect(typeof result.body.duration_ms).toBe('number')

    // GW-01 failure post-back fired: PUT carrying ❌ note + last_status=failed
    const postBack = f.mock.calls.find(
      c => String(c[0]).includes('/tickets/123.json')
        && (c[1] as { method?: string })?.method === 'PUT'
        && String((c[1] as { body?: string })?.body ?? '').includes('"comment"')
    )
    expect(postBack).toBeTruthy()
    const body = JSON.parse(String((postBack![1] as { body: string }).body))
    expect(body.ticket.comment.public).toBe(false)
    expect(body.ticket.comment.body).toContain('❌')
    expect(body.ticket.custom_fields.map((x: { id: number }) => x.id)).toEqual([33])
    const ls = JSON.parse(body.ticket.custom_fields[0].value)
    expect(ls).toMatchObject({
      v: 1, status: 'failed', outcome: 'failed',
      docSystem: 'onesystems', reason: 'Sjálfvirk skjalfesting mistókst'
    })
  })

  it('webhook failure path: post-back write itself rejecting does NOT change the 500', async () => {
    const f = global.fetch as ReturnType<typeof vi.fn>
    f
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: baseTicket }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ comments: [{ id: 1, body: 'Hi', public: true, author_id: 100 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ users: [{ id: 100, name: 'A', email: 'a@test.com' }] })
      })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upload boom' })
      // GW-01 failure post-back PUT itself rejects → must be swallowed
      .mockRejectedValueOnce(new Error('Zendesk down'))

    const req = makeRequest({ ticket_id: 123 })
    const result = await handleWebhook(req)

    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
  })
})
