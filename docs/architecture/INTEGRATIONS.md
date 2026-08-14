# External Integrations

**Analysis Date:** 2026-05-21

This service is a stateless multi-tenant **gateway** sitting between Zendesk (one or more brands) and one or more government document/archive systems (OneSystems, GoPro, future: Workpoint). It is invoked along three inbound paths and fans out to three outbound systems per tenant.

## Quick reference

```text
                    ┌──────────── inbound (3) ────────────┐
                    │                                      │
   Zendesk          │   Málaskrá (ZAF app, browser)        │   Operator
   (HTTP webhook)   │   POST /v1/attachments               │   GET /v1/audit
   POST /v1/webhook │   POST /v1/cases                     │   (Bearer AUDIT_SECRET)
   (HMAC signed)    │   (X-Api-Key header)                 │
                    │                                      │
                    ▼                                      ▼
            ┌───────────────────────────────────────────────────┐
            │   milli-mala-multi-tenant gateway                 │
            │   src/worker.ts (Cloudflare) | src/index.ts (Node)│
            │   Tenant resolved via brand_id → TenantConfig     │
            └─────┬──────────────────┬────────────────┬─────────┘
                  │                  │                │
        outbound (4) — all per-tenant credentials, all native fetch()
                  │                  │                │
                  ▼                  ▼                ▼                ▼
        Zendesk REST API     OneSystems          GoPro          (Future: Workpoint)
        api/v2/tickets       OneRecord API       v2 API         not implemented
        (read + write-back)  (Bearer/AppKey)     (Bearer/U+P)
```

## Inbound — APIs this service exposes

All four routes are wired identically in `src/worker.ts:46-232` (Workers) and `src/index.ts:214-224` (Node `createServer`). Both runtimes share the same handler modules: `src/services/archive/webhook.ts`, `src/services/archive/attachments.ts`, `src/services/archive/cases.ts`. Body cap on every POST: 1 MB.

### `POST /v1/webhook` — Zendesk webhook receiver

- **Caller:** Zendesk webhook (HTTP target trigger), one webhook per tenant.
- **Auth model:** HMAC-SHA256 of `timestamp + rawBody` using the tenant's `zendesk.webhookSecret`, sent in headers `X-Zendesk-Webhook-Signature` (base64) and `X-Zendesk-Webhook-Signature-Timestamp` (ISO-8601). Constant-time comparison via `node:crypto.timingSafeEqual` and a **5-minute timestamp tolerance** to block replays (`src/services/archive/webhook.ts:13,19-39`).
- **Body shape:** `{ ticket_id, brand_id, doc_endpoint }`. `brand_id` selects the tenant; `doc_endpoint` is a key into `TenantConfig.endpoints` (e.g. `"onesystems"` or `"gopro"`).
- **Owner:** `src/services/archive/webhook.ts` → `src/services/archive/documentTicket.ts` (`documentTicket()` orchestrator: fetch ticket, render PDF, upload to doc system, post-back to ticket, audit).
- **Zendesk-newcomer note:** In a Zendesk trigger you build the webhook target with these headers + raw JSON template; the secret is configured once per webhook in Zendesk admin and pasted into the tenant's `*_ZENDESK_WEBHOOK_SECRET` env var on the gateway side. The webhook would normally be created on the Zendesk account by `requirements.json` install or by hand.

### `POST /v1/attachments` — Málaskrá ZAF app: forward existing attachments

- **Caller:** the **Málaskrá** Zendesk sidebar app (ZAF — Zendesk App Framework, browser-side). The app calls the gateway from inside the agent's browser via `client.request({ secure: true, … })` so the apiKey is substituted by the Zendesk proxy.
- **Auth model:** shared secret in **`X-Api-Key`** header, constant-time compared against `tenantConfig.malaskra.apiKey` (`src/services/archive/attachments.ts:25-33`).
- **Body shape:** `{ ticket_id, brand_id, doc_endpoint, case_number }`. The Málaskrá app supplies a pre-existing `case_number`; the gateway downloads the ticket's Zendesk attachments server-side and re-uploads them to the doc system.
- **Owner:** `src/services/archive/attachments.ts`. Brand cross-check is fail-closed (`ticket.brand_id` must equal the supplied `brand_id` or 403, `src/services/archive/attachments.ts:121-133`).
- **Side effect (GW-01):** after the upload loop, calls `postResultToTicket()` to drop an internal-note + custom-field update on the ticket (`src/services/archive/attachments.ts:78-111,184-187`).

