# Operations

_Last updated: 2026-09-02._

How milli-mála is deployed and run in production, and what to do when something needs changing or has gone wrong. Written for whoever is on the technical side day to day, and for Digital Iceland DevOps who run the platform.

---

## 1. Where it runs

| | |
|---|---|
| Runtime | One Docker container, Node.js 20 on Alpine, non-root user |
| Host | AWS ECS, cluster `tooling-prod`, service `prod-milli-mala-multi-tenant`, region `eu-west-1` |
| Image registry | ECR `821090935708.dkr.ecr.eu-west-1.amazonaws.com/milli-mala-multi-tenant` |
| Public URL | `https://milli-mala.tooling.island.is` |
| Health | `GET /v1/health` returns `{"status":"ok", ...}` |
| Port | 8080 |
| Logs | Structured JSON on stdout, one line per event, `brand_id` on every line |
| Secrets | AWS Parameter Store, injected as environment variables |
| Deploy source | `main` of `island-is/milli-mala-multi-tenant` |

The Cloudflare Workers entry point in the repository is **not** deployed anywhere. Ignore it operationally.

## 2. Who does what

| Role | Owns |
|---|---|
| Integration maintainers (currently Vertis) | Priorities, institution relationships, tenant onboarding, secret hand-offs, triage, PRs, deploy requests |
| Digital Iceland DevOps | The ECS service, Parameter Store, pressing the deploy button, rollback |
| Repository reviewers | Approving PRs into this repository |
| Institution admins | Their Zendesk brand: webhook, trigger, Málaskrá app install |

## 3. Deploying

### How the pipeline behaves today

`.github/workflows/deploy.yml` in the upstream repository builds the image, pushes it to ECR, registers a new ECS task definition with that tag, updates the service, and waits for it to stabilise.

It has three triggers. Only one works for our workflow:

| Trigger | Result |
|---|---|
| `workflow_dispatch` on `main` | **Works.** This is how every production deploy has happened. |
| Pull request merged into `main` | **Fails** when the PR came from a fork. GitHub does not expose the OIDC secret to fork-originated events, so the job runs under the runner's default role and is denied `ecs:DescribeTaskDefinition`. Every merged fork PR shows a red "Build and Deploy" run. That red run is expected and means nothing was deployed. |
| Push of a `v*` tag | Untested. |

Consequence: **merging to upstream `main` does not put code in production.** Someone must run the workflow by hand afterwards.

### Deploy procedure

1. Confirm the upstream `main` commit you want is merged and CI is green.
2. If the change adds a tenant or a new environment variable, confirm with DevOps that the values are in Parameter Store **before** step 3. A missing variable crashes the container at boot for every tenant, not just the new one.
3. Ask DevOps to run **Actions, Build and Deploy, Run workflow** on `main` with the image tag left blank. Or, if you have permission, run it yourself:
   ```bash
   gh workflow run deploy.yml -R island-is/milli-mala-multi-tenant --ref main
   gh run watch -R island-is/milli-mala-multi-tenant
   ```
4. The first attempt fails more often than it should for reasons unrelated to the change. If it fails, read the log before assuming a config problem. A rerun usually succeeds.
5. Verify:
   ```bash
   curl https://milli-mala.tooling.island.is/v1/health
   ```
   then send one real ticket through for the tenant you changed, and check the internal note appears on the ticket and the document appears in the archive.

### Rollback

Each image is tagged with the short commit SHA. To roll back, run the same workflow with **image tag** set to the previous SHA. The build step is skipped and the service is pointed at the old image.

```bash
gh run list -R island-is/milli-mala-multi-tenant --workflow "Build and Deploy" --status success
gh workflow run deploy.yml -R island-is/milli-mala-multi-tenant --ref main -f image_tag=<previous sha>
```

Rollback does not touch Parameter Store. If the rollback target predates a tenant, that tenant's variables are simply unused.

## 4. Configuration

Two layers.

