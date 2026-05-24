# Testing Patterns

**Analysis Date:** 2026-05-21

## Test Framework

**Runner:** Vitest 4.0.18 (`package.json:28`). ESM-native, no Jest config needed.

**Coverage provider:** `@vitest/coverage-v8` 4.0.18 (`package.json:24`).

**Assertion library:** Vitest's built-in `expect` (Chai-compatible API). No separate library.

**Mocking:** Vitest's `vi.fn()`, `vi.mock()`, `vi.clearAllMocks()`, `vi.spyOn()`. `node-mocks-http` is installed (`package.json:25`) but used sparingly — most HTTP testing drives the real Node server (see runtime parity test).

**Config:** `vitest.config.ts`:
- `globals: true` — `describe`/`it`/`expect`/`vi` available without imports (tests still import them explicitly by convention).
- `environment: 'node'` — no DOM. All adapters are server-side.
- Coverage `provider: 'v8'`, reporters `['text', 'json', 'html']`.
- **Coverage exclusions:** `node_modules/**`, `tests/**`, `*.config.*`, `src/worker.ts`, `src/index.ts`. The two runtime entrypoints are excluded because they're tested via the runtime-parity integration test instead (and including them would penalize coverage on bootstrap code that has its own dedicated test).

## Run Commands

```bash
npm test                 # vitest run — full suite, one shot
npm run test:watch       # vitest — interactive watch
npm run test:coverage    # vitest run --coverage — produces ./coverage/
npm run typecheck        # tsc --noEmit — separate from tests
```

There is no `lint` script. There is no `pretest` typecheck hook — run `npm run typecheck && npm test` manually before pushing.

## Test File Organization

**Location:** `tests/` at the repo root, **not** co-located with sources. `tsconfig.json:20` explicitly excludes `tests` from the emitted build.

**Naming:** `<source>.test.ts` mirroring the file under test:
- `tests/onesystems.test.ts` → `src/onesystems.ts`
- `tests/gopro.test.ts` → `src/gopro.ts`
- `tests/cases.test.ts` → `src/cases.ts`

**Qualified suffixes** for specialized test kinds:
- `tests/cases.contract.test.ts` — frozen GW-06 wire-contract lock (cross-repo fixture consumer)
- `tests/integration.runtime-parity.test.ts` — Node vs Cloudflare Worker adapter parity
- `tests/zendesk.write.test.ts` — focused on the write seam (`requestWrite`, `setTicketCustomField`)
- `tests/onesystems.createCase.test.ts` — single-method focus when a method is large enough to warrant its own file

**Fixtures:** `tests/fixtures/` — currently holds `gw06-contract.fixtures.ts`, the canonical cross-repo wire-contract fixtures. Plain TS data with **no test-framework imports** (so the malaskra_v3 repo can vendor a byte-identical copy and assert from its side).

## Test Structure

**Suite organization** — nested `describe` blocks by class → method:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OneSystemsClient } from '../src/onesystems.js'

global.fetch = vi.fn() as unknown as typeof fetch

describe('OneSystemsClient', () => {
  let client: OneSystemsClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new OneSystemsClient('https://api.onesystems.test', 'test-app-key', { ... })
  })

  describe('constructor', () => { it('should initialize with correct properties', () => { ... }) })
  describe('authenticate',  () => { it('should call login endpoint and store token', async () => { ... }) })
  describe('uploadDocument',() => {
    beforeEach(() => { client.token = 'valid-token'; client.tokenExpiry = Date.now() + 60_000 })
    it('should upload PDF with correct multipart form fields', async () => { ... })
  })
})
```
Reference: `tests/onesystems.test.ts:1-33`, `tests/gopro.test.ts:1-31`.

**Conventions:**
- `import { describe, it, expect, vi, beforeEach } from 'vitest'` — always explicit even though `globals: true` is set.
- Imports use `.js` extensions matching the ESM source style: `from '../src/onesystems.js'`.
- One top-level `describe` per file matching the SUT name.
- `it` titles read as English sentences starting with `should ...` for unit tests; contract tests use scenario-style titles (`'create_failed → RES_CREATE_FAILED (no caseNumber)'`).
- `beforeEach(() => vi.clearAllMocks())` is mandatory at every `describe` level that has mock state.

## Mocking Strategy

### HTTP — `global.fetch` is mocked, never patched per-call

**Global mock installed once at module top, cleared every test:**
```ts
global.fetch = vi.fn() as unknown as typeof fetch

