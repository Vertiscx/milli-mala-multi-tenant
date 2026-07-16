/**
 * Runtime-parity smoke test (test-plan items 2 + 3).
 *
 * Proves POST /v1/cases behaves IDENTICALLY through:
 *   - the REAL Node HTTP adapter (src/index.ts → handleCasesHttp): body
 *     parse, header lowercasing, FileTenantStore + resolveTenantConfig,
 *     FileAuditStore binding, result→HTTP mapping via sendJson.
 *   - the REAL Cloudflare Worker adapter (src/worker.ts default export):
 *     request.text() parse, KvTenantStore + resolveTenantConfig,
 *     env.AUDIT_LOG binding, Response.json result→HTTP mapping.
 *
 * Both adapters exercise their genuine code paths in-process (no live
 * servers spun by us beyond index.ts's own createServer on an ephemeral
 * loopback port, hit via node:http — no new deps). Upstreams are stubbed
 * via a URL-routing global.fetch mock so every scenario is deterministic.
 *
 * NEW FILE ONLY — no src or existing test edited (G1/G2/pre-G3 invariant).
 *
 * For EACH of 7 scenarios we assert nodeResult.status === workerResult.status
 * AND deep-equal parsed bodies (GW-06 envelope), and that the scenario
 * reached its expected non-gate status (precondition: not stuck at parse/401).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { request as httpRequest, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { createHmac } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { AuditStore } from '../src/types.js'

// Capture the http.Server that src/index.ts creates on import. node:http is
// ESM (non-configurable namespace) so we cannot vi.spyOn createServer; instead
// mock the module with a factory that wraps the REAL createServer — the
// returned server, its request handler, routing and the entire src/index.ts
// adapter remain the genuine production code.
const capturedServers: Server[] = []
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return {
    ...actual,
    default: actual,
    createServer: (...args: unknown[]) => {
      // @ts-expect-error forward to real impl
      const s = actual.createServer(...args)
      capturedServers.push(s)
      return s
    }
  }
})

// ─── Tenant env (set BEFORE importing src/index.ts so loadTenants/requireEnv
//     succeed and the FileTenantStore is built from the real config path) ────
const ONESYS_BASE = 'https://api.onesystems.test'
const GOPRO_BASE = 'https://api.gopro.test'
const ONESYS_BRAND = '30220057411090' // Kerfisstjórn — onesystems
const GOPRO_BRAND = '28710908212242' // Vinnueftirlitið — gopro (prod)
// Tenant secrets — must satisfy the SYN-MUT-28-1 strength rules that
// validateTenantConfig enforces (≥32 chars for tokens/keys, ≥16 for the
// GoPro password; not a single repeated character). Weak values here make
// resolveTenantConfig reject every tenant and 400 every scenario.
const MALASKRA_KEY = 'test-malaskra-key-shared-0123456789ab'
const K_TOKEN = 'kerfis-zendesk-api-token-0123456789ab'
const K_WEBHOOK = 'kerfis-zendesk-webhook-secret-0123456789'
const K_APPKEY = 'kerfis-onesystems-app-key-0123456789ab'
const V_TOKEN = 'vinnu-zendesk-api-token-0123456789abcd'
const V_WEBHOOK = 'vinnu-zendesk-webhook-secret-0123456789'
const V_PASSWORD = 'vinnu-gopro-password-0123456789'
const S_TOKEN = 'samg-zendesk-api-token-0123456789abcd'
const S_WEBHOOK = 'samg-zendesk-webhook-secret-0123456789'
const S_APPKEY = 'samg-onesystems-app-key-0123456789abcd'

const TENANT_ENV: Record<string, string> = {
  KERFISSTJORN_ZENDESK_SUBDOMAIN: 'kerfis',
  KERFISSTJORN_ZENDESK_EMAIL: 'k@example.com',
  KERFISSTJORN_ZENDESK_API_TOKEN: K_TOKEN,
  KERFISSTJORN_ZENDESK_WEBHOOK_SECRET: K_WEBHOOK,
  KERFISSTJORN_ONESYSTEMS_BASE_URL: ONESYS_BASE,
  KERFISSTJORN_ONESYSTEMS_APP_KEY: K_APPKEY,
  KERFISSTJORN_MALASKRA_API_KEY: MALASKRA_KEY,
  // Phase 6 — webhook create inputs (template + kennitala custom fields)
  // + the case-number field the create path stamps (MD-02: the create
  // branch refuses to mint without a field to stamp).
  KERFISSTJORN_TEMPLATE_FIELD_ID: '100',
  KERFISSTJORN_KENNITALA_FIELD_ID: '200',
  KERFISSTJORN_CASE_NUMBER_FIELD_ID: '7777',
  VINNUEFTIRLIT_ZENDESK_SUBDOMAIN: 'vinnu',
  VINNUEFTIRLIT_ZENDESK_EMAIL: 'v@example.com',
  VINNUEFTIRLIT_ZENDESK_API_TOKEN: V_TOKEN,
  VINNUEFTIRLIT_ZENDESK_WEBHOOK_SECRET: V_WEBHOOK,
  VINNUEFTIRLIT_GOPRO_BASE_URL: GOPRO_BASE,
  VINNUEFTIRLIT_GOPRO_USERNAME: 'vuser',
  VINNUEFTIRLIT_GOPRO_PASSWORD: V_PASSWORD,
  VINNUEFTIRLIT_MALASKRA_API_KEY: MALASKRA_KEY,
  SAMGONGUSTOFA_ZENDESK_SUBDOMAIN: 'samgongu',
  SAMGONGUSTOFA_ZENDESK_EMAIL: 's@example.com',
  SAMGONGUSTOFA_ZENDESK_API_TOKEN: S_TOKEN,
  SAMGONGUSTOFA_ZENDESK_WEBHOOK_SECRET: S_WEBHOOK,
  SAMGONGUSTOFA_ONESYSTEMS_BASE_URL: ONESYS_BASE,
  SAMGONGUSTOFA_ONESYSTEMS_APP_KEY: S_APPKEY,
  SAMGONGUSTOFA_MALASKRA_API_KEY: MALASKRA_KEY,
  TRYGGINGASTOFNUN_ZENDESK_SUBDOMAIN: 'trygg',
  TRYGGINGASTOFNUN_ZENDESK_EMAIL: 't@example.com',
  TRYGGINGASTOFNUN_ZENDESK_API_TOKEN: 'trygg-zendesk-api-token-0123456789ab',
  TRYGGINGASTOFNUN_ZENDESK_WEBHOOK_SECRET: 'trygg-zendesk-webhook-secret-012345678',
  TRYGGINGASTOFNUN_ONESYSTEMS_BASE_URL: ONESYS_BASE,
  TRYGGINGASTOFNUN_ONESYSTEMS_APP_KEY: 'trygg-onesystems-app-key-0123456789ab',
  TRYGGINGASTOFNUN_MALASKRA_API_KEY: MALASKRA_KEY,
  TRYGGINGASTOFNUN_INTERNAL_ZENDESK_SUBDOMAIN: 'trygg',
  TRYGGINGASTOFNUN_INTERNAL_ZENDESK_EMAIL: 't@example.com',
  TRYGGINGASTOFNUN_INTERNAL_ZENDESK_API_TOKEN: 'tryggint-zendesk-api-token-0123456789',
  TRYGGINGASTOFNUN_INTERNAL_ZENDESK_WEBHOOK_SECRET: 'tryggint-zendesk-webhook-secret-01234',
  TRYGGINGASTOFNUN_INTERNAL_ONESYSTEMS_BASE_URL: ONESYS_BASE,
  TRYGGINGASTOFNUN_INTERNAL_ONESYSTEMS_APP_KEY: 'tryggint-onesystems-app-key-012345678',
  TRYGGINGASTOFNUN_INTERNAL_MALASKRA_API_KEY: MALASKRA_KEY,
  HMS_ZENDESK_SUBDOMAIN: 'digitaliceland',
  HMS_ZENDESK_EMAIL: 'h@example.com',
  HMS_ZENDESK_API_TOKEN: 'hms-zendesk-api-token-0123456789abcd',
  HMS_ZENDESK_WEBHOOK_SECRET: 'hms-zendesk-webhook-secret-0123456789',
  HMS_ONESYSTEMS_BASE_URL: ONESYS_BASE,
  HMS_ONESYSTEMS_APP_KEY: 'hms-onesystems-app-key-0123456789abcd',
  HMS_MALASKRA_API_KEY: MALASKRA_KEY
}

const savedEnv: Record<string, string | undefined> = {}
for (const [k, v] of Object.entries(TENANT_ENV)) {
  savedEnv[k] = process.env[k]
  process.env[k] = v
}
const savedPort = process.env.PORT
const savedAuditDir = process.env.AUDIT_DIR
const savedKService = process.env.K_SERVICE
process.env.AUDIT_DIR = `/tmp/mm-parity-audit-${process.pid}`
// PORT=0 → index.ts's createServer binds an ephemeral loopback port.
process.env.PORT = '0'

global.fetch = vi.fn() as unknown as typeof fetch
const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>

// ─── Per-scenario upstream behaviour knobs ──────────────────────────────────
type Mode = {
  ticketBrand: number
  uploadFails: boolean
  // Phase 6 webhook create scenario: custom fields on the fetched ticket
  // (template + kennitala stamped, case-number field empty/absent).
  ticketCustomFields?: { id: number; value: string | number | boolean | null }[]
}
let mode: Mode

function jsonRes(obj: unknown) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) }
}
function textRes(str: string) {
  return { ok: true, status: 200, json: async () => JSON.parse(str), text: async () => str }
}
function failRes(status: number, body = 'boom') {
  return { ok: false, status, statusText: 'err', text: async () => body, json: async () => ({}) }
}

/**
 * URL-routing fetch stub (order-independent so it is byte-identical for
 * the Node and Worker adapters regardless of incidental call interleaving):
 *   getTicket → getTicketComments → getUsersMany → OneSystems auth →
 *   CreateCaseUid → stamp/post-back PUT /tickets → AddDocument2
 */