**Instance settings**, read by `src/platform/config.ts`:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Listen port | `8080` |
| `LOG_LEVEL` | `info`, `debug`, `error` | `info` |
| `AUDIT_SECRET` | Bearer token for `/v1/audit`. Empty disables the endpoint. | empty |
| `AUDIT_DIR` | Where audit entries are written | `./audit-data` |

**Tenant settings**, read by `src/tenants.config.ts`. Every tenant has this set, prefixed with its name:

| Variable | Required | Notes |
|---|---|---|
| `<T>_ZENDESK_SUBDOMAIN` | yes | **Bare subdomain only**, for example `digitaliceland`. Not the hostname. A value with a dot fails validation and the tenant returns 400 on every request. |
| `<T>_ZENDESK_EMAIL` | yes | The API user. Needs ticket-write scope for the case-number stamp and the result note. |
| `<T>_ZENDESK_API_TOKEN` | yes | 32+ characters. Zendesk tokens are 40. |
| `<T>_ZENDESK_WEBHOOK_SECRET` | yes | Shown once by Zendesk when the webhook is created. 32+ characters. |
| `<T>_ONESYSTEMS_BASE_URL` and `<T>_ONESYSTEMS_APP_KEY` | OneSystems tenants | HTTPS, public hostname, **no trailing slash**. |
| `<T>_GOPRO_BASE_URL`, `<T>_GOPRO_USERNAME`, `<T>_GOPRO_PASSWORD` | GoPro tenants | Password 16+ characters. |
| `<T>_MALASKRA_API_KEY` | yes | Generate fresh: `openssl rand -hex 24`. Must be unique across tenants. The same value goes into the Málaskrá app's secure setting for that brand. |
| `<T>_TEMPLATE_FIELD_ID`, `<T>_KENNITALA_FIELD_ID`, `<T>_CASE_NUMBER_FIELD_ID` | optional | Numeric Zendesk custom-field IDs. Not secrets. Account-level, so every brand on the same Zendesk account uses the same three numbers. Without `CASE_NUMBER_FIELD_ID` the webhook will not create cases. |

The full list with current tenants is [.env.example](.env.example).

Validation runs at boot. The container refuses to start on a missing required variable, a subdomain with invalid characters, a non-HTTPS or private-address archive URL, a short or repeated-character secret, or a non-integer field ID. The error names the variable.

## 5. Adding a tenant

End to end, in the order that avoids the two common mistakes (deploying before secrets exist, and confusing subdomain with hostname).

1. **Collect from the institution:** brand ID, which archive product, the archive base URL and credential, whether internal notes should be included in the PDF.
2. **Zendesk side, done by the institution admin or by you with admin access:**
   - Create the webhook: Admin Center, Apps and integrations, Webhooks. URL `https://milli-mala.tooling.island.is/v1/webhook`, method POST, JSON. Enable the signing secret and copy it.
   - Create the trigger. Body:
     ```json
     { "ticket_id": "{{ticket.id}}", "brand_id": "{{ticket.brand.id}}", "doc_endpoint": "onesystems" }
     ```
     **The trigger must be one-shot.** The gateway writes a note back onto the ticket, which re-evaluates triggers. Use a marker tag the trigger requires and removes in the same run, for example condition "tag `malaskra_doc_pending` present", actions "notify webhook" and "remove tag `malaskra_doc_pending`". A trigger on a bare condition like "status is solved" loops in production.
   - If the tenant uses case creation from the webhook, the template field must be stamped by an earlier trigger, before the archive trigger fires.
   - Install the Málaskrá app on the brand and set its API key secure setting to the value you will generate in step 4.
3. **Code:** open a PR adding the tenant block to `src/tenants.config.ts` and the variable names to `.env.example`. The existing blocks are the template. Run `npm test`; the config test loads the real list with placeholder values.
4. **Secrets:** prepare the variable block, fill in the values, and send it to DevOps through a secure channel (Bitwarden Send). Never paste secrets into a PR, an issue, a chat, or a planning note. Ask DevOps to confirm the values are in Parameter Store.
5. **Deploy** as in section 3, only after step 4 is confirmed.
6. **Verify** with one real ticket on the new brand.

