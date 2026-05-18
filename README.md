# Milli-Mala

**Multi-tenant Zendesk-to-archive gateway for Icelandic government institutions**

Milli-mala is a secure bridge between Zendesk and government document archive systems. It receives requests via two paths:

- **Webhook** (`/v1/webhook`) — triggered by Zendesk automation (e.g. ticket solved, closed, or any trigger the institution configures)
- **Attachments** (`/v1/attachments`) — called by the Malaskra Zendesk app to forward ticket attachments on demand

For each request, milli-mala resolves the tenant by `brand_id`, fetches the ticket data from Zendesk server-side, generates a PDF summary, and uploads it to the tenant's configured archive system. Supports **OneSystems** and **GoPro** (gopro.net) as document backends. Each tenant can have multiple archive endpoints.

## Architecture

```
  Zendesk / Malaskra              milli-mala                 Archive Systems
  ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────────┐
  │ Sends:           │      │ Holds per tenant:│      │ OneSystems           │
  │ · ticket_id      │─────>│ · Zendesk creds  │─────>│ GoPro                │
  │ · brand_id       │      │ · Archive creds  │      │ (others in future)   │
  │ · doc_endpoint   │      │ · PDF settings   │      │                      │
  │ · X-Api-Key or   │      │                  │      │                      │
  │   HMAC signature │      │ Resolves tenant  │      │                      │
  │                  │      │ by brand_id      │      │                      │
  └──────────────────┘      └──────────────────┘      └──────────────────────┘
    No archive creds           No public exposure         No Zendesk exposure
```

Milli-mala acts as a DMZ gateway — Zendesk and Malaskra never see archive credentials, and archive systems never see Zendesk credentials.

### Tech stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Cloudflare Workers (primary), Node.js / Docker / K8s also supported
- **PDF**: jsPDF (CF Workers compatible, no filesystem needed)
- **Audit**: Cloudflare KV (Workers) or file-based store (Docker/Node.js), 90-day TTL
- **Tests**: Vitest (170+ tests)
- **License**: Apache 2.0

## Multi-tenant design

Each Zendesk brand maps to a tenant. The caller sends `brand_id` and `doc_endpoint` in every request. Milli-mala resolves the tenant config from a backing store:

| Deployment | Tenant config store |
|-----------|-------------------|
| Cloudflare Workers | KV namespace (`TENANT_KV`) — one key per tenant: `tenant:{brand_id}` |
| Docker / K8s | `src/tenants.config.ts` (committed structure) + environment variables (secrets) |

### Tenant config structure

The `TenantConfig` shape is the same regardless of where it's stored — see `src/types.ts` for the canonical definition. A populated example:

```ts
{
  brand_id: '360001234567',
  name: 'Samgongustofa',
  zendesk: {
    subdomain: 'samgongustofa',
    email: 'integration@samgongustofa.is',
    apiToken: '...',
    webhookSecret: '...'
  },
  endpoints: {
    onesystems: { type: 'onesystems', baseUrl: 'https://api.onesystems.is', appKey: '...' },
    gopro:      { type: 'gopro',      baseUrl: 'https://api.gopro.is', username: '...', password: '...' }
  },
  malaskra: { apiKey: '...' },
  pdf: { companyName: 'Samgongustofa', locale: 'is-IS', includeInternalNotes: false }
}
```

The `endpoints` map allows each institution to have multiple archive systems. The `doc_endpoint` field in the request selects which one. Each endpoint's `type` field (`"onesystems"` or `"gopro"`) determines which client is used.

### Adding or rotating tenants (Docker / K8s)

Tenant *structure* lives in `src/tenants.config.ts` (committed, code-reviewed). Tenant *secrets* live with DevOps as flat environment variables. See [`.env.example`](.env.example) for the full list of required variables.

