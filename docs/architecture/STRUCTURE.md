# Codebase Structure

**Analysis Date:** 2026-05-21
**Audience:** TS/Node engineer about to add a new doc-system adapter (Workpoint), following the existing OneSystems/GoPro pattern.

## Directory Layout

```
milli-mala-multi-tenant/
├── src/                       # All production TypeScript
│   ├── worker.ts              # Cloudflare Worker entrypoint (KV-backed tenants)
│   ├── index.ts               # Node http server entrypoint (env-backed tenants)
│   ├── webhook.ts             # POST /v1/webhook handler (HMAC, freshness, delegate)
│   ├── cases.ts               # POST /v1/cases handler (manual create/append, GW-06)
│   ├── attachments.ts         # POST /v1/attachments handler (manual attachment forwarding)
│   ├── documentTicket.ts      # Documentation pipeline stages + orchestrator
│   ├── postResultToTicket.ts  # GW-01 best-effort post-back (note + custom fields) + recordOutcome
│   ├── docClient.ts           # Factory: EndpointConfig → DocClient (ONLY ep.type switch)
│   ├── onesystems.ts          # OneSystems adapter (uploadDocument + createCase)
│   ├── gopro.ts               # GoPro adapter (uploadDocument only, multi-file)
│   ├── zendesk.ts             # Zendesk REST client (read + requestWrite/PUT)
│   ├── pdf.ts                 # jsPDF ticket renderer
│   ├── tenant.ts              # Tenant store interfaces + validators + SSRF guard
│   ├── tenants.config.ts      # Tenant definitions for Node path (env-built)
│   ├── fileAuditStore.ts      # File-backed AuditStore (Node deployments)
│   ├── env.ts                 # requireEnv (fail-fast secret loader)
│   ├── config.ts              # Instance-level (non-tenant) config singleton
│   ├── logger.ts              # Structured JSON logger
│   └── types.ts               # All shared TypeScript interfaces/types
├── tests/                     # Vitest unit + contract tests (mirror src/ filenames)
│   ├── fixtures/              # Shared test data (e.g., gw06-contract.fixtures.ts)
│   ├── *.test.ts              # Per-module unit tests
│   ├── cases.contract.test.ts # GW-06 wire-contract assertions
│   └── integration.runtime-parity.test.ts  # Worker vs Node parity check
├── .github/workflows/         # CI: test.yml (vitest), ci.yml, deploy.yml (wrangler deploy)
├── .planning/                 # Local-only GSD planning artifacts (gitignored)
│   ├── codebase/              # This map (ARCHITECTURE.md, STRUCTURE.md)
│   ├── phases/                # Per-phase plans (01-g1, 02-g2, 03-g3)
│   └── pr-artifacts/          # PR drafts
├── .wrangler/                 # Local miniflare state (gitignored)
├── coverage/                  # Vitest v8 coverage output (gitignored)
├── dist/                      # tsc output (gitignored)
├── package.json               # npm scripts + jspdf dep only (Workers-friendly)
├── tsconfig.json              # TS config (ESM, node:* allowed)
├── vitest.config.ts           # Vitest config (coverage gate)
├── wrangler.toml              # Cloudflare config (main=src/worker.ts, KV bindings, nodejs_compat)
├── Dockerfile                 # Node container build
├── docker-compose.yml         # Local Node stack
├── entrypoint.sh              # Container entrypoint
├── tenants.json               # Local seed for KV bulk-write (contains secrets — gitignored)
├── .env.example               # Template of all required env vars for Node deploy
├── README.md                  # High-level repo overview
├── DEPLOYMENT.md              # Deploy runbook (KV seed, wrangler, secrets)
├── HANDOVER.md                # Session handoff notes
└── sbom.json                  # CycloneDX SBOM
```

## Directory Purposes

**`src/`:**
- Purpose: All production code. Flat layout — no subdirectories. Filename = module = concern.
- Contains: 20 `.ts` files (3 entrypoints, 3 handlers, 6 infrastructure modules, 2 adapters, 1 factory, types, helpers).
- Key files: `worker.ts`, `index.ts`, `docClient.ts`, `tenant.ts`, `types.ts`.

**`tests/`:**
- Purpose: Vitest tests; one `*.test.ts` per `src/*.ts` module, plus `*.contract.test.ts` for wire-contract guarantees and a `runtime-parity` integration test.
- Contains: All tests use `global.fetch = vi.fn()` to mock outbound HTTP. No live network.
- Key files: `cases.contract.test.ts` (locks GW-06 envelope), `onesystems.createCase.test.ts` (locks OneSystems wire bytes).

