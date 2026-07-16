# Deployment Guide

Deployment guide for milli-mala, the multi-tenant Zendesk-to-archive gateway. Each deployment requires:

1. **Instance-level config** — port, log level, audit secret (environment variables)
2. **Tenant config** — per-institution Zendesk credentials, archive endpoints, PDF settings. Cloudflare Workers store these in KV; Docker/Node.js builds them at startup from `src/tenants.config.ts` (committed structure) plus environment variables (secrets).

## Table of Contents

- [Option 1: Cloudflare Workers](#option-1-cloudflare-workers-recommended)
- [Option 2: Docker / Docker Compose](#option-2-docker--docker-compose)
- [Option 3: Kubernetes](#option-3-kubernetes)
- [Option 4: Node.js on Server](#option-4-nodejs-on-server)
- [Tenant Configuration](#tenant-configuration)
- [Zendesk Setup](#zendesk-setup)
- [Testing Your Deployment](#testing-your-deployment)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

---

## Option 1: Cloudflare Workers

Serverless, globally distributed deployment with no infrastructure to manage.

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- Zendesk admin access with API token per institution
- Archive system credentials per institution

### Step 1: Clone and install

```bash
git clone https://github.com/Vertiscx/milli-mala-multi-tenant.git
cd milli-mala-multi-tenant
npm install
```

### Step 2: Authenticate with Cloudflare

```bash
wrangler login
```

### Step 3: Create KV namespaces

Two KV namespaces are needed: one for tenant config, one for audit logs.

```bash
wrangler kv namespace create TENANT_KV
wrangler kv namespace create AUDIT_LOG
```

Copy the returned namespace IDs into your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TENANT_KV"
id = "your-tenant-kv-namespace-id"

[[kv_namespaces]]
binding = "AUDIT_LOG"
id = "your-audit-log-namespace-id"
```

### Step 4: Set instance-level secrets

```bash
wrangler secret put AUDIT_SECRET    # Random string for /v1/audit endpoint access
```

### Step 5: Upload tenant config to KV

Each tenant is stored as a JSON value with key `tenant:{brand_id}`:

```bash
# Upload tenant config for a brand
wrangler kv key put --binding=TENANT_KV \
  "tenant:360001234567" \
  '{"brand_id":"360001234567","name":"Samgongustofa","zendesk":{"subdomain":"samgongustofa","email":"integration@samgongustofa.is","apiToken":"...","webhookSecret":"..."},"endpoints":{"onesystems":{"type":"onesystems","baseUrl":"https://api.onesystems.is","appKey":"..."}},"malaskra":{"apiKey":"..."},"pdf":{"companyName":"Samgongustofa","locale":"is-IS","includeInternalNotes":false}}'
```

See [Tenant Configuration](#tenant-configuration) for the full schema.

### Step 6: Deploy

```bash
npm test              # Verify tests pass
wrangler deploy       # Deploy to production
```

Your worker will be available at `https://milli-mala.<your-subdomain>.workers.dev`.

### Viewing logs

```bash
wrangler tail
```

---

## Option 2: Docker / Docker Compose

For on-premises or cloud VM deployments.

### Prerequisites

- Docker and Docker Compose installed
- An entry per tenant in `src/tenants.config.ts` (committed)
- All env vars listed in `.env.example` provisioned as secrets

### Step 1: Clone and install

```bash
git clone https://github.com/island-is/milli-mala-multi-tenant.git
cd milli-mala-multi-tenant
```

### Step 2: Configure tenants

Tenant *structure* lives in `src/tenants.config.ts` (committed, code-reviewed). Tenant *secrets* are environment variables provisioned by your operations team. See [Tenant Configuration](#tenant-configuration) below for the full schema and onboarding flow.

### Step 3: Create .env file

Copy `.env.example` to `.env` and fill in real values from your secrets store:

```bash
cp .env.example .env
# edit .env — fill in every variable with its real value
```

The container will fail to start if any required variable is missing. Service-level settings (`PORT`, `LOG_LEVEL`, `AUDIT_SECRET`, `AUDIT_DIR`) and all tenant secrets share the same `.env` file in this deployment.

### Step 4: Start the service

Using Docker Compose:

```bash
docker-compose up -d
```

Or build and run manually:

```bash
docker build -t milli-mala .
docker run -d -p 8080:8080 \
  --env-file .env \
  --name milli-mala milli-mala
```

### Step 5: Verify

```bash
curl http://localhost:8080/v1/health
```

Expected response:

```json
{"status":"ok","service":"milli-mala","version":"2.0.0","timestamp":"..."}
```

### Step 6: Expose to internet

The service needs to be reachable from Zendesk. Options:

**Caddy (recommended):**

```
milli-mala.yourdomain.com {
    reverse_proxy localhost:8080
}
```

**Nginx:**

```nginx
server {
    listen 443 ssl;
    server_name milli-mala.yourdomain.com;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**Cloudflare Tunnel (no port forwarding needed):**

```bash
cloudflared tunnel create milli-mala
# Configure tunnel to point to http://localhost:8080
cloudflared tunnel run milli-mala
```

### Managing the service

```bash
docker-compose logs -f        # View logs
docker-compose restart         # Restart
docker-compose down            # Stop
```

---

## Option 3: Kubernetes

### Step 1: Build and push the container image

```bash
docker build -t your-registry/milli-mala:latest .
docker push your-registry/milli-mala:latest
```

### Step 2: Create the tenant secret

Create one Kubernetes Secret containing every tenant env var listed in `.env.example`. Keep them in a private `.env` file (never committed) and load it via `--from-env-file`:

```bash
kubectl create secret generic milli-mala-tenants \
  --from-env-file=./.env
```

### Step 3: Create instance config

```bash
kubectl create configmap milli-mala-config \
  --from-literal=PORT=8080 \
  --from-literal=LOG_LEVEL=info

kubectl create secret generic milli-mala-secrets \
  --from-literal=AUDIT_SECRET=your-random-audit-secret
```

The deployment manifest should reference both secrets via `envFrom` so all tenant variables and the audit secret reach the container at startup.

### Step 4: Deploy

See the `k8s/` directory for manifests (deployment, service, configmap, secret templates).

```bash
kubectl apply -f k8s/
```

### Step 5: Verify

```bash
kubectl port-forward svc/milli-mala 8080:8080
curl http://localhost:8080/v1/health
```

---

## Option 4: Node.js on Server

For running directly on a VM or bare-metal server.

### Prerequisites

- Node.js 20+
- A process manager (PM2 recommended) or systemd
- A reverse proxy (Caddy or Nginx) for HTTPS

### Step 1: Clone and build

```bash
git clone https://github.com/Vertiscx/milli-mala-multi-tenant.git
cd milli-mala-multi-tenant
npm install
npm run build
```

### Step 2: Configure

Copy `.env.example` to `.env` and fill in real values for every variable listed (service settings + every tenant secret). See [Tenant Configuration](#tenant-configuration) for what each variable does.

```bash
cp .env.example .env
# edit .env — fill in ZENDESK_API_TOKEN, AUDIT_SECRET, every tenant secret, etc.
```

### Step 3: Start

**PM2 (recommended):**

```bash
npm install -g pm2
pm2 start dist/index.js --name milli-mala
pm2 save
pm2 startup
```

**systemd:**

Create `/etc/systemd/system/milli-mala.service`:

```ini
[Unit]
Description=Milli-Mala Zendesk Bridge
After=network.target

[Service]
Type=simple
User=milli-mala
WorkingDirectory=/opt/milli-mala
EnvironmentFile=/opt/milli-mala/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable milli-mala
sudo systemctl start milli-mala
```

### Step 4: Set up HTTPS with a reverse proxy

Use Caddy, Nginx, or Cloudflare Tunnel as described in [Option 2](#step-6-expose-to-internet).

### Step 5: Verify

```bash
curl http://localhost:8080/v1/health
```

---

## Tenant Configuration

### Full schema

Each tenant object has this structure:

| Field | Type | Required | Description |
|---|---|---|---|
| `brand_id` | string | Yes | Zendesk brand ID — the lookup key |
| `name` | string | Yes | Institution name (for logging) |
| `zendesk.subdomain` | string | Yes | Zendesk subdomain |
| `zendesk.email` | string | Yes | Zendesk admin email |
| `zendesk.apiToken` | string | Yes | Zendesk API token (requires **ticket-write** scope — see [Zendesk Setup](#zendesk-setup)) |
| `zendesk.webhookSecret` | string | Yes | Zendesk webhook signing secret |
| `endpoints` | map | Yes | At least one archive endpoint |
| `endpoints.{name}.type` | string | Yes | `"onesystems"` or `"gopro"` |
| `endpoints.{name}.baseUrl` | string | Yes | Archive system API URL |
| `endpoints.{name}.appKey` | string | If OneSystems | OneSystems app key |
| `endpoints.{name}.username` | string | If GoPro | GoPro login username |
| `endpoints.{name}.password` | string | If GoPro | GoPro login password |
| `endpoints.{name}.caseNumberFieldId` | number | No | Zendesk custom field ID the gateway writes the archive case number to (GW-01 post-back). **Required for webhook case creation** — the create path refuses to mint without a field to stamp (the stamp is the retry/duplicate-mint guard). Node runtime: set via `<TENANT>_CASE_NUMBER_FIELD_ID` |
| `endpoints.{name}.lastStatusFieldId` | number | No | Zendesk custom field ID for the GW-01 `last_status` value (ratified JSON v1 — see [Result post-back](README.md#result-post-back-gw-01)) |
| `endpoints.{name}.lastExportFieldId` | number | No | Zendesk **date** custom field ID for the last successful export (`YYYY-MM-DD`) |
| `endpoints.{name}.templateFieldId` | number | No | Zendesk custom field ID for the case template. Written on the OneSystems create path, and also **read** as the case-template source on the webhook create path (the trigger-stamped `malaskra_snidmat` field — app setting `malaskra_snidmat`) |
| `endpoints.{name}.kennitalaFieldId` | number | No | Zendesk custom field ID the gateway reads the kennitala from on the OneSystems webhook create path (app setting `kennitala_custom_field`). Ignored (harmless) on GoPro endpoints |
| `endpoints.{name}.tokenTtlMs` | number | No | Auth token TTL in ms (default: 1500000) |
| `malaskra.apiKey` | string | Yes | API key for `/v1/cases` and `/v1/attachments` authentication (`X-Api-Key`) |
| `pdf.companyName` | string | No | Company name in PDF header |
| `pdf.locale` | string | No | Date formatting locale (default: `is-IS`) |
| `pdf.includeInternalNotes` | boolean | No | Include internal notes in PDF (default: `false`) |

> **Post-back field IDs are optional and graceful.** Any `*FieldId` left unset is skipped — the gateway still posts the internal note. Custom fields are **account-level** in Zendesk: the same numeric IDs apply across every brand on one Zendesk account, so they are configured per Zendesk account, not per brand. They are written back to the ticket by every documentation path (`/v1/cases`, `/v1/webhook`, `/v1/attachments`).
>
> **Webhook create inputs (templateFieldId / kennitalaFieldId).** When present, field IDs must be positive integers — a malformed value rejects the whole tenant config. On the Node runtime, set them per tenant via the optional env vars `<TENANT>_TEMPLATE_FIELD_ID` and `<TENANT>_KENNITALA_FIELD_ID` (positive integers; see [`.env.example`](.env.example)). On the Cloudflare Workers runtime, set the same `templateFieldId` / `kennitalaFieldId` keys directly in the tenant JSON in KV. Unset means the webhook create inputs are unavailable for that tenant.

### Adding a new tenant

**Cloudflare Workers:**

```bash
wrangler kv key put --binding=TENANT_KV \
  "tenant:NEW_BRAND_ID" \
  '{ ... tenant JSON ... }'
```

**Docker / K8s / Node.js:**

1. PR a new entry into the `tenants` array in `src/tenants.config.ts` (uses `requireEnv` for each new secret).
2. Provision the new environment variables on the deployment (Kubernetes Secret, `.env` file, etc.).
3. Restart the service. `requireEnv` fails fast if any variable is missing.

Rotating a secret is just step 2 + restart — no code change.

### Instance-level environment variables

These are not per-tenant — they configure the service itself:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8080` | HTTP server port (Docker/Node.js only) |
| `LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `AUDIT_SECRET` | No | — | Bearer token for `/v1/audit` endpoint |
| `AUDIT_DIR` | No | `./audit-data` | Audit log directory (Docker/Node.js only) |

Tenant secrets (Zendesk, archive systems, Málaskrá) are also environment variables — see [`.env.example`](.env.example) for the full list. They are required at startup; missing values cause the container to fail fast.

---

## Zendesk Setup

Each institution needs a webhook and trigger configured in their Zendesk account.

> **API token scope:** The tenant's `zendesk.apiToken` now requires **ticket-write** scope. The gateway can issue `PUT /tickets/{id}.json` to set a ticket custom field (e.g. writing back the archive case number). This capability is unwired in the current release — it is consumed by the future `POST /v1/cases` endpoint — but provisioning the token with ticket-write scope now avoids a re-issue later.

### Step 1: Create webhook

1. Go to **Admin Center** > **Apps and integrations** > **Webhooks**
2. Create a new webhook:
   - **URL**: Your milli-mala endpoint + `/v1/webhook` (e.g. `https://milli-mala.workers.dev/v1/webhook`)
   - **Method**: POST
   - **Content-Type**: `application/json`
3. Enable **Signing Secret** and copy the value — this goes into the tenant's `zendesk.webhookSecret`

### Step 2: Create trigger

1. Navigate to **Admin Center** > **Objects and rules** > **Business rules** > **Triggers**
2. Create a new trigger:
   - **Name**: `Archive ticket to document system`
   - **Conditions**: Whatever automation the institution wants (e.g. ticket solved, ticket closed, specific tag added)
   - **Action**: Notify webhook with body:

```json
{
  "ticket_id": "{{ticket.id}}",
  "brand_id": "{{ticket.brand.id}}",
  "doc_endpoint": "onesystems"
}
```

The `doc_endpoint` value should match one of the keys in the tenant's `endpoints` map. It is hardcoded per trigger — each brand knows which archive system to target.

> **Trigger staging for webhook create (OneSystems).** If the tenant uses the webhook create path, the gateway reads the case template from the `malaskra_snidmat` custom field and the kennitala from the `kennitala_custom_field` field on the fetched ticket. Admins must configure the Zendesk trigger(s) so the `malaskra_snidmat` template field is stamped **BEFORE** the close/webhook trigger fires — an unstamped field means no template is available at create time. Map the app settings `malaskra_snidmat` (template) and `kennitala_custom_field` (kennitala) to the same numeric field IDs configured as `templateFieldId` / `kennitalaFieldId` in the tenant config (see [Tenant Configuration](#tenant-configuration)).

> **Webhook create rejects (422).** When the case-number field is empty on an OneSystems tenant, the gateway creates the case via One — but it refuses loudly (HTTP 422, nothing archived, no fallback reference) when the create intent cannot be honored. The audit log records event `webhook_create_rejected` with one of three outcomes:
>
> | Outcome | Meaning | Usual root cause |
> |---------|---------|------------------|
> | `missing_template` | Case-number field empty AND template field empty — no create intent was staged | Trigger misconfiguration (template not stamped before the webhook fired), **or** `templateFieldId` missing/wrong in tenant config |
> | `missing_kennitala` | Template present but the kennitala field is empty — the gateway never invents a value | Agent workflow gap, or `kennitalaFieldId` missing/wrong in tenant config |
> | `missing_case_number_field_config` | Create intent staged but `caseNumberFieldId` is not configured — without a field to stamp there is no duplicate-mint guard, so the gateway will not mint | Tenant config missing `<TENANT>_CASE_NUMBER_FIELD_ID` (Node) / `caseNumberFieldId` (KV) |
>
> A 422 is deliberate and non-retryable: Zendesk does not retry 4xx, and retrying a misconfiguration cannot succeed. Fix the trigger or config, then re-fire the trigger (re-add the marker tag) to document the ticket.

> ### ⚠️ Loop-safety — required (GW-04)
>
> After documenting, the gateway writes the result **back onto the ticket** (an internal note plus the status custom fields — the GW-01 post-back). That ticket update will **re-fire the trigger** if its condition can still match, causing an infinite loop (repeated archive uploads and ticket notes for one ticket).
>
> The trigger **must be one-shot**. Use a marker tag the trigger both requires and removes in the same run:
>
> - **Condition:** ticket has tag `malaskra_doc_pending` (the institution's own automation adds this tag when documentation is wanted).
> - **Actions:** Notify webhook (as above) **and** *Remove tag* `malaskra_doc_pending`.
>
> Because the trigger removes its own trigger condition, the post-back ticket update cannot satisfy it again — it fires exactly once per request. A trigger that fires on a general condition (e.g. "ticket solved") **without** a self-removing marker **will loop in production**. This is load-bearing operational safety, not optional. The manual Málaskrá sidebar path is user-initiated and not subject to this, but any trigger/automation path is.

### Step 3: Activate

1. Save the trigger
2. Ensure it is active

---

## Testing Your Deployment

### Health check

```bash
curl https://YOUR_ENDPOINT/v1/health
```

Expected:

```json
{"status":"ok","service":"milli-mala","version":"2.0.0","timestamp":"..."}
```

### End-to-end test

1. Ensure at least one tenant is configured
2. Create a test ticket in the tenant's Zendesk brand
3. Add some comments and an attachment
4. Trigger the automation (e.g. solve the ticket)
5. Check the archive system for the uploaded PDF
6. Check audit log: `curl -H "Authorization: Bearer YOUR_AUDIT_SECRET" https://YOUR_ENDPOINT/v1/audit?brand_id=BRAND_ID`

---

## Updating

### Cloudflare Workers

```bash
git pull
npm test
wrangler deploy
```

No downtime — the new version replaces the old one atomically.

### Docker

```bash
git pull
docker-compose build
docker-compose up -d
```

Brief downtime during container restart. Zendesk retries failed webhooks automatically.

### Kubernetes

```bash
docker build -t your-registry/milli-mala:latest .
docker push your-registry/milli-mala:latest
kubectl rollout restart deployment/milli-mala
```

Rolling update with no downtime.

### Node.js

```bash
git pull
npm install
npm run build
pm2 restart milli-mala    # or: sudo systemctl restart milli-mala
```

Brief downtime during restart.

---

## Troubleshooting

### "Invalid request" (400)

- The `brand_id` may not match any tenant config, or the request body is missing required fields
- **CF Workers**: Verify the KV key exists: `wrangler kv key get --binding=TENANT_KV "tenant:BRAND_ID"`
- **Docker/Node.js**: Check `src/tenants.config.ts` contains the brand_id and that the corresponding env vars are set on the deployment

### "Missing brand_id" or "Missing doc_endpoint" (400)

- The request body is missing required fields

- Check the Zendesk trigger body includes `brand_id` and `doc_endpoint`

### "Unknown doc_endpoint" (500)

- The `doc_endpoint` in the request doesn't match any key in the tenant's `endpoints` map
- Verify the trigger body's `doc_endpoint` value matches the tenant config

### "Invalid webhook signature" (401)

- The `zendesk.webhookSecret` in the tenant config doesn't match the webhook's signing secret in Zendesk
- Re-copy the signing secret from Zendesk Admin Center

### "Invalid or missing API key" (401) on /v1/attachments

- The `X-Api-Key` header doesn't match the tenant's `malaskra.apiKey`
- Verify the API key in the Malaskra app configuration

### Authentication failed for archive system

- Verify the archive credentials in the tenant config (OneSystems: `appKey`, GoPro: `username`/`password`)
- Test the archive API directly if issues persist

### Viewing logs

**Cloudflare Workers:** `wrangler tail`

**Docker:** `docker-compose logs -f`

**K8s:** `kubectl logs -f deployment/milli-mala`

**PM2:** `pm2 logs milli-mala`

**systemd:** `journalctl -u milli-mala -f`

All logs are structured JSON with `brand_id` included for filtering.

---

## Related documentation

- [Malaskra Zendesk App](https://github.com/Vertiscx/malaskra_v2)
- [Zendesk Webhooks](https://developer.zendesk.com/documentation/webhooks/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Docker](https://docs.docker.com/)