### `POST /v1/cases` — Málaskrá ZAF app: create or document into a case

- **Caller:** same Málaskrá ZAF app.
- **Auth model:** same `X-Api-Key` header (`src/services/archive/cases.ts:47-55`, verbatim copy of the `attachments.ts` check).
- **Body shape (GW-06 contract, authoritative copy lives in `~/dev/malaskra_v3/.planning/GATEWAY-CHANGES.md §GW-06`):** `{ ticket_id, brand_id, doc_endpoint }` plus **exactly one of**:
  - `create: { onesystems: { caseTemplate, kennitala, caseName? } }` — mint a new OneSystems case, stamp `caseNumber` back on the ticket, then upload PDF + attachments.
  - `case_number: string` — document into an existing case.
- **Response envelope (GW-06, 7 outcome codes, locked order):** `documented | create_failed | orphan_case | validation | auth | brand_mismatch | gopro_create_unsupported`. The `orphan_case` outcome (HTTP 207) is critical: it means createCase succeeded but a later step failed — the minted `caseNumber` is surfaced so the agent isn't left with a silently-orphaned case.
- **Owner:** `src/services/archive/cases.ts`. Capability check for case creation is **duck-typed** on the doc client (`typeof docClient.createCase === 'function'`, `src/services/archive/cases.ts:178-180`), NOT branched on `ep.type`. The only `ep.type` switch in the create/upload path lives in `src/services/archive/docClient.ts:14-30` (`createDocClient` factory).

### `GET /v1/health`

- Unauthenticated liveness check. Returns `{ status:'ok', service:'milli-mala', version:'2.0.0', timestamp }`.
- Owner: `src/worker.ts:51-56` / `src/index.ts:69-71`. Also used by the Dockerfile `HEALTHCHECK` (`wget --spider http://localhost:8080/v1/health` every 30 s).

### `GET /v1/audit`

- **Caller:** operators / on-call. Bearer-token gated.
- **Auth model:** `Authorization: Bearer <AUDIT_SECRET>`, compared via SHA-256 + `timingSafeEqual` (`src/worker.ts:197-207`, `src/index.ts:175-185`).
- Query params (sanitized to `[a-zA-Z0-9_-]+` via `sanitizeAuditParam`, `src/platform/tenant.ts:215-218`): `brand_id`, `ticket_id`, `limit` (max 100, default 20). Picks one of three KV prefixes: `audit:`, `audit:<brand>:`, `ticket:<brand>:<ticket>:`.
- Owner: `src/worker.ts:193-228` / `src/index.ts:168-205`. Read-only — entries are written by `writeAudit()` in `src/services/archive/documentTicket.ts:177-258`.

## Outbound — services this gateway calls

### 1. Zendesk REST API

- **Protocol:** HTTPS to `https://<subdomain>.zendesk.com/api/v2/…` — URL built per request from `tenantConfig.zendesk.subdomain` (`src/platform/zendesk.ts:14-16`). Subdomain format is validated by `SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/i` (`src/platform/tenant.ts:16,125-130`) to block URL-injection via crafted tenant config.
- **Auth model:** HTTP Basic, `Basic base64(email/token:apiToken)` (`src/platform/zendesk.ts:16`). Zendesk's "API token" auth uses the literal suffix `/token` on the email.
- **Endpoints used (all called from `src/platform/zendesk.ts`):**
  - `GET /tickets/{id}.json` → `getTicket()` (`src/platform/zendesk.ts:57-60`).
  - `GET /tickets/{id}/comments.json` → `getTicketComments()` (`src/platform/zendesk.ts:62-65`).
  - `GET /users/{id}.json` → `getUser()` (defined but `getUsersMany` is preferred).
  - `GET /users/show_many.json?ids=…` → `getUsersMany()` (`src/platform/zendesk.ts:72-76`) — batch resolve comment authors.
  - `GET <attachment.content_url>` → `fetchAttachments()` (`src/platform/zendesk.ts:86-154`). The attachment URL comes from the comment JSON; the gateway **re-validates** it before downloading (HTTPS-only, last-two-labels of hostname must be `zendesk.com` or `zdassets.com` — SSRF guard against attacker-controlled comment payloads, `src/platform/zendesk.ts:108-122`). Caps: `maxFiles=50`, `maxTotalBytes=100 MB`.
  - `PUT /tickets/{id}.json` → `requestWrite()` (`src/platform/zendesk.ts:29-43`, `setTicketCustomField()` `src/platform/zendesk.ts:45-55`). Used to (a) stamp the new caseNumber on the ticket after a `create` (`src/services/archive/cases.ts:240`), (b) write back the GW-01 internal note + custom fields (`src/services/archive/postResultToTicket.ts:170-181`).
