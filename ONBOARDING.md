# Onboarding — milli-mala-multi-tenant

Welcome, Viggo. This guide is your map into the codebase.

**Your mission:** add **Workpoint** as a third document-system adapter, alongside the existing **OneSystems** and **GoPro** adapters. By the time you finish reading this, you should know exactly where Workpoint slots in, what invariants you must not break, and what to read in what order.

This guide assumes you are strong in TypeScript / Node, and new to the Zendesk ecosystem. It deliberately spends more time on Zendesk-specific concepts than on TypeScript-specific ones.

---

## 1. What this codebase is, in 30 seconds

`milli-mala-multi-tenant` is a **stateless gateway** that lives between Zendesk and Icelandic government document-archive systems.

```
Zendesk  ──>  milli-mala (this repo)  ──>  archive system (OneSystems / GoPro / Workpoint)
```

Three jobs:

1. **Receive** a request from Zendesk (webhook on ticket close, or manual call from the Málaskrá Zendesk app).
2. **Pull** the full ticket + comments + attachments from Zendesk and render a PDF.
3. **Push** that PDF (and optionally the original attachments) into the institution's document archive.

It is multi-tenant — one deployment serves many Icelandic institutions (Samgöngustofa, Vinnueftirlitið, etc.). Each institution = one Zendesk brand = one **tenant** in our terminology.

It runs in two shapes from the same source tree:

- **Cloudflare Workers** (production primary) — `src/worker.ts`, tenant config in KV.
- **Node http server** (Docker / K8s fallback) — `src/index.ts`, tenant config built from env vars at startup.

That's it. There's no database, no queue, no cache. ~3,000 lines of TypeScript with one runtime dep (`jspdf`) and ~280 tests.

---

## 2. Zendesk concepts you need (TS engineer's quick primer)

Most of the codebase is "normal" TypeScript. The unusual parts are all Zendesk vocabulary. Learn these four and the rest of the code reads cleanly.

### 2.1 Brand

A Zendesk **brand** is a customer-facing identity inside a single Zendesk account. One Zendesk account can host many brands (one per institution we serve). Every ticket belongs to exactly one brand, identified by a numeric `brand_id`.

**Why this matters here:** `brand_id` is our tenant key. Every API request to this gateway includes `brand_id` in the body, and the very first thing we do is look up the matching `TenantConfig`. There is no global "current tenant" — it's always passed explicitly.

### 2.2 Custom fields

Zendesk lets each account define **custom fields** on tickets, users, and organizations. Each field has a numeric ID. We use ticket custom fields to write back the outcome of an archival action: case number, last status, last export date, template used.

**Critical and counter-intuitive:** custom fields are defined **per Zendesk account**, NOT per brand. All brands on the same Zendesk account share the same field IDs. Per-brand field-ID config would be wrong; per-Zendesk-account is right. We currently happen to have one Zendesk account per institution, but the rule still holds — when you see `caseNumberFieldId` in `EndpointConfig`, that ID is account-level.

### 2.3 ZAF + secure settings (only relevant when you read the `malaskra_v3` repo)

The **Málaskrá** Zendesk app (the iframe that sits in the ticket sidebar) calls our `/v1/cases` and `/v1/attachments` endpoints. It runs inside Zendesk's sandboxed iframe and uses the **Zendesk Apps Framework (ZAF)**.

The app's API key is a Zendesk **secure setting**: stored in Zendesk's secure-settings store (NOT in iframe JS), and substituted by Zendesk's proxy when the app makes outbound calls via `client.request({ secure: true })`. The raw key never enters the iframe's heap.

You do not need to touch the Málaskrá app to add Workpoint — you'll touch this gateway. But when you see `X-Api-Key` in our code, that header is what Zendesk's proxy injects on the Málaskrá app's behalf.

(See `~/.claude/CLAUDE.md` "Zendesk Development" section for the full secure-settings rules — they govern the app side, not this gateway.)

### 2.4 Webhook + HMAC