**`tests/fixtures/`:**
- Purpose: Reusable test data shared across tests.
- Contains: `gw06-contract.fixtures.ts` and similar.

**`.planning/`:**
- Purpose: GSD planning artifacts. Local-only; gitignored.
- Contains: `PROJECT.md`, `ROADMAP.md`, `STATE.md`, `REQUIREMENTS.md`, `codebase/`, `phases/`, `pr-artifacts/`.
- Not consumed by runtime.

**`.github/workflows/`:**
- Purpose: GitHub Actions.
- Contains: `ci.yml`, `test.yml` (vitest + coverage), `deploy.yml` (wrangler).

## Key File Locations

**Entry Points:**
- `src/worker.ts`: Cloudflare Workers entry. Routes + KV tenant lookup. Configured as `main` in `wrangler.toml:2`.
- `src/index.ts`: Node http entry. Routes + file-tenant lookup. Re-exports `handleWebhook`/`handleAttachments`/`handleCases` for cloud-function imports.

**Configuration (build/deploy):**
- `wrangler.toml`: CF deployment, KV namespace IDs (staging populated), `nodejs_compat` flag — load-bearing for `node:crypto`.
- `tsconfig.json`: ESM, strict.
- `vitest.config.ts`: Coverage gate (test runtime).
- `package.json`: `type: module`, only runtime dep is `jspdf`. Node >=20.
- `.env.example`: Template of all `requireEnv` keys consumed by `src/tenants.config.ts`.

**Configuration (runtime):**
- `src/config.ts`: Instance-level singleton (`port`, `logLevel`, `auditSecret`). Built once from `process.env`.
- `src/tenants.config.ts`: The list of tenants and which env vars supply their secrets. **Edit here when onboarding a new tenant (Node deploy).**
- `tenants.json`: Local seed file used by `DEPLOYMENT.md` instructions to bulk-write to `TENANT_KV` for the Workers deploy. Contains secrets → gitignored, never read at runtime.

**Routing (where each `POST /v1/*` is dispatched):**
- `src/worker.ts:51-228`: CF route table for `/v1/health`, `/v1/webhook`, `/v1/attachments`, `/v1/cases`, `/v1/audit`.
- `src/index.ts:217-221`: Node route table (same paths).

**Tenant resolution + validation:**
- `src/tenant.ts:41-58`: `KvTenantStore` (CF path).
- `src/tenant.ts:62-77`: `FileTenantStore` (Node path).
- `src/tenant.ts:86-106`: `resolveTenantConfig` — single fail-closed entry point.
- `src/tenant.ts:112-158`: `validateTenantConfig` + `validateEndpoint` (SSRF guard, subdomain pattern).
- `src/tenant.ts:203-209`: `resolveEndpoint` — `tenantConfig.endpoints[docEndpoint]` lookup.
- `src/tenant.ts:225-230`: `validateCaseNumber` — applies to `case_number` on the wire.

**Doc-system adapters + factory:**
- `src/docClient.ts:14-30`: `createDocClient(ep, user?)` — **THE ONLY `ep.type` switch.**
- `src/onesystems.ts:45-210`: `OneSystemsClient` class. `authenticate`, `uploadDocument` (multipart), `createCase` (JSON).
- `src/gopro.ts:10-98`: `GoProClient` class. `authenticate`, `uploadDocument` (per-file loop, no `createCase`).

**Documentation pipeline (shared stages):**
- `src/documentTicket.ts:51-104`: `fetchTicketInfo` — owns the brand cross-check.
- `src/documentTicket.ts:109-119`: `renderPdf`.
- `src/documentTicket.ts:126-145`: `resolveCaseNumber` (webhook path; uses `ep.caseNumberFieldId` or `ZD-${ticketId}`).
- `src/documentTicket.ts:153-170`: `postToCase` — single `docClient.uploadDocument` call.
- `src/documentTicket.ts:177-259`: `writeAudit` — best-effort 2-key KV write, 90-day TTL.
- `src/documentTicket.ts:274-414`: `documentTicket` orchestrator (webhook-only full pipeline).

**Post-back (GW-01 finalization):**
- `src/postResultToTicket.ts:60-84`: `buildNote` (Icelandic ✅/❌ template).
- `src/postResultToTicket.ts:97-110`: `buildLastStatusValue` (compact JSON v1 cross-repo contract).
- `src/postResultToTicket.ts:122-149`: `buildCustomFields` (reads per-endpoint field IDs).
- `src/postResultToTicket.ts:156-195`: `postResultToTicket` — single atomic PUT, never throws.
- `src/postResultToTicket.ts:205-244`: `recordOutcome` — once-per-request finalizer (writeAudit + postResultToTicket).