- **Zendesk-newcomer notes:**
  - **Custom fields are account-level**, not brand-level (see user CLAUDE.md). One field ID is shared by all brands on the same Zendesk account; in this repo the IDs are configured per-endpoint in `EndpointConfig` (`src/platform/types.ts:37-40`: `caseNumberFieldId`, `lastStatusFieldId`, `lastExportFieldId`, `templateFieldId`). All are `number | null`; `null` means "skip writing this field gracefully" (`src/services/archive/postResultToTicket.ts:122-149`).
  - **Internal note vs public comment:** the GW-01 post-back uses `comment.public = false` so the result is visible to agents but not the requester (`src/services/archive/postResultToTicket.ts:166`). This is mandatory per Zendesk security guidance (approval links / sensitive actions must never be public).
  - **Date custom fields** accept only `YYYY-MM-DD`, not full ISO — `lastExportFieldId` is written as `o.timestamp.slice(0, 10)` (`src/services/archive/postResultToTicket.ts:138-142`).
  - **`last_status` is a JSON-stringified blob in a text custom field**, schema v1 (`src/services/archive/postResultToTicket.ts:97-110`): `{ v:1, status, outcome, timestamp, caseNumber?, docSystem, template?, reason? }`. This is the cross-repo contract the Málaskrá app reads back.

### 2. OneSystems — `OneRecord` API

- **Protocol:** HTTPS to `https://<host>/ZenDeskAPI/api/…` (per `tenants.json`, e.g. `https://onecrm.oneportal.is/ZenDeskAPI/`). `baseUrl` is validated HTTPS-only with private-IP block-list (`src/platform/tenant.ts:19-23,167-183`).
- **Auth model:** Two-step. (1) `POST /api/Authenticate/login` with `{ appKey }` → returns a bearer token (either as a raw string or `{ token | accessToken }`, both branches handled, `src/services/archive/onesystems.ts:62-80`). (2) Subsequent calls send `Authorization: Bearer <token>`. Token cached in-memory with `tokenTtlMs` (default 25 minutes) and re-fetched lazily by `ensureAuthenticated()`.
- **Endpoints used (`src/services/archive/onesystems.ts`):**
  - `POST /api/Authenticate/login` — auth.
  - `POST /api/OneRecord/CreateCaseUid` — create a new case. Body is the locked 5-field JSON `{ idNumber, caseTemplate, caseName, externalId, currentUser }`; `idNumber` is the Icelandic kennitala with all non-digits stripped (`normalizeKennitala`, `src/services/archive/onesystems.ts:14-16`). Response parsing uses a 7-branch waterfall (`extractCaseNumber`, `src/services/archive/onesystems.ts:24-43`) to pull a case number from any of `caseNumber | CaseNumber | id | Id | result.id | …`.
  - `POST /api/OneRecord/AddDocument2` — upload one PDF. Hand-rolled `multipart/form-data` body (no FormData helper) with fields `CaseNumber`, `User`, `FileName`, `FileArray` (base64), `Date`, `XML`. CRLF-injection guard on every text field (`sanitize`); XML-escape on the XML field (`escapeXml`) (`src/services/archive/onesystems.ts:94-160`).
- **Per-tenant credentials:** `EndpointConfig.appKey` (when `type === 'onesystems'`). Lives in env var `KERFISSTJORN_ONESYSTEMS_APP_KEY` (Node) or inside the KV JSON blob (Workers).
- **Tenant currently using it:** Kerfisstjórn (`brand_id: 33979373713298`, `src/tenants.config.ts:36-58`).
- **Capabilities:** OneSystems is the **only** doc system that supports case creation today. `gopro_create_unsupported` (GW-06) is the explicit failure code when a `create` is attempted against a GoPro endpoint.

