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
import { handleWebhook } from '../src/services/archive/webhook.js'
import { resolveCreateInputs } from '../src/services/archive/documentTicket.js'
import type { TenantConfig, AuditStore, EndpointConfig, ZendeskTicket } from '../src/platform/types.js'

// Mock fetch globally (mirrors tests/webhook.test.ts)
global.fetch = vi.fn() as unknown as typeof fetch

function makeSignature(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('base64')
}

function makeTenantConfig(overrides: Partial<Omit<TenantConfig, 'services'>> & {
  endpoints?: Record<string, EndpointConfig>
} = {}): TenantConfig {
  const { endpoints, ...rest } = overrides
  return {
    brand_id: '360001234567',
    name: 'Test Tenant',
    zendesk: {
      subdomain: 'test',
      email: 'test@example.com',
      apiToken: 'test-token',
      webhookSecret: 'test-webhook-secret'
    },
    services: {
      archive: {
        endpoints: endpoints ?? {
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
        }
      }
    },
    ...rest
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

// Phase 7 (WHCC-05): an OneSystems tenant no longer gets a ZD- fallback on
// an EMPTY case-number field — it 422s loudly instead. The pipeline-behavior
// tests below (best-effort audit, author fallback, duration parity, failure
// post-back) therefore document into a POPULATED field ('C-100') so they
// keep exercising the exact same code paths they always pinned.
const fieldedTicket = {
  ...baseTicket,
  custom_fields: [{ id: 7777, value: 'C-100' }]
}

function makeFieldedTenant(epExtra: Record<string, unknown> = {}): TenantConfig {
  return makeTenantConfig({
    endpoints: {
      onesystems: {
        type: 'onesystems',
        baseUrl: 'https://api.onesystems.test',
        appKey: 'test-key',
        caseNumberFieldId: 7777,
        ...epExtra
      }
    }
  })
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
    mockHappyFetchSequence({ ticket: fieldedTicket })
    const auditStore: AuditStore = {
      put: vi.fn().mockRejectedValue(new Error('KV unavailable')),
      get: vi.fn(),
      list: vi.fn()
    }
    const req = makeRequest({ ticket_id: 123 }, { tenantConfig: makeFieldedTenant(), auditStore })
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
    mockHappyFetchSequence({ ticket: fieldedTicket, usersReject: true })
    const req = makeRequest({ ticket_id: 123 }, { tenantConfig: makeFieldedTenant() })
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
    mockHappyFetchSequence({ ticket: fieldedTicket })
    const captured: string[] = []
    const auditStore: AuditStore = {
      put: vi.fn(async (_key: string, value: string) => {
        captured.push(value)
      }),
      get: vi.fn(),
      list: vi.fn()
    }
    const req = makeRequest({ ticket_id: 123 }, { tenantConfig: makeFieldedTenant(), auditStore })
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
    const tenantConfig = makeFieldedTenant({ lastStatusFieldId: 33 })
    const f = global.fetch as ReturnType<typeof vi.fn>
    f
      // getTicket
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: fieldedTicket }) })
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
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: fieldedTicket }) })
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

    const req = makeRequest({ ticket_id: 123 }, { tenantConfig: makeFieldedTenant() })
    const result = await handleWebhook(req)

    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
  })
})

// ─── resolveCreateInputs — webhook create input extraction (CONF-01/02) ──