function installFetchRouter() {
  fetchMock().mockImplementation(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/comments.json')) {
      return jsonRes({ comments: [{ id: 1, body: 'Hi', public: true, author_id: 7 }] })
    }
    if (url.includes('/users/show_many.json')) {
      return jsonRes({ users: [{ id: 7, name: 'Agent', email: 'agent@example.com' }] })
    }
    if (/\/tickets\/123\.json$/.test(url)) {
      // getTicket (GET) + case-number stamp PUT + GW-01 post-back PUT all
      // share this route (order-independent).
      return jsonRes({
        ticket: {
          id: 123, subject: 'Test', brand_id: mode.ticketBrand,
          ...(mode.ticketCustomFields !== undefined ? { custom_fields: mode.ticketCustomFields } : {})
        }
      })
    }
    if (url.includes('/api/Authenticate/login')) {
      return textRes(JSON.stringify({ token: 'os-token' }))
    }
    if (url.includes('/api/OneRecord/CreateCaseUid')) {
      return jsonRes({ caseNumber: 'OS-9' })
    }
    if (url.includes('/api/OneRecord/AddDocument2')) {
      return mode.uploadFails ? failRes(500, 'upload boom') : jsonRes({ success: true })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

// ─── Adapter drivers ────────────────────────────────────────────────────────
type Resp = { status: number; body: unknown }

// Worker-side audit capture (memAudit put target; cleared in beforeEach).
const workerAuditEntries: string[] = []

let nodeServer: Server // index.ts's own server, captured via createServer spy
let nodePort: number

// Worker stub env
function makeWorkerEnv() {
  const tenants: Record<string, string> = {
    [`tenant:${ONESYS_BRAND}`]: JSON.stringify({
      brand_id: ONESYS_BRAND,
      name: 'Kerfisstjórn',
      zendesk: { subdomain: 'kerfis', email: 'k@example.com', apiToken: K_TOKEN, webhookSecret: K_WEBHOOK },
      endpoints: { onesystems: { type: 'onesystems', baseUrl: ONESYS_BASE, appKey: K_APPKEY, templateFieldId: 100, kennitalaFieldId: 200, caseNumberFieldId: 7777 } },
      malaskra: { apiKey: MALASKRA_KEY },
      pdf: { companyName: 'Kerfisstjórn', locale: 'is-IS', includeInternalNotes: false }
    }),
    [`tenant:${GOPRO_BRAND}`]: JSON.stringify({
      brand_id: GOPRO_BRAND,
      name: 'Vinnueftirlitið',
      zendesk: { subdomain: 'vinnu', email: 'v@example.com', apiToken: V_TOKEN, webhookSecret: V_WEBHOOK },
      endpoints: { gopro: { type: 'gopro', baseUrl: GOPRO_BASE, username: 'vuser', password: V_PASSWORD } },
      malaskra: { apiKey: MALASKRA_KEY },
      pdf: { companyName: 'Vinnueftirlitið', locale: 'is-IS', includeInternalNotes: false }
    })
  }
  const memAudit: AuditStore = {
    // Captured so scenarios can assert on the persisted audit entry
    // (cleared per test in beforeEach).
    async put(_key: string, value: string) { workerAuditEntries.push(value) },
    async get() { return null },
    async list() { return { keys: [] } }
  }
  return {
    TENANT_KV: { async get(key: string) { return tenants[key] ?? null } },
    AUDIT_LOG: memAudit,
    AUDIT_SECRET: ''
  }
}

let workerMod: { default: { fetch(r: Request, e: unknown, c: unknown): Promise<Response> } }

async function driveWorker(headers: Record<string, string>, body: unknown, path = '/v1/cases'): Promise<Resp> {
  const req = new Request(`https://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const res = await workerMod.default.fetch(req, makeWorkerEnv(), {})
  return { status: res.status, body: await res.json() }
}

function driveNode(headers: Record<string, string>, body: unknown, path = '/v1/cases'): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: nodePort,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

beforeAll(async () => {
  // index.ts auto-runs startServer() on import (not a cloud fn), which calls
  // the wrapped node:http.createServer + server.listen on ephemeral PORT=0.
  await import('../src/index.js')
  nodeServer = capturedServers[capturedServers.length - 1]
  if (!nodeServer) throw new Error('index.ts did not create an http server')
  await new Promise<void>((res) => {
    if (nodeServer.listening) return res()
    nodeServer.once('listening', () => res())
  })
  nodePort = (nodeServer.address() as AddressInfo).port

  workerMod = (await import('../src/worker.js')) as typeof workerMod
})

afterAll(async () => {
  if (nodeServer) await new Promise<void>((res) => nodeServer.close(() => res()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (savedPort === undefined) delete process.env.PORT
  else process.env.PORT = savedPort
  if (savedAuditDir === undefined) delete process.env.AUDIT_DIR
  else process.env.AUDIT_DIR = savedAuditDir
  if (savedKService === undefined) delete process.env.K_SERVICE
  else process.env.K_SERVICE = savedKService
})

beforeEach(() => {
  vi.clearAllMocks()
  workerAuditEntries.length = 0
  mode = { ticketBrand: Number(ONESYS_BRAND), uploadFails: false }
  installFetchRouter()
})

// Run an identical request through BOTH adapters and assert full parity.
async function assertParity(
  headers: Record<string, string>,
  body: unknown,
  expectedStatus: number,
  label: string
) {
  const node = await driveNode(headers, body)
  const worker = await driveWorker(headers, body)
  // Precondition: scenario actually reached its target (not stuck at a gate).
  expect(node.status, `${label}: node reached expected status`).toBe(expectedStatus)
  expect(worker.status, `${label}: worker reached expected status`).toBe(expectedStatus)
  // Parity: identical status + deep-equal GW-06 envelope across runtimes.
  expect(node.status, `${label}: status parity`).toBe(worker.status)
  expect(node.body, `${label}: body parity`).toStrictEqual(worker.body)
  return node
}

const KEY = { 'x-api-key': MALASKRA_KEY }
const NS_CREATE = { onesystems: { caseTemplate: 'T', kennitala: '1234567890' } }

describe('Node vs Worker /v1/cases runtime parity', () => {
  it('(1) create path happy → 200 documented caseNumber', async () => {
    const r = await assertParity(
      KEY,
      { ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems', create: NS_CREATE },
      200,
      'create-happy'
    )
    expect(r.body).toStrictEqual({ ok: true, outcome: 'documented', caseNumber: 'OS-9' })
  })

  it('(2) case_number path happy → 200 documented', async () => {
    const r = await assertParity(
      KEY,
      { ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems', case_number: 'C-9' },
      200,
      'casenum-happy'
    )
    expect(r.body).toStrictEqual({ ok: true, outcome: 'documented', caseNumber: 'C-9' })
  })

  it('(3) bad x-api-key → 401 auth', async () => {
    const r = await assertParity(
      { 'x-api-key': 'wrong' },
      { ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems', case_number: 'C-9' },
      401,
      'bad-key'
    )
    const b = r.body as Record<string, unknown>
    expect(b.ok).toBe(false)
    expect(b.outcome).toBe('auth')
    expect(typeof b.error).toBe('string')
  })

  it('(4) neither create nor case_number → 400 validation', async () => {
    const r = await assertParity(
      KEY,
      { ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems' },
      400,
      'validation'
    )
    const b = r.body as Record<string, unknown>
    expect(b.ok).toBe(false)
    expect(b.outcome).toBe('validation')
    expect(typeof b.error).toBe('string')
  })

  it('(5) gopro endpoint + create → 422 gopro_create_unsupported', async () => {
    mode.ticketBrand = Number(GOPRO_BRAND) // ticket must belong to the gopro brand
    const r = await assertParity(
      KEY,
      { ticket_id: 123, brand_id: GOPRO_BRAND, doc_endpoint: 'gopro', create: NS_CREATE },
      422,
      'gopro-create'
    )
    const b = r.body as Record<string, unknown>
    expect(b.ok).toBe(false)
    expect(b.outcome).toBe('gopro_create_unsupported')
  })

  it('(6) create OK + upload fails → 207 orphan_case + caseNumber', async () => {
    mode.uploadFails = true
    const r = await assertParity(
      KEY,
      { ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems', create: NS_CREATE },
      207,
      'orphan'
    )
    const b = r.body as Record<string, unknown>
    expect(b.ok).toBe(false)
    expect(b.outcome).toBe('orphan_case')
    expect(b.caseNumber).toBe('OS-9')
  })

  it('(7) case_number path + upload fails → 500 generic envelope', async () => {
    mode.uploadFails = true
    const node = await driveNode(KEY, {
      ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems', case_number: 'C-7'
    })
    const worker = await driveWorker(KEY, {
      ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems', case_number: 'C-7'
    })
    expect(node.status, 'casenum-upload-fail: node reached 500').toBe(500)
    expect(worker.status, 'casenum-upload-fail: worker reached 500').toBe(500)
    expect(node.status).toBe(worker.status)
    // duration_ms differs by runtime; assert shape parity then strip it.
    const nb = node.body as Record<string, unknown>
    const wb = worker.body as Record<string, unknown>
    expect(nb.error).toBe('Internal server error')
    expect(wb.error).toBe('Internal server error')
    expect(typeof nb.duration_ms).toBe('number')
    expect(typeof wb.duration_ms).toBe('number')
    expect(nb.ok).toBeUndefined()
    expect(nb.outcome).toBeUndefined()
    expect(wb.ok).toBeUndefined()
    expect(wb.outcome).toBeUndefined()
    const { duration_ms: _n, ...nRest } = nb
    const { duration_ms: _w, ...wRest } = wb
    expect(nRest).toStrictEqual(wRest)
  })

  it('(8) webhook create path: empty case-number field + template/kennitala stamped → 200 with One-minted number, audit case_number_source created', async () => {
    // Ticket carries the trigger-stamped create inputs but NO case-number
    // field — the Phase 6 create branch must engage in both runtimes.
    mode.ticketCustomFields = [
      { id: 100, value: 'T-mál' }, // templateFieldId
      { id: 200, value: '1234567890' } // kennitalaFieldId
    ]
    const body = { ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems' }
    // Sign exactly the JSON string the drive helpers send (timestamp + rawBody).
    const rawBody = JSON.stringify(body)
    const timestamp = new Date().toISOString()
    const signature = createHmac('sha256', K_WEBHOOK).update(timestamp + rawBody).digest('base64')
    const headers = {
      'x-zendesk-webhook-signature': signature,
      'x-zendesk-webhook-signature-timestamp': timestamp
    }

    // LO-02: AUDIT_DIR is shared across the whole file and earlier
    // scenarios (e.g. (1) /v1/cases create) already wrote OS-9 entries
    // with source 'created' — snapshot the dir BEFORE driving node so the
    // node-side assertion below only inspects files THIS scenario wrote.
    const auditDir = process.env.AUDIT_DIR as string
    const preexisting = new Set(await readdir(auditDir).catch(() => [] as string[]))

    const node = await driveNode(headers, body, '/v1/webhook')
    const worker = await driveWorker(headers, body, '/v1/webhook')
    expect(node.status, 'webhook-create: node reached 200').toBe(200)
    expect(worker.status, 'webhook-create: worker reached 200').toBe(200)

    // Success body carries the One-minted number, never a ZD- reference.
    const nb = node.body as Record<string, unknown>
    const wb = worker.body as Record<string, unknown>
    expect(nb.case_number).toBe('OS-9')
    expect(wb.case_number).toBe('OS-9')
    // duration_ms differs by runtime; assert shape parity then strip it.
    expect(typeof nb.duration_ms).toBe('number')
    expect(typeof wb.duration_ms).toBe('number')
    const { duration_ms: _n, ...nRest } = nb
    const { duration_ms: _w, ...wRest } = wb
    expect(nRest).toStrictEqual(wRest)

    // Worker audit: persisted entry shows the minted number with source 'created'.
    const workerAudits = workerAuditEntries.map(v => JSON.parse(v) as {
      destination: { case_number: string; case_number_source: string }
    })
    expect(workerAudits.length).toBeGreaterThan(0)
    for (const entry of workerAudits) {
      expect(entry.destination.case_number).toBe('OS-9')
      expect(entry.destination.case_number_source).toBe('created')
    }

    // Node audit: FileAuditStore wrote the same entry under AUDIT_DIR.
    // Only NEW files count (LO-02) — the node webhook create path must
    // itself have persisted the minted number with source 'created'.
    const files = (await readdir(auditDir)).filter(f => !preexisting.has(f))
    expect(files.length).toBeGreaterThan(0)
    const nodeAudits = await Promise.all(files.map(async f => {
      const stored = JSON.parse(await readFile(`${auditDir}/${f}`, 'utf8')) as { value: string }
      return JSON.parse(stored.value) as { destination: { case_number: string; case_number_source: string } }
    }))
    for (const entry of nodeAudits) {
      expect(entry.destination.case_number).toBe('OS-9')
      expect(entry.destination.case_number_source).toBe('created')
    }
  })

  it('(9) webhook loud-fail: empty case-number field + NO template stamped → 422 missing_template in BOTH runtimes, webhook_create_rejected audit', async () => {
    // Phase 7 (WHCC-05/AUDIT-01): a trigger that never stamped the template
    // is a loud, non-retryable misconfiguration — 422, distinct audit event,
    // nothing minted, nothing archived, no ZD- anywhere. Mirrors scenario
    // (8)'s drive helpers (HMAC signing, worker audit capture, node
    // AUDIT_DIR read).
    mode.ticketCustomFields = [
      { id: 200, value: '1234567890' } // kennitala only — template ABSENT
    ]
    const body = { ticket_id: 123, brand_id: ONESYS_BRAND, doc_endpoint: 'onesystems' }
    const rawBody = JSON.stringify(body)
    const timestamp = new Date().toISOString()
    const signature = createHmac('sha256', K_WEBHOOK).update(timestamp + rawBody).digest('base64')
    const headers = {
      'x-zendesk-webhook-signature': signature,
      'x-zendesk-webhook-signature-timestamp': timestamp
    }

    // LO-02: only inspect audit files THIS scenario wrote.
    const auditDir = process.env.AUDIT_DIR as string
    const preexisting = new Set(await readdir(auditDir).catch(() => [] as string[]))

    const node = await driveNode(headers, body, '/v1/webhook')
    const worker = await driveWorker(headers, body, '/v1/webhook')
    expect(node.status, 'webhook-loud-fail: node reached 422').toBe(422)
    expect(worker.status, 'webhook-loud-fail: worker reached 422').toBe(422)

    // The 422 body carries the mode and no case reference — full parity
    // (no duration_ms in the reject body, so deep-equal directly).
    const nb = node.body as Record<string, unknown>
    const wb = worker.body as Record<string, unknown>
    expect(nb.outcome).toBe('missing_template')
    expect(wb.outcome).toBe('missing_template')
    expect(nb.case_number).toBeUndefined()
    expect(wb.case_number).toBeUndefined()
    expect(nb).toStrictEqual(wb)

    type RejectAudit = {
      event: string
      outcome: string
      destination: { case_number: string | null; case_number_source: string }
    }

    // Worker audit: distinct event/outcome, case_number null / source none.
    const workerAudits = workerAuditEntries.map(v => JSON.parse(v) as RejectAudit)
    expect(workerAudits.length).toBeGreaterThan(0)
    for (const entry of workerAudits) {
      expect(entry.event).toBe('webhook_create_rejected')
      expect(entry.outcome).toBe('missing_template')
      expect(entry.destination.case_number).toBeNull()
      expect(entry.destination.case_number_source).toBe('none')
    }

    // Node audit: FileAuditStore wrote the same reject entry under AUDIT_DIR.
    const files = (await readdir(auditDir)).filter(f => !preexisting.has(f))
    expect(files.length).toBeGreaterThan(0)
    const nodeAudits = await Promise.all(files.map(async f => {
      const stored = JSON.parse(await readFile(`${auditDir}/${f}`, 'utf8')) as { value: string }
      return JSON.parse(stored.value) as RejectAudit
    }))
    for (const entry of nodeAudits) {
      expect(entry.event).toBe('webhook_create_rejected')
      expect(entry.outcome).toBe('missing_template')
      expect(entry.destination.case_number).toBeNull()
      expect(entry.destination.case_number_source).toBe('none')
    }
  })
})
