# Deployment Guide

Complete guide for deploying Milli-Mala, the Zendesk document archival bridge service. Supports OneSystems and GoPro (gopro.net) as document backends — set `DOC_SYSTEM` to choose which one.

## Table of Contents

- [Option 1: Cloudflare Workers (Recommended)](#option-1-cloudflare-workers-recommended)
- [Option 2: Azure Container Apps](#option-2-azure-container-apps)
- [Option 3: Self-Hosted Docker](#option-3-self-hosted-docker)
- [Option 4: Node.js on Server](#option-4-nodejs-on-server)
- [Updating Milli-Mala](#updating-milli-mala)
- [Zendesk Webhook Setup](#zendesk-webhook-setup)
- [Running Tests](#running-tests)
- [Testing Your Deployment](#testing-your-deployment)
- [Troubleshooting](#troubleshooting)

---

## Option 1: Cloudflare Workers (Recommended)

Cloudflare Workers provides a serverless, globally distributed deployment with no infrastructure to manage. This is the primary deployment target.

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed (`npm install -g wrangler`)
- Zendesk admin access with API token
- OneSystems or GoPro API credentials (depending on `DOC_SYSTEM`)

### Step 1: Clone and install

```bash
git clone https://github.com/Vertiscx/milli-mala.git
cd milli-mala
npm install
```

### Step 2: Authenticate with Cloudflare

```bash
wrangler login
```

### Step 3: Create KV namespace for audit logs

```bash
wrangler kv namespace create AUDIT_LOG
```

Copy the returned namespace ID into your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "AUDIT_LOG"
id = "your-namespace-id-here"
```

### Step 4: Set secrets

All sensitive configuration is stored as encrypted Cloudflare Worker secrets, never in code or environment variables:

```bash
wrangler secret put ZENDESK_SUBDOMAIN      # e.g. "yourcompany"
wrangler secret put ZENDESK_EMAIL           # Zendesk admin email
wrangler secret put ZENDESK_API_TOKEN       # Zendesk API token
wrangler secret put ZENDESK_WEBHOOK_SECRET  # Zendesk webhook signing secret
wrangler secret put DOC_SYSTEM              # "onesystems" or "gopro" (default: onesystems)
wrangler secret put MALASKRA_API_KEY        # API key for /attachments endpoint (if using Malaskra)
wrangler secret put AUDIT_SECRET            # Random string for /audit endpoint access
```

**If using OneSystems** (`DOC_SYSTEM=onesystems`):
```bash
wrangler secret put ONESYSTEMS_BASE_URL     # OneSystems API URL
wrangler secret put ONESYSTEMS_APP_KEY      # OneSystems app key
```

**If using GoPro** (`DOC_SYSTEM=gopro`):
```bash
wrangler secret put GOPRO_BASE_URL          # GoPro API base URL
wrangler secret put GOPRO_USERNAME          # GoPro login username
wrangler secret put GOPRO_PASSWORD          # GoPro login password
```

### Step 5: Deploy

```bash
wrangler deploy
```

Your worker will be available at `https://milli-mala.<your-subdomain>.workers.dev`.

### Step 6: Configure Zendesk webhook

1. Go to **Admin Center** > **Apps and integrations** > **Webhooks**
2. Create a new webhook pointing to your worker URL
3. Set the **Signing Secret** and copy it (this is your `ZENDESK_WEBHOOK_SECRET`)
4. Create a **Trigger** that fires when tickets are solved/closed with the body:
   ```json
   { "ticket_id": "{{ticket.id}}" }
   ```

### Viewing logs

```bash
wrangler tail
```

---

## Option 2: Azure Container Apps

For Azure-based deployments, use Azure Container Apps with the Docker image.

### Prerequisites

- Azure subscription
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- Docker installed locally (for building the image)

### Step 1: Build and push the container image

```bash
# Login to Azure
az login

# Create a resource group
az group create --name milli-mala-rg --location northeurope

# Create Azure Container Registry
az acr create --name millimalaacr --resource-group milli-mala-rg --sku Basic
az acr login --name millimalaacr

# Build and push
docker build -t millimalaacr.azurecr.io/milli-mala:latest .
docker push millimalaacr.azurecr.io/milli-mala:latest
```

### Step 2: Create Container App environment

```bash
az containerapp env create \
  --name milli-mala-env \
  --resource-group milli-mala-rg \
  --location northeurope
```

### Step 3: Deploy the container

```bash
az containerapp create \
  --name milli-mala \
  --resource-group milli-mala-rg \
  --environment milli-mala-env \
  --image millimalaacr.azurecr.io/milli-mala:latest \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 3 \
  --registry-server millimalaacr.azurecr.io \
  --secrets \
    zendesk-subdomain="YOUR_SUBDOMAIN" \
    zendesk-email="YOUR_EMAIL" \
    zendesk-api-token="YOUR_TOKEN" \
    zendesk-webhook-secret="YOUR_SECRET" \
    doc-system="onesystems" \
    onesystems-base-url="YOUR_URL" \
    onesystems-app-key="YOUR_KEY" \
  --env-vars \
    ZENDESK_SUBDOMAIN=secretref:zendesk-subdomain \
    ZENDESK_EMAIL=secretref:zendesk-email \
    ZENDESK_API_TOKEN=secretref:zendesk-api-token \
    ZENDESK_WEBHOOK_SECRET=secretref:zendesk-webhook-secret \
    DOC_SYSTEM=secretref:doc-system \
    ONESYSTEMS_BASE_URL=secretref:onesystems-base-url \
    ONESYSTEMS_APP_KEY=secretref:onesystems-app-key \
    PORT=8080 \
    LOG_LEVEL=info \
    PDF_LOCALE=is-IS \
    PDF_INCLUDE_INTERNAL_NOTES=false \
    PDF_COMPANY_NAME=YourCompanyName
```

### Step 4: Get the application URL

```bash
az containerapp show \
  --name milli-mala \
  --resource-group milli-mala-rg \
  --query properties.configuration.ingress.fqdn \
  --output tsv
```

Use this URL when configuring the Zendesk webhook.

### Viewing logs

```bash
az containerapp logs show \
  --name milli-mala \
  --resource-group milli-mala-rg \
  --follow
```

**Note**: The Azure deployment uses the Node.js server entry point (`src/index.js`). Audit entries are stored using a file-based audit store (configurable via `AUDIT_DIR`, default: `./audit-data`). The `/audit` endpoint is available with `AUDIT_SECRET` configured.

---

## Option 3: Self-Hosted Docker

For organizations that prefer on-premises hosting or need more control.

### Step 1: Install Docker

```bash
# macOS
brew install docker docker-compose

# Linux (Ubuntu/Debian)
sudo apt-get update
sudo apt-get install docker.io docker-compose
sudo systemctl enable docker
sudo systemctl start docker

# Add your user to docker group
sudo usermod -aG docker $USER
```

### Step 2: Clone and Configure

```bash
git clone https://github.com/Vertiscx/milli-mala.git
cd milli-mala

# Copy and edit configuration
cp .env.example .env
nano .env  # or use your preferred editor
```

### Step 3: Start the Service

Using Docker Compose (recommended):
```bash
docker-compose up -d
```

Or build and run manually:
```bash
docker build -t milli-mala .
docker run -d -p 8080:8080 --env-file .env --name milli-mala milli-mala
```

### Step 4: Verify It's Running

```bash
# Check container status
docker ps

# Check logs
docker-compose logs -f

# Test health endpoint
curl http://localhost:8080/health
```

### Step 5: Expose to Internet

The service needs to be accessible from Zendesk. Options:

#### Option A: Reverse Proxy with Caddy (Recommended)

```bash
# Install Caddy
sudo apt install caddy

# Create Caddyfile
cat > /etc/caddy/Caddyfile << EOF
milli-mala.yourdomain.com {
    reverse_proxy localhost:8080
}
EOF

# Start Caddy
sudo systemctl enable caddy
sudo systemctl start caddy
```

#### Option B: Reverse Proxy with Nginx

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

#### Option C: Cloudflare Tunnel (No Port Forwarding)

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create milli-mala

# Configure tunnel
cat > ~/.cloudflared/config.yml << EOF
tunnel: YOUR_TUNNEL_ID
credentials-file: /root/.cloudflared/YOUR_TUNNEL_ID.json
ingress:
  - hostname: milli-mala.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
EOF

# Run tunnel
cloudflared tunnel run milli-mala
```

### Managing the Service

```bash
# View logs
docker-compose logs -f

# Restart service
docker-compose restart

# Stop service
docker-compose down

# Update to latest version
git pull
docker-compose build
docker-compose up -d
```

---

## Option 4: Node.js on Server

For running directly on a VM or bare-metal server without Docker.

### Prerequisites

- Server with Node.js 20+ installed
- A process manager (PM2 recommended) or systemd
- A reverse proxy (Caddy or Nginx) for HTTPS
- Git installed

### Step 1: Clone and install

```bash
git clone https://github.com/Vertiscx/milli-mala.git
cd milli-mala
npm install --production
```

### Step 2: Configure environment

```bash
cp .env.example .env
nano .env  # Fill in your values
```

### Step 3: Start with PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start the service
pm2 start src/index.js --name milli-mala

# Save process list so it restarts on reboot
pm2 save
pm2 startup
```

### Alternative: Start with systemd

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
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable milli-mala
sudo systemctl start milli-mala
```

### Step 4: Set up HTTPS with reverse proxy

Use the same Caddy, Nginx, or Cloudflare Tunnel instructions from [Option 3](#option-3-self-hosted-docker) — they work identically since the service runs on `localhost:8080`.

### Step 5: Verify

```bash
curl http://localhost:8080/health
```

### Viewing logs

```bash
# PM2
pm2 logs milli-mala

# systemd
journalctl -u milli-mala -f
```

---

## Updating Milli-Mala

How to deploy a new version for each deployment type.

### Cloudflare Workers

```bash
cd milli-mala
git pull
npm test          # Verify tests pass
wrangler deploy   # Deploy in seconds
```

No downtime — the new version replaces the old one atomically.

### Azure Container Apps

```bash
cd milli-mala
git pull

# Rebuild and push the container image
docker build -t millimalaacr.azurecr.io/milli-mala:latest .
docker push millimalaacr.azurecr.io/milli-mala:latest

# Trigger a new revision
az containerapp update \
  --name milli-mala \
  --resource-group milli-mala-rg \
  --image millimalaacr.azurecr.io/milli-mala:latest
```

Azure performs a rolling update with no downtime.

### Self-Hosted Docker

```bash
cd milli-mala
git pull
docker-compose build
docker-compose up -d
```

There will be a few seconds of downtime while the container restarts. Zendesk will retry failed webhooks automatically.

### Node.js on Server

```bash
cd milli-mala
git pull
npm install --production   # Install any new dependencies

# PM2
pm2 restart milli-mala

# systemd
sudo systemctl restart milli-mala
```

There will be a few seconds of downtime during restart. Zendesk will retry failed webhooks automatically.

---

## Zendesk Webhook Setup

This creates the automation that triggers Milli-Mala when tickets close.

### Step 1: Create Webhook

1. Go to **Admin Center** > **Apps and integrations** > **Webhooks**
2. Create a new webhook:
   - **URL**: Your Milli-Mala endpoint (e.g. `https://milli-mala.your-subdomain.workers.dev`)
   - **Method**: POST
   - **Content-Type**: `application/json`
3. Set the **Signing Secret** and copy it (this is your `ZENDESK_WEBHOOK_SECRET`)

### Step 2: Create Trigger

1. Navigate to **Admin Center** > **Objects and rules** > **Business rules** > **Triggers**
2. Create a new trigger:
   - **Name**: `Archive ticket to document system`
   - **Condition**: Ticket status changed to Solved (or Closed)
   - **Action**: Notify webhook with body:
   ```json
   { "ticket_id": "{{ticket.id}}" }
   ```

### Step 3: Activate

1. Save the trigger
2. Ensure it is active

---

## Running Tests

```bash
npm test
```

---

## Testing Your Deployment

### Test 1: Health Check

```bash
curl https://YOUR_ENDPOINT/health
```

Expected response:
```json
{"status":"ok","service":"milli-mala","timestamp":"2026-02-09T10:30:00.000Z"}
```

### Test 2: End-to-End Test

1. Create a test ticket in Zendesk
2. Add some comments and an attachment
3. Solve the ticket
4. Check your document system (OneSystems or GoPro) for the archived case
5. Verify PDF uploaded correctly

---

## Troubleshooting

### Common Issues

#### "Missing configuration" error
- Ensure all required environment variables / secrets are set
- For Cloudflare Workers, verify secrets were set via `wrangler secret put`
- For Docker, check `.env` file exists and is formatted correctly

#### "Authentication failed" for Zendesk
- Verify `ZENDESK_EMAIL` is an admin account
- Check `ZENDESK_API_TOKEN` is valid (not expired)
- Ensure token format is correct (no extra spaces)

#### "Token exchange failed" for OneSystems
- Verify `ONESYSTEMS_BASE_URL` is correct
- Check `ONESYSTEMS_APP_KEY` is valid
- Test the OneSystems API directly if issues persist

#### "Authentication failed" for GoPro
- Verify `GOPRO_BASE_URL` is correct
- Check `GOPRO_USERNAME` and `GOPRO_PASSWORD` are valid
- Test the GoPro API directly if issues persist

#### Webhook not triggering
- Verify the Zendesk trigger is active
- Check trigger conditions match your workflow
- Review Zendesk trigger logs for errors

#### PDF generation fails
- Check ticket has valid content
- Verify memory allocation (increase if needed for Docker/Azure)
- Check logs for specific error messages

### Viewing Logs

**Cloudflare Workers:**
```bash
wrangler tail
```

**Azure Container Apps:**
```bash
az containerapp logs show --name milli-mala --resource-group milli-mala-rg --follow
```

**Docker:**
```bash
docker-compose logs -f milli-mala
```

---

## Required Configuration

| Variable | Required | Description |
|---|---|---|
| `ZENDESK_SUBDOMAIN` | Yes | Your Zendesk subdomain |
| `ZENDESK_EMAIL` | Yes | Admin email address in Zendesk |
| `ZENDESK_API_TOKEN` | Yes | Zendesk API token |
| `ZENDESK_WEBHOOK_SECRET` | Yes | Zendesk webhook signing secret for HMAC verification |
| `DOC_SYSTEM` | No | `"onesystems"` or `"gopro"` (default: `onesystems`) |
| `ONESYSTEMS_BASE_URL` | If OneSystems | OneSystems API base URL |
| `ONESYSTEMS_APP_KEY` | If OneSystems | OneSystems app key for authentication |
| `ONESYSTEMS_CASE_NUMBER_FIELD_ID` | No | Zendesk custom field ID for OneSystems case number |
| `GOPRO_BASE_URL` | If GoPro | GoPro API base URL |
| `GOPRO_USERNAME` | If GoPro | GoPro login username |
| `GOPRO_PASSWORD` | If GoPro | GoPro login password |
| `GOPRO_CASE_NUMBER_FIELD_ID` | No | Zendesk custom field ID for GoPro case number |
| `MALASKRA_API_KEY` | If using Malaskra | API key for authenticating `/attachments` requests from Malaskra |
| `AUDIT_SECRET` | No | Bearer token for `/audit` endpoint access |
| `AUDIT_DIR` | No | Directory for file-based audit storage (default: `./audit-data`, Docker/Node.js only) |
| `PORT` | No | Service port (default: 8080, Docker/Azure only) |
| `LOG_LEVEL` | No | Log level (default: info) |
| `TOKEN_TTL_MS` | No | Authentication token TTL in milliseconds (default: 1500000 = 25 min) |
| `PDF_LOCALE` | No | Date formatting locale (default: is-IS) |
| `PDF_INCLUDE_INTERNAL_NOTES` | No | Include internal notes in PDF (default: false) |
| `PDF_COMPANY_NAME` | No | Company name in PDF header |

---

## Security Best Practices

1. **Store credentials securely** — Use Cloudflare secrets, Azure secretref, or Docker secrets. Never store in code or plaintext config.
2. **Use HTTPS** — Always use HTTPS in production. Cloudflare Workers and Azure Container Apps handle this automatically.
3. **Restrict access** — HMAC webhook signature verification ensures only Zendesk can trigger the webhook. The `/audit` endpoint requires a Bearer token.
4. **Monitor and alert** — Set up log monitoring and configure alerts for failures.
5. **Multi-tenant consideration: `doc_system` override** — The `/attachments` endpoint currently allows the caller to override the target document system via the `doc_system` field in the request body. In a single-tenant setup this is convenient (Malaskra can target GoPro or OneSystems per-request). In a multi-tenant or government deployment, consider restricting this by validating `doc_system` against an allow-list (`["gopro", "onesystems"]`) or ignoring the field entirely and always using the server's configured `DOC_SYSTEM`. This prevents a compromised API key from routing data to an unintended system.

---

## Related Documentation

- [Malaskra Zendesk App](https://github.com/Vertiscx/malaskra_v2)
- [Zendesk Webhooks](https://developer.zendesk.com/documentation/webhooks/)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/)
- [Docker Documentation](https://docs.docker.com/)
