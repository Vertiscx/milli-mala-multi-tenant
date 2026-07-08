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
  SAMGONGUSTOFA_MALASKRA_API_KEY: MALASKRA_KEY
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
 *   CreateCaseUid → (PUT /tickets skipped: no caseNumberFieldId) → AddDocument2
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
      // getTicket (GET) — PUT is never issued (no caseNumberFieldId configured)
      return jsonRes({ ticket: { id: 123, subject: 'Test', brand_id: mode.ticketBrand } })
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

let nodeServer: Server // index.ts's own server, captured via createServer spy
let nodePort: number

// Worker stub env
function makeWorkerEnv() {
  const tenants: Record<string, string> = {
    [`tenant:${ONESYS_BRAND}`]: JSON.stringify({
      brand_id: ONESYS_BRAND,
      name: 'Kerfisstjórn',
      zendesk: { subdomain: 'kerfis', email: 'k@example.com', apiToken: K_TOKEN, webhookSecret: K_WEBHOOK },
      endpoints: { onesystems: { type: 'onesystems', baseUrl: ONESYS_BASE, appKey: K_APPKEY } },
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
    async put() {},
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

async function driveWorker(headers: Record<string, string>, body: unknown): Promise<Resp> {
  const req = new Request('https://x/v1/cases', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const res = await workerMod.default.fetch(req, makeWorkerEnv(), {})
  return { status: res.status, body: await res.json() }
}

function driveNode(headers: Record<string, string>, body: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: nodePort,
        path: '/v1/cases',
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
})
