# Architecture

_Last updated: 2026-09-02. Describes `main` as of island-is #40._

Milli-mála is a multi-tenant gateway for Zendesk integrations in the Icelandic public sector. It has two layers: a **platform** that authenticates requests, resolves tenants, holds credentials and writes audit entries, and **services** that run one integration each on top of it. One service exists in production, the archive service, and it is the reason the platform was built. This document explains how a request moves through the system, how tenants are isolated, where the extension points are, and what the system deliberately does not do.

Read [README.md](README.md) first for the short version and local setup. Read [OPERATIONS.md](OPERATIONS.md) for deploying and running it.

---

## 1. What it does

**The platform** solves the problems every Zendesk integration for an institution runs into: proving a request came from Zendesk or from an authorised app, telling institutions apart, holding credentials for the far system without exposing them, and keeping a record of what happened. It knows nothing about archives.

**The archive service** is the integration in production. An institution handles citizen correspondence in Zendesk and is obliged to file it in its official archive. The service receives a signed request naming a ticket, fetches the ticket from Zendesk, renders it to PDF, and uploads the PDF and any attachments into the institution's archive case. If the ticket has no case yet, it can ask the archive to create one and write the new case number back onto the ticket. Zendesk never sees archive credentials. Archive systems never see Zendesk credentials.

Two archive products are supported: **OneSystems** and **GoPro**. Seven institutions are configured today.

