# Coding Conventions

**Analysis Date:** 2026-05-21

## TypeScript Configuration

**Compiler settings** (`tsconfig.json`):
- `target: ES2022`, `module: ES2022`, `moduleResolution: bundler`
- **`strict: true`** — full strict mode (no implicit any, strict null checks, etc.)
- `esModuleInterop: true`, `forceConsistentCasingInFileNames: true`
- `rootDir: src`, `outDir: dist`, tests excluded from emitted build
- Project is **ESM** (`"type": "module"` in `package.json`)

**Implications for new code:**
- All relative imports use the `.js` extension even though sources are `.ts` (ESM resolution requirement). Example from `src/docClient.ts:6-8`:
  ```ts
  import { OneSystemsClient } from './onesystems.js'
  import { GoProClient } from './gopro.js'
  import type { EndpointConfig, DocClient } from './types.js'
  ```
- `import type { ... }` is used for type-only imports (see every adapter).
- No runtime validation library is used — **no Zod, no io-ts, no class-validator**. Request parsing is hand-rolled per handler with explicit `typeof` / shape checks (`src/cases.ts:103-124`, `src/tenant.ts:112-197`).

## Naming Patterns

**Files:** `lowerCamelCase.ts` for modules — `docClient.ts`, `documentTicket.ts`, `fileAuditStore.ts`, `postResultToTicket.ts`. No kebab-case, no `index.ts` barrels (except the Node entrypoint).

**Tests:** `<source>.test.ts` co-sibling of source name, all in `tests/`. Contract/parity tests get a qualifier: `cases.contract.test.ts`, `integration.runtime-parity.test.ts`, `zendesk.write.test.ts`, `onesystems.createCase.test.ts`.

**Classes:** `PascalCase` — `OneSystemsClient`, `GoProClient`, `ZendeskClient`, `FileTenantStore`, `KvTenantStore`, `FileAuditStore`.

**Functions:** `lowerCamelCase`, verb-first — `handleCases`, `handleWebhook`, `resolveEndpoint`, `validateCaseNumber`, `createDocClient`, `recordOutcome`, `buildNote`, `fetchTicketInfo`, `writeAudit`.

**Interfaces / Types:** `PascalCase` — `TenantConfig`, `EndpointConfig`, `DocClient`, `UploadDocumentParams`, `HandlerResult`, `DocumentationOutcome`, `AuditStore`. All in `src/types.ts`.

**Constants:** `SCREAMING_SNAKE_CASE` for true constants (`DEFAULT_EXTERNAL_USER` in `src/onesystems.ts:11`, `LOG_LEVELS` in `src/logger.ts:8`, `SUBDOMAIN_PATTERN` / `PRIVATE_IP_PATTERNS` / `AUDIT_PARAM_PATTERN` in `src/tenant.ts:16-27`).

**Locked enums:** Use `as const` readonly tuples to pin order, not TS `enum`. Example `tests/fixtures/gw06-contract.fixtures.ts:34-44`:
```ts
export const GW06_OUTCOMES = [
  'documented', 'create_failed', 'orphan_case', 'validation',
  'auth', 'brand_mismatch', 'gopro_create_unsupported'
] as const
export type Gw06Outcome = (typeof GW06_OUTCOMES)[number]
```

## Code Style

**Formatting:**
- **No Prettier, no ESLint, no Biome.** `.github/workflows/test.yml:62-64` says "No linter configured yet". Style is enforced by convention + review.
- 2-space indent, single quotes, **no semicolons** at end of statements (except where required by ASI). Verify with any `src/*.ts` file.
- Trailing commas in multi-line literals: yes.
- Line length: ~100 chars informal; comments wrap at ~80.

**Module style:**
- Named exports only, no `export default` in `src/` (worker exports `default` object only because Cloudflare requires it, `src/worker.ts`).
- Module-level `const logger = createLogger('<component>')` at top of each adapter (`src/onesystems.ts:8`, `src/gopro.ts:8`, `src/cases.ts:40`). The component name matches the filename.

## Import Organization

Order observed in `src/cases.ts:31-38`, `src/documentTicket.ts:14-31`:
1. Node built-ins — `import { timingSafeEqual, createHash } from 'node:crypto'`
2. Local runtime imports — `./logger.js`, `./tenant.js`, `./docClient.js`, etc.
3. Type-only imports last — `import type { ... } from './types.js'`

