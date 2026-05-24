# Technology Stack

**Analysis Date:** 2026-05-21

## Languages

**Primary:**
- TypeScript ^5.5.0 — all source under `src/` (see `tsconfig.json`). `strict: true`, ES2022 target/module, `moduleResolution: "bundler"`, `rootDir: src`, `outDir: dist`, `declaration: true`, `sourceMap: true`. Type checking enforced via `npm run typecheck` (`tsc --noEmit`).

**Secondary:**
- Shell — `entrypoint.sh` (POSIX `sh`, materializes `$TENANTS_JSON` to `/app/tenants.json` then `exec node dist/index.js`).
- YAML — GitHub Actions in `.github/workflows/`.
- TOML — Cloudflare Workers config in `wrangler.toml`.

## Runtime

**Environment (dual target — same TS, two entrypoints):**

| Target | Entrypoint | Runtime | Notes |
|--------|-----------|---------|-------|
| Cloudflare Workers | `src/worker.ts` | V8 isolate / Workers runtime | Uses `node:crypto` (`createHmac`, `timingSafeEqual`, `createHash`) — requires `compatibility_flags = ["nodejs_compat"]` set in `wrangler.toml:4` |
| Node.js (Docker / ECS / K8s) | `src/index.ts` | Node.js ≥ 20 (`package.json:engines`) | Plain `node:http` `createServer`, listens on `$PORT` (default 8080) |

Compatibility date pinned to `2024-09-23` (`wrangler.toml:3`).

**Package Manager:**
- npm (the only manager — `package-lock.json` is committed at the repo root, 74 KB).
- Lockfile present (`npm ci` used in Dockerfile + every CI job).

## Frameworks

**Core:**
- **No web framework.** The Node server is hand-rolled on `node:http` (`src/index.ts:13,46-67,214-224`) — manual path/method routing, manual JSON body reader with a 1 MB cap (`MAX_BODY_SIZE`), manual `sendJson` helper. No Express/Fastify/Hono.
- The Workers entrypoint uses the standard `export default { fetch }` handler with `Response.json` (`src/worker.ts:46-232`).
- Both entrypoints expose the same 5 routes: `POST /v1/webhook`, `POST /v1/attachments`, `POST /v1/cases`, `GET /v1/health`, `GET /v1/audit`.

**Testing:**
- **Vitest** ^4.0.18 (`vitest`, `@vitest/coverage-v8`) — config at `vitest.config.ts`. Globals enabled (`describe`/`it`/`expect` ambient), `environment: 'node'`. Coverage provider is v8; `src/worker.ts` and `src/index.ts` are excluded from coverage as runtime-parity entrypoints.
- **node-mocks-http** ^1.17.2 — used in tests under `tests/` to fake `IncomingMessage`/`ServerResponse` for the Node HTTP path.
- No separate assertion library — `expect` from Vitest.
- No linter is wired in (`.github/workflows/test.yml:62-64` is an explicit "No linter configured yet" placeholder marked `continue-on-error: true`). There is no `.eslintrc*`, `.prettierrc*`, or `biome.json` in the repo.

**Build/Dev:**
- **tsx** ^4.0.0 — `npm start` = `npx tsx src/index.ts`, `npm run dev` = `npx tsx --watch src/index.ts` (TS executed directly in dev, no build step).
- **tsc** — `npm run build` emits to `dist/`. The Dockerfile builds via `npx tsc` in the builder stage, then copies `dist/` to the runtime image and runs `node dist/index.js`.
- **wrangler** (Cloudflare CLI) — invoked indirectly: `cloudflare/wrangler-action@v3` in CI for `deploy --dry-run`; locally for `wrangler deploy --env staging`, `wrangler tail`, `wrangler secret put`. Wrangler itself is NOT pinned in `package.json` devDependencies — it is expected to be run via `npx wrangler` or the GitHub Action.

## Key Dependencies

