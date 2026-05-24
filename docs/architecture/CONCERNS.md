# Codebase Concerns

**Analysis Date:** 2026-05-21
**Audience:** TS/Node engineer adding a new doc-system adapter (Workpoint) alongside `OneSystemsClient` / `GoProClient`.

This file is a landmine map. Read it before touching `src/docClient.ts`, `src/cases.ts`, `src/types.ts`, or any new adapter.

---

## Multi-Tenant Isolation Invariants (must never cross-tenant leak)

This service is multi-tenant; a single Worker / container serves multiple Zendesk brands and multiple archive endpoints. Every handler is responsible for proving the request matches the tenant **before** doing anything destructive.

**The brand cross-check is fail-closed and load-bearing.** Three handlers each repeat it; do NOT skip it in a new adapter or a new endpoint:

- `src/documentTicket.ts:66-77` — webhook path, inside `fetchTicketInfo`. Missing `ticket.brand_id` → 403 `Ticket brand_id unavailable`. Mismatch → 403 `Ticket does not belong to this brand`. Returns a `HandlerResult`, never throws.
- `src/attachments.ts:122-133` — attachments path, identical logic, inlined.
- `src/cases.ts:154-167` — cases path delegates to `fetchTicketInfo` and then **rewrites** the body into the GW-06 envelope (`outcome: 'brand_mismatch'`) before returning. Do NOT spread `fetched.result.body` directly into a GW-06 response — it carries snake_case fields that must not leak across the cross-repo seam.

**Tenant resolution is per-request, by `brand_id` from the JSON body** (`src/worker.ts:73-90`, `src/index.ts:87-94`). The `TenantConfig` carries Zendesk creds, archive creds, the malaskra API key, and the endpoints map. There is no global "current tenant" — every function takes `tenantConfig` explicitly. Do NOT introduce module-level mutable state keyed by anything other than the per-request `tenantConfig` argument; that would be a cross-tenant leak primitive.

**Adapter authors must not cache state across requests.** `OneSystemsClient` and `GoProClient` are instantiated **per request** in `createDocClient` (`src/docClient.ts:14-30`). The token / token-expiry fields on the client instance live only for that one request. If you add a Workpoint client, follow the same shape — no module-level token cache, no shared client.

**`requestId` / brand-id must be in every log line that matters.** All `logger.warn` / `logger.error` sites in `src/cases.ts`, `src/attachments.ts`, `src/documentTicket.ts` include `brand_id` so cross-tenant log mixing is recoverable from stdout. Match the convention.

**`tenants.json` is git-ignored** (`.gitignore:9`). The repo ships `src/tenants.config.ts` which **builds** the array from env vars via `requireEnv()` (see Secret Handling below). Do NOT add a fallback that reads `tenants.json` from disk; that file is operator-managed and may or may not exist.

---

## Secret Handling Rules

**Secrets come from the runtime environment (Wrangler / CF env / Docker env), never from `.env` files and never hard-coded.**

- Cloudflare Workers: `wrangler secret put <NAME>` (interactive — `wrangler.toml:19-20`). Tenant configs live in **KV** (`TENANT_KV` namespace, `src/worker.ts:83-90`, `src/tenant.ts:41-58`); the KV value is the full `TenantConfig` JSON. The KV record itself **is** the secret store on the Worker.
- Docker / K8s: env vars consumed at startup by `src/tenants.config.ts` through `requireEnv()` (`src/env.ts:12-21`). Missing env → throws at startup → container crashes (intentional, fail-fast).

**Do not** add fallback defaults for credentials, do not log them, do not surface them in HTTP responses or in the GW-01 internal note.

**The Zendesk error message rule:** PII / raw error details stay in `logger.error(...)` and the audit log only. The GW-01 internal note (`src/postResultToTicket.ts:60-84`) uses a short Icelandic `sanitizedReason` field — never `(err as Error).message`. See `cases.ts:213, 275, 307` for the four allowed sanitized strings. If you add a new failure surface in a Workpoint adapter, you must pass a sanitized Icelandic reason; do not let raw `err.message` leak into a ticket comment that an end user can read.

**OneSystems bearer-token PII guard:** the comment at `src/onesystems.ts:167` calls this out explicitly — the bearer token must never appear in a thrown error message. Workpoint adapter authors must match this discipline: `throw new Error(\`Workpoint X failed: ${response.status} - ${text}\`)` is fine; including `Authorization` headers or the password is not.