No path aliases configured. All imports are relative.

## Error Handling

This codebase has **explicit, documented error precedence semantics** ("locked failure order"). Read this section in full before refactoring any handler.

### House rules

1. **Throwing vs. returning a `HandlerResult`.** Handlers (`handleCases`, `handleWebhook`, `handleAttachments`) return `{ status, body }` for every *expected* failure (validation, auth, brand mismatch, unsupported capability). They only `throw` for *infra* failures. The outer `catch` then maps to the generic 500 envelope `{ error: 'Internal server error', duration_ms }`. Stages that can short-circuit a handler return a discriminated union: `{ ok: true, ... } | { ok: false, result: HandlerResult }` (see `fetchTicketInfo` in `src/documentTicket.ts:51-104`, `resolveCaseNumber` at `src/documentTicket.ts:126-145`).

2. **Locked error precedence — DO NOT REORDER.** `src/documentTicket.ts:311-314` explicitly preserves the original order:
   > "createDocClient is constructed here (original line-134 position) so a misconfigured-endpoint throw keeps its precedence BEFORE the validateCaseNumber 400 — preserving byte-identical error ordering."
   Refactors must diff control flow against the original; a previous refactor silently inverted error precedence (see `MEMORY.md` → "Extraction refactor error precedence"). When in doubt, write a test that exercises both error conditions simultaneously and assert which one wins.

3. **GW-06 7-outcome envelope is LOCKED.** `src/cases.ts:16-17` and `tests/fixtures/gw06-contract.fixtures.ts:34-44` define the 7-code enum in fixed order: `documented | create_failed | orphan_case | validation | auth | brand_mismatch | gopro_create_unsupported`. Success: `{ ok: true, outcome: 'documented', caseNumber }`. Failure: `{ ok: false, outcome, error }`. Orphan adds `caseNumber`. **Infra 500 is NOT a GW-06 outcome** — it has shape `{ error, duration_ms }` with no `ok`/`outcome` (`src/cases.ts:358`).

4. **Orphan-case rule (create-path only).** If `createCase` succeeded but a subsequent step failed, the minted case number MUST NOT be lost. Return HTTP 207 with `outcome: 'orphan_case'` and `caseNumber` populated (`src/cases.ts:253-289`). The `case_number` path never mints, so its post-step failures fall through to the generic 500 — explicitly distinct.

5. **GW-01 finalizer is best-effort.** `recordOutcome` (`src/postResultToTicket.ts`) NEVER throws. Any failure is logged + swallowed; it MUST NOT change the HTTP response already computed. Same rule for `writeAudit` (`src/documentTicket.ts:177-259`). Inner `try/catch` blocks around `auditStore.put` log `warn` and continue.

6. **Capability checks are duck-typed, NEVER on `ep.type`.** From `src/cases.ts:177-180`:
   ```ts
   const canCreateCase = typeof (docClient as Partial<OneSystemsClient>).createCase === 'function'
   ```
   This is the convention for "this adapter supports operation X". `ep.type` switching only happens in `createDocClient` (`src/docClient.ts`) — that file is the single switch site.

### Error message conventions

- Errors thrown by adapters start with the system name: `OneSystems auth failed: 401`, `GoPro upload rejected: ...`, `OneSystems createCase: missing case number in response`. Status code + truncated upstream body appended where useful.
- Validation errors are short, descriptive English: `'Invalid or missing ticket_id'`, `'Provide exactly one of create or case_number'`.
- User-facing Icelandic reasons for the GW-01 internal note live in `sanitizedReason` on `DocumentationOutcome` — preserve Icelandic special chars (`þ`, `ð`, `æ`, `ö`, `á`, `í`, `ó`, `ú`, `é`). Examples in `src/cases.ts:214, 276, 308`: `'Stofnun máls mistókst'`, `'Skjalfesting eftir stofnun máls mistókst'`. NEVER include raw upstream error detail in the note — it lands in audit/logs only.
- Bearer tokens / credentials NEVER appear in thrown `Error` messages (`src/onesystems.ts:166-167` documents this PII guard).

## Validation Pattern (no Zod)