beforeEach(() => { vi.clearAllMocks() })
```

**Sequential responses** — chain `mockResolvedValueOnce` in the order the SUT calls `fetch`:
```ts
;(global.fetch as ReturnType<typeof vi.fn>)
  .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ token: 'os' }) })
  .mockResolvedValueOnce({ ok: true, json: async () => ({ caseNumber: 'OS-2024-0007' }) })
  .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
```
Order matters and is brittle by design — the contract test deliberately pins the call order. Reference: `tests/cases.contract.test.ts:118-130`.

**URL-routing implementation** for tests where call order is incidental — used in `tests/integration.runtime-parity.test.ts:113-137`:
```ts
fetchMock().mockImplementation(async (input: unknown) => {
  const url = String(input)
  if (url.includes('/comments.json')) return jsonRes({ comments: [...] })
  if (url.includes('/users/show_many.json')) return jsonRes({ users: [...] })
  if (/\/tickets\/123\.json$/.test(url)) return jsonRes({ ticket: { ... } })
  if (url.includes('/api/Authenticate/login')) return textRes(JSON.stringify({ token: 'os-token' }))
  ...
  throw new Error(`unexpected fetch: ${url}`)
})
```
Use the router form when two adapters (Node, Worker) must produce byte-identical responses regardless of incidental call interleaving.

**Mock response shape** — minimum required:
- `{ ok: true, json: async () => ({ ... }) }` for JSON endpoints
- `{ ok: true, text: async () => '...' }` for text/string-token endpoints (OneSystems/GoPro auth)
- `{ ok: false, status: 500, text: async () => 'Server error' }` for upstream failures
- Helper builders: see `jsonRes` / `textRes` / `failRes` in `tests/integration.runtime-parity.test.ts:97-105`.

**Asserting on call args** — read `(global.fetch as ReturnType<typeof vi.fn>).mock.calls[N][1].body` to inspect the request payload (`tests/onesystems.test.ts:151-160`, `tests/gopro.test.ts:128-132`).

### ZAF / Zendesk

**There are no ZAF mocks in this repo.** This is a gateway service, not a ZAF app — there is no `client.request({ secure: true })` proxy. All Zendesk API calls go out via raw `fetch()` to `https://<subdomain>.zendesk.com/api/v2/...` using the tenant's email + API token (Basic auth). They are mocked the same way as doc-system calls (global fetch + sequential responses).

If you came from a ZAF app codebase: drop those mental models here. Look at `tests/zendesk.test.ts` and `tests/zendesk.write.test.ts` for the actual pattern.

### Doc-system clients

Mocked at the `fetch` layer, never at the class layer. **Do not** `vi.mock('../src/onesystems.js')` — drive the real `OneSystemsClient` and stub its outbound HTTP. This way the multipart body construction, XML escaping, base64 encoding, and auth refresh logic all stay under test.