**Critical (runtime — there is exactly one):**
- **jspdf** ^4.1.0 — pure-JS PDF renderer. The ONLY production dependency. Used by `src/pdf.ts` to render Zendesk tickets to A4 PDFs (`new jsPDF({ unit: 'pt', format: 'a4' })`, `doc.text`, `doc.setFont('helvetica', …)`, `doc.output('arraybuffer')`). jsPDF runs in both Node and the Workers V8 isolate without polyfills; everything else the gateway needs (HTTP, crypto, base64) comes from Node built-ins or Workers globals.

**Standard library (no package, but load-bearing):**
- `node:crypto` — `createHmac` for Zendesk webhook signature verification (`src/webhook.ts:6,21-25`); `timingSafeEqual` + `createHash` for constant-time API-key and bearer-token checks (`src/attachments.ts:9,29-33`, `src/cases.ts:31,47-55`, `src/index.ts:12,179-181`).
- `node:http` — Node entrypoint server (`src/index.ts:13,214`).
- `node:fs/promises` — `FileAuditStore` reads/writes JSON files for the Docker audit store (`src/fileAuditStore.ts:7`).
- `node:path` — `join` for audit file paths (`src/fileAuditStore.ts:8`).
- Global `fetch` (Node 20+ and Workers) — every outbound HTTP call (Zendesk API, OneSystems, GoPro, Zendesk attachment downloads) uses native `fetch` directly; no axios/got/undici-wrapper.

**Infrastructure (Cloudflare bindings — declared in `wrangler.toml`, not in `package.json`):**
- KV namespace **`TENANT_KV`** — tenant config store keyed by `tenant:<brand_id>` (`src/tenant.ts:48-58` `KvTenantStore`).
- KV namespace **`AUDIT_LOG`** — append-only audit entries keyed by `audit:<brand_id>:<ts>:<ticket_id>` and `ticket:<brand_id>:<ticket_id>:<ts>` with `expirationTtl: 90 * 24 * 60 * 60` (90 days) (`src/documentTicket.ts:242-258`).
- Secret **`AUDIT_SECRET`** — bearer token gating `GET /v1/audit` (set via `wrangler secret put AUDIT_SECRET`).

**Development:**
- `@types/node` ^20.0.0 — type declarations for Node built-ins (`tsconfig.json` has `"types": ["node"]`). No `@cloudflare/workers-types` is declared; `CfEnv` is hand-typed in `src/worker.ts:19-23`.

## Configuration

**Environment:**

Two runtimes use two different config-loading strategies, but the data shape (`TenantConfig` from `src/types.ts:7-14`) is identical:

| Target | Where tenants come from | Where secrets come from |
|--------|------------------------|-------------------------|
| Node / Docker / ECS | `loadTenants()` in `src/tenants.config.ts` builds a hard-coded array of two tenants and pulls every credential through `requireEnv(NAME)` (`src/env.ts:12-21` — throws if missing/empty, fails the container at startup) | Flat env vars, one set per tenant, prefixed by tenant slug (`KERFISSTJORN_*`, `VINNUEFTIRLIT_*`). Template in `.env.example`. |
| Cloudflare Workers | `KvTenantStore.get('tenant:<brand_id>')` reads JSON from the `TENANT_KV` binding (`src/tenant.ts:41-58`) | Embedded in the KV JSON blob (Zendesk credentials, doc-system credentials, malaskra apiKey) + the worker-level `AUDIT_SECRET` set via `wrangler secret put` |

Instance-level (non-tenant) config is read once from `process.env` by `getConfig()` in `src/config.ts:17-30`: `PORT` (default 8080), `LOG_LEVEL` (default `info`), `AUDIT_SECRET` (default empty → 401 on `/v1/audit`).

The Node entrypoint also honours `AUDIT_DIR` (default `./audit-data`) for the `FileAuditStore` (`src/index.ts:212`).