Zendesk can fire a **webhook** when a trigger condition matches (e.g., ticket solved). The webhook POSTs to our `/v1/webhook` with an HMAC-SHA256 signature header. We verify the signature, verify the timestamp is fresh (±5 min), then run the documentation pipeline.

There is a footgun here called **GW-04 loop-safety**: because we also write back to the ticket (an internal note + custom fields), a poorly-configured Zendesk trigger can loop. The fix lives in Zendesk trigger config (one-shot pattern with a marker tag), not in this code. You don't need to solve it; you do need to know it exists when you read `DEPLOYMENT.md` and the post-back code.

---

## 3. The multi-tenant model

The shape:

```ts
// src/types.ts
TenantConfig = {
  brand_id: '360001234567',
  zendesk:   { subdomain, email, apiToken, webhookSecret },
  endpoints: {
    onesystems: { type: 'onesystems', baseUrl, appKey, …fieldIds },
    gopro:      { type: 'gopro',      baseUrl, username, password, …fieldIds },
    // workpoint:  { type: 'workpoint', baseUrl, …, …fieldIds }   <-- you
  },
  malaskra:  { apiKey },
  pdf:       { companyName, locale, includeInternalNotes },
}
```

Two things to internalize:

1. **One tenant per brand.** `brand_id` → exactly one `TenantConfig`. There is no global tenant state. Every function that needs it takes `tenantConfig` as a parameter.
2. **A tenant has multiple endpoints.** A single institution may write to OneSystems for some tickets and GoPro for others. The caller picks via the `doc_endpoint` field in the request body, which is a key into `tenantConfig.endpoints`.

**Where tenant data lives at runtime:**

- **Workers:** KV namespace `TENANT_KV`, key `tenant:${brand_id}`, value is the full `TenantConfig` JSON. KV is the secret store.
- **Node:** `src/tenants.config.ts` defines the structure; secrets come from env vars via `requireEnv('VAR_NAME')` which throws at startup if anything is missing (intentional fail-fast).

**Never** read `tenants.json` from disk in code. That file is a local seed used to bulk-write KV from a developer machine; production never sees it. (`.gitignored`.)

---

## 4. The doc-system adapter pattern — where Workpoint slots in

This is the most important section. Read it twice.

```
src/cases.ts ───┐
src/webhook.ts ─┼──> src/documentTicket.ts  ─┐
src/attachments.ts ┘                          │
                                              ▼
                                   src/docClient.ts  ◄── THE ONLY ep.type SWITCH
                                              │
                          ┌───────────────────┼────────────────────┐
                          ▼                   ▼                    ▼
                  src/onesystems.ts    src/gopro.ts        src/workpoint.ts (you)
```

**`src/docClient.ts` is the one and only place in the codebase that switches on `ep.type`.** Every other layer programs against the `DocClient` interface declared in `src/types.ts`.

### 4.1 The `DocClient` contract

Minimum every adapter must implement:

```ts
interface DocClient {
  uploadDocument(params: UploadDocumentParams): Promise<unknown>
}
```

Optional capability (declared as a method, NOT a `type` discriminator):

```ts
createCase?(params: CreateCaseParams): Promise<CreateCaseResult>
```

OneSystems has both. GoPro has only `uploadDocument`. The cases handler **duck-types** the capability:

```ts
// src/cases.ts:178
const canCreateCase =
  typeof (docClient as Partial<OneSystemsClient>).createCase === 'function'
```

If `canCreateCase` is false on the create path, the handler returns `422 outcome: 'gopro_create_unsupported'`. **The outcome name is doc-system-agnostic** despite its name — don't rename it without coordinating GW-06 (see §6).

### 4.2 Your Workpoint adapter, schematically

You will (in roughly this order):

