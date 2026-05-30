# CLAUDE.md — milli-mala-multi-tenant

Project-specific guidance for Claude Code sessions working in this repo. Read in addition to `ONBOARDING.md` (for new contributors) and `DEPLOYMENT.md` (for operators).

## Tenant onboarding — hard-won lessons

When adding or repointing a tenant (PR like #15 or #16):

- **ECS task definitions are full replacements, not patches.** When you generate the DevOps handoff, always include **every** env var across **every** tenant, not just the diff for the new/changed one. Sending only the new tenant's vars will cause DevOps to ship a task def missing the existing tenants and the container will crash-loop on the first missing var (`requireEnv` throws → nginx returns 503 for all tenants). The handoff `.env` is canonical; the diff is not.
- **SYN-MUT-28-1 secret strength rules** are enforced at startup and will block deploys silently:
  - Tokens, keys, webhook secrets: ≥32 characters
  - GoPro password: ≥16 characters (length only — repeated-char rule was relaxed in #17 because passwords are user-set on the upstream system)
  - All other secrets must not be a single repeated character (e.g. `'xxxxxxxx...'`)
  - `malaskra.apiKey` must be unique across tenants (FileTenantStore cross-tenant check)
  Verify candidate values against these rules **before** sending to DevOps — startup failures are invisible without monitoring.
- **PR title prefix:**
  - `chore(tenant):` for repointing an existing tenant (brand_id change, credential rotation)
  - `feat(tenant):` for adding a brand-new tenant
- **Custom field IDs are account-level, not brand-level** (Zendesk model). Reuse the same numeric ID across every brand on one Zendesk account. Per-brand field-ID config is the wrong shape.

## Cross-repo seams

- `/v1/cases` request/response contract is governed by **app-repo GW-06** (`malaskra_v3`), not by this gateway's local context. Reconcile cross-repo before changing the envelope shape.
- The Málaskrá Zendesk app at `~/dev/malaskra_v3` is the consumer of `/v1/cases` and `/v1/attachments`. Its API key reaches us via Zendesk's secure-settings proxy as `X-Api-Key` — never via raw `fetch()`.

## Upstream vs fork

- **Upstream:** `island-is/milli-mala-multi-tenant` (production target — hosted gateway for Icelandic institutions).
- **Fork:** `Vertiscx/milli-mala-multi-tenant` (development fork — code work happens here first).
- Do **not** open PRs against `island-is/island.is` (the monorepo) — that is not the right target.
- Do **not** PR to `island-is/milli-mala-multi-tenant` unsolicited; perfect the change in the Vertiscx fork first (test, review, polish), then upstream once stable. Legitimate exceptions: tenant configs for institutions actually being onboarded to the hosted gateway.

## Operational gaps to know about

These were captured as todos during the 2026-05 prod onboarding cycle and are not yet addressed:

- **No monitoring on `/v1/health` or container restarts.** Outages are invisible until manually tested. See `.planning/todos/pending/2026-05-27-per-tenant-graceful-loading.md`.
- **`loadTenants` fails fast on any missing env var** — one misconfigured tenant takes down all tenants. Per-tenant graceful loading is captured as a todo; until that lands, treat env-var changes as high-blast-radius.

## Repository specifics

- Stateless gateway, no DB / queue / cache. ~3k lines TypeScript, one runtime dep (`jspdf`).
- Two deployment shapes from one source tree: Cloudflare Workers (`src/worker.ts` + KV) and Node http (`src/index.ts` + env vars). Both must stay byte-identical at the HTTP boundary — `tests/integration.runtime-parity.test.ts` enforces this.
- `.planning/` is **gitignored** by project policy (local-only artifacts). Do not force-add planning docs to commits.
- Tests: vitest, 300+ tests, runs in <1s. Always run the full suite (`npx vitest run`) before pushing — the runtime-parity test in particular has caught subtle adapter divergences (see PR #14 history).