**Build:**
- `tsconfig.json` — sole TS config. `strict`, `esModuleInterop`, `forceConsistentCasingInFileNames`, `resolveJsonModule`, `declaration` + `declarationMap` + `sourceMap`. `exclude: ["node_modules", "dist", "tests"]` — tests are NOT compiled by `tsc`, only Vitest runs them.
- `wrangler.toml` — Workers config. `main = "src/worker.ts"` (wrangler bundles the TS directly). Default `[vars] LOG_LEVEL = "info"`; the `[env.staging]` environment overrides to `debug` and pins the staging KV namespace IDs (`TENANT_KV = 48fde62a3d764730a785d445e464bcae`, `AUDIT_LOG = b4779d850432478aa656cb68559a71f2`).
- `vitest.config.ts` — Vitest config. `globals: true`, `environment: 'node'`, v8 coverage. **Worker entrypoints excluded from coverage** (`src/worker.ts`, `src/index.ts`) — they are runtime-parity adapters, tested via integration suites under `tests/` instead.
- `Dockerfile` — multi-stage. Builder: `node:20-alpine`, `npm ci`, `npx tsc`. Runtime: `node:20-alpine`, `npm ci --only=production` (just jsPDF), copies `dist/` + `entrypoint.sh`, drops to non-root `nodejs:1001` user, exposes 8080, `HEALTHCHECK` curls `/v1/health` every 30 s. Entrypoint materializes `$TENANTS_JSON` (if set) to `/app/tenants.json` before exec'ing the server.
- `docker-compose.yml` — local-dev convenience: builds the Dockerfile, maps 8080:8080, loads `.env` via `env_file`, replicates the healthcheck.

## Platform Requirements

**Development:**
- Node.js ≥ 20.0.0 (`package.json:engines.node`).
- npm (uses `package-lock.json`).
- `npm install` then `npm start` (Node) or `npx wrangler dev` (Workers — requires a Cloudflare account + KV namespaces).
- A real Zendesk subdomain + API token + webhook secret per tenant for end-to-end testing — there is no mock/stub Zendesk in the dev loop.

**Production (three supported deployment targets, same source):**

1. **Cloudflare Workers** (primary, evident from `wrangler.toml`, the `[env.staging]` block, and the dual-entrypoint design):
   - Deploy: `wrangler deploy --env staging` (and presumably `--env production` once configured).
   - Bindings: `TENANT_KV`, `AUDIT_LOG`, secret `AUDIT_SECRET`.
   - Logs: `wrangler tail --env staging`.

2. **AWS ECS Fargate** (via `.github/workflows/deploy.yml`):
   - Image registry: `821090935708.dkr.ecr.eu-west-1.amazonaws.com/milli-mala-multi-tenant`.
   - Cluster: `tooling-prod`, service: `prod-milli-mala-multi-tenant`, region: `eu-west-1`.
   - Auth: GitHub OIDC → `secrets.TOOLING_OIDC_ARN` (no static AWS keys in CI).
   - Deploy flow: on PR-merged-to-main / tag push / manual dispatch, build & push Docker image, register a new ECS task definition by mutating the existing one's `containerDefinitions[0].image`, then `aws ecs update-service` + `wait services-stable`.

3. **Kubernetes / generic Docker** — the `Dockerfile` + `docker-compose.yml` + the README's "DEPLOYMENT.md" reference (17 KB doc at repo root) indicate K8s/self-host is a supported target. Same image, same env-var contract.

The `entrypoint.sh` `$TENANTS_JSON` hack lets a K8s/ECS deployment supply the entire tenant config as one secret JSON blob (Kubernetes Secret → env var → file) instead of two-dozen flat env vars — useful when running >2 tenants without exploding the env-var matrix.

## CI

`.github/workflows/`:
- **`ci.yml`** — runs on push/PR to `main`. `npm ci` + `npx vitest run`. On main only, a `deploy-dry-run` job runs `wrangler deploy --dry-run` against the Cloudflare API (`continue-on-error: true`).
- **`test.yml`** — runs on push/PR to `main`/`develop`. Matrix over Node 20.x and 22.x, runs `npm test` and `npm run test:coverage`, uploads to Codecov (continue-on-error). Lint job is a placeholder.
- **`deploy.yml`** — see "Production" above. Triggered by PR-merged-to-main, `v*` tag push, or manual `workflow_dispatch`.

CODEOWNERS exists at `.github/CODEOWNERS`.

---

*Stack analysis: 2026-05-21*
