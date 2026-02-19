# Milli-Mala

**Zendesk → Document System Bridge Service**

Middleware service for automatic ticket archival. When a Zendesk ticket is closed, this service receives a webhook, generates a PDF summary of the ticket and its comments, and uploads it to the configured document system. Supports OneSystems and GoPro (gopro.net) as document backends — set `DOC_SYSTEM` to choose which one. Works alongside Malaskra.

## Architecture

```
Zendesk Webhook → Cloudflare Worker → PDF Generation → Document System API
                       ↓                                (OneSystems or GoPro)
                  KV Audit Log
```

- **Runtime**: Cloudflare Workers (primary), Node.js/Docker/Azure also supported
- **PDF**: jsPDF (CF Workers compatible, no filesystem needed)
- **Audit**: Cloudflare KV (Workers) or file-based store (Docker/Node.js), 90-day TTL

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for full deployment guides (Cloudflare Workers, Azure Container Apps, Self-hosted Docker), Zendesk webhook setup, and troubleshooting.

### Running Tests

```bash
npm test
```

## Data Handling and Retention

This section documents how ticket data flows through the system, what is retained, and where data is stored. This is relevant for data protection compliance and government security requirements.

### Data Flow Overview

```
                     ┌─────────────────────────────────────────────────┐
                     │               Milli-Mala Worker                 │
                     │                  (in memory)                    │
                     │                                                 │
  Zendesk API ──────>│  1. Fetch ticket metadata (subject, status,     │
  (HTTPS GET)        │     dates, custom_fields)                       │
                     │  2. Fetch all comments (public + internal)      │
                     │  3. Fetch user record for solving agent         │
                     │  4. Download attachment binaries                │
                     │                                                 │
                     │  5. Generate PDF from ticket + comments         │──────> Document System
                     │  6. Upload PDF as base64                        │        (HTTPS POST)
                     │                                                 │
                     │  7. Write audit entry (metadata only)           │──────> Cloudflare KV
                     │                                                 │
                     │  8. Discard all data from memory                │
                     └─────────────────────────────────────────────────┘
```

### What is fetched from Zendesk

| Data | Source | Used for |
|---|---|---|
| Ticket metadata | `GET /tickets/{id}.json` | PDF header (subject, status, dates) |
| All comments | `GET /tickets/{id}/comments.json` | PDF body (rich text, timestamps) |
| All comment author records | `GET /users/show_many.json?ids=...` | PDF comment headers (agent/user names) and document system `User` field (solving agent email) |
| Attachment binaries | `GET {content_url}` | Uploaded to document system alongside PDF (GoPro: individually; OneSystems: via `/attachments` endpoint) |

### What is included in the PDF

The generated PDF contains:

- Ticket number, subject, status, created/updated dates
- All **public** comments with timestamps and **agent/user names** (resolved from Zendesk user records)
- Comment bodies retain **rich text formatting** (bold, italic, lists, headings, blockquotes, links)
- Internal notes are **excluded by default** (`PDF_INCLUDE_INTERNAL_NOTES=false`)

The PDF does **not** contain:
- Requester email address
- Attachment contents
- Custom field values (except case number if configured)

### What is sent to the document system

The service uploads the generated PDF to whichever document system is configured via `DOC_SYSTEM`. Both systems receive:

- **Case number** — from a Zendesk custom field, or `ZD-{ticket_id}` as fallback
- **Solving agent email** — used as the `User` field
- **PDF file** — base64-encoded ticket summary
- **Filename** — `ticket-{ticket_id}.pdf`

**OneSystems** (`DOC_SYSTEM=onesystems`): Multipart form upload to `/api/OneRecord/AddDocument2`, authenticated with `Authorization: Bearer` token.

**GoPro** (`DOC_SYSTEM=gopro`): JSON body upload to `/v2/Documents/Create` (one file per call), authenticated with `Authorization: Bearer` token.

All connections use HTTPS. Text fields are sanitized to prevent CRLF injection.

### What is stored in the audit log (Cloudflare KV)

Audit log entries are stored in Cloudflare KV with a **90-day TTL** (automatic expiration). Entries contain **operational metadata only**, no PII:

```json
{
  "event": "ticket_archived",
  "timestamp": "2026-02-09T12:00:00.000Z",
  "duration_ms": 1234,
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
- Zendesk subdomain or document system URL

### What is NOT retained by Milli-Mala

Milli-Mala is a stateless pass-through service. The following data is held **only in memory** during request processing and discarded immediately after:

| Data | Held in memory | Written to disk | Sent externally |
|---|---|---|---|
| Ticket metadata (subject, status, dates) | During request | Never | Embedded in PDF |
| Comment bodies (rich text) | During request | Never | Embedded in PDF |
| Agent/user names | During request | Never | Embedded in PDF comment headers |
| Internal notes | During request | Never | Excluded from PDF by default |
| Attachment binaries | During request | Never | Uploaded to document system |
| Solving agent email | During request | Never | Sent as document system `User` field |
| Generated PDF | During request | Never | Sent to document system as base64 |
| API tokens (Zendesk, document system) | During request | Never | Sent only to their respective APIs over HTTPS |

**Key points:**
- No database, filesystem, or persistent storage is used (except audit log: Cloudflare KV or file-based store for metadata only)
- All ticket data is garbage-collected after the HTTP response is sent
- Cloudflare Workers have no filesystem — data cannot be written to disk
- In the Node.js/Docker deployment, only audit metadata is written to disk (no PII)

### Attachment handling

Attachments are downloaded from Zendesk and uploaded to the configured document system:

1. Validated for SSRF (only `*.zendesk.com` and `*.zdassets.com` HTTPS URLs allowed)
2. Capped at **50 files** and **100 MB total** to prevent resource exhaustion
3. Downloaded into memory as binary buffers
4. **GoPro**: uploaded individually via `/v2/Documents/Create` alongside the PDF
5. **OneSystems**: uploaded via the `/attachments` endpoint (triggered by Malaskra)
6. Counted in the audit log (count only, no filenames or content)
7. Discarded when the request completes (garbage collected)

Attachment binary data never touches disk.

## Security

Last audited: 2026-02-16. No critical or high-severity findings remain open.

| Control | Details |
|---|---|
| Webhook Authentication | HMAC-SHA256 with `timingSafeEqual` — only Zendesk can trigger the webhook |
| Replay Protection | Webhook timestamp must be within 5-minute window to prevent replay attacks |
| Constant-Time Auth | All secret comparisons (webhook, API key, audit secret) use SHA-256 + `timingSafeEqual` to prevent timing and length oracle attacks |
| Attachments Endpoint Auth | `X-Api-Key` header required, verified with constant-time comparison |
| Audit Endpoint Auth | Bearer token required for `/audit` access |
| Body Size Limit | 1 MB enforced in both Node.js and Cloudflare Worker |
| Attachment Limits | Max 50 files and 100 MB total per request to prevent resource exhaustion |
| SSRF Protection | Attachment downloads restricted to `*.zendesk.com` and `*.zdassets.com` (HTTPS only) |
| Input Sanitization | CRLF injection prevented on multipart fields; XML escaping on metadata; `ticket_id` validated as positive integer |
| Error Handling | Internal errors return generic message — no stack traces or secrets leaked |
| Secret Management | All credentials stored as encrypted secrets, never in code or config files |
| Stateless | No PII stored — ticket data is held in memory only during processing |
| Container Security | Non-root Docker container (`node:20-alpine`), 1 production dependency |

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/webhook` or `/` | Zendesk HMAC | Receives ticket archival webhooks |
| `POST` | `/attachments` | `X-Api-Key` header | Forwards ticket attachments to document system (called by Malaskra) |
| `GET` | `/health` | None | Health check (returns service status) |
| `GET` | `/audit` | Bearer token | Query audit log entries |

### Audit Endpoint Usage

```bash
# List recent entries
curl -H "Authorization: Bearer YOUR_AUDIT_SECRET" \
  https://your-worker.workers.dev/audit

# Filter by ticket
curl -H "Authorization: Bearer YOUR_AUDIT_SECRET" \
  https://your-worker.workers.dev/audit?ticket_id=123&limit=10
```

## License

Apache-2.0