Hand-rolled. The template, used in `src/cases.ts:103-124` and `src/onesystems.ts:24-43`:
```ts
const c = body.create as Record<string, unknown>
const ns = c?.onesystems as Record<string, unknown> | undefined
const caseTemplate = typeof ns?.caseTemplate === 'string' ? ns.caseTemplate : ''
const kennitala = typeof ns?.kennitala === 'string' ? ns.kennitala : ''
if (!caseTemplate || !kennitala) {
  return { status: 400, body: { ok: false, outcome: 'validation', error: 'Missing ...' } }
}
```
Rules:
- Cast incoming JSON to `Record<string, unknown>`, then `typeof` narrow each field.
- First-match-wins waterfalls use explicit `if (...) return` chains (`extractCaseNumber` in `src/onesystems.ts:24-43`). "Matched-but-empty" and "missing" are deliberately distinguished.
- Cross-cutting validators (case_number, subdomain, baseUrl SSRF) live in `src/tenant.ts:215-230`. **Always validate `case_number` via `validateCaseNumber()`** — never inline.

## Logging

**Logger:** `src/logger.ts` exports `createLogger(component: string): Logger`. JSON-only stdout output (Google Cloud Functions / Docker friendly). Levels: `debug | info | warn | error`. Min level from `config.service.logLevel`.

**Usage pattern** (top of every adapter):
```ts
import { createLogger } from './logger.js'
import type { Logger } from './types.js'
const logger: Logger = createLogger('cases')
```

**Calls always pass a structured data object — never string interpolation:**
```ts
logger.info('Cases request', { brand_id: brandId, ticketId, docEndpoint, intent: ... })
logger.error('createCase failed', { brand_id: brandId, ticketId, error: (err as Error).message })
```
Standard keys: `brand_id`, `ticket_id` / `ticketId`, `error` (always `(err as Error).message` — never the full error object, to avoid leaking stack frames into Cloud Logging).

## Comments / JSDoc

- Module-level block comment at the top of every `src/` file describing purpose, contract source-of-truth, and gotchas. See `src/documentTicket.ts:1-12`, `src/cases.ts:1-29`, `src/postResultToTicket.ts:1-14`.
- Function-level JSDoc whenever the function has a non-obvious contract (ownership, throws-vs-returns, ordering). `src/documentTicket.ts:45-50` is a good template.
- Inline comments cite the source-of-truth when behavior is ported verbatim: `// Ported verbatim from app malaskra_v3/src/clients/onesystems/cases.ts:104` (`src/onesystems.ts:10`), `// GW-06 L85-89` (in fixtures), `// CTX L70-72` (in contract tests).
- **No emojis in code** (except the two Icelandic internal-note glyphs `✅` / `❌` in `src/postResultToTicket.ts:65, 71` which are user-facing).

## Function Design

- Long handler functions are acceptable when the ordering is the contract (`handleCases` is 290 lines; the locked 6-step order is the whole point). Don't extract for extraction's sake.
- Extraction pattern (`src/documentTicket.ts`): each stage is a standalone function returning either a typed success or `{ ok: false, result: HandlerResult }`. The orchestrator composes them in the locked order. Behavior-preserving extractions require risk-hardening tests **before** the refactor (`tests/documentTicket.test.ts:1-18` is the template).
- Async only — no callback APIs.
- Buffers (Node `Buffer`) cross the gateway. The Cloudflare Worker runtime polyfills `Buffer`.

## Adapter Pattern (How to Add a New Doc-System Adapter)

This is the prescriptive recipe. Follow it.

1. **Implement `DocClient`** (`src/types.ts:114-116`):
   ```ts
   export interface DocClient {
     uploadDocument(params: UploadDocumentParams): Promise<unknown>
   }
   ```
   New file `src/<system>.ts`. Model on `src/gopro.ts` (simpler) or `src/onesystems.ts` (with `createCase`).

2. **Class shape:**
   - Constructor takes `(baseUrl, ...creds, { tokenTtlMs }?)`. Default `tokenTtlMs = 25 * 60 * 1000`.
   - Public fields: `baseUrl`, credentials, `token: string | null`, `tokenExpiry: number | null`, `tokenTtlMs: number`.
   - Methods: `authenticate()`, `ensureAuthenticated()`, `uploadDocument(params)`, optionally `createCase(params)` if the system supports minting.
   - `ensureAuthenticated()` checks `if (!this.token || Date.now() > this.tokenExpiry!) await this.authenticate()`. The `!` non-null assertion on `tokenExpiry` is the established pattern.