### 3. GoPro — `gopro.net` v2 API

- **Protocol:** HTTPS to `https://<host>/<service-path>/v2/…` (per `tenants.json`, e.g. `https://foris.gopro.net/ver_supp/services/`).
- **Auth model:** Two-step. (1) `POST /v2/Authenticate` with `{ username, password }` → returns a bearer token as a **plain string** (response body may be a JSON-quoted string; the client strips surrounding quotes, `src/services/archive/gopro.ts:37-41`). (2) Subsequent calls send `Authorization: Bearer <token>`. Same 25-minute TTL + `ensureAuthenticated` pattern as OneSystems.
- **Endpoints used (`src/services/archive/gopro.ts`):**
  - `POST /v2/Authenticate` — auth.
  - `POST /v2/Documents/Create` — upload a document. **One file per call**, so `uploadDocument()` loops over `[pdf, …attachments]` and POSTs each separately (`src/services/archive/gopro.ts:50-95`). Body: `{ caseNumber, subject, fileName, content }` with `content` as base64. Success is gated on the response field `succeeded === true` — `succeeded: false` is treated as a thrown error using `result.message` (`src/services/archive/gopro.ts:86-90`).
  - **No case-creation endpoint.** `OneSystemsClient.createCase` exists; `GoProClient` has no `createCase`. The `/v1/cases` handler duck-types on this to return `gopro_create_unsupported` (`src/services/archive/cases.ts:178-185`).
- **Per-tenant credentials:** `EndpointConfig.username` and `EndpointConfig.password` (when `type === 'gopro'`). Lives in env vars `VINNUEFTIRLIT_GOPRO_USERNAME` + `VINNUEFTIRLIT_GOPRO_PASSWORD`.
- **Tenant currently using it:** Vinnueftirlitið (`brand_id: 33979400825874`, `src/tenants.config.ts:60-83`).

### 4. (Future) Workpoint

Mentioned in the project description and `~/.claude/.../MEMORY.md` as the next adapter to add. **Not yet implemented** in this codebase — there is no `src/workpoint.ts`, and `EndpointConfig.type` is currently a closed union `'onesystems' | 'gopro'` (`src/platform/types.ts:32`). Adding it will require: a new `WorkpointClient` implementing `DocClient`, a new branch in `createDocClient()` (`src/services/archive/docClient.ts:14-30`), widening the union in `src/platform/types.ts`, and a new `validateEndpoint` branch in `src/platform/tenant.ts:185-192`.

## Data Storage

**Databases:** none. The gateway is stateless per request.

**Tenant config (read-only at request time):**
- **Cloudflare Workers:** Cloudflare KV namespace `TENANT_KV`, key `tenant:<brand_id>`, value = JSON of `TenantConfig`. Read by `KvTenantStore.get()` (`src/platform/tenant.ts:41-58`).
- **Node / Docker:** in-memory `Map<brand_id, TenantConfig>` (`FileTenantStore`, `src/platform/tenant.ts:62-77`), built once at startup from `loadTenants()` in `src/tenants.config.ts` against `process.env`.

**Audit log (write-mostly, 90-day TTL):**
- **Cloudflare Workers:** Cloudflare KV namespace `AUDIT_LOG`. Each archival event is written **twice** — once under `audit:<brand_id>:<ts>:<ticket_id>` (time-ordered global) and once under `ticket:<brand_id>:<ticket_id>:<ts>` (per-ticket history). TTL 90 days via `expirationTtl: 90 * 24 * 60 * 60` (`src/services/archive/documentTicket.ts:242-258`). Best-effort writes — KV put failures are logged and swallowed.
- **Node / Docker:** `FileAuditStore` (`src/platform/fileAuditStore.ts`) — one JSON file per key under `$AUDIT_DIR` (default `./audit-data`). Filename = `encodeURIComponent(key) + '.json'`. Each file stores `{ value, expiresAt }`; expired entries are deleted on read.

**File Storage:** the doc systems (OneSystems / GoPro) own the persisted PDFs. The gateway buffers the PDF in memory (`Buffer`) only for the duration of one request.

**Caching:**
- In-memory bearer token caches inside `OneSystemsClient` and `GoProClient` (25-minute TTL).
- The `getConfig()` `InstanceConfig` is memoized at module scope (`src/platform/config.ts:15-30`).