**Zendesk client:**
- `src/zendesk.ts:14-16`: Constructor + basic-auth header.
- `src/zendesk.ts:19-27`: `request` (GET).
- `src/zendesk.ts:29-43`: `requestWrite` (PUT/POST) — used by GW-01 post-back.
- `src/zendesk.ts:45-55`: `setTicketCustomField` — one-field PUT helper.
- `src/zendesk.ts:57-76`: `getTicket`, `getTicketComments`, `getUser`, `getUsersMany`.
- `src/zendesk.ts:78+`: `fetchAttachments` (downloads with `failed[]` sidecar).

**PDF:**
- `src/pdf.ts:14`: `generateTicketPdf(ticket, comments, { pdfConfig, userMap })` — pure function, returns Buffer.

**Error mapping:**
- Per-handler outer catch returns 500 `{ error: 'Internal server error', duration_ms }`. See `src/cases.ts:353-359`, `src/attachments.ts:204-207`, `src/webhook.ts:73-76`.
- GW-06 envelope codes (cases path): `src/cases.ts` returns explicit `{ ok: false, outcome, error }` per failure mode. Codes locked in `src/cases.ts` JSDoc lines 14-18.

**Audit store:**
- `src/types.ts:181-185`: `AuditStore` interface (`put`/`get`/`list`).
- Cloudflare implementation: KV binding from `wrangler.toml` (`AUDIT_LOG`), no custom code.
- Node implementation: `src/fileAuditStore.ts:19-89` (one JSON file per key under `./audit-data/`).

**Tests:**
- `tests/onesystems.test.ts`, `tests/onesystems.createCase.test.ts`: OneSystems wire contract.
- `tests/gopro.test.ts`: GoPro wire contract.
- `tests/cases.contract.test.ts` + `tests/fixtures/gw06-contract.fixtures.ts`: GW-06 envelope assertions.
- `tests/integration.runtime-parity.test.ts`: Worker and Node entries produce the same `HandlerResult` for the same input.
- `tests/tenant.test.ts`, `tests/tenants.config.test.ts`: validator + SSRF guard + env loader.

## Naming Conventions

**Files:**
- One concern per file. Filename matches the primary export's domain (e.g., `onesystems.ts` exports `OneSystemsClient`).
- Lowercase. camelCase for multi-word (`docClient.ts`, `documentTicket.ts`, `postResultToTicket.ts`, `fileAuditStore.ts`).
- Tests mirror source: `src/cases.ts` ↔ `tests/cases.test.ts`. Contract tests append `.contract`: `tests/cases.contract.test.ts`.

**Directories:**
- Flat. No subdirectories under `src/`. Adapters are NOT in their own folder. **Do not introduce `src/adapters/`** — the convention is flat.

**Types:**
- All shared types in `src/types.ts`. PascalCase. Section comment dividers (`// ─── Section ───`).

**Imports:**
- All intra-repo imports use `./*.js` extensions (ESM + Workers requirement). When adding `src/workpoint.ts`, import it as `from './workpoint.js'`.

## Where to Add New Code

### Adding a new doc-system adapter — Workpoint walkthrough

Read these files in this order before touching anything:

1. **`src/types.ts`** — Skim sections `Tenant Configuration` and `Document System Types`. You will widen one union and may add fields to one interface.
2. **`src/docClient.ts`** — The whole file (30 lines). This is the ONE file that must learn about Workpoint.
3. **`src/onesystems.ts`** (210 lines) — Read end to end. Note the auth-token caching pattern (`ensureAuthenticated`), the `DocClient` implementation, the optional `createCase` method, and the no-tokens-in-error-messages discipline (`src/onesystems.ts:167`).
4. **`src/gopro.ts`** (98 lines) — Read end to end for the simpler shape (only `uploadDocument`).
5. **`src/tenant.ts:160-197`** — `validateEndpoint`. You will add a `workpoint` branch checking whatever credentials it needs.
6. **`src/cases.ts:178-185`** — Confirm you understand duck-typed capability detection. If Workpoint supports `createCase` you do nothing here; if it doesn't, the existing 422 `gopro_create_unsupported` path will fire (despite the name, the code is generic).
7. **`src/postResultToTicket.ts`** — Skim. The post-back reads `ep.caseNumberFieldId`, `ep.lastStatusFieldId`, `ep.lastExportFieldId`, `ep.templateFieldId` generically — Workpoint inherits this for free.
8. **`tests/onesystems.test.ts` + `tests/onesystems.createCase.test.ts`** — Mirror these for `tests/workpoint.test.ts`. The pattern uses `global.fetch = vi.fn()` + per-test `mockResolvedValueOnce`.