**`.gitignore` already covers `.env`, `.env.local`, `tenants.json`, `*.log`, `audit-data/`, `coverage/`.** Adding a new secret? Add the env var name to `src/tenants.config.ts` via `requireEnv()`, document it in `DEPLOYMENT.md`, and tell DevOps. Do not commit the value.

**CRLF / control-char injection:** `src/onesystems.ts:95` sanitizes every string field that lands in the multipart body to strip `\r\n`. Workpoint adapter must do the same on any text field shipped to the doc system, otherwise a hostile `case_number` or filename can inject a multipart header.

---

## The Locked Failure Order (NEVER silently lose a created case)

**Core value of `POST /v1/cases`:** if `createCase` succeeds and a later step fails, the response is HTTP 207 `outcome: 'orphan_case'` carrying the minted `caseNumber`. The caller **must** see the number that was minted on their behalf. See the docstring at `src/cases.ts:1-29`.

The 7-code outcome enum is **LOCKED** (`src/cases.ts:16-17`, also `tests/fixtures/gw06-contract.fixtures.ts`):

```
documented | create_failed | orphan_case | validation | auth | brand_mismatch | gopro_create_unsupported
```

There is **no 8th code**. Infrastructure failures fall through to the catch-all `{ error: 'Internal server error', duration_ms }` envelope (HTTP 500) which is **not** one of the 7 codes — see `src/cases.ts:353-359`.

**The locked step order in `handleCases`:**

| # | Step | File:Line | What happens on failure |
|---|------|-----------|--------------------------|
| Gate-1 | `verifyApiKey` | `cases.ts:76-78` | 401 `outcome: 'auth'` |
| Gate-2 | Validate `ticket_id` | `cases.ts:81-84` | 400 `outcome: 'validation'` |
| Gate-3 | Exactly-one-of `create` XOR `case_number` | `cases.ts:87-91` | 400 `outcome: 'validation'` |
| Gate-4 | Validate `body.case_number` (if supplied) | `cases.ts:94-99` | 400 `outcome: 'validation'` |
| Gate-5 | Validate `body.create.onesystems.{caseTemplate,kennitala}` | `cases.ts:101-124` | 400 `outcome: 'validation'` |
| Gate-6 | `resolveEndpoint` | `cases.ts:129-134` | 400 `outcome: 'validation'` |
| 1 | `fetchTicketInfo` (also brand cross-check) | `cases.ts:154-167` | 403 `outcome: 'brand_mismatch'` |
| 2 | `renderPdf` | `cases.ts:171` | 500 infra envelope (outer catch) |
| 3 | `createDocClient` (the **only** `ep.type` switch) | `cases.ts:174` | 500 infra envelope |
| 3a | **Capability check FIRST** (duck-typed `createCase`) | `cases.ts:178-185` | 422 `outcome: 'gopro_create_unsupported'` |
| 3b | `createCase` (create path only) | `cases.ts:187-223` | 502 `outcome: 'create_failed'`. **Nothing minted yet.** |
| — | **LATCH** `createdCaseNumber` the INSTANT createCase resolves | `cases.ts:196-197` | — |
| 4 | `setTicketCustomField` stamping the new case# (create path only) | `cases.ts:233-240` | **207 `orphan_case`** (number not lost) |
| 5 | `postToCase` (PDF upload) | `cases.ts:252` | **207 `orphan_case`** (create path) / 500 (case_number path) |
| 6 | Success finalize + audit + GW-01 post-back | `cases.ts:319-352` | — |

**Do not reorder.** Two separate try/catches are deliberate:

- `cases.ts:187-223` — wraps **only** the createCase call. Its catch is `create_failed` (502). Nothing has been minted yet.
- `cases.ts:231-316` — wraps steps 4 + 5. The `if (createdCaseNumber !== undefined)` branch at line 254 is what produces `orphan_case`; the `else` branch (case_number path, nothing minted) rethrows to the outer 500.

**Anti-pattern that has bitten the codebase before** (see memory note `extraction-refactor-error-precedence`): refactoring this file by combining the two catches, or by moving createCase outside the dedicated try, silently inverts the locked order — a created case will start failing with a 500 envelope instead of 207 orphan_case. The number is then permanently lost from the caller's perspective. Tests in `tests/cases.test.ts` and the contract fixtures in `tests/cases.contract.test.ts` are written to catch this; do not "fix" them by relaxing the assertions.