Exception: in `tests/integration.runtime-parity.test.ts:35-47` `vi.mock('node:http', async (importOriginal) => ...)` wraps `createServer` to capture the server instance — the real implementation is forwarded. Use this pattern (wrap, don't replace) when you need a handle on a third-party-created object.

### Cryptography / HMAC (webhook tests)

Webhook tests build a **real** HMAC signature with `crypto.createHmac('sha256', secret)` and a fresh timestamp, so the gate is genuinely passed. From `tests/documentTicket.test.ts:9-31`:
```ts
function makeSignature(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(timestamp + rawBody).digest('base64')
}
```
The header comment explicitly forbids "request stuck at 401 would pass these tests for the wrong reason" — every test asserts its expected non-gate status as a precondition before asserting the contract under test. Replicate this discipline.

### Filesystem (`FileAuditStore`)

Real fs in a `tmpdir`, `mkdtemp` per test, `rm({ recursive: true, force: true })` in `afterEach`. From `tests/fileAuditStore.test.ts:1-16`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fas-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
```

## Fixture / Tenant Config Pattern

A `makeTenantConfig(overrides)` factory is defined per test file, **not shared**. The duplication is deliberate — each test owns its config so a change to one test's tenant shape can't ripple. Template from `tests/cases.contract.test.ts:45-67`:
```ts
function makeTenantConfig(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    brand_id: '360001234567',
    name: 'Test Tenant',
    zendesk: { subdomain: 'test', email: 'test@example.com', apiToken: 'test-token', webhookSecret: 'test-webhook-secret' },
    endpoints: { onesystems: { type: 'onesystems', baseUrl: 'https://api.onesystems.test', appKey: 'test-key', caseNumberFieldId: 42 } },
    malaskra: { apiKey: 'test-malaskra-key' },
    pdf: { companyName: 'Test Company', locale: 'is-IS', includeInternalNotes: false },
    ...overrides
  }
}
```
Variant builders (`goproTenantConfig()` in `tests/cases.contract.test.ts:69-75`) compose via `makeTenantConfig({ endpoints: { gopro: ... } })`.

## Cross-Repo Contract Fixtures

`tests/fixtures/gw06-contract.fixtures.ts` is **the** authoritative wire-contract fixture set for GW-06. Key properties:

1. **No vitest imports** — plain TS data, framework-agnostic.
2. **Derived from `.planning` / GW-06 specs, NOT from `src/cases.ts`.** Every value has a `GW-06 L<n>` or `CTX L<n>` line cite in a comment. Sourcing from the implementation would be circular (test asserts implementation matches itself).
3. **Vendored byte-identical** into the malaskra_v3 repo, which asserts its tolerant zod parser accepts every RESPONSE fixture and rejects every invalid REQUEST fixture. Both ends testing the same fixtures proves the cross-repo seam without wiring the systems.
4. The frozen 7-outcome enum `GW06_OUTCOMES` is a readonly `as const` tuple — order-pinned. Tests assert `RESPONSE_FIXTURES_GW06.map(f => f.body.outcome)` equals it 1:1.

**If `tests/cases.contract.test.ts` fails — DO NOT "fix" the test or the fixtures.** Fix the handler, or coordinate a deliberate GW-06 contract change with the malaskra_v3 side first.

## Unit vs Integration vs Contract — Boundaries

| Kind | Files | What it proves | What it mocks |
|------|-------|----------------|---------------|
| **Unit** | `onesystems.test.ts`, `gopro.test.ts`, `zendesk.test.ts`, `pdf.test.ts`, `tenant.test.ts`, `config.test.ts`, `env.test.ts`, `tenants.config.test.ts`, `fileAuditStore.test.ts`, `postResultToTicket.test.ts` | One class/module in isolation, every branch | `global.fetch` (or real fs for `FileAuditStore`) |
| **Handler / behavior** | `webhook.test.ts`, `cases.test.ts`, `attachments.test.ts`, `documentTicket.test.ts` | End-to-end handler call returns the right `{ status, body }`; locked-order semantics; best-effort swallowing | `global.fetch` (sequential or routed); real HMAC for webhook |
| **Contract** | `cases.contract.test.ts` | GW-06 wire envelope matches canonical fixtures, 7-outcome enum frozen, no PII leak | `global.fetch` |
| **Integration (runtime parity)** | `integration.runtime-parity.test.ts` | Real Node HTTP adapter (`src/index.ts`) and real CF Worker adapter (`src/worker.ts`) produce **byte-identical** responses for the same input | `global.fetch` + routed; wraps `node:http.createServer` to capture the real server |

The runtime-parity test imports the **real** `src/index.ts` (which auto-starts `createServer` on `PORT=0` for an ephemeral loopback port) and the **real** `src/worker.ts`. Both adapters are exercised in-process — no live servers spun beyond `index.ts`'s own.

## "Tested at build time" vs "Tested live in staging"

Per `~/.claude/CLAUDE.md` (Zendesk testing discipline) **and** the established workflow on this repo:

**Tested at build time** (CI gate, blocks merge):
- All unit + handler + contract + runtime-parity tests via Vitest.
- TypeScript compilation via `tsc --noEmit` (run manually; not yet wired into `ci.yml`).
- Wrangler `deploy --dry-run` (`ci.yml:40-46`, `continue-on-error: true` so it warns but doesn't block).
- Coverage upload to Codecov (`test.yml:36-43`, `continue-on-error: true`).

**Tested live in staging — deferred, NOT per-phase:**
- Real Zendesk webhook delivery (HMAC + freshness gate against a real Zendesk webhook secret).
- Real OneSystems / GoPro upstream calls (live auth, real CreateCaseUid + AddDocument2 / Documents/Create round-trips). Foot-guns recorded in `~/.claude/projects/.../memory/live-staging-validation.md` — trailing-slash `baseUrl` 404, OneSystems `WebNumber` template, `wrangler --remote` required.
- Per-brand cross-talk (multi-tenant brand isolation in the real CF KV).
- ZAF settings substitution (this gateway is consumed by Zendesk apps that **do** use ZAF secure settings — those apps' iframe behavior is validated in the consumer repo, not here).
- End-to-end PDF rendering of real Icelandic-content tickets (visual / glyph fidelity).

**Build-time tests MUST NOT depend on real upstream credentials.** Every external HTTP boundary is mocked. Don't add a test that hits a real OneSystems sandbox — defer that to the live-staging window.

## Coverage Tooling & CI Gate

**Codecov:** uploaded by `.github/workflows/test.yml:36-43` from the Node-20.x matrix leg only. Action: `codecov/codecov-action@v4`. File: `./coverage/coverage-final.json`. Flag: `unittests`. `continue-on-error: true` so a Codecov outage doesn't block CI.

**There is NO `codecov.yml`.** This means **the default Codecov project gate applies — it blocks PRs on ANY coverage drop.** This was a real problem (see `~/.claude/projects/.../memory/codecov-project-gate.md`):
- Exclude runtime entrypoints (`src/worker.ts`, `src/index.ts`) from `vitest.config.ts:14-15` — already done — because their coverage is measured only via the runtime-parity test and Codecov undercounts them otherwise.
- Test new modules thoroughly on first PR. A new file landing without tests = guaranteed coverage drop = blocked PR. (`tests/fileAuditStore.test.ts` was added in commit `5a299f0` specifically to clear this gate.)
- The SBOM `name`/`purl` desync caveat from `npm-audit-fix-desync.md` applies to dependency PRs only.

**CI workflows** (both run on push to `main` + PRs to `main`):
- `.github/workflows/test.yml` — matrix Node 20.x + 22.x, runs `npm test`, then `npm run test:coverage`, then uploads to Codecov from the 20.x leg.
- `.github/workflows/ci.yml` — single Node 20, runs `npx vitest run` (sanity), then `wrangler deploy --dry-run` (only on `main`, `continue-on-error: true`).
- `.github/workflows/test.yml:45-64` has a `lint` job that's currently a no-op (`echo "No linter configured yet"`, `continue-on-error: true`). Don't rely on it.

## Test Patterns to Replicate When Adding a Doc-System Adapter

Concrete walk-through for the new-adapter case.

### 1. `tests/<system>.test.ts` — the unit suite

Copy `tests/gopro.test.ts` as the skeleton (the simpler of the two existing adapters). You must cover:

- **constructor:** properties set correctly, defaults applied when options omitted.
- **`authenticate`:** correct endpoint URL, correct request body shape, stores token + sets `tokenExpiry`, throws `<System> auth failed: <status>` on `!response.ok`. Handle each token-response format the upstream actually returns (string, `{ token }`, `{ accessToken }` — see `tests/onesystems.test.ts:36-83`).
- **`ensureAuthenticated`:** auth-on-cold-start, skip-when-fresh, re-auth-when-expired. Three tests.
- **`uploadDocument`:** correct URL, headers including `Authorization: Bearer <token>`, request body shape, auth happens before upload when token absent, throws on `!response.ok` with the upstream body appended, throws on `succeeded: false` semantic failures.
- **`createCase`** (if supported): correct payload shape, throws on `!response.ok`, throws on missing case number in response, kennitala normalization.

Sequential `mockResolvedValueOnce` chain — auth first, then operation. Pre-set `client.token = 'valid-token'; client.tokenExpiry = Date.now() + 60_000` in a nested `beforeEach` for the operation describe block so you don't have to chain the auth mock in every test.

### 2. `tests/cases.test.ts` — add scenarios through the gateway

If the new adapter supports `createCase`, add a `documented` happy-path test through `handleCases`. If it doesn't, the existing `RES_GOPRO_CREATE_UNSUPPORTED` path covers it generically (the duck-typed capability check in `src/cases.ts:178-180` means any adapter without `createCase` falls through to 422 automatically).

### 3. `tests/cases.contract.test.ts` — usually NO change

GW-06 is wire-format agnostic to the doc-system. A new adapter doesn't change the envelope. **Only edit this file if GW-06 itself is amended** — and then only after coordinating with malaskra_v3. The contract test's job is to detect drift, not adapt to it.

### 4. `tests/integration.runtime-parity.test.ts` — add a parity scenario if the adapter has a distinct code path

If the new adapter shares the OneSystems-style mint+upload flow, the existing 7 scenarios already cover the gateway behavior. If it has a meaningfully different shape (e.g., async upload with polling), add a scenario asserting Node vs Worker parity.

### 5. Coverage check

```bash
npm run test:coverage
open coverage/index.html
```
Verify your new `src/<system>.ts` shows green. The Codecov project gate will block the PR otherwise.

## Common Patterns

### Async testing
`async/await` throughout. Never `.then()` chains. `await expect(...).rejects.toThrow(...)` for error assertions:
```ts
await expect(client.authenticate()).rejects.toThrow('OneSystems auth failed: 401')
```

### Body inspection
```ts
const callBody = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
expect(callBody).toContain('name="CaseNumber"')
// or for JSON bodies:
const parsed = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
expect(parsed.caseNumber).toBe('CASE-123')
```

### Multipart assertions
Don't try to parse multipart bodies — `expect(callBody).toContain('name="<field>"')` plus `expect(callBody).toContain('<expected value>')` is the convention (`tests/onesystems.test.ts:151-161`).

### Error-precedence tests
When two errors could fire, write a test that triggers BOTH conditions and asserts which wins. Reference the comment in `src/documentTicket.ts:311-314` for the rationale.

### Best-effort assertions
For best-effort side-effects (audit, GW-01 finalizer), test BOTH branches: the side-effect succeeds and updates state; the side-effect throws and is swallowed, leaving the HTTP response unchanged. `tests/postResultToTicket.test.ts` is the template.

### Env vars
The runtime-parity test (`tests/integration.runtime-parity.test.ts:75-86`) saves & restores `process.env` around the test run. Always save → mutate → restore in `afterAll` so concurrent / subsequent files don't see leaked state.

---

*Testing analysis: 2026-05-21*
