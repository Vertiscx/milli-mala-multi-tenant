# Milli-mála as a Zendesk Gateway Platform

**Status:** Proposal — for joint architecture decision with Digital Iceland
**Date:** 2026-07-16
**Authors:** Vertis (Brynjólfur Stefánsson), with Claude Code

## 1. Context and Problem

Milli-mála today is a single-purpose gateway: a Zendesk trigger or API call fires,
the service fetches the ticket, renders a PDF, and files it into an institution's
archive system (OneSystems or GoPro). It is multi-tenant — one deployment serves
many institutions on one Zendesk instance, keyed by `brand_id` — and it is hosted
by Digital Iceland on AWS ECS.

New needs are arriving that share the same shape — *a Zendesk event fires, and
middleware must do work that Zendesk itself cannot* — but are not archiving:

- **Ticket splitting (service A).** Zendesk creates only one ticket per inbound
  email even when it was addressed to several institutions' service addresses.
  A trigger-driven service must read the original `To:` recipients, compare
  against known service addresses, and create the missing tickets via API so
  each institution has its own ticket.
- **Forward annotation (service B).** When an agent forwards an email from
  their own mailbox into Zendesk, add an internal note marking it as such.
- **CSAT links (service C).** A Zendesk automation, some time after solve,
  asks the gateway to generate and send a one-time CSAT link.
- More will follow — any workflow where Zendesk needs authenticated middleware.

Every one of these needs the same expensive plumbing milli-mála already has:
webhook signature verification, per-institution (tenant) configuration and
secrets, a Zendesk API client, structured audit logging, and a governed
deployment at Digital Iceland.

**The question:** one service or several? One repo or a monorepo?

## 2. Decision (proposed)

**One service, one repo, with a strict internal boundary between *platform* and
*services* — structured so that extracting a service into its own deployable
later is a folder move, not a rewrite.**

### Why not the alternatives

- **Two deployables (integration layer + workflow engine).** The distinction
  ("Zendesk → external system" vs "Zendesk → Zendesk") is directional, not
  operational. All capabilities are the same risk class: asynchronous ticket
  post-processing, none in a synchronous citizen-facing path. Splitting
  doubles the ECS services, pipelines, secret sets, and monitoring surfaces
  Digital Iceland must govern — for no isolation benefit that module
  boundaries don't already give.
- **Monorepo with multiple deployables (island.is style) now.** Right answer
  at ~5+ services with separate teams or release cadences. Today it is
  overhead without payoff. The proposed structure *is* the escape hatch: when
  a service earns its own deployable, `services/<name>/` plus `platform/`
  becomes its own package.

### The one candidate for early extraction

Ticket splitting (service A) has the highest-consequence failure mode: if it
fails silently, an institution's tickets simply never exist. If any capability
is ever split out for independent deployment and alerting, it is this one. The
structure below makes that possible without prejudging it.

## 3. Target Structure

```
src/
  platform/                  # shared, service-agnostic foundation
    http/                    # Node server + CF Worker adapters, router,
                             #   body reading, JSON responses, size limits
    tenant/                  # TenantStore (file/KV), resolution, core validation
    zendesk/                 # API client + webhook signature/timestamp verification
    audit/                   # AuditStore interface + file/KV backends
    logger.ts
    types.ts                 # platform types only (TenantConfig core,
                             #   HandlerResult, AuditStore, Logger)
  services/
    archive/                 # everything milli-mála does today:
                             #   webhook pipeline, PDF rendering, cases,
                             #   attachments, OneSystems + GoPro clients,
                             #   result post-back, archive-specific types
    ticket-split/            # future — service A
    forward-note/            # future — service B
    csat/                    # future — service C
  index.ts                   # Node entry: wire route registry into HTTP server
  worker.ts                  # CF Worker entry: same registry, Worker adapter
  tenants.config.ts          # tenant list: core section + per-service sections
```

### Rules that keep the boundary honest

1. `platform/` never imports from `services/`.
2. A service imports from `platform/` and from itself — never from a sibling
   service. Cross-service needs are a signal the code belongs in `platform/`.
3. Each service owns its routes, its slice of tenant config (including
   validation), and its domain types.

## 4. Route Registry

Today, adding an endpoint means hand-writing a near-identical HTTP wrapper in
**both** `index.ts` (Node) and `worker.ts` (Cloudflare) — parse body, extract
`brand_id`, resolve tenant, dispatch. Worse, `doc_endpoint` (an archive
concept) is demanded at the platform layer for every route.

Instead, each service exports a route table:

```ts
// services/archive/routes.ts
export const routes: ServiceRoute[] = [
  { method: 'POST', path: '/v1/webhook',     handler: handleWebhook },
  { method: 'POST', path: '/v1/attachments', handler: handleAttachments },
  { method: 'POST', path: '/v1/cases',       handler: handleCases },
]
```

The platform composes all service route tables once, and both entry points
(`index.ts`, `worker.ts`) iterate the same registry. The platform does what is
universal — body limits, JSON parsing, `brand_id` extraction, tenant
resolution, webhook signature verification for trigger-driven routes — and
hands the handler a validated, typed request. Service-specific fields like
`doc_endpoint` move into the service's own handler.

Adding service A then means: create `services/ticket-split/`, export its
routes, add its config section. No edits to platform code, no duplicated
wrappers.

## 5. Tenant Configuration Model

Today `TenantConfig` assumes every tenant archives: `malaskra`, `pdf`, and
`endpoints` are required, and validation fails without `pdf.companyName`. A
tenant that only wants CSAT could not exist.

Proposed shape — a small required core plus optional per-service sections:

```ts
interface TenantConfig {
  brand_id: string
  name: string
  zendesk: ZendeskConfig            // subdomain, email, apiToken, webhookSecret
  services: {
    archive?: ArchiveServiceConfig  // endpoints, malaskra, pdf — today's config
    ticketSplit?: TicketSplitConfig // future: service-address list, etc.
    csat?: CsatConfig               // future
  }
}
```

- The platform validates the core (identity, Zendesk credentials, secret
  strength per SYN-MUT-28-1).
- Each service validates its own section and is simply inactive for tenants
  that omit it.
- Env-var naming keeps the existing convention:
  `<TENANT>_<SERVICE>_<KEY>` (existing archive vars keep their names —
  no ECS secret changes in the restructure).

## 6. What Stays Exactly As It Is

- **Deployment model:** one ECS service at Digital Iceland, same Docker image,
  same env-var secret injection. The Cloudflare Worker path remains supported.
- **Security posture:** HMAC webhook verification, timestamp freshness,
  SSRF-guarded endpoint URLs, secret-strength validation, audit trail.
- **The archive behavior:** byte-identical. The restructure moves files and
  introduces seams; it does not change what `/v1/webhook`, `/v1/attachments`,
  or `/v1/cases` do.
- **External contracts:** all existing routes, payloads, and responses.

## 7. Migration Plan — Two Runs

**Run 1 — restructure (one PR).**
Move files into `platform/` / `services/archive/`, introduce the route
registry, split `types.ts`, and reshape `TenantConfig` into core +
`services.archive`. Mechanical, behavior-preserving. Gate: the full existing
test suite passes unchanged (barring import paths), and the runtime-parity
tests confirm Node and Worker entry points still behave identically.

**Run 2 — split `documentTicket.ts` (one PR).**
The 781-line archive pipeline becomes readable stages inside
`services/archive/` (fetch → render → resolve case → upload → record outcome).
Kept separate from Run 1 so reviewers never face a moved-AND-changed file.
Lesson applied from the earlier extraction refactor: diff the control flow
explicitly and test combined error conditions, so error precedence cannot
silently invert.

Only after both runs does new-service work (A/B/C) begin, each as its own
`services/<name>/` addition.

## 8. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Restructure PR is large and hard to review | Pure moves + import updates only; behavior gated by unchanged tests; no logic edits allowed in Run 1 |
| Shared blast radius (one bad deploy affects all services) | All services are async post-processing (retryable); per-service audit events; health endpoint reports per-service status |
| Config reshape breaks existing tenants | `tenants.config.ts` is code — the compiler enforces the new shape; runtime-parity tests cover both runtimes; env-var names unchanged |
| Boundary erosion over time (services importing each other) | Lint rule (import restrictions) enforcing the three boundary rules |
| Service A's silent-failure consequence | Designed-in: per-service audit outcomes from day one; extraction path if it needs independent alerting |

## 9. Resolved Questions (2026-07-16)

1. **One deployable, confirmed.** We evolve milli-mála as is — the single
   service already deployed at Digital Iceland. No new deployables.
2. **Naming stays.** The repo remains `milli-mala-multi-tenant`; no rename.
3. **Data processing unchanged.** The restructure itself changes nothing about
   data handling. Any assessment for ticket splitting (service A) is deferred
   to when that service is actually designed.
4. **Audit storage stays file-based for now** — logged as a known improvement:

> **Improvement note (open):** the audit log is file-based and ephemeral on
> ECS — a container restart loses it. When the platform gains its next
> service, or at the next infrastructure conversation with DI, propose durable
> audit storage (database or object storage). Until then, this remains the top
> operational risk.