describe('resolveCreateInputs', () => {
  function makeEp(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
    return {
      type: 'onesystems',
      baseUrl: 'https://api.onesystems.test',
      appKey: 'test-key',
      ...overrides
    }
  }

  function makeTicket(customFields?: { id: number; value: string | number | boolean | null }[]): ZendeskTicket {
    return {
      id: 123,
      subject: 'Test ticket',
      status: 'closed',
      created_at: '2025-01-01T00:00:00Z',
      ...(customFields !== undefined ? { custom_fields: customFields } : {})
    }
  }

  it('returns the raw template string from the configured templateFieldId field', () => {
    const ep = makeEp({ templateFieldId: 100 })
    const ticket = makeTicket([{ id: 100, value: 'Almennt erindi' }])
    expect(resolveCreateInputs(ep, ticket)).toEqual({ template: 'Almennt erindi' })
  })

  it('returns the raw kennitala with hyphen intact (no normalization)', () => {
    const ep = makeEp({ kennitalaFieldId: 200 })
    const ticket = makeTicket([{ id: 200, value: '010190-2989' }])
    expect(resolveCreateInputs(ep, ticket)).toEqual({ kennitala: '010190-2989' })
  })

  it('trims surrounding whitespace, preserving Icelandic characters', () => {
    const ep = makeEp({ templateFieldId: 100 })
    const ticket = makeTicket([{ id: 100, value: '  TR-mál  ' }])
    expect(resolveCreateInputs(ep, ticket)).toEqual({ template: 'TR-mál' })
  })

  it('treats a whitespace-only field value as absent', () => {
    const ep = makeEp({ templateFieldId: 100 })
    const ticket = makeTicket([{ id: 100, value: '   ' }])
    const result = resolveCreateInputs(ep, ticket)
    expect('template' in result).toBe(false)
    expect(result).toEqual({})
  })

  it('treats a null field value as absent', () => {
    const ep = makeEp({ kennitalaFieldId: 200 })
    const ticket = makeTicket([{ id: 200, value: null }])
    expect(resolveCreateInputs(ep, ticket)).toEqual({})
  })

  it('treats a configured field ID with no matching custom_fields entry as absent', () => {
    const ep = makeEp({ templateFieldId: 100, kennitalaFieldId: 200 })
    const ticket = makeTicket([{ id: 999, value: 'unrelated' }])
    expect(resolveCreateInputs(ep, ticket)).toEqual({})
  })

  it('treats unset/null field IDs on the endpoint as absent', () => {
    const ticket = makeTicket([{ id: 100, value: 'Almennt erindi' }])
    expect(resolveCreateInputs(makeEp(), ticket)).toEqual({})
    expect(resolveCreateInputs(makeEp({ templateFieldId: null, kennitalaFieldId: null }), ticket)).toEqual({})
  })

  it('returns {} without throwing when ticket.custom_fields is undefined', () => {
    const ep = makeEp({ templateFieldId: 100, kennitalaFieldId: 200 })
    expect(resolveCreateInputs(ep, makeTicket())).toEqual({})
  })

  it('stringifies a numeric field value', () => {
    const ep = makeEp({ kennitalaFieldId: 200 })
    const ticket = makeTicket([{ id: 200, value: 1201503369 }])
    expect(resolveCreateInputs(ep, ticket)).toEqual({ kennitala: '1201503369' })
  })

  it('returns both inputs in one call when both fields are configured and present', () => {
    const ep = makeEp({ templateFieldId: 100, kennitalaFieldId: 200 })
    const ticket = makeTicket([
      { id: 100, value: 'Almennt erindi' },
      { id: 200, value: '010190-2989' }
    ])
    expect(resolveCreateInputs(ep, ticket)).toEqual({
      template: 'Almennt erindi',
      kennitala: '010190-2989'
    })
  })
})

// ─── Phase 6: webhook create path (WHCC-01..04, 06, 07) ──────────────────
//
// A webhook ticket with an EMPTY case-number field on an OneSystems tenant
// must mint a real case via createCase (CreateCaseUid), stamp the minted
// number onto the ticket BEFORE upload, document into it, and persist the
// audit with case_number_source 'created'. Minted-but-failed → 207 (never
// 5xx — Zendesk would retry and mint a SECOND case). Populated-field,
// GoPro, and fall-through paths must stay byte-equivalent to today.
//
// All scenarios drive the REAL handleWebhook with a URL-routing fetch mock
// (order-independent), asserting the wire calls — same discipline as the
// runtime-parity suite.