3. **Optional `createCase` (case-mint capability):**
   - Implement only if the upstream supports it. Duck-typing in `src/cases.ts:178-180` checks `typeof docClient.createCase === 'function'`. Adapters without it correctly produce GW-06 `gopro_create_unsupported` 422.
   - Return `{ caseNumber, caseTemplate }` (the `CreateCaseResult` shape, `src/types.ts:126-129`).
   - On failure throw — `handleCases` translates to `create_failed`. NEVER return a sentinel like `null`.

4. **Wire into the factory** — `src/docClient.ts`. Extend the `ep.type` union in `src/types.ts:24` (currently `'onesystems' | 'gopro'`) and add the branch in `createDocClient` that throws on missing credentials. Update `validateEndpoint` in `src/tenant.ts:160-197` with the new credential checks.

5. **Tests** — see `TESTING.md`. At minimum:
   - `tests/<system>.test.ts` — constructor / authenticate / ensureAuthenticated / uploadDocument (mocking `global.fetch`).
   - If `createCase` exists: `tests/<system>.createCase.test.ts`.
   - Add a branch to `tests/cases.test.ts` and `tests/cases.contract.test.ts` covering the new adapter through the gateway.
   - Add the new system to `tests/integration.runtime-parity.test.ts` if it has a meaningfully different code path.

6. **Logger name** matches the module: `const logger = createLogger('<system>')`.

7. **Sanitize multipart / XML / JSON outputs.** See `sanitize` and `escapeXml` helpers in `src/onesystems.ts:95-103` — strip CRLF from text form-data fields, escape XML special chars when building XML.

## Git Workflow

**Commit message style** (from `git log`):
- Conventional Commits with phase scope: `<type>(<phase or area>): <subject>`.
- Types: `feat`, `fix`, `test`, `docs`, `refactor`.
- Scopes are phase IDs (`03-g4`, `03-01`, `02-01`, `01-01`, `gw01`) — these match `.planning/phases/*/` directories.
- Subject is imperative, ≤ ~70 chars, lowercase start, no trailing period.

Examples from `git log`:
```
feat(gw01): post internal note + fields on /v1/attachments path
fix(03-g4): write lastExport as date-only YYYY-MM-DD (Zendesk date field)
test(03): canonical GW-06 contract fixtures (Tier 2a seam lock)
refactor(01-01): thin handleWebhook to delegate to documentTicket
docs(03-g4): correct stale comments (documentTicket outer try/catch; lastExport date-only)
```

**No `Co-Authored-By: Claude` trailer.** Per user instruction — author commits as the user only.

## Branch Naming

Observed in `git branch -a`:
- Phase branches: `g1`, `g2`, `g3`, `g4` (current milestone branches), `pr-g1`...`pr-g4` (PR-ready snapshots).
- Topic branches: `fix/syn-mut-28-2-brand-enumeration`, `fix/syn-mut-28-3-case-number-validation`, `docs/new-tenant-worked-example`, `deps/audit-refresh-2026-05`.
- Pattern: `<type>/<short-kebab-description>` for topic branches; bare milestone IDs for phase work.

`main` is the integration target. PRs go to the Vertiscx fork first (see `MEMORY.md` → "island-is PR workflow"), never directly to upstream `island-is` without review.

## Module Design

**Exports:** Named only. No barrel files in `src/`. Each consumer imports directly from the source module.

**Public surface of `src/`:**
- Handlers: `handleWebhook`, `handleCases`, `handleAttachments` — invoked by `src/index.ts` (Node) and `src/worker.ts` (CF).
- Adapters: `OneSystemsClient`, `GoProClient`, `ZendeskClient`.
- Factories: `createDocClient`, `createLogger`.
- Resolvers / validators: `resolveTenantConfig`, `resolveEndpoint`, `validateCaseNumber`, `validateTenantConfig`, `sanitizeAuditParam`.
- Stores: `KvTenantStore`, `FileTenantStore`, `FileAuditStore`.
- Pipeline stages: `fetchTicketInfo`, `renderPdf`, `resolveCaseNumber`, `postToCase`, `writeAudit` — exported from `src/documentTicket.ts` so `cases.ts` can recompose them.

Dynamic `import()` is used for one-shot lazy loads to break cycles: `const { recordOutcome } = await import('./postResultToTicket.js')` (`src/documentTicket.ts:330`). Don't introduce more — refactor the type/dep graph instead.

---

*Convention analysis: 2026-05-21*
