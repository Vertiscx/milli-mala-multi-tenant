# Roadmap (proposed): Workpoint Module — v2.0 milestone

**Status:** Pre-milestone scaffold. Not yet promoted to active milestone. Promote via `/gsd:new-milestone` once v1.0 (Manual Documentation via Gateway) ships and current STATE.md is archived.

**Owner:** Viggo
**Mentor / reviewer:** Bryn
**Onboarding:** See [ONBOARDING.md](../../ONBOARDING.md) at the repo root.

---

## Why this milestone

Add **Workpoint** as a third document-archive adapter alongside OneSystems and GoPro. Workpoint is needed by [TBD — list of Icelandic institutions adopting Workpoint goes here once known].

The adapter pattern is already in place (`src/docClient.ts`, `DocClient` interface in `src/types.ts`). This milestone slots Workpoint into that seam without touching any handler.

## Out of scope

- Changing the GW-06 contract envelope of `POST /v1/cases`. (If Workpoint's `createCase` parameters differ from OneSystems', that's a **coordinated** GW-06 change with `malaskra_v3`, NOT a unilateral change here. Capture as a separate cross-repo phase if it materialises.)
- Refactoring or "improving" the locked failure order in `src/cases.ts`. The order is locked. Tests will catch regressions.
- Touching `src/webhook.ts` (byte-frozen since G1).
- Replacing OneSystems or GoPro adapters. Workpoint is additive.

---

## Open questions (BLOCKING — must answer before WP2)

These are unknowns that the milestone cannot proceed past WP1 without resolving:

1. **Vendor API docs.** Where are Workpoint's docs? Public URL, PDF, or vendor contact?
2. **Wire protocol.** REST + JSON? REST + multipart? SOAP/XML? Something else?
3. **Auth model.** Bearer token? Username + password → token exchange? mTLS? OAuth2?
4. **Token lifetime.** Drives the `tokenTtlMs` choice in the adapter (OneSystems = 25 min, GoPro = 25 min).
5. **Case creation capability.** Does Workpoint have a "create case + upload document" workflow like OneSystems, or upload-only like GoPro?
6. **Case-number format.** Length, allowed characters. Drives validator looseness in `src/tenant.ts:225-230`.
7. **Sandbox / staging environment.** Available? On what URL? Credentials issued through whom?
8. **Attachment model.** One file per call (GoPro-style), multipart with the PDF (OneSystems-style), or other?
9. **Error semantics.** Does Workpoint return 4xx for unknown case numbers (better than OneSystems which silently 200s), or does it have its own silent-success modes?
10. **Adopting institutions.** Which Zendesk-account tenants will install Workpoint? Drives the `requirements.json` step on the `malaskra_v3` side (per-Zendesk-account custom fields).

Capture answers in `.planning/workpoint/RESEARCH.md` as they arrive (Viggo: feel free to create that file as you learn things).

---

## Proposed phases

Numbering uses `WP` prefix to namespace away from `G` (gateway v1) phases.

### Phase WP1 — Skeleton + type union

**Goal:** Make Workpoint visible in the type system and factory, without any real adapter logic. CI green.

**Scope:**
- `src/types.ts`: add `'workpoint'` to `EndpointConfig['type']` union.
- `src/docClient.ts`: add `case 'workpoint':` branch that throws `Error('Workpoint adapter not yet implemented')`.
- `README.md`: mention Workpoint as a planned third backend.

**Success criteria:**
1. `npm test` still green (all existing OneSystems/GoPro paths unaffected).
2. `npx tsc --noEmit` green.
3. PR is small (~10 lines + docs) and reviewable in isolation.

**Depends on:** v1.0 merged to `main`.

**Branch:** `workpoint-1` off `main`.

**Estimated effort:** 1 hour + review.

---

### Phase WP2 — `WorkpointClient.uploadDocument`

**Goal:** First real Workpoint capability — upload a PDF to an existing Workpoint case. Mocked with `global.fetch` in tests; no live calls yet.

**Scope:**
- `src/workpoint.ts`: new file. Export `WorkpointClient` with:
  - Constructor taking `EndpointConfig` (extended with Workpoint-specific creds).
  - `authenticate()` private — token fetch + cache with TTL.
  - `uploadDocument(params: UploadDocumentParams): Promise<unknown>` — wire format per Workpoint vendor docs.
- `src/types.ts`: extend `EndpointConfig` with Workpoint-specific optional credential fields (e.g. `apiKey`, `clientId`+`clientSecret`, whatever auth needs).
- `src/docClient.ts`: replace the throw from WP1 with a real `new WorkpointClient(ep)` construction.
- `tests/workpoint.test.ts`: mirror `tests/onesystems.test.ts` structure — auth happy path, auth failure, upload happy path, upload failure → throw with sanitized message (NO bearer token in error text), token caching within a single request.
- `DEPLOYMENT.md`: document the new tenant config fields.

**Success criteria:**
1. `WorkpointClient` is constructed by `createDocClient` when `ep.type === 'workpoint'`.
2. The full pipeline (`POST /v1/cases` with `case_number` path) works end-to-end against a mocked Workpoint endpoint.
3. `tests/workpoint.test.ts` covers auth + upload + token caching + CRLF/control-char sanitization on text fields.
4. Coverage gate: no drop on any other file.

**Depends on:** WP1 merged. Answers to open questions 1–5, 8, 9.

**Branch:** `workpoint-2` off `main`.

**Estimated effort:** 1–2 days.

---

### Phase WP3 — `WorkpointClient.createCase` *(conditional)*

**Goal:** If Workpoint supports case creation, add the optional `createCase` method to the client. The duck-typed capability gate in `src/cases.ts:178` flips automatically.

**Scope (only if Workpoint supports createCase):**
- `src/workpoint.ts`: add `createCase(params: CreateCaseParams): Promise<CreateCaseResult>` matching the contract in `src/types.ts`.
- `src/types.ts`: if Workpoint's create-case parameters differ from OneSystems', add a `WorkpointCreateExtras` shape and surface it through GW-06 as `body.create.workpoint.*` — **coordinate with `malaskra_v3`** before merging.
- `tests/workpoint.createCase.test.ts`: mirror `tests/onesystems.createCase.test.ts`.
- `tests/cases.test.ts`: add a Workpoint create-path case alongside the OneSystems one.
- `tests/fixtures/gw06-contract.fixtures.ts`: extend with a Workpoint create-path fixture (requires coordinated change in `malaskra_v3`).

**Success criteria:**
1. The capability gate at `src/cases.ts:178` flips for Workpoint endpoints without any handler-level changes.
2. The locked failure order still holds: `createCase` failure → 502 `create_failed` (nothing minted); `createCase` success + later failure → 207 `orphan_case` carrying the minted Workpoint case number.
3. `tests/cases.contract.test.ts` passes (or, if intentionally extended, the matching extension lands in `malaskra_v3` in the same window).

**Depends on:** WP2 merged. Answer to open question 5.

**Branch:** `workpoint-3` off `main`.

**Estimated effort:** 1–2 days + cross-repo coordination.

**SKIPS if Workpoint does not support case creation** — the duck-type gate in `cases.ts` produces `gopro_create_unsupported` automatically. Document the decision in this phase's CHANGES.md and move to WP4.

---

### Phase WP4 — Live staging validation

**Goal:** Prove the Workpoint adapter against a real Workpoint staging environment. Surface vendor-side quirks (the OneSystems trailing-slash / WebNumber / silent-200 family).

**Scope:**
- Provision a test tenant in staging KV / env with Workpoint endpoint credentials.
- Run the test matrix from `.planning/codebase/CONCERNS.md` §"OneSystems-Specific Quirks", adapted to Workpoint:
  - Trailing-slash `baseUrl` behavior.
  - Template / case-type identifier (display name vs internal code).
  - Behavior on unknown case number (4xx vs silent 200).
  - Empty / malformed kennitala-equivalent.
  - Case-number extraction from response (write a 7-branch waterfall like `extractCaseNumber` if needed).
  - Token TTL boundary (force a re-auth mid-request by setting `tokenTtlMs` very low).
- Capture findings in `.planning/workpoint/STAGING-FINDINGS.md`.
- Fold any discovered quirks into the adapter + tests.

**Success criteria:**
1. End-to-end documented ticket lands in a real Workpoint case.
2. GW-01 post-back (internal note + custom fields) verified by reading the ticket back from Zendesk.
3. Audit entry persisted with `doc_endpoint: 'workpoint'`.
4. STAGING-FINDINGS.md captures all surprises for future maintainers.

**Depends on:** WP2 (and WP3 if applicable) merged. Answer to open question 7 (sandbox availability).

**Branch:** `workpoint-4` off `main`.

**Estimated effort:** 1–3 days, sensitive to vendor sandbox stability.

---

### Phase WP5 — Ship + install runbook

**Goal:** Promote the adapter to a real Zendesk-account tenant. Cross-repo coordination with `malaskra_v3` to register any new custom fields on the affected accounts.

**Scope:**
- DEPLOYMENT.md: full Workpoint section (KV seed shape, env-var list for Node deploy, secret rotation steps).
- `malaskra_v3` side (separate PR in that repo): if any new custom fields needed, update `requirements.json` for the affected Zendesk account installs.
- Per-account install runbook (KV write + admin-side field creation if not auto-created).
- Production deploy of the gateway.
- Live smoke test against one real tenant.

**Success criteria:**
1. One real institution successfully documents a real ticket into a real Workpoint case via the Málaskrá app.
2. All four custom fields (caseNumber, lastStatus, lastExport, optional template) populated correctly on the ticket.
3. No errors in CF tail / structured logs across a 24-hour window.
4. Audit entries queryable through `/v1/audit` with `doc_endpoint=workpoint`.

**Depends on:** WP2, WP4 (and WP3 if applicable) merged. Answer to open question 10.

**Branch:** `workpoint-5` off `main`.

**Estimated effort:** 1 day + post-ship monitoring.

---

## Phase summary

| Phase | Title | Depends on | Blocking unknowns | Est. effort |
|-------|-------|------------|-------------------|-------------|
| WP1 | Skeleton + type union | v1.0 shipped | none | 1 hr |
| WP2 | uploadDocument | WP1 | Q1–5, 8, 9 | 1–2 days |
| WP3 | createCase (conditional) | WP2 | Q5 | 1–2 days + cross-repo |
| WP4 | Live staging validation | WP2 (+WP3) | Q7 | 1–3 days |
| WP5 | Ship + install runbook | WP2, WP4 (+WP3) | Q10 | 1 day |

**Total:** ~1 week of focused work after blocking questions are answered, spread across roughly 2 calendar weeks accounting for cross-repo coordination and vendor-sandbox responsiveness.

---

## Promotion checklist (when this becomes the active milestone)

When v1.0 ships and you're ready to make this the live milestone:

1. Archive current `.planning/STATE.md`, `PROJECT.md`, `ROADMAP.md` into `.planning/v1.0-archive/`.
2. Run `/gsd:new-milestone` and feed it this scaffold as the starting roadmap.
3. Create per-phase directories under `.planning/phases/` (e.g. `06-wp1-skeleton/`, `07-wp2-upload/`, etc.).
4. Update `.planning/PROJECT.md` "Core Value" line to the Workpoint mission.
5. Delete this scaffold once everything is migrated — it has served its purpose.

---

*Scaffold created: 2026-05-21. Promote to active milestone when v1.0 PRs land.*
