<!-- refreshed: 2026-05-21 -->
# Architecture

**Analysis Date:** 2026-05-21
**Audience:** TS/Node engineer about to add a new doc-system adapter (Workpoint), following the existing OneSystems/GoPro pattern.

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                        Zendesk (per brand / per tenant)                  │
│  ┌─────────────────────────┐         ┌────────────────────────────────┐ │
│  │  Malaskrá ZAF iframe    │         │  Trigger / Webhook             │ │
│  │  (sidebar app, manual)  │         │  (automatic on ticket close)   │ │
│  │  Calls gateway over     │         │  POSTs to gateway with         │ │
│  │  HTTPS w/ X-Api-Key     │         │  HMAC-SHA256 signature header  │ │
│  └─────────────┬───────────┘         └─────────────┬──────────────────┘ │
└────────────────┼─────────────────────────────────────┼──────────────────┘
                 │                                     │
                 │  POST /v1/cases                     │  POST /v1/webhook
                 │  POST /v1/attachments               │
                 ▼                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                Gateway Worker (this repo: milli-mala)                    │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Entrypoint (per-runtime adapter)                                   │  │
│  │   `src/worker.ts`  ← Cloudflare Workers (KV-backed tenants)        │  │
│  │   `src/index.ts`   ← Node http server (file-backed tenants)        │  │
│  │   Body parse + size cap (1 MB) + tenant resolution + dispatch      │  │
│  └─────────────┬───────────────────────┬──────────────────────────────┘  │
│                │                       │                                 │
│                ▼                       ▼                                 │
│  ┌────────────────────────┐   ┌────────────────────────┐                │
│  │ Tenant resolution      │   │ Handlers (HTTP-agnostic)│                │
│  │ `src/tenant.ts`        │   │ `src/webhook.ts`        │                │
│  │ - KvTenantStore        │   │ `src/cases.ts`          │                │
│  │ - FileTenantStore      │   │ `src/attachments.ts`    │                │
│  │ - validateTenantConfig │   │ Return { status, body } │                │
│  └────────────────────────┘   └──────────┬─────────────┘                │
│                                          │                              │
│                                          ▼                              │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ Pipeline stages (`src/documentTicket.ts`)                       │    │
│  │  fetchTicketInfo → renderPdf → createDocClient                  │    │
│  │   → (createCase?) → postToCase → recordOutcome                  │    │
│  └─────────────┬───────────────────────┬───────────────────────────┘    │
│                │                       │                                │
│                ▼                       ▼                                │
│  ┌──────────────────────┐   ┌────────────────────────────────────────┐ │
│  │ Zendesk client       │   │ DocClient factory                       │ │
│  │ `src/zendesk.ts`     │   │ `src/docClient.ts`                      │ │
│  │  - getTicket         │   │  switch on ep.type → adapter instance   │ │
│  │  - getTicketComments │   │  (the ONLY adapter switch in the code)  │ │
│  │  - fetchAttachments  │   └─────┬───────────────────┬───────────────┘ │
│  │  - getUsersMany      │         │                   │                 │
│  │  - requestWrite      │         ▼                   ▼                 │
│  │    (PUT for GW-01    │   ┌───────────────┐  ┌────────────────┐      │
│  │     post-back)       │   │ OneSystems    │  │ GoPro          │      │
│  └──────────┬───────────┘   │ `onesystems.ts│  │ `gopro.ts`     │      │
│             │               │  uploadDoc +  │  │  uploadDoc only│      │
│             │               │  createCase   │  │  (multi-file)  │      │
│             │               └───────┬───────┘  └────────┬───────┘      │
│             │                       │                   │              │
│             ▼                       ▼                   ▼              │
│  ┌──────────────────┐    ┌───────────────────────────────────┐         │
│  │ PDF rendering    │    │ Audit store                       │         │
│  │ `src/pdf.ts`     │    │ `src/fileAuditStore.ts` (Node) /  │         │
│  │ (jsPDF)          │    │ CF KV (Workers, env.AUDIT_LOG)    │         │
│  └──────────────────┘    └───────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────────┘
                 │                                     │
                 ▼                                     ▼
        Zendesk Tickets API                  External Archive Systems
        (read/write, GW-01 PUT)              OneSystems / GoPro / …
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Worker entrypoint (CF) | HTTP routing, size cap, KV tenant lookup, audit endpoint | `src/worker.ts` |
| Node entrypoint | HTTP routing (http server), file tenant lookup, audit endpoint | `src/index.ts` |
| Tenant store + validators | Resolve `brand_id` → `TenantConfig`, SSRF/subdomain guards | `src/tenant.ts` |
| Tenant config builder | Define which tenants exist, pull secrets from env vars | `src/tenants.config.ts` |
| Webhook handler | HMAC verify + freshness + delegate to pipeline | `src/webhook.ts` |
| Cases handler (manual create/append) | GW-06 envelope, exactly-one-of `create` XOR `case_number`, orphan_case safety | `src/cases.ts` |
| Attachments handler (manual forwarding) | Fetch ZD attachments, forward each via `docClient.uploadDocument` | `src/attachments.ts` |
| Documentation pipeline | Composable stages (fetch/render/upload), shared by all 3 handlers | `src/documentTicket.ts` |
| Result post-back (GW-01) | Best-effort internal note + custom-field stamping after each outcome | `src/postResultToTicket.ts` |
| DocClient factory | Build the right adapter from `EndpointConfig.type` | `src/docClient.ts` |
| OneSystems adapter | `authenticate`, `uploadDocument` (multipart), `createCase` | `src/onesystems.ts` |
| GoPro adapter | `authenticate`, `uploadDocument` (per-file POSTs) — no `createCase` | `src/gopro.ts` |
| Zendesk client | REST GET helpers + `requestWrite` (PUT/POST) + `setTicketCustomField` | `src/zendesk.ts` |
| PDF generator | Render `ZendeskTicket + ZendeskComment[]` → `Buffer` (jsPDF) | `src/pdf.ts` |
| Audit store (Node) | File-backed `AuditStore` (KV-shaped interface) | `src/fileAuditStore.ts` |
| Logger | Structured JSON to stdout (severity/component/timestamp) | `src/logger.ts` |
| Instance config | Non-tenant runtime config (port, log level, audit secret) | `src/config.ts` |
| Env reader | `requireEnv` fail-fast for tenant secrets | `src/env.ts` |
| Shared types | `TenantConfig`, `EndpointConfig`, `DocClient`, `DocumentationOutcome`, … | `src/types.ts` |

## Pattern Overview

**Overall:** Layered request gateway with a per-doc-system adapter (Strategy) selected by tenant config. Twin runtime entrypoints (Cloudflare Workers + Node http) share a single HTTP-agnostic handler core.

**Key Characteristics:**
- **Adapter pattern at exactly one seam.** `createDocClient(ep)` in `src/docClient.ts` is the ONLY place that switches on `ep.type`. Every other layer programs against the `DocClient` interface in `src/types.ts`.
- **Capability checks are duck-typed, never `ep.type`-typed.** See `src/cases.ts:178-180` — `typeof (docClient as Partial<OneSystemsClient>).createCase === 'function'`. Add new adapter capabilities by adding a method, not a `type` branch.
- **HTTP-agnostic core.** Handlers accept `{ body, headers, tenantConfig, docEndpoint }` and return `{ status, body }`. Both `worker.ts` and `index.ts` adapt their runtime to this shape.
- **Best-effort side effects.** Audit writes (`writeAudit`) and ticket post-back (`postResultToTicket`) never throw. Their failure must not change the HTTP response — GW-01 mandate.
- **Fail-closed tenant resolution.** Missing brand, malformed config, mismatched ticket brand, or private-IP `baseUrl` all reject the request before any external call.

## Layers

**Runtime adapter (entry):**
- Purpose: Translate platform request shape (CF `Request` / Node `IncomingMessage`) into the canonical handler input
- Location: `src/worker.ts`, `src/index.ts`
- Contains: routing, body size cap (1 MB), JSON parse, brand_id + doc_endpoint extraction, audit endpoint auth (sha256 + `timingSafeEqual`)
- Depends on: handler core, tenant store
- Used by: external HTTPS callers (Zendesk webhook, Malaskrá ZAF iframe)

**Tenant resolution:**
- Purpose: `brand_id` → validated `TenantConfig`; reject anything else
- Location: `src/tenant.ts`, `src/tenants.config.ts`
- Contains: `KvTenantStore`, `FileTenantStore`, `validateTenantConfig`, `validateEndpoint` (HTTPS-only, blocks RFC1918 / loopback / IPv6 literal / localhost), `resolveEndpoint`, `validateCaseNumber`, `sanitizeAuditParam`
- Depends on: env vars (Node path) or KV namespace (Worker path)
- Used by: every handler before invoking any adapter

**Handler core (HTTP-agnostic):**
- Purpose: Per-route auth + validation + pipeline orchestration; return canonical `HandlerResult`
- Location: `src/webhook.ts`, `src/cases.ts`, `src/attachments.ts`
- Contains: auth (HMAC for webhook, sha256-compared X-Api-Key for cases/attachments), input validation, brand cross-check, GW-06 envelope (cases only)
- Depends on: documentation pipeline, doc-client factory, Zendesk client
- Used by: runtime adapters only

**Documentation pipeline (stages):**
- Purpose: Reusable async stages composed differently by each handler
- Location: `src/documentTicket.ts`
- Contains: `fetchTicketInfo` (owns the brand cross-check), `renderPdf`, `resolveCaseNumber`, `postToCase`, `writeAudit`, plus the orchestrator `documentTicket()` used by the webhook path
- Depends on: Zendesk client, doc-client factory, PDF generator, audit store
- Used by: `webhook.ts` (full orchestrator), `cases.ts` (à-la-carte stages), `attachments.ts` (its own loop but same audit/post-back)

**Doc system adapters (Strategy):**
- Purpose: Speak the wire protocol of one archive system
- Location: `src/onesystems.ts`, `src/gopro.ts`; constructed via `src/docClient.ts`
- Contains: bearer-token auth + caching (25 min default), `uploadDocument`, optional `createCase`
- Depends on: nothing else in this repo; pure fetch + `EndpointConfig` fields
- Used by: handlers via `DocClient` interface only

**Post-back / audit (GW-01 finalization):**
- Purpose: Once-per-request best-effort side effects after any terminal outcome
- Location: `src/postResultToTicket.ts`, `writeAudit` in `src/documentTicket.ts`
- Contains: `buildNote` (Icelandic ✅/❌ template), `buildLastStatusValue` (compact JSON v1), `buildCustomFields` (per-endpoint field IDs), `recordOutcome`
- Depends on: Zendesk client (`requestWrite` PUT), audit store
- Used by: all 3 handlers at every terminal point (success, orphan, failure)

## Data Flow

### Primary: `POST /v1/cases` — manual documentation (Malaskrá ZAF iframe → gateway)

End-to-end critical path, the path you most need to understand before adding Workpoint:

1. **ZAF iframe call** — Malaskrá sidebar issues `client.request({ secure: true, ... })`; Zendesk proxy substitutes the per-brand `X-Api-Key` and forwards to gateway. Body: `{ ticket_id, brand_id, doc_endpoint, create?|case_number? }`.
2. **Runtime adapter** parses + size-caps body (`src/worker.ts:148-170` or `src/index.ts:136-166`).
3. **Tenant resolution** — `resolveTenantConfig(brand_id, store)` (`src/tenant.ts:86`). Returns `null` on missing/invalid → 400.
4. **Handler gate** (`src/cases.ts:74-134`):
   - `verifyApiKey` — sha256 + `timingSafeEqual` of header vs `tenantConfig.malaskra.apiKey`
   - Validate `ticket_id` (positive int)
   - Enforce exactly-one-of `create` XOR `case_number`
   - On `create` path: validate `body.create.onesystems.{caseTemplate, kennitala}` (note: GW-06 backend-namespaced)
   - On `case_number` path: `validateCaseNumber`
   - `resolveEndpoint(tenantConfig, docEndpoint)` — looks up `tenantConfig.endpoints[docEndpoint]`
5. **`fetchTicketInfo`** (`src/documentTicket.ts:51`) — ticket + comments + attachments + author resolution + brand cross-check. Returns the GW-06 `brand_mismatch` envelope on mismatch.
6. **`renderPdf`** (`src/documentTicket.ts:109`) — jsPDF.
7. **`createDocClient(ep, solvingAgentEmail)`** (`src/docClient.ts:14`) — **the only `ep.type` branch in the codebase**.
8. **Create path only:** duck-typed capability check (`typeof docClient.createCase === 'function'`). If unsupported → 422 `gopro_create_unsupported`. Otherwise call `createCase` → latch `createdCaseNumber`. Failure → 502 `create_failed` (nothing minted, safe to retry).
9. **Stamp** the new case number into `ticket.custom_fields[ep.caseNumberFieldId]` via `ZendeskClient.setTicketCustomField` (create path only).
10. **`postToCase`** (`src/documentTicket.ts:153`) — `docClient.uploadDocument({ caseNumber, filename, pdfBuffer, attachments, metadata })`.
11. **Inner-catch policy:** if `postToCase` throws on the create path → 207 `orphan_case` (case# returned to caller so it can't be lost); on `case_number` path → rethrow → outer 500.
12. **`recordOutcome`** (`src/postResultToTicket.ts:205`) — writes audit entry + PUTs ticket with internal note + custom fields (`caseNumberFieldId`, `templateFieldId`, `lastStatusFieldId`, `lastExportFieldId`). Best-effort.
13. **200 GW-06 envelope** `{ ok: true, outcome: 'documented', caseNumber }`.

### Secondary: `POST /v1/attachments` — manual attachment forwarding

1. ZAF iframe sends `{ ticket_id, brand_id, doc_endpoint, case_number }` with `X-Api-Key`.
2. `verifyApiKey` → validate inputs → `resolveEndpoint`.
3. `ZendeskClient.getTicket` + brand cross-check (`src/attachments.ts:114-133`).
4. `getTicketComments` + `fetchAttachments`. Empty → 200 (and post-back with zero forwarded).
5. `createDocClient(ep)` then loop: for each attachment, `docClient.uploadDocument({ caseNumber, filename, pdfBuffer: att.data, metadata })`. Individual failures collected into `errors[]`, not thrown.
6. `finalizePostBack` → `postResultToTicket` (no `writeAudit` recursion; audit happens via `recordOutcome` only in the cases/webhook paths).
7. 200 with `{ success, ticket_id, brand_id, case_number, attachments_total, attachments_forwarded, errors? }`.

### Tertiary: `POST /v1/webhook` — automatic archival on ticket close

1. Zendesk webhook sends body with `X-Zendesk-Webhook-Signature` + `-Timestamp` headers.
2. `verifyWebhookSignature` (HMAC-SHA256, `timingSafeEqual`) + `isTimestampFresh` (±5 min) — `src/webhook.ts:19-39`.
3. Delegate to `documentTicket(req, ticketId, startTime)` — the full pipeline orchestrator (`src/documentTicket.ts:274`).
4. `fetchTicketInfo` → `renderPdf` → `createDocClient` → `resolveCaseNumber` (custom-field lookup with `ZD-${ticketId}` fallback) → `postToCase` → `recordOutcome` (with `intent: 'webhook'` so the persisted audit entry stays byte-identical to the pre-G4 shape).
5. Failure mid-pipeline → best-effort failure post-back, then rethrow → outer 500.

### State Management

- **No in-memory state across requests** apart from doc-client auth-token caches (one client is constructed per request, so cache is single-request only).
- **All cross-request state lives in KV** (Workers) or **the filesystem** (`./audit-data/` for Node) via the `AuditStore` interface.
- **Tenant configs are loaded once at startup** for Node (`loadTenants` in `src/index.ts:37`) and per-request from KV for Workers.

## Key Abstractions

**`TenantConfig`** (`src/types.ts:7`):
- Single source of truth for a tenant's wiring: Zendesk creds, named endpoints, Malaskrá API key, PDF settings.
- One tenant per Zendesk brand. Per-Zendesk-account custom-field IDs live inside each `EndpointConfig` (note: NOT per-brand — see `~/.claude/CLAUDE.md` Zendesk Development rule).

**`EndpointConfig`** (`src/types.ts:23`):
- Discriminator: `type: 'onesystems' | 'gopro'`. **Add `'workpoint'` here when adding the adapter.**
- Per-endpoint optional credentials (OneSystems uses `appKey`, GoPro uses `username`/`password`).
- Per-endpoint optional Zendesk field IDs: `caseNumberFieldId`, `lastStatusFieldId`, `lastExportFieldId`, `templateFieldId`. These drive the GW-01 post-back.

**`DocClient` interface** (`src/types.ts:114`):
- Minimum contract: `uploadDocument(params: UploadDocumentParams): Promise<unknown>`.
- Adapters that support `POST /v1/cases` create path also declare `createCase(params: CreateCaseParams): Promise<CreateCaseResult>` — this is duck-typed at the call site, NOT part of the base interface.

**`DocumentationOutcome`** (`src/types.ts:138`):
- The typed object passed once to `recordOutcome` at every terminal point. Carries everything `writeAudit` + `postResultToTicket` need (ok/outcome/intent/caseNumber/docSystem/timestamp/sanitizedReason/etc.) with no path-specific branching downstream.
- 7 GW-06 outcome codes (LOCKED order): `documented | create_failed | orphan_case | validation | auth | brand_mismatch | gopro_create_unsupported`.

**`HandlerResult`** (`src/types.ts:158`):
- `{ status: number, body: Record<string, unknown> }` — the canonical return shape for every handler.

**`AuditStore`** (`src/types.ts:181`):
- KV-shaped 3-method interface (`put`/`get`/`list`) implemented by both Cloudflare KV (binding) and `FileAuditStore`.

## Entry Points

**Cloudflare Worker:**
- Location: `src/worker.ts` (wired in `wrangler.toml:2` as `main`)
- Triggers: HTTPS fetch to deployed Worker (`milli-mala-staging.*.workers.dev` for staging)
- Bindings expected: `TENANT_KV`, `AUDIT_LOG`, secret `AUDIT_SECRET`
- Tenant data: written to KV with key `tenant:${brandId}` (see `KvTenantStore.get`, `src/tenant.ts:48`)

**Node HTTP server:**
- Location: `src/index.ts:208` (`startServer`)
- Triggers: `npm start` / Docker `entrypoint.sh` / K8s deployment
- Tenants loaded from `src/tenants.config.ts` at startup; all secrets via `requireEnv`
- Audit dir: `process.env.AUDIT_DIR || './audit-data'`

**Cloud Function detection:** `src/index.ts:229` — auto-skips `startServer()` when `K_SERVICE` or `FUNCTION_TARGET` is set (so it can be imported as a module).

## Architectural Constraints

- **Threading:** Both runtimes are single-threaded async (Workers event loop / Node event loop). No worker threads.
- **Global state:** `config` cache in `src/config.ts:15` (module-level, reset via `resetConfig()` for tests). No other module-level mutable state.
- **No DI container.** Dependencies are passed positionally through stage signatures. Tests inject by re-importing modules or mocking `global.fetch`.
- **Cloudflare nodejs_compat REQUIRED** (`wrangler.toml:4`) — `src/webhook.ts` and `src/worker.ts` use `node:crypto` for HMAC and `timingSafeEqual`.
- **Body size hard cap: 1 MB** (both runtimes). Enforced before parse to limit DoS surface.
- **Outgoing `baseUrl` SSRF guard** (`src/tenant.ts:160-183`) — HTTPS-only, no private/loopback/IPv6 literals. Applies to ALL endpoint types; new adapters inherit it for free.
- **Subdomain pattern** (`src/tenant.ts:16`) — Zendesk subdomain must match `/^[a-z0-9][a-z0-9-]*$/i` to prevent URL injection.
- **No `Co-Authored-By` trailers** in commits authored by the assistant (per user CLAUDE.md).

## Anti-Patterns

### Branching on `ep.type` outside the factory

**What happens:** A handler adds `if (ep.type === 'onesystems') { … }` to gate a capability or change behavior.
**Why it's wrong:** Every adapter then needs explicit awareness in every handler. The 7th GW-06 code (`gopro_create_unsupported`) explicitly exists so callers can ignore `ep.type` and ask the client itself.
**Do this instead:** Add a method to the adapter (or omit it) and duck-type. See `src/cases.ts:178-180`:
```ts
const canCreateCase =
  typeof (docClient as Partial<OneSystemsClient>).createCase === 'function'