A second service, email inspection, was built in mid-2026 and is not merged; see [ONBOARDING.md](ONBOARDING.md#open-decisions). The rest of this document describes the platform and the archive service as they run today.

---

## 2. Shape of the system

```
                         ┌──────────────────────────────────────┐
  Zendesk trigger ──────▶│  POST /v1/webhook      (HMAC signed) │
                         │                                      │      OneSystems
  Málaskrá app ─────────▶│  POST /v1/cases        (X-Api-Key)   │────▶    or
  (agent sidebar)        │  POST /v1/attachments  (X-Api-Key)   │       GoPro
                         │                                      │
  Operator ─────────────▶│  GET  /v1/audit        (Bearer)      │
  Load balancer ────────▶│  GET  /v1/health       (none)        │
                         └──────────────────────────────────────┘
                                   one Node.js container
                              ▲ reads ticket, writes result note
                              └──────── Zendesk API ────────────▶
```

One stateless container. No database, no queue, no cache. The only persistent state is an optional audit log written to a directory (see section 8).

---

## 3. Code layout

```
src/
  index.ts                  Node HTTP server. Production entry point.
  worker.ts                 Cloudflare Worker entry point. NOT production (see section 10).
  tenants.config.ts         The tenant list. Secrets come from env vars.

  platform/                 Shared foundation. Knows nothing about archiving.
    env.ts                  requireEnv / optionalNumberEnv — fail fast at boot
    config.ts               Instance settings: port, log level, audit secret
    tenant.ts               Tenant lookup + validation + SSRF and secret-strength guards
    zendesk.ts              Zendesk REST client: read ticket, comments, users, attachments; write fields
    fileAuditStore.ts       Directory-backed audit store
    logger.ts               Structured JSON to stdout
    http/routes.ts          Route table type + matcher
    types.ts                Shared types (TenantConfig, EndpointConfig, AuditStore, ...)

  services/archive/         The archive capability. May import platform; platform never imports it.
    routes.ts               The three POST routes and their handlers
    webhook.ts              /v1/webhook: verify signature + freshness, then documentTicket()
    cases.ts                /v1/cases: manual documentation or case creation from Málaskrá
    attachments.ts          /v1/attachments: forward attachments only
    documentTicket.ts       Orchestrator for the webhook path
    pipeline/               The stages the orchestrator composes:
      fetch.ts                get ticket + comments + users + attachments; brand cross-check
      render.ts               PDF
      caseNumber.ts           read the case-number field, or fall back to ZD-<ticket>
      createFlow.ts           create a case when the field is empty (OneSystems only)
      deliver.ts              upload PDF + attachments to the archive
      finalize.ts             failure bookkeeping
      audit.ts                audit entry writer
    postResultToTicket.ts   Writes an internal note + custom fields back to the ticket
    docClient.ts            THE adapter switch. Only place that branches on endpoint type.
    onesystems.ts           OneSystems adapter (upload + createCase)
    gopro.ts                GoPro adapter (upload only)
    pdf.ts                  jsPDF rendering
    types.ts                Archive-only types (DocClient, DocumentationOutcome, ...)
```

The rule that keeps this honest: `platform/` never imports from `services/`. A second service could be added under `services/` without touching the platform.

---

## 4. Request lifecycle

Every POST goes through the same gate in `src/index.ts` before any handler runs:

1. Body is read with a 1 MB cap and parsed as JSON.
2. `brand_id` is required. It is the tenant key.
3. The tenant is looked up and validated. Unknown or invalid tenant returns a neutral `400 Invalid request` so the endpoint does not enumerate tenants.
4. The route handler runs with the resolved `TenantConfig`.

Then, per endpoint:

**`/v1/webhook`** (Zendesk trigger, on ticket solved or closed)
1. Verify the Zendesk HMAC-SHA256 signature over `timestamp + body` with the tenant's webhook secret. Constant-time compare.
2. Reject if the timestamp is more than five minutes from now. Replay protection.
3. Fetch the ticket. **Brand cross-check:** if the ticket's `brand_id` does not equal the tenant's, return 403. This is what stops one institution's webhook from archiving another institution's ticket.
4. Fetch comments, the users named in them, and attachments. Attachment downloads are restricted to `zendesk.com` and `zdassets.com` hosts and are capped by count and total size. Skipped files are reported, never silently dropped.
5. Render the PDF. Internal notes are included only if the tenant's `pdf.includeInternalNotes` is true.
6. Decide the case number. See section 5.
7. Upload PDF and attachments to the archive.
8. Write an audit entry and post an internal note back to the ticket with the outcome. If configured, stamp status and last-export custom fields.

**`/v1/cases`** (Málaskrá app, agent-initiated)
Same as webhook from step 3 on, but authenticated by `X-Api-Key` against the tenant's Málaskrá key, and the agent chooses explicitly: document into an existing `case_number`, or `create` a new case with a template and kennitala. Responds with a fixed seven-value outcome envelope: `documented`, `create_failed`, `orphan_case`, `validation`, `auth`, `brand_mismatch`, `gopro_create_unsupported`.

**`/v1/attachments`** (Málaskrá app)
Authenticated by `X-Api-Key`. Forwards attachments to an existing case. No PDF.

---

## 5. Case numbers and the failure rules

This is the part of the system that carries the most domain knowledge. The rules are:

| Situation | Behaviour |
|---|---|
| Ticket's case-number field is populated | Use it. Validate length and characters. Upload. |
| Field is empty, backend is GoPro | Use `ZD-<ticket id>` as the case reference. GoPro cannot create cases. |
| Field is empty, backend is OneSystems, template and kennitala fields present | **Create** a case in OneSystems, **stamp** the new number on the ticket, **then** upload. |
| Field is empty, backend is OneSystems, template or kennitala missing | **422**, nothing created, nothing uploaded. Internal note explains which field is missing. |
| Case was created but stamp or upload then failed | **207** with the created case number in the body and the audit entry. Never a 5xx. |
| Any failure before a case is created | **500**. Zendesk retries. Safe because nothing was minted. |

Why stamp before upload: Zendesk retries failed webhooks. If the case number is already on the ticket when the retry arrives, the retry takes the populated-field path and cannot create a second case. This is the only duplicate-mint guard, which is why a tenant without a configured `caseNumberFieldId` is refused on the create path.

Why 422 and 207 instead of 500: a 5xx makes Zendesk retry. Retrying a request that can never succeed is noise. Retrying a request that already created a case would create another one.

---

## 6. Tenants

A tenant is one Zendesk brand. Brands on the same Zendesk account share custom-field IDs, so several institutions on the Digital Iceland account use the same three field IDs.

Tenant shape (`src/platform/types.ts`):

```
brand_id, name
zendesk:   subdomain, email, apiToken, webhookSecret
services.archive:
  endpoints:  { <name>: { type, baseUrl, appKey | username+password, field IDs } }
  malaskra:   { apiKey }
  pdf:        { companyName, locale, includeInternalNotes }
```

Tenants are declared in `src/tenants.config.ts` with every secret read from an environment variable named `<TENANT>_<FIELD>`. Validation at boot rejects:

- a missing required variable (the container does not start),
- a Zendesk subdomain containing anything but letters, digits and hyphens,
- an archive `baseUrl` that is not HTTPS or that points at a private or loopback address,
- a secret shorter than 32 characters or made of one repeated character,
- two tenants sharing a Málaskrá key,
- a field ID that is not a positive integer.

A request for one tenant can only ever read that tenant's Zendesk and write to that tenant's archive. There is no cross-tenant code path.

---

## 7. The adapter seam

`src/services/archive/docClient.ts` is 31 lines and is the only code that branches on endpoint `type`. Everything above it programs against:

```ts
interface DocClient {
  uploadDocument(params): Promise<unknown>
}
// optional, detected at runtime:
createCase(params): Promise<{ caseNumber, caseTemplate }>
```

Adding a third archive product means one new adapter file, one new branch in the factory, one new value in the `type` union, and a validation clause for its credentials. Nothing in the pipeline changes.

---

## 8. Audit log

Every documentation attempt writes two entries, keyed for two query shapes:

```
audit:<brand_id>:<timestamp>:<ticket_id>     newest-first per tenant
ticket:<brand_id>:<ticket_id>:<timestamp>    history of one ticket
```

Entries hold ticket ID, brand, outcome, case number and source, duration, PDF size, failed attachments. No ticket content, no kennitala. TTL is 90 days.

`GET /v1/audit?brand_id=&ticket_id=&limit=` reads them, authenticated by `Authorization: Bearer <AUDIT_SECRET>`.

**Known limitation.** The production store is `FileAuditStore`, which writes files under `AUDIT_DIR` inside the container. Unless that directory is on a mounted volume, the log is lost on every redeploy. The `AuditStore` interface is three methods; a durable implementation is the recommended next change.

---

## 9. Security boundaries

| Boundary | Enforcement |
|---|---|
| Request is really from Zendesk | HMAC-SHA256 over timestamp + body, five-minute window |
| Request is really from Málaskrá | Per-tenant API key, SHA-256 then constant-time compare |
| Ticket belongs to this tenant | Brand cross-check, 403 on mismatch, 403 if brand absent |
| Outbound to archive only where configured | HTTPS only, private ranges blocked, at config validation |
| Outbound to Zendesk only | Attachment URLs must be on `zendesk.com` or `zdassets.com` |
| No secret leakage in responses | Fixed error strings; upstream bodies are capped before logging |
| No PII in audit | Metadata only |
| Weak or placeholder secrets | Rejected at boot |

The container runs as a non-root user, exposes port 8080, and has one runtime dependency (jsPDF).

---

## 10. What is not production

- **`src/worker.ts` and `KvTenantStore`.** A Cloudflare Workers runtime exists and is kept in sync by a runtime-parity test. It is not deployed anywhere. Production is the Node container on AWS ECS at Digital Iceland. Treat the Worker path as an experiment that may be removed.
- **`entrypoint.sh` and `TENANTS_JSON`.** The entrypoint writes an optional `TENANTS_JSON` env var to a file, but `src/index.ts` loads tenants from `tenants.config.ts`, not from that file. This is a leftover.
- **Anything under `.planning/`.** Vertis-internal working notes, excluded from the upstream repository.

---

## 11. Known gaps

In priority order.

1. **Audit log is not durable** on ECS (section 8).
2. **Tenants are code.** Each new institution is a PR, a review, seven secrets, and a deploy.
3. **No retry or queue.** The gateway depends on Zendesk's retry behaviour. Adequate at current volume; not adequate if an archive is down for an hour under high load.
4. **The Worker runtime doubles the maintenance surface** for no production benefit.
5. **Pipeline files carry heavy refactor-era comments** referencing planning documents that are not in this repository.

---

## 12. Tests

23 files, 422 tests, `npm test`. Highlights:

- `tests/integration.runtime-parity.test.ts` runs the same requests through the Node and Worker entry points and asserts identical responses.
- `tests/cases.contract.test.ts` pins the `/v1/cases` envelope.
- `tests/pipeline.guards.test.ts` covers the case-number rules in section 5.
- `tests/tenants.config.test.ts` checks the real tenant list loads with placeholder secrets.

CI runs tests on Node 20 and 22 on every PR, plus CodeQL.