## 6. Rotating a secret

No code change. DevOps updates the value in Parameter Store and restarts the service. For the Málaskrá key, update the app's secure setting on the brand at the same time. For the webhook secret, regenerate it in Zendesk first, then update Parameter Store, then restart. Requests signed with the old secret fail with 401 in between, and Zendesk retries them.

## 7. Reading the audit log

```bash
export S=<AUDIT_SECRET>
curl -H "Authorization: Bearer $S" "https://milli-mala.tooling.island.is/v1/audit?brand_id=<brand>&limit=20"
curl -H "Authorization: Bearer $S" "https://milli-mala.tooling.island.is/v1/audit?brand_id=<brand>&ticket_id=<id>"
```

Entries carry event, outcome, case number and its source, duration, PDF size, and any attachments that were skipped. No ticket content. Retention is 90 days.

**Caveat:** entries are files inside the container under `AUDIT_DIR`. Unless that path is a mounted volume, the log resets on every deploy. Treat it as recent history, not as the archive of record. Making it durable is a known next step.

## 8. Diagnosing a failure

Start with the ticket. Every attempt leaves an internal note: a tick with the case number, or a cross with a reason in Icelandic. Then the audit log for that ticket. Then the container logs, filtered by `brand_id`.

| Symptom | Likely cause | Check |
|---|---|---|
| Container will not start | Missing or invalid env var | Boot log names the variable. Compare against `.env.example`. |
| Every request for one tenant returns `400 Invalid request` | Tenant failed validation at boot, usually subdomain with a dot or a bad archive URL | Boot log. |
| `401 Invalid webhook signature` | Webhook secret mismatch | Re-copy the signing secret from the Zendesk webhook. |
| `401 Webhook timestamp expired` | Clock skew or a replayed request | Compare timestamps. Five-minute window. |
| `401` on `/v1/cases` or `/v1/attachments` | Málaskrá key mismatch | Compare the app's secure setting with Parameter Store. |
| `403 Brand mismatch` | Trigger on one brand sent a ticket belonging to another | Check the trigger's brand scope. |
| `422 missing_template` or `missing_kennitala` | Case creation requested but the ticket lacks the field | Trigger ordering, or the field IDs in config are wrong. |
| `422 missing_case_number_field_config` | Tenant has no `CASE_NUMBER_FIELD_ID` | Add it and redeploy. |
| `207 orphan_case` | Case was created in the archive but the upload or stamp failed | The case number is in the note and audit entry. File the document manually or re-run through Málaskrá with that case number. |
| Archive returns 404 on upload | Trailing slash on the base URL, or wrong path | Config. |
| Archive auth fails | Expired or wrong credential | Test the archive API directly. |
| Same ticket archived repeatedly | Trigger is not one-shot | Fix the trigger as in section 5. |
| Red "Build and Deploy" on a merged PR | Expected for fork PRs | Nothing was deployed. Run the workflow manually. |

## 9. Network

Inbound: HTTPS from Zendesk and from the Málaskrá app in agents' browsers.

Outbound, and nothing else: `*.zendesk.com` and `*.zdassets.com` for the Zendesk API and attachment downloads, and each tenant's archive URL. Attachment downloads are refused for any other host. Archive URLs are refused if they resolve to private or loopback ranges.

## 10. Data handling

The service is stateless. Ticket content, comments, attachments and the rendered PDF exist in memory for the duration of one request and are discarded. Only audit metadata is written to disk, and it contains no ticket content, names, emails, or kennitala. Attachments are capped at 50 files and 100 MB per request; anything over the cap is reported in the result note, not silently dropped. Internal notes are excluded from the PDF unless the tenant opts in.