| Operation | Where the change happens |
|---|---|
| Add a new tenant | PR appending an entry to `src/tenants.config.ts` + ask DevOps to provision the new env vars listed by `requireEnv` calls in that entry |
| Rotate a secret | DevOps updates the env var on the deployment and restarts the container — no code change |
| Update a non-secret (PDF copy, endpoint URL) | PR to `src/tenants.config.ts` only |
| Remove a tenant | PR removing the entry + ask DevOps to deprovision the now-orphaned env vars |

The container fails to start if any required env var is missing — intentional, surfaces misconfiguration immediately rather than per-request.

### Request format

Both endpoints receive the same three fields:

```json
{
  "ticket_id": "12345",
  "brand_id": "360001234567",
  "doc_endpoint": "onesystems"
}
```

The webhook endpoint also requires Zendesk HMAC signature headers. The attachments and cases endpoints require an `X-Api-Key` header (validated against the tenant's `malaskra.apiKey`). The cases endpoint additionally takes either a `create` block or a `case_number` (see [Cases endpoint](#cases-endpoint)).

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/webhook` | Zendesk HMAC | Generates PDF from ticket and uploads to archive system |
| `POST` | `/v1/cases` | `X-Api-Key` header | Synchronous manual documentation: create a case and/or document an existing one (called by Málaskrá) |
| `POST` | `/v1/attachments` | `X-Api-Key` header | Forwards ticket attachments to archive system (called by Malaskra) |
| `GET` | `/v1/health` | None | Health check |
| `GET` | `/v1/audit` | Bearer token | Query audit log entries |

### Cases endpoint

`POST /v1/cases` documents a Zendesk ticket into an archive case **synchronously** — the gateway runs the whole pipeline inline and returns the outcome in the response body. Called by the Málaskrá Zendesk app. The request/response shape is governed by the cross-repo **GW-06** contract.

The request carries the three common fields plus **exactly one** of `create` or `case_number`:

```json
// Create a new case, then document into it:
{
  "ticket_id": "12345",
  "brand_id": "360001234567",
  "doc_endpoint": "onesystems",
  "create": { "onesystems": { "caseTemplate": "...", "kennitala": "...", "caseName": "..." } }
}

// Document into an existing case:
{
  "ticket_id": "12345",
  "brand_id": "360001234567",
  "doc_endpoint": "onesystems",
  "case_number": "2026-00123"
}
```

Every structured response is the GW-06 envelope — success `{ ok: true, outcome: "documented", caseNumber }`, failure `{ ok: false, outcome, error }`, orphan `{ ok: false, outcome: "orphan_case", error, caseNumber }`. The `outcome` is one of seven codes:

| Outcome | HTTP | Meaning |
|---|---|---|
| `documented` | 200 | Ticket documented into the case |
| `orphan_case` | 207 | Case was created but a later step failed — response carries the created `caseNumber` so it is never silently lost (create path only) |
| `create_failed` | 502 | Archive case creation failed |
| `validation` | 400 | Malformed request (missing/invalid fields, or not exactly one of `create`/`case_number`) |
| `auth` | 401 | Invalid or missing `X-Api-Key` |
| `brand_mismatch` | 403 | Ticket does not belong to the caller's brand |
| `gopro_create_unsupported` | 422 | `create` requested for a GoPro endpoint (case creation is not supported there) |

A failure on the **`case_number` path** (documenting into an existing case) propagates to a generic `HTTP 500 { error, duration_ms }` — this is a retry-safe internal error, not a GW-06 outcome (nothing was minted, so there is no orphan to report).

### Result post-back (GW-01)

After **every** documentation action — `/v1/cases`, `/v1/webhook`, and `/v1/attachments` — the gateway writes the outcome back onto the Zendesk ticket so the agent (and the Málaskrá sidebar) can see it. This is a single atomic, best-effort `PUT`: it **never throws and never changes the HTTP response or the archival result**. It is skipped for `auth`, `validation`, and `brand_mismatch` (no trusted ticket context).

It writes:

- **An internal note** (`public: false`) — `✅` with the case number on success, `❌` with a sanitized reason on failure, plus any failed attachments. Timestamp in UTC `DD.MM.YYYY HH:MM:SS`.
- **Custom fields** (each written only if its `*FieldId` is configured on the endpoint — see [Tenant schema](DEPLOYMENT.md#tenant-configuration)):
  - `caseNumberFieldId` — the archive case number (success)
  - `lastStatusFieldId` — the ratified **`last_status` JSON v1**: `{ v:1, status, outcome, timestamp, caseNumber?, docSystem, template?, reason? }` (absent keys omitted, never null). On failure only this field is written (it itself carries the reason).
  - `lastExportFieldId` — date-only `YYYY-MM-DD` (Zendesk date field) on success
  - `templateFieldId` — the case template, OneSystems create path only

> **Operational prerequisite (GW-04):** because the post-back updates the ticket, any Zendesk **trigger** that drives `/v1/webhook` must be one-shot (fire on a marker tag it removes in the same run) or it will loop. See [Zendesk Setup → Loop-safety](DEPLOYMENT.md#zendesk-setup).

### Audit endpoint

```bash
# List recent entries
curl -H "Authorization: Bearer YOUR_AUDIT_SECRET" \
  https://your-endpoint/v1/audit

# Filter by brand
curl -H "Authorization: Bearer YOUR_AUDIT_SECRET" \
  https://your-endpoint/v1/audit?brand_id=360001234567&limit=10

# Filter by brand + ticket
curl -H "Authorization: Bearer YOUR_AUDIT_SECRET" \
  https://your-endpoint/v1/audit?brand_id=360001234567&ticket_id=123
```

## Environment variables (Node.js / Docker)

Service-level settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Listen port | `8080` |
| `LOG_LEVEL` | Log level (`info`, `debug`, `error`) | `info` |
| `AUDIT_SECRET` | Bearer token for `/v1/audit` endpoint | (empty — audit endpoint disabled) |
| `AUDIT_DIR` | Directory for persistent audit log | `./audit-data` |

Tenant credentials (Zendesk API token, archive system keys, Málaskrá API keys) are also environment variables — see [`.env.example`](.env.example) for the complete list. They are read at startup by `src/tenants.config.ts` via the `requireEnv` helper; missing variables cause startup to fail loudly.

For Cloudflare Workers, tenant config is stored in KV (`TENANT_KV` binding) and `AUDIT_SECRET` is set as a Worker secret.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for full deployment guides:

- Cloudflare Workers
- Docker / Docker Compose
- Kubernetes
- Node.js on server

### Running tests

```bash
npm test
```

## Data handling and retention

This section documents how ticket data flows through the system, what is retained, and where data is stored. Relevant for data protection compliance and government security requirements.

### Data flow

```
                     ┌─────────────────────────────────────────────────┐
  Request            │               Milli-Mala                        │
  (brand_id,         │                                                 │
   ticket_id,   ────>│  1. Resolve tenant config by brand_id           │
   doc_endpoint)     │  2. Fetch ticket metadata from Zendesk          │
                     │  3. Fetch all comments (public + internal)      │
                     │  4. Resolve comment author names                │
                     │  5. Download attachment binaries                │
                     │                                                 │
                     │  6. Generate PDF from ticket + comments         │──> Archive System
                     │  7. Upload PDF + attachments                    │    (HTTPS POST)
                     │                                                 │
                     │  8. Write audit entry (metadata only)           │──> Audit Store
                     │  9. Discard all data from memory                │
                     └─────────────────────────────────────────────────┘
```

### What is fetched from Zendesk

| Data | Source | Used for |
|---|---|---|
| Ticket metadata | `GET /tickets/{id}.json` | PDF header (subject, status, dates) |
| All comments | `GET /tickets/{id}/comments.json` | PDF body (rich text, timestamps) |
| Comment author records | `GET /users/show_many.json?ids=...` | PDF comment headers (agent/user names) and document system `User` field (solving agent email) |
| Attachment binaries | `GET {content_url}` | Uploaded to archive system alongside PDF |

### What is included in the PDF

The generated PDF contains:

- Ticket number, subject, status, created/updated dates
- All **public** comments with timestamps and **agent/user names** (resolved from Zendesk user records)
- Comment bodies retain **rich text formatting** (bold, italic, lists, headings, blockquotes, links)
- Internal notes are **excluded by default** (configurable per tenant via `pdf.includeInternalNotes`)

The PDF does **not** contain:

- Requester email address
- Attachment contents
- Custom field values (except case number if configured)

### What is sent to the archive system

The archive system selected by `doc_endpoint` receives:

- **Case number** — from a Zendesk custom field (configured per endpoint via `caseNumberFieldId`), or `ZD-{ticket_id}` as fallback
- **Solving agent email** — used as the `User` field
- **PDF file** — ticket summary
- **Filename** — `ticket-{ticket_id}.pdf`

**OneSystems**: Multipart form upload to `/api/OneRecord/AddDocument2`, authenticated with `Authorization: Bearer` token.

**GoPro**: JSON body upload to `/v2/Documents/Create` (one file per call), authenticated with `Authorization: Bearer` token.

All connections use HTTPS. Text fields are sanitized to prevent CRLF injection.

### What is stored in the audit log

Audit entries are stored with a **90-day TTL**. Entries contain **operational metadata only**, no PII:

```json
{
  "event": "ticket_archived",
  "timestamp": "2026-02-09T12:00:00.000Z",
  "duration_ms": 1234,
  "brand_id": "360001234567",
  "source": {
    "ticket_id": 12345,
    "ticket_status": "solved",
    "total_comments": 8,
    "public_comments": 6,
    "internal_notes": 2,
    "internal_notes_included": false,
    "total_attachments": 3
  },
  "destination": {
    "doc_endpoint": "onesystems",
    "doc_system": "onesystems",
    "case_number": "CASE-001",
    "case_number_source": "custom_field",
    "pdf_filename": "ticket-12345.pdf",
    "pdf_size_bytes": 45678
  }
}
```

The audit log does **not** store:

- Ticket subjects or descriptions
- Comment bodies
- Requester or agent names/emails
- Attachment filenames or contents
- Zendesk subdomain or archive system URL

### What is NOT retained

Milli-mala is a stateless pass-through service. The following data is held **only in memory** during request processing and discarded immediately after:

| Data | Held in memory | Written to disk | Sent externally |
|---|---|---|---|
| Ticket metadata (subject, status, dates) | During request | Never | Embedded in PDF |
| Comment bodies (rich text) | During request | Never | Embedded in PDF |
| Agent/user names | During request | Never | Embedded in PDF comment headers |
| Internal notes | During request | Never | Excluded from PDF by default |
| Attachment binaries | During request | Never | Uploaded to archive system |
| Solving agent email | During request | Never | Sent as archive system `User` field |
| Generated PDF | During request | Never | Sent to archive system |
| API tokens (Zendesk, archive) | During request | Never | Sent only to their respective APIs over HTTPS |

**Key points:**

- No database, filesystem, or persistent storage is used (except audit log: KV or file-based store for metadata only)
- All ticket data is garbage-collected after the HTTP response is sent
- Cloudflare Workers have no filesystem — data cannot be written to disk
- In the Node.js/Docker deployment, only audit metadata is written to disk (no PII)

### Attachment handling

Attachments are downloaded from Zendesk and uploaded to the configured archive system:

1. Validated for SSRF (only `*.zendesk.com` and `*.zdassets.com` HTTPS URLs allowed)
2. Capped at **50 files** and **100 MB total** to prevent resource exhaustion
3. Downloaded into memory as binary buffers
4. **GoPro**: uploaded individually via `/v2/Documents/Create` alongside the PDF
5. **OneSystems**: uploaded via the `/v1/attachments` endpoint (triggered by Malaskra)
6. Counted in the audit log (count only, no filenames or content)
7. Discarded when the request completes (garbage collected)

Attachment binary data never touches disk.

## Security

| Control | Details |
|---|---|
| Tenant isolation | Each brand_id resolves to its own credentials and endpoints. No cross-tenant data access. |
| Webhook authentication | HMAC-SHA256 with `timingSafeEqual` — only Zendesk can trigger the webhook |
| Replay protection | Webhook timestamp must be within 5-minute window |
| Constant-time auth | All secret comparisons (webhook, API key, audit secret) use SHA-256 + `timingSafeEqual` to prevent timing and length oracle attacks |
| Attachments endpoint auth | `X-Api-Key` header required, verified against tenant's `malaskra.apiKey` with constant-time comparison |
| Audit endpoint auth | Bearer token required for `/v1/audit` access |
| Endpoint validation | `doc_endpoint` must exist in the tenant's `endpoints` map — unknown endpoints are rejected |
| Body size limit | 1 MB enforced in both Node.js and Cloudflare Worker |
| Attachment limits | Max 50 files and 100 MB total per request |
| SSRF protection | Attachment downloads restricted to `*.zendesk.com` and `*.zdassets.com` (HTTPS only) |
| Input sanitization | CRLF injection prevented on multipart fields; XML escaping on metadata; `ticket_id` validated as positive integer |
| Error handling | Internal errors return generic message — no stack traces or secrets leaked |
| Secret management | Tenant credentials in encrypted KV (CF) or mounted secrets (K8s/Docker). Never in code. |
| Stateless | No PII stored — ticket data held in memory only during processing |
| Container security | Non-root Docker container (`node:20-alpine`), 1 production dependency |
| Structured logging | JSON format with `brand_id` in all entries. No PII in logs. |

## Future: OAuth 2.0 authentication

The `/v1/attachments` endpoint currently uses a static API key (`X-Api-Key` header) for authentication. This is secure — keys are per-tenant and compared in constant time — but static keys have limitations:

- A leaked key remains valid until manually rotated
- Keys carry no expiry, scope, or identity information
- No standard way to audit which client made a request

**Recommended upgrade: OAuth 2.0 with island.is authentication service.**

The island.is authentication service is built on OAuth 2.0 / OpenID Connect and is the standard for government service-to-service authentication in Iceland. Migrating to OAuth would provide:

- **Short-lived tokens** — access tokens expire automatically (e.g. 1 hour), limiting the damage from a leaked credential
- **Scopes** — tokens can be restricted to specific tenants or actions (e.g. "can only access brand 360001234567")
- **Audit trail** — each token carries client identity, enabling per-caller audit logging
- **Standard protocol** — aligns with devland.is standards and enables integration with other island.is services

### What would need to change

| Component | Current | With OAuth |
|-----------|---------|-----------|
| **Malaskra app** | Sends static `X-Api-Key` header | Requests an access token from the authorization server, sends `Authorization: Bearer {token}` |
| **Tenant config** | `malaskra.apiKey` field | Replace with `malaskra.oauth.audience` or `malaskra.oauth.allowedClientIds` |
| **`/v1/attachments` handler** | Compares `X-Api-Key` against tenant config | Validates JWT signature, checks expiry, verifies audience/scope matches tenant |
| **`/v1/webhook` endpoint** | No change needed | No change — Zendesk HMAC signing is Zendesk's own standard |
| **`/v1/audit` endpoint** | Static Bearer token | Could also migrate to OAuth, or keep as-is for internal use |

### Migration path

1. Add a `/v1/token` endpoint or integrate with island.is auth service as the authorization server
2. Update the attachments handler to accept and validate JWTs alongside the existing API key (backwards compatible)
3. Update Malaskra to use OAuth token flow
4. Once all clients are migrated, remove static API key support

This is not required for the current deployment but is recommended before scaling to more institutions or exposing the API to additional consumers beyond Malaskra.

## License

Apache-2.0