**The capability gate at `cases.ts:178-179` is intentionally duck-typed**:

```ts
const canCreateCase = typeof (docClient as Partial<OneSystemsClient>).createCase === 'function'
```

It is NOT switched on `ep.type`. If Workpoint supports case creation, give the client a `createCase` method matching the `CreateCaseParams` / `CreateCaseResult` contract in `src/types.ts:118-129`, and the gate flips automatically. If Workpoint does **not** support creation, do not implement `createCase` — the duck-type check will surface `gopro_create_unsupported` (the enum value is doc-system-agnostic despite its name; do not rename it without coordinating GW-06).

---

## Cross-Repo Seam — GW-06 Governs `/v1/cases`

**This gateway is not the source of truth for the `/v1/cases` wire contract.** The authoritative spec lives in the Zendesk app repo:

- **Source of truth:** `/Users/brynjolfur/dev/malaskra_v3/.planning/GATEWAY-CHANGES.md §GW-06` (cited at `src/cases.ts:4-6` and `tests/cases.contract.test.ts:4-6`).
- **Frozen conformance fixtures** (shared byte-identical between this repo and `malaskra_v3`): `tests/fixtures/gw06-contract.fixtures.ts`.
- **Conformance test:** `tests/cases.contract.test.ts` — drives `handleCases` with the canonical request fixtures and deep-equals the response against the canonical response fixtures.

**If `tests/cases.contract.test.ts` fails, the contract has drifted. DO NOT "fix" the test or the fixtures.** Fix the handler, or coordinate a deliberate GW-06 change with the malaskra_v3 side first. See memory note `gw06-cross-repo-contract-authority`.

**Workpoint impact on GW-06:** the `body.create` shape is backend-namespaced (`body.create.onesystems.caseTemplate` etc., `cases.ts:101-124`). If Workpoint supports case creation with a different parameter set, that requires a coordinated GW-06 change — a new namespace `body.create.workpoint.*`. Do NOT shove Workpoint fields into the `onesystems` namespace.

**The other cross-repo artifact is the ratified `last_status` JSON v1** built in `src/postResultToTicket.ts:97-110`. Shape:

```
{"v":1,"status":"success|failed","outcome":"...","timestamp":"<ISO-UTC>","caseNumber"?,"docSystem","template"?,"reason"?}
```

Absent fields are **omitted**, never `null`. The malaskra_v3 app's `parseLastStatus` consumes this — adding fields without coordinating breaks the consumer.

**Field-ID mapping is per-Zendesk-account, NOT per-brand.** From the global CLAUDE.md and confirmed by `.planning/HANDOFF-to-malaskra-session.md:20-24`:

- `caseNumberFieldId` ← `malaskra_malsnumer`
- `templateFieldId` ← `malaskra_snidmat` (OneSystems-only — gateway echoes the accepted template on create)
- `lastStatusFieldId` ← `malaskra_last_status` (the ratified JSON lives here)
- `lastExportFieldId` ← `malaskra_last_export` (Zendesk DATE field — `YYYY-MM-DD` only, see Field Quirks below)

Adding a Workpoint-specific field would need a new `EndpointConfig` property + the `requirements.json` install step on the malaskra_v3 side. Reuse `caseNumberFieldId` / `lastStatusFieldId` / `lastExportFieldId` for Workpoint where possible.

---

## Codecov / Coverage Gate Foot-Gun

**There is no `codecov.yml` in this repo.** Confirmed: `ls codecov.yml` → not found. CI in `.github/workflows/ci.yml` runs `npx vitest run` but does not currently call Codecov; if/when it's added, the default **project gate blocks on ANY coverage drop** (memory note `codecov-project-gate`).

**Already-excluded from coverage** (`vitest.config.ts:10-17`): `src/worker.ts`, `src/index.ts` — these are runtime entrypoints with tiny adaptation logic but huge body-parsing/branching that's exercised by `tests/integration.runtime-parity.test.ts`. If you add a Workpoint-specific entrypoint adaptation (unlikely), exclude it too — otherwise the runtime-parity test counts both copies and the project gate will tank.

