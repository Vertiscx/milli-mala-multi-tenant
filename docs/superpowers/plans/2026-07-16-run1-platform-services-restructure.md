# Run 1: Platform/Services Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize milli-mala-multi-tenant into two clearly separated parts — `src/platform/` (the shared foundation every service uses) and `src/services/archive/` (the archiving work it does today) — without changing what the service does. The unchanged test suite is the proof.

**Architecture:** Three pull requests on the Vertiscx fork, done in order. Each one is small, does exactly one thing, and can be checked on its own: (1) move files into the new folders, (2) replace the duplicated request-handling code with one shared route list, (3) reshape the tenant configuration so archiving becomes one optional section instead of a requirement for every tenant. The full reasoning lives in `docs/architecture/2026-07-16-gateway-platform-design.md`.

**Tech Stack:** TypeScript (ES modules, imports end in `.js`), Node 20, vitest for tests. No new dependencies.

## Rules That Apply to Every Task

- **Nothing the service does may change.** Same routes, same responses, same error messages, word for word. Tests may only get updated file paths (PR 1 and 2) or updated config shapes (PR 3) — never changed expectations.
- **A commit either moves files or changes code — never both.** This is what lets a reviewer see at a glance that a change is purely structural.
- **Environment variable names do not change.** No secrets need to be touched on the servers.
- Every commit must pass both checks before it is made: `npm run typecheck` (no errors) and `npm test` (same number of passing tests as the baseline recorded in Task 0).
- Commits are authored as the user, with no Claude co-author line.
- All pull requests go to the Vertiscx fork first. Sending the work upstream to island-is happens later, after the fork version is validated.
- **Folder rules** (design doc, section 3): code in `platform/` may never import from `services/`; a service may never import from another service.

## Before Starting (important)

