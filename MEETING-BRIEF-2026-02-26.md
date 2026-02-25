# Meeting Brief: Milli-Mala Multi-Tenant Hosting at Digital Iceland

**Date:** 26 February 2026
**Meeting with:** Digital Iceland DevOps Team
**Prepared for:** Brynjolfur

---

## What Is Milli-Mala (Plain Language)

Milli-mala is a **multi-tenant bridge service** that sits between Zendesk and government document archive systems (OneSystems or GoPro).

**Multi-tenant** means it serves multiple government institutions from a single deployment. Each institution (tenant) has its own Zendesk brand, its own credentials, and its own archive system — completely isolated from each other.

### How It Gets Triggered

There are **two ways** ticket data gets sent to the document archive:

#### Path 1: Automatic (Zendesk Webhook)

1. An institution's Zendesk ticket gets solved/closed
2. Zendesk sends a webhook (signed "ping") to milli-mala with the ticket number and brand ID
3. Milli-mala verifies the signature, looks up which institution it belongs to
4. It fetches the ticket, comments, user names, and attachments from that institution's Zendesk
5. It builds a PDF of the full conversation
6. It uploads the PDF + attachments to that institution's archive system
7. It logs what happened (metadata only, no personal data) and responds "done"

#### Path 2: Manual (Malaskra Zendesk App)

1. An agent clicks "Document Case" in the Malaskra sidebar app inside Zendesk
2. Malaskra calls milli-mala's `/v1/attachments` endpoint with an API key and brand ID
3. Milli-mala looks up the institution, fetches the ticket's attachments from Zendesk
4. It forwards the attachments to the institution's archive system
5. For **GoPro**: milli-mala handles everything server-side
6. For **OneSystems**: Malaskra generates the PDF itself, then milli-mala forwards attachments separately

**The service never stores any ticket data.** It reads, converts, forwards, and forgets. The only thing it keeps is a short audit log entry like "ticket #1234, brand 360001234567, processed at 14:32, result: success."

---

## How It's Built (What to Tell DevOps)

**Key talking points:**

- **Language:** TypeScript (strict mode) — same as the island.is stack
- **Runtime:** Node.js 20 (Alpine Linux container)
- **Container ready:** Multi-stage Docker build, runs as non-root user (UID 1001), built-in health checks
- **Single dependency:** Only one external library (jsPDF for PDF generation). Everything else uses built-in Node.js.
- **Stateless:** No database. No file storage needed. Processes requests in memory and forgets.
- **Multi-tenant:** Each institution is isolated — own credentials, own archive endpoints, own webhook secrets. Tenant configs stored in Cloudflare KV or a mounted `tenants.json` file.
- **Audit logging:** Optional file-based audit log or Cloudflare KV (metadata only, no PII, 90-day TTL)
- **Tests:** 119 unit tests covering all security paths
- **License:** Apache 2.0

**Docker details they'll want:**
- Base image: `node:20-alpine` (multi-stage build — TypeScript compiled in builder stage, only JS shipped)
- Non-root user: `nodejs` (UID 1001, GID 1001)
- Port: 8080
- Health endpoint: `GET /v1/health`
- Tenant config: mount `tenants.json` as read-only volume
- Production install: `npm ci --only=production`

**Useful vocabulary for the meeting:**

| Term | What to say |
|------|-------------|
| "Stateless middleware" | It doesn't store anything, just passes data through |
| "Multi-tenant" | One deployment serves multiple institutions, each isolated |
| "Brand ID" | Zendesk's way of identifying which institution a ticket belongs to |
| "Webhook-driven" | Zendesk pushes to us, we don't poll |
| "HMAC signature verification" | We check that requests are genuinely from Zendesk using a shared secret |
| "Fail-closed" | If anything is uncertain (missing brand, wrong signature), the request is rejected — never allowed through |
| "Non-root container" | The process inside Docker doesn't run as admin, limiting damage if compromised |
| "DMZ gateway" | Milli-mala sits between Zendesk and the archive — neither side sees the other's credentials |