**`tests/fileAuditStore.test.ts` is the canonical example of testing a file-backed implementation** — file-system writes are real, the test uses a tmp dir. Do NOT mock `node:fs/promises` for adapter tests; mock `global.fetch` (see `tests/onesystems.test.ts:1-30` and `tests/gopro.test.ts:1-30`).

**Don't write a Workpoint adapter without unit tests next to it** (`tests/workpoint.test.ts` + `tests/workpoint.createCase.test.ts` if applicable). The existing OneSystems / GoPro test suites are the template — mirror their structure exactly so the project gate doesn't drop.

---

## `npm audit` / Lockfile Foot-Guns

Memory note `npm-audit-fix-desync`:

- `npm audit fix` updates `package-lock.json` but can leave `node_modules/` stale, after which `npm audit` falsely reports 0 vulnerabilities while the installed tree still has them.
- **Always run `npm ci` after `npm audit fix`** to bring `node_modules/` in sync with the lockfile.
- The tell-tale is `sbom.json` listing a package `name` that doesn't match its `purl` — that's lockfile/install drift.

`package.json:16-29` — runtime dep is only `jspdf`. Test/dev deps: `vitest`, `@vitest/coverage-v8`, `tsx`, `typescript`, `@types/node`, `node-mocks-http`. Keep the dep count tight; Workpoint adapter should not need new deps unless the doc system requires SOAP / XML signing.

---

## OneSystems-Specific Quirks (NEW ADAPTER AUTHOR: READ THIS)

These are real-world boundary behaviors that mocks **cannot** surface. Workpoint will have its own analogous quirks — discover them on a real staging environment before declaring "done."

From `.planning/HANDOFF-to-malaskra-session.md:26-30`:

### 1. `baseUrl` trailing slash → silent 404

`OneSystemsClient.uploadDocument` constructs URLs as `${this.baseUrl}/api/OneRecord/AddDocument2` (`src/onesystems.ts:143`). If `baseUrl` ends with `/`, the resulting URL is `https://host//api/...` and OneSystems returns 404 silently. **Strip trailing slashes** when populating `EndpointConfig.baseUrl` in `tenants.json` / KV.

`src/tenant.ts:167-183` does HTTPS-only / private-IP-block validation but does NOT trim trailing slashes. Workpoint adapter authors: either trim in the adapter constructor, or document the requirement loudly in your endpoint's KV setup docs.

### 2. `caseTemplate` is the **WebNumber**, not the display title

OneSystems' `caseTemplate` field accepts the internal WebNumber (e.g. `almenntmal`, `prufa`, `thonustubeidnir`, `thjonustubeidnir_it`), NOT the human-friendly display title shown in the OneSystems UI. There is no template mapping table in this repo — the value is passed through verbatim (`src/onesystems.ts:178-182`, also referenced at `.planning/phases/02-g2-new-building-blocks/02-RESEARCH.md:78`). The app side (malaskra_v3) is responsible for collecting the right value from the operator.

**Workpoint equivalent:** if Workpoint has a similar "template / case-type" concept, find out what the API-canonical identifier is **early**. Do not assume it matches the display name.

### 3. OneSystems `AddDocument2` silently accepts a non-existent case number

A typo'd or stale `case_number` will return 200 OK — the document goes into limbo, not into the intended case. This is OneSystems' behavior, not the gateway's. The gateway has no way to validate the case number exists before uploading. **Workpoint adapter author:** check whether Workpoint's upload endpoint returns 4xx for unknown case numbers; if so, that's actually better than OneSystems and you should not "normalize" the behavior to match.

### 4. Zendesk silently ignores unknown custom-field IDs on PUT

If `caseNumberFieldId` / `lastStatusFieldId` / `lastExportFieldId` / `templateFieldId` in the endpoint config don't exist on the target Zendesk account, the PUT in `src/zendesk.ts:45-55` and `src/postResultToTicket.ts:177-181` returns 200 but the field is not set. **No error is surfaced** to the gateway or the caller. The only way to detect this is to read back the ticket and verify. The runbook step is "verify Zendesk readback" in `.planning/STATE.md:66`.

### 5. `kennitala` is digits-only

OneSystems `CreateCaseUid` expects `idNumber` as a digits-only string (`normalizeKennitala` at `src/onesystems.ts:14-16` strips every non-digit — no length assertion). Icelandic kennitölur are usually 10 digits but the gateway does not enforce that; OneSystems will reject malformed ones with a 4xx → `create_failed` (502). Workpoint may have its own ID format; do not blindly copy the digits-only stripper.