## Authentication & Identity

**Inbound auth (one model per route):**

| Route | Mechanism | Secret source | Check location |
|-------|-----------|---------------|----------------|
| `POST /v1/webhook` | HMAC-SHA256 of `timestamp+rawBody`, base64, `timingSafeEqual` | `tenantConfig.zendesk.webhookSecret` (per tenant) | `src/services/archive/webhook.ts:19-29` |
| `POST /v1/attachments` | `X-Api-Key` header, SHA-256 + `timingSafeEqual` | `tenantConfig.malaskra.apiKey` (per tenant) | `src/services/archive/attachments.ts:25-33` |
| `POST /v1/cases` | `X-Api-Key` header, SHA-256 + `timingSafeEqual` | `tenantConfig.malaskra.apiKey` (per tenant) | `src/services/archive/cases.ts:47-55` |
| `GET /v1/audit` | `Authorization: Bearer <secret>`, SHA-256 + `timingSafeEqual` | env var / Workers secret `AUDIT_SECRET` (global, not per tenant) | `src/worker.ts:197-207`, `src/index.ts:175-185` |
| `GET /v1/health` | none | — | — |

**Brand cross-check (every per-ticket route):** after fetching the ticket via Zendesk's API, the gateway compares `ticket.brand_id` against the request's `brand_id` and 403's on mismatch or missing (`src/services/archive/attachments.ts:120-133`, `src/services/archive/documentTicket.ts:65-77`). This is the defense against a ticket in tenant A being archived against tenant B's doc-system credentials.

**No SSO, no user identity.** The "solving agent" identity is best-effort: `src/services/archive/documentTicket.ts:93-101` looks up the author of the last comment via Zendesk's `users/show_many` and passes their email as `currentUser` to OneSystems' `CreateCaseUid` (`src/services/archive/cases.ts:193`). Fallback string is `'Zendesk'`.

## Monitoring & Observability

**Error Tracking:** none. No Sentry / Rollbar / Datadog client is in `package.json`. Errors are logged at level `error` or `warn` via the structured JSON logger.

**Logs:** structured JSON to stdout (one entry per `console.log` call), with shape `{ severity, component, message, timestamp, ...data }` (`src/platform/logger.ts:14-27`). Workers logs surface via `wrangler tail`; Node/ECS logs go to CloudWatch via the Docker stdout driver. Log levels gated by `LOG_LEVEL` (`debug|info|warn|error`).

**Audit log (semi-observability):** the per-request audit entries written to KV / `FileAuditStore` carry operational fields (duration_ms, total/internal_notes, doc_system, case_number_source, outcome) and are queryable via `GET /v1/audit`. No PII is stored — `writeAudit` deliberately does not persist ticket bodies or attachment contents.

## CI/CD & Deployment

**Hosting (three live or supported targets):**
- **Cloudflare Workers** — primary edge target. Staging worker is `milli-mala-staging` (`wrangler.toml:29`); KV namespaces are pinned by ID in `[env.staging]`.
- **AWS ECS Fargate** — `eu-west-1`, ECR repo `821090935708.dkr.ecr.eu-west-1.amazonaws.com/milli-mala-multi-tenant`, cluster `tooling-prod`, service `prod-milli-mala-multi-tenant`.
- **Kubernetes / generic Docker** — supported via the Dockerfile and `entrypoint.sh` `$TENANTS_JSON` pattern; runbook in `DEPLOYMENT.md`.

**CI Pipelines:**
- `.github/workflows/ci.yml` — Vitest + `wrangler deploy --dry-run` on main pushes. Cloudflare auth via `secrets.CLOUDFLARE_API_TOKEN`.
- `.github/workflows/test.yml` — matrix Vitest on Node 20/22, Codecov upload on Node 20 (continue-on-error).
- `.github/workflows/deploy.yml` — Docker build → ECR push → ECS task-def register → service update. AWS auth via GitHub OIDC (`secrets.TOOLING_OIDC_ARN`, no static AWS keys). Triggers: PR merged to `main`, `v*` tag push, or manual `workflow_dispatch` with an `image_tag` input to redeploy an existing image.

## Environment Configuration

**Required env vars (Node / Docker only — Workers reads from KV):**