Then make these edits, in this order:

1. **`src/types.ts:25`** — Widen `EndpointConfig.type`:
   ```ts
   type: 'onesystems' | 'gopro' | 'workpoint'
   ```
   Add any Workpoint-specific credential fields below the existing OneSystems/GoPro ones.

2. **New file `src/workpoint.ts`** — Create a `WorkpointClient` class implementing `DocClient`. Mirror `src/gopro.ts` shape if the API is simple, `src/onesystems.ts` if it needs multipart. Token TTL default 25 minutes (`25 * 60 * 1000`).

3. **`src/docClient.ts:14-30`** — Add a third branch:
   ```ts
   if (ep.type === 'workpoint') {
     if (!ep.<credField>) throw new Error('Workpoint endpoint missing <credField>')
     return new WorkpointClient(ep.baseUrl, ep.<credField>, { tokenTtlMs: ep.tokenTtlMs })
   }
   ```

4. **`src/tenant.ts:185-192`** — Add a branch in `validateEndpoint`:
   ```ts
   } else if (ep.type === 'workpoint') {
     if (!ep.<credField>) missing.push('<credField>')
   ```
   Update the `unknown type` error message (line 191) to list `workpoint`.

5. **`src/tenants.config.ts`** — Add a sample `workpoint:` endpoint to one tenant if you have credentials, OR document the new env-var names in `.env.example`. New env var names should follow the `<TENANT>_WORKPOINT_<FIELD>` pattern.

6. **New test `tests/workpoint.test.ts`** — Mirror `tests/onesystems.test.ts`. Mock `global.fetch`. Assert exact wire bytes (URL, method, headers, body shape). If Workpoint supports `createCase`, add a `tests/workpoint.createCase.test.ts` mirroring the existing one.

7. **(Optional) `tests/cases.contract.test.ts`** — If Workpoint supports `createCase`, add a fixture row; if not, the existing `gopro_create_unsupported` test already covers the duck-typed fallback.

**Files you should NOT need to touch:**

- `src/worker.ts`, `src/index.ts` — runtime adapters, doc-system-agnostic.
- `src/webhook.ts`, `src/cases.ts`, `src/attachments.ts` — handlers program against `DocClient`, not `ep.type`.
- `src/documentTicket.ts`, `src/postResultToTicket.ts` — pipeline and post-back are generic.
- `src/zendesk.ts`, `src/pdf.ts`, `src/logger.ts`, `src/config.ts`, `src/env.ts` — orthogonal.

If you find yourself editing any of those, step back: you are probably reaching for the `ep.type` anti-pattern (see `ARCHITECTURE.md` → Anti-Patterns) when a duck-typed capability check or an interface method would do.

### New feature (non-adapter)

- Cross-cutting (logging, error mapping, SSRF policy): `src/tenant.ts` or `src/logger.ts`; never per-handler.
- New endpoint (new `POST /v1/*`): create `src/<name>.ts` exporting `handle<Name>({ body, headers, tenantConfig, docEndpoint }): Promise<HandlerResult>`, then wire two routes — one in `src/worker.ts`, one in `src/index.ts`. Add `tests/<name>.test.ts`.

### Utilities

- Shared low-level helpers: prefer adding to the closest existing module. The repo's discipline is "no `utils/` grab bag." If you genuinely need a new module, name it after its single concern.

## Special Directories

**`.wrangler/`:**
- Purpose: Local miniflare runtime state (CF KV emulation under `.wrangler/state/v3/kv/...`).
- Generated: Yes (by `wrangler dev`).
- Committed: No.

**`dist/`:**
- Purpose: `tsc` output. The CF deploy uses `wrangler deploy` against `src/worker.ts` directly; `dist/` is only for type-check / Docker builds.
- Generated: Yes.
- Committed: No.

**`coverage/`:**
- Purpose: Vitest v8 coverage output (`coverage/coverage-final.json`).
- Generated: Yes (`npm run test:coverage`).
- Committed: No.

**`.planning/`:**
- Purpose: GSD planning artifacts (this file lives here).
- Generated: Yes (by you / planning commands).
- Committed: No (local-only).

**`node_modules/`:** standard. Gitignored.

---

*Structure analysis: 2026-05-21*