```

### Throwing from `postResultToTicket` or `writeAudit`

**What happens:** A change inside `src/postResultToTicket.ts` lets an error escape.
**Why it's wrong:** GW-01 mandate: best-effort side effects must NOT change the already-computed HTTP response. The HTTP envelope is authoritative; the ticket note + audit are advisory.
**Do this instead:** Wrap any new logic in try/catch + `logger.warn(...)`. See `src/postResultToTicket.ts:188-194`.

### Reading `tenants.json` at runtime

**What happens:** New code paths the gateway to load `/Users/.../tenants.json` directly.
**Why it's wrong:** `tenants.json` is a local seed used to push values into KV (see `DEPLOYMENT.md`); it contains secrets and is gitignored. Production must read from `TENANT_KV` (Workers) or env-built `loadTenants()` (Node).
**Do this instead:** Use `TenantStore.get(brandId)`; never `fs.readFile('tenants.json')`.

### Reusing `attachments.ts` helpers from `cases.ts`

**What happens:** A refactor extracts `verifyApiKey` into a shared module.
**Why it's wrong:** `src/cases.ts:47-55` says verbatim: *"Copied verbatim from src/attachments.ts:21-29 (do NOT import/share — src/attachments.ts must stay byte-identical)."* The duplication is load-bearing for the G4 byte-identical guarantee.
**Do this instead:** Leave the duplicate. Update both if security policy changes.

### Silently dropping a minted case number

**What happens:** A `try/catch` widens around `createCase + postToCase` and returns a generic 500 on any error.
**Why it's wrong:** If `createCase` succeeded and `postToCase` failed, the caller never learns the case number. The OneSystems case persists with no document — orphan, but invisible.
**Do this instead:** Match the structure in `src/cases.ts:229-316` — separate inner try/catch keyed off `createdCaseNumber !== undefined` returns 207 `orphan_case` carrying `caseNumber`.

## Error Handling

**Strategy:** Three error tiers, each with its own response shape.

1. **Validation / auth / brand_mismatch** — early returns with `{ ok: false, outcome: <code>, error }`. NO post-back, NO audit (no real ticket context).
2. **Adapter / Zendesk-write failures mid-pipeline** — caught in handler, mapped to `outcome: 'failed' | 'create_failed' | 'orphan_case'`, post-back fires, then either return GW-06 envelope (cases) or rethrow to outer 500 (webhook, attachments).
3. **Uncaught / infrastructure** — outer try/catch in each handler returns 500 `{ error: 'Internal server error', duration_ms }`. NOT a GW-06 outcome, NOT an 8th code.

**Patterns:**
- All comparisons of secrets use `node:crypto` `timingSafeEqual` over hashed buffers (so length leaks aren't possible).
- HMAC signatures: `createHmac('sha256', secret).update(timestamp + rawBody).digest('base64')` then `timingSafeEqual` (`src/webhook.ts:19-29`).
- Adapter errors carry HTTP status in the message text (e.g. `OneSystems upload failed: ${status} - ${errorText}`). Never leak bearer tokens in messages (`src/onesystems.ts:167`).

## Cross-Cutting Concerns

**Logging:** Structured JSON via `createLogger(component)` (`src/logger.ts`). Levels: debug/info/warn/error. All log lines include `severity`, `component`, `message`, `timestamp`. Tenant identifiers are logged as `brand_id` (a public Zendesk ID, not a secret).

**Validation:** Centralized in `src/tenant.ts` (subdomain, baseUrl, case_number, audit params) and inline in each handler (ticket_id, GW-06 envelope shape). Validation always precedes adapter construction.

**Authentication:**
- Webhook → Zendesk HMAC-SHA256 over `timestamp + rawBody`, secret = `tenantConfig.zendesk.webhookSecret`.
- Cases / attachments → `X-Api-Key` header compared (sha256 + `timingSafeEqual`) against `tenantConfig.malaskra.apiKey`.
- Audit endpoint → `Authorization: Bearer ${AUDIT_SECRET}` (instance secret, not per-tenant).
- Zendesk outbound → Basic `${email}/token:${apiToken}` (`src/zendesk.ts:14-16`).

**SSRF guard:** `validateEndpoint` (`src/tenant.ts:160-183`) blocks any `baseUrl` that resolves to private/reserved hostnames. Applies before adapter construction, so it covers every adapter type uniformly.

**Audit writes:** `writeAudit` (`src/documentTicket.ts:177`) writes one record under TWO keys (`audit:${brandId}:${ts}:${ticketId}` and `ticket:${brandId}:${ticketId}:${ts}`) with `expirationTtl: 90 * 24 * 60 * 60` (90 days). Webhook path passes no enrichment args so the persisted shape stays byte-identical to the pre-G4 entry.

---

*Architecture analysis: 2026-05-21*