1. Add `'workpoint'` to the `EndpointConfig.type` union in `src/types.ts`.
2. Add a `src/workpoint.ts` exporting `WorkpointClient` with `authenticate` + `uploadDocument` (and `createCase` if Workpoint supports it).
3. Add a `case 'workpoint':` branch in `createDocClient` in `src/docClient.ts`.
4. Write `tests/workpoint.test.ts` (and `tests/workpoint.createCase.test.ts` if applicable), mirroring the OneSystems / GoPro test files exactly.
5. Document the new tenant config in `DEPLOYMENT.md`.

Steps 1, 3, 4 are mechanical. Step 2 is where the real work lives — wire format, auth model, error mapping. Step 5 is the install runbook.

**You do NOT need to touch:**

- `src/cases.ts`, `src/webhook.ts`, `src/attachments.ts`, `src/documentTicket.ts` — they are adapter-agnostic.
- `src/tenant.ts` — SSRF + URL validation applies to your adapter for free.
- `src/postResultToTicket.ts` — the GW-01 post-back uses the same `caseNumberFieldId`/`lastStatusFieldId`/`lastExportFieldId`/`templateFieldId` fields. You inherit the post-back.

If you find yourself wanting to edit any of those files, **stop** and ask. Most of the time it means you've stumbled into something load-bearing.

---

## 5. The locked failure order — the non-negotiable invariant

**Read this carefully.** This is the single rule that has bitten this codebase before, and the tests are written to catch you if you break it.

The core value of `POST /v1/cases` is: **if `createCase` succeeds and a later step fails, the caller MUST learn the case number that was minted on their behalf.** Otherwise we silently create orphan cases in OneSystems that nobody knows about. That is unacceptable.

The mechanism: two separate try/catches in `src/cases.ts`, and an outcome enum of **exactly seven codes** (`documented | create_failed | orphan_case | validation | auth | brand_mismatch | gopro_create_unsupported`). The order of gates and the structure of the catches is **locked**.

For Workpoint, the only thing you need to know is:

- If Workpoint supports case creation, implement `createCase` on your client. The duck-type gate flips automatically.
- If Workpoint does NOT support case creation, do not implement `createCase`. The duck-type gate produces `gopro_create_unsupported` automatically (yes, the enum value is misnamed — see §6).
- **Do not** add a `case 'workpoint':` branch anywhere outside `src/docClient.ts`. No handler should know that Workpoint exists by name.

For the full story, read [`docs/architecture/CONCERNS.md`](docs/architecture/CONCERNS.md) "The Locked Failure Order" section — it's the most important section in that doc.

---

## 6. The GW-06 cross-repo contract

This gateway and the Málaskrá Zendesk app (in `~/dev/malaskra_v3`) share a wire contract called **GW-06**. It governs the request/response envelope of `POST /v1/cases`.

**Key rule:** the contract's source of truth is `malaskra_v3/.planning/GATEWAY-CHANGES.md §GW-06`, NOT this repo. If `tests/cases.contract.test.ts` fails, the contract has drifted — do **not** "fix" the test. Coordinate a deliberate GW-06 change with the malaskra_v3 side first.

**Workpoint impact:** the `body.create` payload is backend-namespaced. Today: `body.create.onesystems.{caseTemplate, kennitala, …}`. If Workpoint supports case creation with different parameters, that needs a coordinated GW-06 change to introduce `body.create.workpoint.*`. Do NOT cram Workpoint fields into the `onesystems` namespace.

Memory note: `gw06-cross-repo-contract-authority` in this project's memory captures this.

---

## 7. Reading order

Read these in this order. Stop and explore the code each time something is unclear.

### 7.1 First pass — get oriented (~30 minutes)

1. **[README.md](README.md)** — high-level system + endpoint table + data flow.
2. **[docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)** — the system diagram and end-to-end data flow for `POST /v1/cases`. **This is the single most important doc.** §"Data Flow" walks the critical path step by step.
3. **[docs/architecture/STRUCTURE.md](docs/architecture/STRUCTURE.md)** — the directory map. Skim to know where things live.

### 7.2 Second pass — read the code (~2 hours)

In this exact order:

1. **`src/types.ts`** — every interface you'll touch. Internalize `TenantConfig`, `EndpointConfig`, `DocClient`, `UploadDocumentParams`, `CreateCaseParams`, `CreateCaseResult`, `DocumentationOutcome`, `HandlerResult`.
2. **`src/docClient.ts`** — 30 lines. The factory. This is the seam.
3. **`src/onesystems.ts`** — the complex adapter (has both upload and createCase, multipart wire format). Skim, don't memorize.
4. **`src/gopro.ts`** — the simple adapter (upload only, per-file loop, JSON wire format). Skim.
5. **`src/cases.ts`** — the manual create/append handler. Read the docstring at the top and §"Locked Failure Order" in CONCERNS.md side-by-side with the code. Pay attention to the two try/catches around lines 187–316.
6. **`src/documentTicket.ts`** — the pipeline stages. The `fetchTicketInfo` brand cross-check is load-bearing.
7. **`src/postResultToTicket.ts`** — the GW-01 post-back. Notice that nothing throws.

### 7.3 Third pass — landmines (~30 minutes)

8. **[docs/architecture/CONCERNS.md](docs/architecture/CONCERNS.md)** — read end-to-end. This is your landmine map. The OneSystems-specific quirks section will save you days of debugging on Workpoint.
9. **[docs/architecture/CONVENTIONS.md](docs/architecture/CONVENTIONS.md)** — house style.
10. **[docs/architecture/TESTING.md](docs/architecture/TESTING.md)** — how to write tests that match the existing patterns.

### 7.4 Reference (consult as needed)

- **[docs/architecture/STACK.md](docs/architecture/STACK.md)** — versions, deps.
- **[docs/architecture/INTEGRATIONS.md](docs/architecture/INTEGRATIONS.md)** — every external system, its protocol and auth.
- **[DEPLOYMENT.md](DEPLOYMENT.md)** — how to deploy and how to seed KV.
- **`tests/onesystems.test.ts`, `tests/gopro.test.ts`** — the template you'll copy for `tests/workpoint.test.ts`.

---

## 8. Dev setup

```bash
# Clone, install
git clone <repo> milli-mala-multi-tenant
cd milli-mala-multi-tenant
npm ci          # NOT npm install — see memory note npm-audit-fix-desync

# Run tests
npm test        # vitest run, ~280 tests, should be all green
npm run test:watch  # if you prefer

# Type-check only
npx tsc --noEmit

# Coverage
npm run test:coverage
```

**You do not need a real Zendesk or a real OneSystems/GoPro instance to develop and test Workpoint locally.** All tests mock `global.fetch`. The first time you'll exercise real services is at the **ship window** — see TESTING.md "Testing discipline for Zendesk apps" in the global CLAUDE.md for the rationale.

**You will need:**