### 6. The `caseNumber` extraction waterfall is 7-branch first-match-wins

`extractCaseNumber` at `src/onesystems.ts:24-43` — exact 7-branch precedence (`caseNumber`, `CaseNumber`, `id`, `Id`, `result.id`, ... matched-but-empty-string yields `''` and does NOT fall through). Workpoint will return its own response shape; write its extractor with the same explicitness — do not chain optional access on a `Record<string, unknown>` and hope.

### 7. The bearer-token + multipart-boundary shape is OneSystems-specific

`src/onesystems.ts:88-160` — multipart body is hand-rolled with a CRLF-sanitized boundary and base64-encoded PDF in a `FileArray` field. Do **not** copy this verbatim into Workpoint; design the wire format from Workpoint's own docs. GoPro uses JSON with base64 in a `content` field (`src/gopro.ts:50-97`) — same input, completely different wire shape.

### 8. Token TTL is per-adapter

OneSystems: 25 min default (`src/onesystems.ts:53`). GoPro: 25 min default (`src/gopro.ts:18`). Both expose `tokenTtlMs` in `EndpointConfig`. The token is a **per-request** field on the client instance (per the multi-tenant isolation rule) — the TTL only matters if a single request makes multiple uploads (e.g., the attachments path, which calls `uploadDocument` in a loop, `src/attachments.ts:161-175`). Workpoint: pick a TTL slightly under the doc system's actual token lifetime.

---

## Loop-Safety / GW-04 Operational Requirement

`.planning/pr-artifacts/body-pr4.md:17` and memory note: the GW-01 post-back **updates the ticket** (internal note + custom fields via `ZendeskClient.requestWrite`). Any Zendesk **trigger** that drives `/v1/webhook` must be **one-shot** — fires on a marker tag and removes that tag in the same trigger run — or it will loop (live-proven: misconfigured trigger looped 15× / 6× on real tickets; a correct trigger fires exactly once).