describe('documentTicket webhook create path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** Tenant whose onesystems endpoint carries all three field IDs. */
  function makeCreateTenant(epOverrides: Record<string, unknown> = {}): TenantConfig {
    return makeTenantConfig({
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: 'https://api.onesystems.test',
          appKey: 'test-key',
          caseNumberFieldId: 7777,
          templateFieldId: 100,
          kennitalaFieldId: 200,
          ...epOverrides
        }
      }
    })
  }

  /** Ticket with an EMPTY case-number field + template + kennitala stamped. */
  function makeCreateTicket(
    customFields: { id: number; value: string | number | boolean | null }[] = [
      { id: 7777, value: null },
      { id: 100, value: 'Almennt erindi' },
      { id: 200, value: '010190-2989' }
    ]
  ) {
    return { ...baseTicket, custom_fields: customFields }
  }

  type RoutedCall = { label: string; url: string; method: string; body?: string }

  /**
   * URL-routing fetch mock (order-independent). Distinguishes the STAMP
   * PUT (custom_fields only, no comment) from the GW-01 post-back PUT
   * (carries a comment) so stamp-before-upload ordering is assertable.
   */
  function installCreateRouter(opts: {
    ticket?: object
    createCaseFails?: boolean
    uploadFails?: boolean
    stampFails?: boolean
    goproUploadFails?: boolean
    mintedCaseNumber?: string
  } = {}): RoutedCall[] {
    const calls: RoutedCall[] = []
    const f = global.fetch as ReturnType<typeof vi.fn>
    f.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const record = (label: string) =>
        calls.push({ label, url, method, ...(init?.body !== undefined ? { body: String(init.body) } : {}) })

      if (url.includes('/comments.json')) {
        record('comments')
        return { ok: true, json: async () => ({ comments: [{ id: 1, body: 'Hello', public: true, author_id: 100 }] }) }
      }
      if (url.includes('/users/show_many.json')) {
        record('users')
        return { ok: true, json: async () => ({ users: [{ id: 100, name: 'Test Agent', email: 'agent@test.com' }] }) }
      }
      if (/\/tickets\/123\.json$/.test(url) && method === 'GET') {
        record('getTicket')
        return { ok: true, json: async () => ({ ticket: opts.ticket ?? makeCreateTicket() }) }
      }
      if (/\/tickets\/123\.json$/.test(url) && method === 'PUT') {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { ticket?: { comment?: unknown } }
        const isStamp = parsed.ticket?.comment === undefined
        record(isStamp ? 'stampPut' : 'postBackPut')
        if (isStamp && opts.stampFails) {
          return { ok: false, status: 500, text: async () => 'stamp boom' }
        }
        return { ok: true, json: async () => ({ ticket: {} }) }
      }
      if (url.includes('/api/Authenticate/login')) {
        record('osAuth')
        return { ok: true, text: async () => JSON.stringify({ token: 'os-token' }) }
      }
      if (url.includes('/api/OneRecord/CreateCaseUid')) {
        record('createCase')
        if (opts.createCaseFails) return { ok: false, status: 500, text: async () => 'create boom' }
        return { ok: true, json: async () => ({ caseNumber: opts.mintedCaseNumber ?? '2607033' }) }
      }
      if (url.includes('/api/OneRecord/AddDocument2')) {
        record('upload')
        if (opts.uploadFails) return { ok: false, status: 500, text: async () => 'upload boom' }
        return { ok: true, json: async () => ({ success: true }) }
      }
      // GoPro routes (WHCC-07 scenario)
      if (url.includes('/v2/Authenticate')) {
        record('goproAuth')
        return { ok: true, text: async () => '"gopro-token"' }
      }
      if (url.includes('/v2/Documents/Create')) {
        record('goproUpload')
        if (opts.goproUploadFails) return { ok: false, status: 500, text: async () => 'gopro boom' }
        return { ok: true, json: async () => ({ succeeded: true, identifier: 'doc-1' }) }
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    })
    return calls
  }

  function makeCapturingAuditStore(captured: string[]): AuditStore {
    return {
      put: vi.fn(async (_key: string, value: string) => { captured.push(value) }),
      get: vi.fn(),
      list: vi.fn()
    }
  }

  it('WHCC-01/03: empty field + template + kennitala → mints via CreateCaseUid with the exact create params and returns 200 with the minted number', async () => {
    const calls = installCreateRouter()
    const req = makeRequest({ ticket_id: 123 }, { tenantConfig: makeCreateTenant() })
    const result = await handleWebhook(req)

    expect(result.status).toBe(200)
    expect(result.body.success).toBe(true)
    expect(result.body.case_number).toBe('2607033')

    // createCase called exactly once, with the composed params on the wire.
    // The raw kennitala '010190-2989' flows through the client, which
    // normalizes digits-only into idNumber (client-owned behavior).
    const creates = calls.filter(c => c.label === 'createCase')
    expect(creates).toHaveLength(1)
    const payload = JSON.parse(creates[0].body!) as Record<string, unknown>
    expect(payload).toMatchObject({
      idNumber: '0101902989',
      caseTemplate: 'Almennt erindi',
      caseName: 'Test ticket',
      externalId: 'ticket_123',
      currentUser: 'agent@test.com'
    })
  })

  it('WHCC-02: minted number is stamped onto the case-number field BEFORE the upload', async () => {
    const calls = installCreateRouter()
    const req = makeRequest({ ticket_id: 123 }, { tenantConfig: makeCreateTenant() })
    const result = await handleWebhook(req)

    expect(result.status).toBe(200)
    const stampIdx = calls.findIndex(c => c.label === 'stampPut')
    const uploadIdx = calls.findIndex(c => c.label === 'upload')
    expect(stampIdx).toBeGreaterThanOrEqual(0)
    expect(uploadIdx).toBeGreaterThanOrEqual(0)
    expect(stampIdx).toBeLessThan(uploadIdx)

    // The stamp PUT writes the minted number into the configured field.
    const stampBody = JSON.parse(calls[stampIdx].body!) as {
      ticket: { custom_fields: { id: number; value: unknown }[] }
    }
    expect(stampBody.ticket.custom_fields).toEqual([{ id: 7777, value: '2607033' }])
  })

  it('audit source: persisted entry carries the minted number + case_number_source created, with NO new top-level keys', async () => {
    installCreateRouter()
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(200)
    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBe('2607033')
    expect(persisted.destination.case_number_source).toBe('created')
    // Byte-shape guard: exactly today's webhook top-level keys, nothing new.
    expect(Object.keys(persisted)).toEqual([
      'event', 'timestamp', 'duration_ms', 'brand_id', 'source', 'destination'
    ])
  })

  it('minted-but-failed (upload): returns 207 with the minted number and a sanitized error; audit keeps source created', async () => {
    installCreateRouter({ uploadFails: true })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    // 207, NOT a 5xx — a 5xx would make Zendesk retry and mint a second case.
    expect(result.status).toBe(207)
    expect(result.body.case_number).toBe('2607033')
    // Sanitized: the raw upstream error must never leak into the body.
    expect(typeof result.body.error).toBe('string')
    expect(String(result.body.error)).not.toContain('upload boom')

    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBe('2607033')
    expect(persisted.destination.case_number_source).toBe('created')
    // MD-01: the orphan entry is NET-NEW this phase and must be
    // distinguishable from a success entry — it carries outcome
    // 'orphan_case' (the ONLY key added vs today's webhook shape).
    expect(persisted.outcome).toBe('orphan_case')
    expect(Object.keys(persisted)).toEqual([
      'event', 'timestamp', 'duration_ms', 'brand_id', 'source', 'destination', 'outcome'
    ])
  })

  it('minted-but-failed (stamp): setTicketCustomField rejecting → same 207 semantics with the minted number', async () => {
    installCreateRouter({ stampFails: true })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(207)
    expect(result.body.case_number).toBe('2607033')

    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBe('2607033')
    expect(persisted.destination.case_number_source).toBe('created')
    // MD-01: orphan entry is distinguishable via the outcome key.
    expect(persisted.outcome).toBe('orphan_case')
  })

  it('createCase fails pre-mint: error propagates to the existing 500 (retry-safe), no stamp, no upload', async () => {
    const calls = installCreateRouter({ createCaseFails: true })
    const req = makeRequest({ ticket_id: 123 }, { tenantConfig: makeCreateTenant() })
    const result = await handleWebhook(req)

    // Nothing was minted → the throw reaches handleWebhook's 500 so
    // Zendesk retries (retry is safe pre-mint).
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')
    expect(calls.filter(c => c.label === 'stampPut')).toHaveLength(0)
    expect(calls.filter(c => c.label === 'upload')).toHaveLength(0)
  })

  it('WHCC-06 regression: populated case-number field → createCase NEVER called, documents into the field value as today', async () => {
    const populated = makeCreateTicket([
      { id: 7777, value: 'CASE-42' },
      { id: 100, value: 'Almennt erindi' },
      { id: 200, value: '010190-2989' }
    ])
    const calls = installCreateRouter({ ticket: populated })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(200)
    expect(result.body.case_number).toBe('CASE-42')
    expect(calls.filter(c => c.label === 'createCase')).toHaveLength(0)

    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number_source).toBe('custom_field')
  })

  // ─── Phase 7: loud-fail 422 rejects (WHCC-05, AUDIT-01/02) ─────────────
  //
  // The three Phase 6 fall-through-to-ZD- modes now fail LOUDLY: 422
  // (non-retryable, 07-CONTEXT locked), one shared audit event
  // 'webhook_create_rejected' with a per-mode outcome, nothing minted,
  // nothing stamped, nothing archived, and NO ZD- reference anywhere.
  // These rewrite the Phase 6 fall-through tests — the phase goal, not a
  // regression.

  /** Shared wire-silence + audit assertions for one loud-fail mode. */
  function assertLoudReject(
    result: { status: number; body: Record<string, unknown> },
    calls: RoutedCall[],
    captured: string[],
    mode: string
  ) {
    // 422 non-retryable, sanitized fixed English error, mode in the body.
    expect(result.status).toBe(422)
    expect(result.body.outcome).toBe(mode)
    expect(typeof result.body.error).toBe('string')
    expect(result.body.ticket_id).toBe(123)
    expect(result.body.brand_id).toBe('360001234567')
    expect(result.body.doc_endpoint).toBe('onesystems')
    // No case reference — the gateway never invents one (WHCC-05).
    expect(result.body.case_number).toBeUndefined()

    // Wire silence: nothing minted, nothing stamped, nothing uploaded.
    expect(calls.filter(c => c.label === 'createCase')).toHaveLength(0)
    expect(calls.filter(c => c.label === 'stampPut')).toHaveLength(0)
    expect(calls.filter(c => c.label === 'upload')).toHaveLength(0)

    // GW-01: the best-effort ❌ post-back still fires on a loud failure.
    expect(calls.filter(c => c.label === 'postBackPut').length).toBeGreaterThan(0)

    // Audit: distinct greppable event/outcome, case_number null / source
    // 'none', and NO ZD- substring anywhere in the persisted JSON.
    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.event).toBe('webhook_create_rejected')
    expect(persisted.outcome).toBe(mode)
    expect(persisted.destination.case_number).toBeNull()
    expect(persisted.destination.case_number_source).toBe('none')
    for (const entry of captured) {
      expect(entry).not.toContain('ZD-')
    }
    return persisted
  }

  it('Mode 1 (AUDIT-01): empty field + kennitala only (no template) → 422 missing_template, nothing archived, distinct audit event', async () => {
    const noTemplate = makeCreateTicket([
      { id: 7777, value: null },
      { id: 200, value: '010190-2989' }
    ])
    const calls = installCreateRouter({ ticket: noTemplate })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    assertLoudReject(result, calls, captured, 'missing_template')
  })

  it('Mode 2 (AUDIT-02): empty field + template only (no kennitala) → 422 missing_kennitala, nothing archived, distinct audit event', async () => {
    const noKennitala = makeCreateTicket([
      { id: 7777, value: null },
      { id: 100, value: 'Almennt erindi' }
    ])
    const calls = installCreateRouter({ ticket: noKennitala })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    assertLoudReject(result, calls, captured, 'missing_kennitala')
  })

  it('WHCC-07 GoPro: empty field + template + kennitala but no createCase on the client → create never engages, ZD- fallback as today', async () => {
    const goproTenant = makeTenantConfig({
      endpoints: {
        gopro: {
          type: 'gopro',
          baseUrl: 'https://api.gopro.test',
          username: 'guser',
          password: 'gpass',
          caseNumberFieldId: 7777,
          templateFieldId: 100,
          kennitalaFieldId: 200
        }
      }
    })
    const calls = installCreateRouter()
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: goproTenant, docEndpoint: 'gopro' }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(200)
    expect(result.body.case_number).toBe('ZD-123')
    // Duck-typed guard: no OneSystems create call, GoPro documents as today.
    expect(calls.filter(c => c.label === 'createCase')).toHaveLength(0)
    expect(calls.filter(c => c.label === 'goproUpload').length).toBeGreaterThan(0)
    expect(calls.filter(c => c.label === 'stampPut')).toHaveLength(0)
  })

  it('invalid minted case number: fails validateCaseNumber → post-mint 207 orphan, no stamp, no upload (LO-04)', async () => {
    // A minted number that flunks the sanitizer (SYN-MUT-28-3) must be
    // treated as a POST-mint failure: 207 orphan (never a retryable 5xx),
    // and the invalid value never reaches the stamp or the upload.
    const calls = installCreateRouter({ mintedCaseNumber: 'OS..9' })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(207)
    expect(calls.filter(c => c.label === 'stampPut')).toHaveLength(0)
    expect(calls.filter(c => c.label === 'upload')).toHaveLength(0)

    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.outcome).toBe('orphan_case')
    expect(persisted.destination.case_number_source).toBe('created')
  })

  it('Mode 3: no caseNumberFieldId configured (template + kennitala present) → 422 missing_case_number_field_config, createCase NEVER called (MD-02)', async () => {
    // Field-ID-less endpoint: the stamp is the ONLY duplicate-mint guard,
    // and without a field to stamp every at-least-once webhook redelivery
    // would mint a FRESH case. With the ZD- fallback gone (WHCC-05) this
    // MUST fail loudly instead of silently keeping ZD-.
    const tenantConfig = makeCreateTenant({ caseNumberFieldId: undefined })
    const ticket = makeCreateTicket([
      { id: 100, value: 'Almennt erindi' },
      { id: 200, value: '010190-2989' }
    ])
    const calls = installCreateRouter({ ticket })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig, auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    assertLoudReject(result, calls, captured, 'missing_case_number_field_config')
  })

  // WR-02: a whitespace-only case-number field is ABSENT — it must engage
  // the gate (422 / create), never silently archive under a whitespace
  // "case reference" with source custom_field.
  it('WR-02: whitespace-only case-number field + no template → gate engages, 422 missing_template (never archived under whitespace)', async () => {
    const whitespaceField = makeCreateTicket([
      { id: 7777, value: '   ' },
      { id: 200, value: '010190-2989' }
    ])
    const calls = installCreateRouter({ ticket: whitespaceField })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    assertLoudReject(result, calls, captured, 'missing_template')
  })

  it('WR-02: whitespace-only case-number field + template + kennitala → create path mints (gate engages, not the upload path)', async () => {
    const whitespaceField = makeCreateTicket([
      { id: 7777, value: ' \t ' },
      { id: 100, value: 'Almennt erindi' },
      { id: 200, value: '010190-2989' }
    ])
    const calls = installCreateRouter({ ticket: whitespaceField })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(200)
    expect(result.body.case_number).toBe('2607033')
    expect(calls.filter(c => c.label === 'createCase')).toHaveLength(1)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBe('2607033')
    expect(persisted.destination.case_number_source).toBe('created')
  })

  it('WR-02 GoPro regression: whitespace-only field on a non-create client → gate never engages, ZD- fallback exactly as today', async () => {
    const goproTenant = makeTenantConfig({
      endpoints: {
        gopro: {
          type: 'gopro',
          baseUrl: 'https://api.gopro.test',
          username: 'guser',
          password: 'gpass',
          caseNumberFieldId: 7777
        }
      }
    })
    const calls = installCreateRouter({
      ticket: makeCreateTicket([{ id: 7777, value: '   ' }])
    })
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: goproTenant, docEndpoint: 'gopro' }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(200)
    // resolveCaseNumber is untouched: GoPro keeps today's behavior for a
    // whitespace field byte-identically (whitespace value, not ZD-).
    expect(result.body.case_number).toBe('   ')
    expect(calls.filter(c => c.label === 'createCase')).toHaveLength(0)
    expect(calls.filter(c => c.label === 'goproUpload').length).toBeGreaterThan(0)
  })

  it('distinctness: the three loud-fail entries are identifiable by event/outcome alone, distinct from each other and from ticket_archived', async () => {
    const scenarios: { tenant: TenantConfig; fields: { id: number; value: string | null }[]; mode: string }[] = [
      {
        tenant: makeCreateTenant(),
        fields: [{ id: 7777, value: null }, { id: 200, value: '010190-2989' }],
        mode: 'missing_template'
      },
      {
        tenant: makeCreateTenant(),
        fields: [{ id: 7777, value: null }, { id: 100, value: 'Almennt erindi' }],
        mode: 'missing_kennitala'
      },
      {
        tenant: makeCreateTenant({ caseNumberFieldId: undefined }),
        fields: [{ id: 100, value: 'Almennt erindi' }, { id: 200, value: '010190-2989' }],
        mode: 'missing_case_number_field_config'
      }
    ]

    const entries: Record<string, unknown>[] = []
    for (const s of scenarios) {
      installCreateRouter({ ticket: makeCreateTicket(s.fields) })
      const captured: string[] = []
      const req = makeRequest(
        { ticket_id: 123 },
        { tenantConfig: s.tenant, auditStore: makeCapturingAuditStore(captured) }
      )
      const result = await handleWebhook(req)
      expect(result.status).toBe(422)
      expect(result.body.outcome).toBe(s.mode)
      entries.push(JSON.parse(captured[0]) as Record<string, unknown>)
    }

    // All three share the greppable event, distinct from existing events.
    for (const e of entries) {
      expect(e.event).toBe('webhook_create_rejected')
      expect(e.event).not.toBe('ticket_archived')
      expect(e.event).not.toBe('orphan_case')
    }
    // Pairwise-distinct outcomes distinguish the modes from each other.
    const outcomes = entries.map(e => e.outcome)
    expect(new Set(outcomes).size).toBe(3)
    expect(outcomes).toEqual([
      'missing_template', 'missing_kennitala', 'missing_case_number_field_config'
    ])
  })

  // ─── Phase 7 Task 2: failure-finalize never fabricates ZD- (WHCC-05) ───
  //
  // The outer-catch failure audit for a createCase-capable tenant must
  // carry case_number null / source 'none' — never a fabricated ZD- value.
  // GoPro failure-finalize stays byte-identical (ZD- + 'fallback' kept).

  it('outer-catch (post-client throw): createCase fails → 500 unchanged, failure audit carries case_number null / source none — never ZD-', async () => {
    // Pipeline throws AFTER docClient exists but BEFORE any number resolves.
    installCreateRouter({ createCaseFails: true })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    // Rethrow unchanged → handleWebhook's 500 envelope.
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')

    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBeNull()
    expect(persisted.destination.case_number_source).toBe('none')
    for (const entry of captured) {
      expect(entry).not.toContain('ZD-')
    }
  })

  it('outer-catch (pre-client throw): getTicketComments rejects → 500, failure audit still case_number null / source none (guarded duck-check)', async () => {
    // Throw happens BEFORE createDocClient runs — the catch re-derives the
    // create capability from the endpoint config and still never fabricates.
    const f = global.fetch as ReturnType<typeof vi.fn>
    f
      // getTicket
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: makeCreateTicket() }) })
      // getTicketComments → REJECTS pre-client
      .mockRejectedValueOnce(new Error('comments boom'))
      // GW-01 failure post-back PUT
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: {} }) })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: makeCreateTenant(), auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')

    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBeNull()
    expect(persisted.destination.case_number_source).toBe('none')
    for (const entry of captured) {
      expect(entry).not.toContain('ZD-')
    }
  })

  it('outer-catch GoPro byte-identical: upload throw → failure audit keeps ZD-123 + source fallback exactly', async () => {
    const goproTenant = makeTenantConfig({
      endpoints: {
        gopro: {
          type: 'gopro',
          baseUrl: 'https://api.gopro.test',
          username: 'guser',
          password: 'gpass'
        }
      }
    })
    installCreateRouter({ goproUploadFails: true })
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: goproTenant, docEndpoint: 'gopro', auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')

    // GoPro keeps today's fallback in the failure audit — byte-identical.
    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBe('ZD-123')
    expect(persisted.destination.case_number_source).toBe('fallback')
  })

  // WR-03: a CONSTRUCTION throw (missing credentials) must not flip the
  // catch-side capability re-derivation — GoPro keeps ZD- + 'fallback'
  // byte-identical, OneSystems keeps null + 'none'.
  it('WR-03 outer-catch GoPro construction-throw: missing username/password → failure audit keeps ZD-123 + source fallback (byte-identical)', async () => {
    const goproTenant = makeTenantConfig({
      endpoints: {
        gopro: {
          type: 'gopro',
          baseUrl: 'https://api.gopro.test'
          // username/password MISSING → createDocClient throws at construction
        } as unknown as EndpointConfig
      }
    })
    installCreateRouter()
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: goproTenant, docEndpoint: 'gopro', auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')

    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBe('ZD-123')
    expect(persisted.destination.case_number_source).toBe('fallback')
  })

  it('WR-03 outer-catch OneSystems construction-throw: missing appKey → failure audit carries case_number null / source none — never ZD-', async () => {
    const osTenant = makeTenantConfig({
      endpoints: {
        onesystems: {
          type: 'onesystems',
          baseUrl: 'https://api.onesystems.test'
          // appKey MISSING → createDocClient throws at construction
        } as unknown as EndpointConfig
      }
    })
    installCreateRouter()
    const captured: string[] = []
    const req = makeRequest(
      { ticket_id: 123 },
      { tenantConfig: osTenant, auditStore: makeCapturingAuditStore(captured) }
    )
    const result = await handleWebhook(req)

    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Internal server error')

    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBeNull()
    expect(persisted.destination.case_number_source).toBe('none')
    for (const entry of captured) {
      expect(entry).not.toContain('ZD-')
    }
  })

  it('recordOutcome never fabricates: caseNumber undefined → no ZD- string in the persisted audit entry', async () => {
    const f = global.fetch as ReturnType<typeof vi.fn>
    f.mockResolvedValue({ ok: true, json: async () => ({ ticket: {} }) })
    const captured: string[] = []
    const tenantConfig = makeCreateTenant()
    const { recordOutcome } = await import('../src/services/archive/postResultToTicket.js')
    await recordOutcome(
      {
        ok: false,
        outcome: 'failed',
        intent: 'webhook',
        caseNumberSource: 'none',
        docSystem: 'onesystems',
        ticketId: 123,
        durationMs: 5,
        pdfFilename: 'ticket-123.pdf',
        pdfSizeBytes: 10,
        failedAttachments: [],
        sanitizedReason: 'Sjálfvirk skjalfesting mistókst',
        timestamp: new Date().toISOString()
      },
      {
        tenantConfig,
        ep: tenantConfig.services.archive!.endpoints.onesystems,
        docEndpoint: 'onesystems',
        ticket: baseTicket as ZendeskTicket,
        comments: [],
        attachments: [],
        pdfBuffer: Buffer.alloc(10),
        auditStore: makeCapturingAuditStore(captured)
      }
    )

    expect(captured.length).toBeGreaterThan(0)
    const persisted = JSON.parse(captured[0]) as Record<string, Record<string, unknown>>
    expect(persisted.destination.case_number).toBeNull()
    for (const entry of captured) {
      expect(entry).not.toContain('ZD-')
    }
  })
})