---

## Security Overview (Government Perspective)

### What's Already Built In

| Security Feature | What It Means |
|---|---|
| **Tenant isolation** | Each institution has its own credentials and endpoints. A request for institution A can never access institution B's data. |
| **Brand cross-check (fail-closed)** | Every request verifies the ticket actually belongs to the claiming brand. If the brand is missing or wrong, the request is blocked — never allowed through. |
| **HMAC-SHA256 webhook signing** | Every request from Zendesk is signed with a secret key. Milli-mala verifies it before doing anything. Fake requests are rejected. |
| **Replay protection** | A signed request can only be used within 5 minutes. An attacker can't capture and replay old requests. |
| **Timing-safe comparisons** | All secret comparisons use constant-time algorithms. An attacker can't guess secrets by measuring response times. |
| **SSRF protection** | Only downloads attachments from `*.zendesk.com` and `*.zdassets.com` over HTTPS. Private IP ranges blocked (127.x, 10.x, 192.168.x, localhost, IPv6). Cannot be tricked into accessing internal network resources. |
| **Input validation** | Ticket IDs must be positive integers. Body capped at 1 MB. Attachments capped at 50 files / 100 MB. Audit query parameters sanitized against injection. |
| **XML/CRLF injection prevention** | Data inserted into XML or multipart forms is escaped and sanitized. |
| **No PII in logs or audit** | Audit log stores only: ticket ID, brand ID, timestamp, success/failure. No names, emails, or ticket content. Logs are structured JSON with no personal data. |
| **No secrets in code** | All credentials come from tenant config (encrypted KV or mounted secrets). Nothing hardcoded. |
| **Generic error responses** | Error messages never reveal internal details, stack traces, or system information. |
| **Minimal attack surface** | 1 external dependency. No database. No persistent state. TypeScript strict mode. |
| **Endpoint validation** | The `doc_endpoint` field must match an endpoint defined in the tenant's config. Unknown endpoints are rejected. |

### What DevOps Should Add / Verify (Their Responsibility)

| Item | Why It Matters |
|---|---|
| **TLS 1.2+ enforcement** | All traffic must be encrypted. Configure at reverse proxy / load balancer level. |
| **Rate limiting** | The app doesn't rate-limit internally. Add this at the proxy or WAF level per tenant/IP. |
| **Network isolation** | The container only needs outbound HTTPS to Zendesk and the archive systems. No inbound access to internal networks. |
| **Secret management** | Tenant configs contain credentials. Store via their secret manager (Azure KeyVault, K8s Secrets, etc.). Mount `tenants.json` as read-only. |
| **Log forwarding** | The app outputs structured JSON logs to stdout. Pipe these to their monitoring stack. |
| **Container image scanning** | Scan the Docker image with Trivy, Snyk, or their standard tools. |
| **Monitoring / alerting** | Health check monitoring on `/v1/health`. Alert on 401/403/500 errors. |

---

## Devland / Digital Iceland Alignment

### Where It Aligns

| Devland Expectation | Milli-Mala Status |
|---|---|
| **TypeScript** | Yes — TypeScript strict mode, same as island.is monorepo |
| **Node.js 20+** | Yes — matches their runtime requirement |
| **Containerized services** | Yes — multi-stage Dockerfile, Alpine-based, non-root |
| **Health checks** | Yes — `/v1/health` endpoint |
| **Structured logging** | Yes — JSON logs to stdout |
| **Open source friendly** | Yes — Apache 2.0 license, 1 dependency (jsPDF, MIT) |
| **Security awareness (OWASP)** | Yes — input validation, SSRF protection, injection prevention, auth hardening, fail-closed model |
| **ISO 27001 alignment** | Partially — good security controls, formal certification comes from the hosting environment |
| **Secrets via environment / config** | Yes — 12-factor app style, no hardcoded secrets |
| **Multi-tenant** | Yes — built for multiple government institutions from day one |