Twelve open pull requests (#17–#28, the July code-review fixes) change the same files this plan moves. If they merge *after* the files move, every one of them will conflict.

**Decide their fate first:** either merge them into the fork's main branch before starting (preferred — they are small and touch different files), or consciously park them, knowing they will need to be re-applied by hand afterwards. Do not start Task 1 with this undecided.

> **DECIDED 2026-07-16: Park them.** The 12 PRs stay open and untouched. After Run 1 lands, each fix gets re-applied by hand to the new file locations as a follow-up task (the old branches serve as the reference diffs).

---

### Task 0: Record the Starting Point

This gives every later step a known-good state to compare against.

- [ ] **Step 1: Start clean on the fork's main branch**

```bash
cd ~/dev/milli-mala-multi-tenant
git checkout main && git status --short   # expect: only untracked .claude/, docs/ items
npm ci
```

- [ ] **Step 2: Record the baseline**

```bash
npm run typecheck            # expect: no output, exit code 0
npm test 2>&1 | tail -5      # note the exact number, e.g. "Tests  372 passed"
```

Write the number down next to this checkbox: `BASELINE_TESTS = 374`

- [ ] **Step 3: Push the design doc to the fork if it is still local-only**

```bash
git log fork/main..main --oneline    # if the design-doc commit is listed:
git push fork main
```

---

## PR 1 — branch `refactor/structure-1-move-files`

**PR title:** `refactor(structure): move files into platform/ and services/archive/ (no behavior change)`

**What the PR description must say:** This PR only moves files and updates the import paths that point at them (design doc, section 3). Three commits: platform moves, archive moves, type-definitions split. To review, use `git diff -M --stat` — the first two commits show every file as a rename. No logic was touched; the test suite passes with the same count as before.

### Task 1: Move the shared foundation files

**Files (moved one-to-one with `git mv`, which preserves file history):**
- `src/config.ts` → `src/platform/config.ts`
- `src/env.ts` → `src/platform/env.ts`
- `src/logger.ts` → `src/platform/logger.ts`
- `src/types.ts` → `src/platform/types.ts`
- `src/tenant.ts` → `src/platform/tenant.ts`
- `src/zendesk.ts` → `src/platform/zendesk.ts`
- `src/fileAuditStore.ts` → `src/platform/fileAuditStore.ts`

Nothing exported changes its name — only where the files live.

- [ ] **Step 1: Create the branch and move the files**

```bash
git checkout -b refactor/structure-1-move-files
mkdir -p src/platform
git mv src/config.ts src/env.ts src/logger.ts src/types.ts src/tenant.ts src/zendesk.ts src/fileAuditStore.ts src/platform/
```

- [ ] **Step 2: Update the import paths**

The rules (the typecheck in Step 3 catches any path that was missed):
- Files inside `src/platform/` import each other exactly as before (`'./x.js'`) — no change needed.
- Every other file in `src/` changes `'./config.js'` to `'./platform/config.js'`, and the same for the other six names.
- Test files change `'../src/tenant.js'` to `'../src/platform/tenant.js'`, same pattern for the rest.

```bash
for f in config env logger types tenant zendesk fileAuditStore; do
  perl -pi -e "s|'\./$f\.js'|'./platform/$f.js'|g" src/*.ts
  perl -pi -e "s|'\.\./src/$f\.js'|'../src/platform/$f.js'|g" tests/*.ts
done
```

- [ ] **Step 3: Check**

```bash
npm run typecheck && npm test 2>&1 | tail -3   # expect BASELINE_TESTS passed
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(structure): move shared plumbing to src/platform/ (pure move)

git mv plus import-path updates only. Per the gateway platform design
(docs/architecture/2026-07-16-gateway-platform-design.md, section 3):
platform/ holds what every service shares — config, env, logging, types,
tenant store, Zendesk client, audit store. No logic changes; test count
unchanged."
```

### Task 2: Move the archive service files

**Files (moved one-to-one with `git mv`):**
- `src/webhook.ts`, `src/documentTicket.ts`, `src/pdf.ts`, `src/cases.ts`, `src/attachments.ts`, `src/onesystems.ts`, `src/gopro.ts`, `src/docClient.ts`, `src/postResultToTicket.ts` — all to `src/services/archive/` keeping their names.

- [ ] **Step 1: Move**

```bash
mkdir -p src/services/archive
git mv src/webhook.ts src/documentTicket.ts src/pdf.ts src/cases.ts src/attachments.ts src/onesystems.ts src/gopro.ts src/docClient.ts src/postResultToTicket.ts src/services/archive/
```

- [ ] **Step 2: Update the import paths**

- Inside `src/services/archive/`: imports of each other stay `'./x.js'`; imports of platform files become `'../../platform/x.js'` (after Task 1 they currently read `'./platform/x.js'`).
- `src/index.ts` and `src/worker.ts`: `'./webhook.js'` becomes `'./services/archive/webhook.js'`, same for attachments and cases.
- Test files: `'../src/webhook.js'` becomes `'../src/services/archive/webhook.js'`, same for the other eight.

```bash
perl -pi -e "s|'\./platform/|'../../platform/|g" src/services/archive/*.ts
for f in webhook documentTicket pdf cases attachments onesystems gopro docClient postResultToTicket; do
  perl -pi -e "s|'\./$f\.js'|'./services/archive/$f.js'|g" src/index.ts src/worker.ts
  perl -pi -e "s|'\.\./src/$f\.js'|'../src/services/archive/$f.js'|g" tests/*.ts
done
```

- [ ] **Step 3: Check** — `npm run typecheck && npm test 2>&1 | tail -3` (BASELINE_TESTS passed)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(structure): move archive capability to src/services/archive/ (pure move)

git mv plus import-path updates only. The archive pipeline (webhook, PDF,
cases, attachments, OneSystems/GoPro clients, ticket post-back) is the
first service on the platform. No logic changes; test count unchanged."
```

### Task 3: Split the type definitions along the same line

`src/platform/types.ts` currently mixes shared types with archive-only types. This task cuts the archive-only ones into a new file, copied as-is.

**Files:**
- Modify: `src/platform/types.ts` (remove the archive-only types)
- Create: `src/services/archive/types.ts` (they land here, unchanged)

**Types that MOVE to `services/archive/types.ts`:**
`DownloadedAttachment`, `AttachmentsResult`, `UploadDocumentParams`, `DocClient`, `CreateCaseParams`, `CreateCaseResult`, `DocumentationOutcome`, `WebhookRequest`, `AttachmentsRequest`, `PdfBlock`, `PdfRun`

**Types that STAY in `src/platform/types.ts`:**
`TenantConfig`, `ZendeskConfig`, `EndpointConfig`, `MalaskraConfig`, `PdfConfig` (still part of TenantConfig until PR 3), `ZendeskTicket`, `ZendeskCustomField`, `ZendeskComment`, `ZendeskAttachment`, `ZendeskUser`, `HandlerResult`, `AuditStore`, `Logger`

Two of the moved types (`WebhookRequest`, `AttachmentsRequest`) mention `TenantConfig` and `AuditStore`, so the new file starts with:

```ts
import type { TenantConfig, AuditStore } from '../../platform/types.js'
```

(`ZendeskAttachment` is used by archive code but describes the Zendesk API, so it stays in platform.)

- [ ] **Step 1:** Cut the listed types out of `platform/types.ts` and paste them unchanged into `services/archive/types.ts`, with the import line above at the top.

- [ ] **Step 2:** Fix the imports in each `src/services/archive/*.ts` file: names that moved now come `from './types.js'`; names that stayed keep coming `from '../../platform/types.js'`. The typecheck lists every wrong one — work through the list until it is clean.

- [ ] **Step 3: Check** — `npm run typecheck && npm test 2>&1 | tail -3` (BASELINE_TESTS passed; a few tests import moved types — update their paths the same way).

- [ ] **Step 4: Commit and open PR 1**

```bash
git add -A
git commit -m "refactor(structure): split types.ts along the platform/service boundary

Archive-only types move unchanged to services/archive/types.ts; platform
keeps tenant config, Zendesk API types, and shared interfaces. No logic
changes."
git push fork refactor/structure-1-move-files
gh pr create --repo Vertiscx/milli-mala-multi-tenant --base main \
  --title "refactor(structure): move files into platform/ and services/archive/ (no behavior change)" \
  --body-file - <<'EOF'
PR 1 of 3 for the gateway platform restructure (see docs/architecture/2026-07-16-gateway-platform-design.md, sections 3 and 7).

**Structural only.** Three commits: (1) platform file moves, (2) archive file moves, (3) type-definitions split. No logic was edited anywhere.

**How to review:** run `git diff -M --stat` — commits 1 and 2 show every file as a rename; commit 3 is a cut-and-paste of type declarations. The full test suite passes with the same test count as main.

**Why:** this draws the line between the shared foundation and the archive service, so future services (ticket splitting, forward notes, CSAT links) can be added beside the archive code instead of tangled into it.
EOF
```

**Merge gate:** review, merge into fork main **as a merge commit, not a squash** (the three-commit structure is itself the review evidence), then `git checkout main && git pull fork main`.

---

## PR 2 — branch `refactor/structure-2-route-registry`

**PR title:** `refactor(http): one shared route list for both runtimes (no behavior change)`

**Why (goes in the PR body):** `index.ts` (the Node server) and `worker.ts` (the Cloudflare version) each contain three nearly identical blocks of request-handling code — read the body, check `brand_id` and `doc_endpoint`, look up the tenant, call the handler. Adding one endpoint today means editing four places. And `doc_endpoint` is an archiving concept that currently every route is forced to have. After this PR, the archive service publishes a small list of its routes, and both runtimes walk that same list. Adding a future service becomes: add its folder, add its routes to the list.

### Task 4: The route list — shared types plus the archive's entries

**Files:**
- Create: `src/platform/http/routes.ts`
- Create: `src/services/archive/routes.ts`
- Test: `tests/routes.test.ts`

**What later tasks depend on (exact names and shapes):**

```ts
// src/platform/http/routes.ts
import type { TenantConfig, AuditStore, HandlerResult } from '../types.js'

export interface GatewayRequest {
  body: Record<string, unknown>
  rawBody: string
  headers: Record<string, string>
  tenantConfig: TenantConfig
  auditStore?: AuditStore
}

export interface ServiceRoute {
  method: 'POST'            // GET routes (health, audit) stay owned by the platform
  path: string              // exact match, e.g. '/v1/webhook'
  handler: (req: GatewayRequest) => Promise<HandlerResult>
}

export function findRoute(routes: ServiceRoute[], method: string, path: string): ServiceRoute | undefined {
  return routes.find(r => r.method === method && r.path === path)
}
```

```ts
// src/services/archive/routes.ts
import type { ServiceRoute, GatewayRequest } from '../../platform/http/routes.js'
import type { HandlerResult } from '../../platform/types.js'
import { handleWebhook } from './webhook.js'
import { handleAttachments } from './attachments.js'
import { handleCases } from './cases.js'

// doc_endpoint is an archive concept, so the archive routes check it themselves —
// with exactly the same error text the server used before:
function getDocEndpoint(req: GatewayRequest): string | HandlerResult {
  const docEndpoint = req.body.doc_endpoint != null ? String(req.body.doc_endpoint) : undefined
  if (!docEndpoint) return { status: 400, body: { error: 'Missing doc_endpoint' } }
  return docEndpoint
}

export const archiveRoutes: ServiceRoute[] = [
  {
    method: 'POST', path: '/v1/webhook',
    handler: async (req) => {
      const docEndpoint = getDocEndpoint(req)
      if (typeof docEndpoint !== 'string') return docEndpoint
      return handleWebhook({ body: req.body, rawBody: req.rawBody, headers: req.headers, tenantConfig: req.tenantConfig, docEndpoint, auditStore: req.auditStore })
    },
  },
  {
    method: 'POST', path: '/v1/attachments',
    handler: async (req) => {
      const docEndpoint = getDocEndpoint(req)
      if (typeof docEndpoint !== 'string') return docEndpoint
      return handleAttachments({ body: req.body, headers: req.headers, tenantConfig: req.tenantConfig, docEndpoint })
    },
  },
  {
    method: 'POST', path: '/v1/cases',
    handler: async (req) => {
      const docEndpoint = getDocEndpoint(req)
      if (typeof docEndpoint !== 'string') return docEndpoint
      return handleCases({ body: req.body, headers: req.headers, tenantConfig: req.tenantConfig, docEndpoint, auditStore: req.auditStore })
    },
  },
]
```

- [ ] **Step 1: Write the test first** (`tests/routes.test.ts`): `findRoute` finds a route by method and path and returns undefined for anything else; `archiveRoutes` contains exactly the three paths above; calling a route handler with a body that has no `doc_endpoint` returns status 400 with the exact text `'Missing doc_endpoint'`.
- [ ] **Step 2: Run it** — `npx vitest run tests/routes.test.ts` — expect FAIL (files don't exist yet).
- [ ] **Step 3: Create both files** exactly as shown above.
- [ ] **Step 4: Run it again** — expect PASS. Then the full check: typecheck plus the whole suite (baseline count plus the new tests).
- [ ] **Step 5: Commit** — `refactor(http): add shared route list and archive route entries (not yet wired in)`

### Task 5: Make the Node server use the route list

**Files:** Modify `src/index.ts` — delete the three near-identical wrapper functions (`handleWebhookHttp`, `handleAttachmentsHttp`, `handleCasesHttp`) and replace them with one shared dispatcher.

**Uses from Task 4:** `findRoute`, `archiveRoutes`, `GatewayRequest`.

The one dispatcher does exactly what the three wrappers did, in the same order, with the same error texts. The health and audit endpoints stay exactly as they are — they belong to the platform.

```ts
// src/index.ts — replaces handleWebhookHttp, handleAttachmentsHttp, handleCasesHttp:
import { findRoute, type ServiceRoute } from './platform/http/routes.js'
import { archiveRoutes } from './services/archive/routes.js'

async function dispatchServiceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: ServiceRoute,
  tenantStore: FileTenantStore,
  auditStore: FileAuditStore
): Promise<void> {
  try {
    const rawBody = await getRequestBody(req, MAX_BODY_SIZE)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' })
    }
    const brandId = body.brand_id != null ? String(body.brand_id) : undefined
    if (!brandId) return sendJson(res, 400, { error: 'Missing brand_id' })

    const tenantConfig = await resolveTenantConfig(brandId, tenantStore)
    if (!tenantConfig) return sendJson(res, 400, { error: 'Invalid request' })

    const headers = req.headers as Record<string, string>
    const result = await route.handler({ body, rawBody, headers, tenantConfig, auditStore })
    sendJson(res, result.status, result.body)
  } catch (error) {
    logger.error('HTTP handler error', { error: (error as Error).message })
    sendJson(res, 500, { error: 'Internal server error' })
  }
}

// and inside createServer's listener, the three route lines become:
const route = req.method === 'POST' ? findRoute(archiveRoutes, req.method, url.pathname) : undefined
if (route) return dispatchServiceRoute(req, res, route, tenantStore, auditStore)
```

Note one deliberate detail: the old wrappers checked `doc_endpoint` *before* looking up the tenant; the route handlers from Task 4 check it *after*. Both orderings return 400 with the same texts, but if any test asserts on the exact response when BOTH `doc_endpoint` and a valid tenant are missing, keep the old precedence by checking `doc_endpoint` inside the dispatcher before tenant lookup instead. Run the suite and let it decide — do not guess.

- [ ] **Step 1: Rewrite the request listener:** platform routes first (health, audit), then the dispatcher above, otherwise 404. One function replaces the three wrappers.
- [ ] **Step 2: Check** — typecheck plus full suite. **`tests/integration.runtime-parity.test.ts` is the key witness here** — it verifies the Node and Cloudflare versions behave identically, and it must pass without being edited.
- [ ] **Step 3: Commit** — `refactor(http): index.ts dispatches via the route list (three wrappers become one)`

### Task 6: Make the Cloudflare worker use the same list

**Files:** Modify `src/worker.ts` — the same replacement, using the same `archiveRoutes`, keeping the Cloudflare-specific pieces (KV tenant store, KV audit store) unchanged.

- [ ] **Step 1: Rewrite** the worker's fetch handler to walk the same route list.
- [ ] **Step 2: Check** — typecheck plus full suite; runtime-parity still untouched and green.
- [ ] **Step 3: Commit and open PR 2.** PR body: the "Why" paragraph above, plus: "To review: read the deleted wrappers next to the one dispatcher that replaced them. Error texts unchanged; the runtime-parity test file was not edited."

**Merge gate:** review, merge (merge commit), pull fork main.

---

## PR 3 — branch `refactor/structure-3-tenant-config-services`

**PR title:** `refactor(config): tenant config becomes core + optional archive section (no behavior change)`

**Why (goes in the PR body):** today every tenant must have archive settings (`malaskra`, `pdf`, `endpoints`) or it fails validation — a tenant that only wants a future service could not exist. After this PR, the required core is just identity plus Zendesk credentials; archiving is one optional section that the archive service validates itself. Environment variable names do not change, so nothing on the servers needs touching.

### Task 7: Reshape the config type

**Files:** Modify `src/platform/types.ts`

**The new shape (everything later tasks use):**

```ts
// platform/types.ts — TenantConfig becomes:
export interface TenantConfig {
  brand_id: string
  name: string
  zendesk: ZendeskConfig
  services: { archive?: ArchiveServiceConfig }
}

// The archive section groups what used to sit at the top level.
// It stays defined in platform/types.ts for now, because the folder rule says
// platform code may not import from services — moving it fully into the
// service needs per-service config loading, which is future work.
export interface ArchiveServiceConfig {
  endpoints: Record<string, EndpointConfig>
  malaskra: MalaskraConfig
  pdf: PdfConfig
}
```

- [ ] **Step 1:** Apply the type change. The typecheck will now fail at every place that reads `tenantConfig.endpoints`, `.malaskra`, or `.pdf` — that error list is exactly the to-do list for Tasks 8 and 9. Do not commit yet.

### Task 8: Update every place that reads the config

**Files (the typecheck errors point at them — expected set):**
- `src/services/archive/`: `documentTicket.ts`, `attachments.ts`, `cases.ts`, `postResultToTicket.ts`
- `src/platform/tenant.ts` (`resolveEndpoint`, `validateTenantConfig`)
- `src/tenants.config.ts`
- `tests/`: every test fixture that builds a tenant config

**The rule:** `tenantConfig.endpoints` becomes `tenantConfig.services.archive.endpoints`, and the same for `.malaskra` and `.pdf`. At each of the three archive entry points (webhook, attachments, cases), add one guard first:

```ts
const archive = tenantConfig.services.archive
if (!archive) return { status: 400, body: { error: 'Invalid request' } }  // same neutral error as an unknown tenant
```

Beyond that property-path change, do not redesign any function signatures in this PR.

- [ ] **Step 1:** Work through every typecheck error with the rule above. In `src/tenants.config.ts`, wrap each tenant's `endpoints`/`malaskra`/`pdf` in `services: { archive: { … } }` — the environment-variable reads themselves stay untouched.
- [ ] **Step 2:** Update the test fixtures the same way — shape only, assertions untouched.
- [ ] **Step 3: Check** — typecheck plus full suite at the expected count.
- [ ] **Step 4: Commit** — `refactor(config): nest archive settings under services.archive (mechanical)`

### Task 9: Split validation the same way

**Files:** Modify `src/platform/tenant.ts`; extend `tests/tenant.test.ts`

`validateTenantConfig` splits into two parts:
- `validateTenantCore(config)` — brand_id, name, the Zendesk fields, the subdomain format check, and the secret-strength rules, all kept word for word.
- `validateArchiveConfig(archive, label)` — endpoints (including the existing per-endpoint checks, unchanged), malaskra key, pdf fields — and it runs **only when the tenant has an archive section**.
- `validateTenantConfig` keeps its name and signature and calls both (the archive part only when present) — so everything that calls it today keeps working. The cross-tenant duplicate-API-key check in `FileTenantStore.fromJson` only updates its property path.

- [ ] **Step 1: Write the new test first:** a tenant with a valid core and NO archive section passes validation. This is the one genuinely new allowance in all of Run 1 — required by the design (section 5). Every case that is rejected today must still be rejected.
- [ ] **Step 2:** Run it — expect FAIL (the validator still demands archive fields).
- [ ] **Step 3:** Implement the split. **Keep every existing error message word for word** — existing tests assert on the exact texts. Do not reorder the checks (a past refactor taught us reordering silently changes which error wins when several apply).
- [ ] **Step 4: Check** — typecheck plus full suite green.
- [ ] **Step 5: Commit and open PR 3.** PR body: the "Why" paragraph plus: "One new test: a tenant without an archive section is now valid. Every existing rejection case is unchanged."

**Merge gate:** review, merge, pull fork main. **Run 1 is complete.**

---

## Wrap-Up Checklist

- [ ] All three PRs merged to Vertiscx main; main is green.
- [ ] `git log --oneline` on main reads as a self-explanatory story: move → route list → config.
- [ ] Update file-path references in `DEPLOYMENT.md` / `ONBOARDING.md` to the new layout (one docs commit — may ride with PR 3 or follow it).
- [ ] Decide when to send the work upstream to island-is: three squashed PRs in the same order, each linking its fork PR as review evidence. Only after fork validation, per the standing workflow.
- [ ] Plan Run 2 (splitting the 781-line `documentTicket.ts` into readable stages) separately.

## Deliberately NOT in Run 1

- Splitting `documentTicket.ts` — that is Run 2.
- Moving webhook signature verification into the platform layer — the handlers keep their security checks exactly where they are.
- Extracting the server code itself into `platform/http/` beyond the route list — `index.ts` and `worker.ts` keep their adapters inline.
- Moving `EndpointConfig`/`PdfConfig` types out of platform — needs per-service config loading first.
- Any new service (ticket splitting, forward notes, CSAT) — those come only after Run 1 and Run 2 have landed.