Service-wide (read by `getConfig()` in `src/platform/config.ts`):
- `PORT` — default `8080`.
- `LOG_LEVEL` — default `info`.
- `AUDIT_SECRET` — required for `GET /v1/audit` to do anything other than 401.
- `AUDIT_DIR` — default `./audit-data`, used by `FileAuditStore`.
- `K_SERVICE` / `FUNCTION_TARGET` — if either is set, the Node entrypoint skips `startServer()` (legacy Cloud Functions guard, `src/index.ts:229-230`).

Per-tenant — one set per tenant slug, all consumed by `requireEnv()` in `src/tenants.config.ts`:

| Variable | Used as |
|----------|---------|
| `KERFISSTJORN_ZENDESK_SUBDOMAIN` | Zendesk URL base for Kerfisstjórn |
| `KERFISSTJORN_ZENDESK_EMAIL` | Basic-auth user |
| `KERFISSTJORN_ZENDESK_API_TOKEN` | Basic-auth password |
| `KERFISSTJORN_ZENDESK_WEBHOOK_SECRET` | HMAC secret for `/v1/webhook` |
| `KERFISSTJORN_ONESYSTEMS_BASE_URL` | OneSystems endpoint base |
| `KERFISSTJORN_ONESYSTEMS_APP_KEY` | OneSystems `appKey` for login |
| `KERFISSTJORN_MALASKRA_API_KEY` | Shared secret for `/v1/attachments` + `/v1/cases` |
| `VINNUEFTIRLIT_ZENDESK_*` | Same four Zendesk slots, Vinnueftirlitið tenant |
| `VINNUEFTIRLIT_GOPRO_BASE_URL` | GoPro endpoint base |
| `VINNUEFTIRLIT_GOPRO_USERNAME` | GoPro login |
| `VINNUEFTIRLIT_GOPRO_PASSWORD` | GoPro login |
| `VINNUEFTIRLIT_MALASKRA_API_KEY` | Shared secret for `/v1/…` |

Missing any of these crashes the process at startup (intentional, `src/platform/env.ts:17-19`). Template lives in `.env.example`. Real values are never committed (`.gitignore` blocks `.env*` and `tenants.json`).

**Secrets location:**
- **Cloudflare Workers:** `wrangler secret put AUDIT_SECRET --env staging`. Tenant credentials live inside the JSON value at KV key `tenant:<brand_id>` (set via `wrangler kv key put`).
- **AWS ECS / K8s:** standard environment variables on the task / pod, sourced from AWS Secrets Manager / SSM Parameter Store / K8s Secret. `entrypoint.sh` also accepts `$TENANTS_JSON` (whole-tenant blob) to support secret-as-file workflows.
- **Local dev:** `.env` (gitignored), loaded by `docker-compose.yml` via `env_file`.

## Webhooks & Callbacks

**Incoming (from Zendesk):** `POST /v1/webhook` — described above. One Zendesk webhook target per tenant brand. In Zendesk admin, the webhook target URL is the gateway endpoint, the secret is shared with the gateway, and the trigger payload must include `ticket_id`, `brand_id`, `doc_endpoint` (typically rendered from Zendesk Liquid placeholders in the trigger template).

**Incoming (from Málaskrá ZAF app):** `POST /v1/attachments`, `POST /v1/cases`. Calls originate browser-side using ZAF's `client.request({ secure: true, … })` mechanism — the `X-Api-Key` header value is the `{{setting.NAME}}` placeholder, which the Zendesk proxy substitutes server-side so the secret never enters the iframe JS heap. **This is mandatory ZAF discipline:** raw `fetch()` from a ZAF iframe cannot use secure settings and would leak the key (see user CLAUDE.md "Secrets — always use Zendesk's platform feature").

**Outgoing (write-back to Zendesk):** GW-01 result post-back via `PUT /tickets/{id}.json`, owned by `src/services/archive/postResultToTicket.ts`. **Best-effort, never throws** — a failed post-back logs a warning and swallows the error; the HTTP response the gateway already computed is unchanged (`src/services/archive/postResultToTicket.ts:185-195`). Writes both an internal-note comment and a custom-fields update in a single PUT.

**Outgoing (to doc systems):** OneSystems `AddDocument2` + `CreateCaseUid`, GoPro `Documents/Create`. No callbacks expected — both are synchronous request/response.

---

*Integration audit: 2026-05-21*