### Where It Differs (And Why That's OK)

| Devland Standard | Milli-Mala | Why It's Fine |
|---|---|---|
| **GraphQL API** | REST/webhook | Milli-mala receives webhooks and calls REST APIs. GraphQL doesn't apply. |
| **Part of the monorepo** | Standalone service | It's infrastructure middleware, not a citizen-facing island.is feature. |
| **X-Road integration** | Direct API calls | Connects to Zendesk (external SaaS) and archive systems. X-Road is for government-to-government data exchange. |
| **WCAG 2.1 AAA** | Not applicable | No user interface — it's a backend service. |
| **OAuth 2.0 auth** | Static API keys (currently) | OAuth 2.0 migration path is documented in the README. Recommended before scaling to more institutions. |

**Bottom line:** Milli-mala is backend infrastructure, not a citizen-facing app. Devland's frontend and accessibility criteria don't apply. What matters is container, security, multi-tenancy, and operations standards — and it meets those.

---

## Questions to Ask the DevOps Team

### Infrastructure Questions (They Need to Answer)

1. **Where will it run?** Kubernetes? Azure Container Apps? Docker on a VM?
2. **How do they handle secrets?** Azure KeyVault? K8s Secrets? (Tenant configs contain credentials)
3. **What's their reverse proxy?** Nginx? Traefik? Cloudflare? (For TLS and rate limiting)
4. **Do they have a container registry?** Where should the Docker image be pushed?
5. **What monitoring do they use?** Prometheus? Grafana? Datadog? (So we match log format)
6. **Network policy?** Does the container need to go through a proxy to reach Zendesk and the archive systems?
7. **Do they require an SBOM** (Software Bill of Materials)? We can generate one with `npm sbom`.
8. **Do they want to manage tenant configs?** Or should we provide them? (They're JSON, can be in a ConfigMap or Secret)

### Things to Ask Them to Check

1. **Scan the Docker image** with their vulnerability scanner
2. **Review outbound network requirements** and whitelist:
   - `*.zendesk.com` (HTTPS) — Zendesk API
   - `*.zdassets.com` (HTTPS) — Zendesk attachment CDN
   - The archive system URLs (OneSystems/GoPro) — per institution
3. **Review the health check** at `GET /v1/health` and integrate with uptime monitoring
4. **Review audit log retention** — is 90 days enough? Government may need longer.
5. **Verify TLS 1.2+** is enforced on their load balancer / reverse proxy
6. **Review the tenant config schema** — are they comfortable managing tenant JSON, or do they want a UI?

---

## What You Need to Bring to the Meeting

1. **The archive system URLs** (OneSystems/GoPro) — so they can whitelist outbound traffic
2. **The Zendesk subdomains** for each institution — so they know which Zendesk instances connect
3. **How many institutions** will use this initially (and expected growth)
4. **Expected volume** — roughly how many tickets per day/week across all tenants
5. **Whether you want staging + production** or just production

---

## Quick Reference Card

```
Service Name:     milli-mala (multi-tenant)
What It Does:     Zendesk ticket -> PDF -> Document archive (per institution)
Language:         TypeScript (strict)
Runtime:          Node.js 20 (Alpine Docker)
Port:             8080
Health Check:     GET /v1/health
Dependencies:     1 (jsPDF)
Database:         None
Storage:          None (optional audit log directory)
Tenant Config:    tenants.json (mounted) or Cloudflare KV
Secrets Needed:   Per tenant: Zendesk creds, archive creds, webhook secret, API key
                  Instance-level: AUDIT_SECRET
Inbound:          HTTPS webhook from Zendesk + HTTPS API call from Malaskra app
Outbound:         HTTPS to Zendesk API + archive system APIs (per tenant)
PII Stored:       None
Tests:            119 unit tests
License:          Apache 2.0
```
