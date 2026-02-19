# Deployment Guide

Deployment guide for milli-mala, the multi-tenant Zendesk-to-archive gateway. Each deployment requires:

1. **Instance-level config** — port, log level, audit secret (environment variables)
2. **Tenant config** — per-institution Zendesk credentials, archive endpoints, PDF settings (stored in KV or `tenants.json`)

## Table of Contents

- [Option 1: Cloudflare Workers (Recommended)](#option-1-cloudflare-workers-recommended)
- [Option 2: Docker / Docker Compose](#option-2-docker--docker-compose)
- [Option 3: Kubernetes](#option-3-kubernetes)
- [Option 4: Node.js on Server](#option-4-nodejs-on-server)
- [Tenant Configuration](#tenant-configuration)
- [Zendesk Setup](#zendesk-setup)
- [Testing Your Deployment](#testing-your-deployment)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

---

## Option 1: Cloudflare Workers (Recommended)

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
- `tenants.json` file with tenant configurations

### Step 1: Clone and install

```bash
git clone https://github.com/Vertiscx/milli-mala-multi-tenant.git
cd milli-mala-multi-tenant
```

### Step 2: Create tenants.json

Create a `tenants.json` file with all tenant configurations:

```json
{
  "tenants": [
    {
      "brand_id": "360001234567",
      "name": "Samgongustofa",
      "zendesk": {
        "subdomain": "samgongustofa",
        "email": "integration@samgongustofa.is",
        "apiToken": "...",
        "webhookSecret": "..."
      },
      "endpoints": {
        "onesystems": {
          "type": "onesystems",
          "baseUrl": "https://api.onesystems.is",
          "appKey": "..."
        }
      },
      "malaskra": {
        "apiKey": "..."
      },
      "pdf": {
        "companyName": "Samgongustofa",
        "locale": "is-IS",
        "includeInternalNotes": false
      }
    }
  ]
}
```

### Step 3: Create .env file

Instance-level configuration only:

```bash
PORT=8080
LOG_LEVEL=info
AUDIT_SECRET=your-random-audit-secret
TENANTS_FILE=./tenants.json
AUDIT_DIR=./audit-data
```

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
  -v $(pwd)/tenants.json:/app/tenants.json:ro \
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

### Step 2: Create the tenant config secret

```bash
kubectl create secret generic milli-mala-tenants \
  --from-file=tenants.json=./tenants.json
```

### Step 3: Create instance config

```bash
kubectl create configmap milli-mala-config \
  --from-literal=PORT=8080 \
  --from-literal=LOG_LEVEL=info

kubectl create secret generic milli-mala-secrets \
  --from-literal=AUDIT_SECRET=your-random-audit-secret
```

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

Create `.env` with instance-level config:

```bash
PORT=8080
LOG_LEVEL=info
AUDIT_SECRET=your-random-audit-secret
TENANTS_FILE=./tenants.json
AUDIT_DIR=./audit-data
```

Create `tenants.json` with tenant configurations (see [Tenant Configuration](#tenant-configuration)).

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
| `zendesk.apiToken` | string | Yes | Zendesk API token |
| `zendesk.webhookSecret` | string | Yes | Zendesk webhook signing secret |
| `endpoints` | map | Yes | At least one archive endpoint |
| `endpoints.{name}.type` | string | Yes | `"onesystems"` or `"gopro"` |
| `endpoints.{name}.baseUrl` | string | Yes | Archive system API URL |
| `endpoints.{name}.appKey` | string | If OneSystems | OneSystems app key |
| `endpoints.{name}.username` | string | If GoPro | GoPro login username |
| `endpoints.{name}.password` | string | If GoPro | GoPro login password |
| `endpoints.{name}.caseNumberFieldId` | number | No | Zendesk custom field ID for case number |
| `endpoints.{name}.tokenTtlMs` | number | No | Auth token TTL in ms (default: 1500000) |
| `malaskra.apiKey` | string | Yes | API key for `/v1/attachments` authentication |
| `pdf.companyName` | string | No | Company name in PDF header |
| `pdf.locale` | string | No | Date formatting locale (default: `is-IS`) |
| `pdf.includeInternalNotes` | boolean | No | Include internal notes in PDF (default: `false`) |

### Adding a new tenant

**Cloudflare Workers:**

```bash
wrangler kv key put --binding=TENANT_KV \
  "tenant:NEW_BRAND_ID" \
  '{ ... tenant JSON ... }'
```

**Docker / K8s / Node.js:**

Add a new entry to the `tenants` array in `tenants.json` and restart the service.

### Instance-level environment variables

These are not per-tenant — they configure the service itself:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8080` | HTTP server port (Docker/Node.js only) |
| `LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `AUDIT_SECRET` | No | — | Bearer token for `/v1/audit` endpoint |
| `TENANTS_FILE` | No | `./tenants.json` | Path to tenants config file (Docker/Node.js only) |
| `AUDIT_DIR` | No | `./audit-data` | Audit log directory (Docker/Node.js only) |

---

## Zendesk Setup

Each institution needs a webhook and trigger configured in their Zendesk account.

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

### "Unknown tenant" (404)

- The `brand_id` in the request doesn't match any tenant config
- **CF Workers**: Verify the KV key exists: `wrangler kv key get --binding=TENANT_KV "tenant:BRAND_ID"`
- **Docker/Node.js**: Check `tenants.json` contains the brand_id

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