- Node 20+ (matches Cloudflare Workers' Node compat surface).
- `wrangler` CLI installed only if/when you want to run the Worker locally (`npx wrangler dev`). Not required for unit tests.
- A `tenants.json` (gitignored) only if you want to seed a real KV. Ask Bryn for the template.

**You will NOT need:**

- A `.env` file in this repo. Secrets in development come from your shell env or `wrangler dev` bindings, not `.env`.
- Docker, unless you want to run the Node http server locally.

---

## 9. House conventions, in one paragraph

TypeScript strict. No `any` (use `unknown` + narrowing). Errors thrown across boundaries carry HTTP-status-text in the message; **never** bearer tokens or passwords. All secret comparisons go through SHA-256 + `timingSafeEqual` from `node:crypto`. Logs are structured JSON, always include `brand_id` (a public ID, not a secret). Validation lives in `src/tenant.ts`; handlers call validators, never reimplement them. Adapters never read module-level mutable state. Tests mirror `src/` file-by-file. Commit messages follow conventional-commit style (`feat(workpoint): …`, `fix(workpoint): …`). **Do not add `Co-Authored-By: Claude` trailers** — author commits as yourself.

For the full version, read [docs/architecture/CONVENTIONS.md](docs/architecture/CONVENTIONS.md).

---

## 10. What we know about Workpoint (today)

**Honest status:** very little.

- Workpoint is another Icelandic document-archive system, in the same category as OneSystems and GoPro.
- It will be a third adapter behind the same `DocClient` interface, slotted in at `src/docClient.ts`.
- We do NOT yet have: vendor API docs, sandbox credentials, the wire format, the auth model, or a confirmed list of institutions that need it.

**What you can do today without those:**

1. Read everything in §7.
2. Skim the OneSystems and GoPro adapters until you can describe in one sentence each how their auth + upload + (for OneSystems) case-creation work.
3. Identify the seven gotchas in CONCERNS.md §"OneSystems-Specific Quirks" and predict which equivalents will exist for Workpoint. (Trailing slash on `baseUrl`? Template-as-internal-code instead of display name? Silent 200 on bad case numbers? Each of those is real.)
4. Sketch a `WorkpointClient` skeleton with the right method signatures and TODO bodies — no real logic yet.

**What we need before you can build the real adapter:**

- The Workpoint vendor (or their docs).
- A staging environment + test credentials.
- The list of Zendesk-account-side institutions adopting Workpoint (drives the `requirements.json` install step on the Málaskrá side).

We'll capture all of that in the **Workpoint milestone** (`.planning/ROADMAP.md` will be updated next session) and discuss/plan each phase from there.

---

## 11. Your first PR (suggested)

When you're ready, the lowest-risk first PR is:

**"chore: add Workpoint placeholder to EndpointConfig type union and docClient factory"**

Scope:

- `src/types.ts` — add `'workpoint'` to `EndpointConfig['type']`.
- `src/docClient.ts` — add a `case 'workpoint':` branch that throws `Error('Workpoint adapter not yet implemented')`.
- No new tests yet (the throw is intentional; we'll add tests when the adapter exists).
- Updates to `README.md` mentioning Workpoint as a planned third backend.

That PR is:

- Tiny (~10 lines + docs).
- Behavior-preserving for OneSystems and GoPro (those branches don't change).
- A useful forcing function — it exposes the seam visibly and gives you a green CI run as a baseline.
- A natural place for a first code review without anything risky in flight.

Don't open it until Bryn has shaken hands on it — but it's a good "I've read everything and I want to make sure I understand the seam" gesture.

---

## 12. People + cross-repo map

| Repo | Path | Why it matters to you |
|---|---|---|
| `milli-mala-multi-tenant` | `~/dev/milli-mala-multi-tenant` | **This repo.** The gateway. |
| `malaskra_v3` | `~/dev/malaskra_v3` | The Zendesk app (sidebar iframe). Owns the GW-06 contract that governs `/v1/cases`. You will not edit it, but when you change `body.create.*` shape, the malaskra_v3 side must change in lockstep. |
| `milli-mala` (single-tenant) | `~/dev/milli-mala` | The original single-tenant prototype. **Legacy.** Don't reference it for new work — this repo is the source of truth. |

**Memory:** if you use the Claude Code memory system, the project memory under `~/.claude/projects/.../memory/MEMORY.md` has notes worth reading — `gw06-cross-repo-contract-authority`, `extraction-refactor-error-precedence`, `live-staging-validation`, `npm-audit-fix-desync`, `codecov-project-gate`. These are real war stories.

---

## 13. Questions worth asking out loud

You will discover things this guide doesn't cover. Ask. Especially these:

- "What does Workpoint actually want on the wire?" (We don't know yet.)
- "Which institutions are migrating to Workpoint, and on what timeline?" (Drives the GW-06 + requirements.json work.)
- "Is there a Workpoint sandbox?" (Mirrors the OneSystems / GoPro staging story.)
- "What's the case-number format?" (Affects `validateCaseNumber` looseness in `src/tenant.ts`.)
- "Does Workpoint support `createCase`?" (Determines whether you implement the optional method.)

Welcome aboard.

---

*Last updated: 2026-05-21*