**This is a load-bearing install step**, documented in `DEPLOYMENT.md` (loop-safety section) and the malaskra_v3 INSTALL-RUNBOOK. **The gateway itself does not enforce loop safety** — there is a noted hardening opportunity (`mm_document_requested` flag set by requester, cleared by the gateway's post-back) that was deferred by decision (~3-line future gateway change). Workpoint adapter changes nothing about this — it's a Zendesk-config concern.

The manual sidebar path (`/v1/cases`, `/v1/attachments`) is user-initiated and not affected by trigger loops.

---

## Fragile / Load-Bearing Areas (touch with care)

### `src/webhook.ts` is byte-frozen

Per `.planning/STATE.md:9` and `.planning/HANDOFF-to-malaskra-session.md:6`, `src/webhook.ts` has been byte-frozen since G1. The G1 extraction explicitly preserved the file. All real logic was extracted into `documentTicket.ts`. **Do not touch `src/webhook.ts`** for a Workpoint adapter — there's nothing in it that needs to change. If you find yourself wanting to edit it, you're solving the wrong problem.

### `src/documentTicket.ts:209-238` — audit entry byte-identical contract

The audit-entry object built in `writeAudit` is byte-identical to the pre-G4 webhook-path entry **when no enrichment args are passed**. The `outcome` / `intent` / `last_status` / `last_export` keys are **spread conditionally** (`...(args.outcome !== undefined ? { outcome: args.outcome } : {})`) so the webhook persisted entry gains NO new keys. Do NOT replace the conditional spread with `outcome: args.outcome ?? undefined` or similar — `undefined` is not the same as absent in `JSON.stringify`, and the byte-identity assertion in `tests/documentTicket.test.ts` will catch the regression.

### `src/postResultToTicket.ts` NEVER throws

`postResultToTicket` and `recordOutcome` are best-effort. Their catches log + swallow. **Do not "improve" this by propagating errors** — the explicit GW-01 mandate is that a post-back failure must not change the HTTP response the gateway already computed. The HTTP response is finalized before this fires. See the docstring at `src/postResultToTicket.ts:1-14` and `:152-155`.

### `src/cases.ts:148` — `recordOutcome` finalize wrapper has its own swallow

The `finalize` helper at `cases.ts:144-151` already wraps `recordOutcome` in try/catch even though `recordOutcome` never throws. This is "defensive belt + suspenders" — keep it. A future change to `recordOutcome` that lets it throw would silently break `/v1/cases` if this wrapper were removed.

### `tests/cases.contract.test.ts` + `tests/fixtures/gw06-contract.fixtures.ts` are the cross-repo seam

Already covered above — but worth repeating: changing these test files unilaterally is a **contract break**. Do not.

---

## Known Sharp Edges in the Existing Adapters (good to know, but not blocking)

- `OneSystemsClient.uploadDocument` ignores the `attachments` parameter passed in `UploadDocumentParams` (the `attachments?` field on the type). Only the PDF goes to OneSystems via `AddDocument2`. Original Zendesk attachments are forwarded **separately** through `/v1/attachments` (a different endpoint, looping `uploadDocument` once per file in `src/attachments.ts:161-175`). The signature accepts `attachments` because `GoProClient.uploadDocument` (`src/gopro.ts:50-97`) DOES use them. Workpoint: pick the model that matches the doc system's API.
- `OneSystemsClient.uploadDocument` returns `response.json().catch(() => ({ success: true }))` (`src/onesystems.ts:159`) — a non-JSON 200 response is silently treated as success. Workpoint adapter should match this leniency only if Workpoint's API genuinely returns non-JSON on success.
- `GoProClient.uploadDocument` calls the upload endpoint **once per file in a loop** (`src/gopro.ts:65-94`) — GoPro accepts only one file per call. If one file fails, the whole call throws and **earlier files have already been uploaded**. There's no rollback. The caller (`src/attachments.ts`) handles partial-failure semantics; the adapter does not.
- `validateCaseNumber` at `src/tenant.ts:225-230` is intentionally loose (length ≤100, no control chars, no `..`). Case-number formats vary between institutions — do not tighten it to a regex for one doc system; that would break others.
- `src/zendesk.ts:114-122` — SSRF protection on attachment download enforces exact domain match (`zendesk.com` or `zdassets.com`) on the **last two labels**. This prevents `evil-zendesk.com` from matching. If Workpoint pulls files from anywhere, replicate this allow-list pattern; do not naïve-`endsWith` the domain.

---

## Missing / Not Built (intentional, do not "fix" without a phase)

- **No loop-immune one-shot intent flag in the gateway.** Decided deferred (`.planning/HANDOFF-to-malaskra-session.md:18`). Trigger config is the workaround.
- **No template mapping table for OneSystems.** App side passes the WebNumber verbatim; the gateway echoes it back.
- **No retry / backoff in any adapter.** Adapters throw on first failure; the GW-01 finalizer reports it and the caller decides what to do.
- **No rate limiting in the gateway.** Cloudflare / Zendesk handle this at their respective layers.
- **No request signing on `/v1/cases` or `/v1/attachments`.** Auth is bearer-token (`X-Api-Key`) with `timingSafeEqual` over SHA-256 (`src/cases.ts:47-55`, `src/attachments.ts:26-34`). Webhook is HMAC-SHA256 of `timestamp + body` (`src/webhook.ts:19-29`). Workpoint endpoints don't change this.

---

## Test Coverage Gaps Worth Knowing

- `src/worker.ts` and `src/index.ts` are excluded from coverage (`vitest.config.ts:14-15`) — their branching is partially exercised by `tests/integration.runtime-parity.test.ts` but not exhaustively. If you add a Workpoint-specific endpoint adaptation in either file (unlikely — most logic lives in the `handleX` core), expect a coverage hit unless you extend the integration test.
- `tests/fileAuditStore.test.ts` is intentionally minimal (85 lines) — covers happy path + TTL expiry + dir-creation failure. Edge cases around concurrent writes / disk-full are not tested.
- The "GoPro live test" was deferred during the build phase (`.planning/STATE.md:60`) — automated tests for GoPro exist but real-environment validation was scheduled for ship-window. Same will be true for Workpoint: build with mocks, validate live at ship.

---

## TODO/FIXME Comments

`grep -rn "TODO\|FIXME\|HACK\|XXX" src/ tests/` → **none.** This codebase has no orphan TODOs. Load-bearing intent is captured in docstrings and `.planning/` artifacts instead. If you add a TODO in your Workpoint adapter, file an opportunity note in `.planning/` and reference it.

---

*Concerns audit: 2026-05-21*
