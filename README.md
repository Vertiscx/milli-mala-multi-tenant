# Milli-mála

**A multi-tenant gateway for Zendesk integrations in the Icelandic public sector.**

_Last updated: 2026-09-02._

Icelandic public institutions handle citizen correspondence in Zendesk. Anything Zendesk needs to reach beyond itself, such as an archive, a case system, or another government service, runs into the same problems: proving a request really came from Zendesk, holding credentials for the far system without exposing them, telling institutions apart, and keeping an audit trail. Milli-mála solves those once. It receives signed events from Zendesk, resolves which institution they belong to, holds the credentials for both sides, runs the integration, and records what happened.

The shared part is the **platform**: HTTP handling, signature and key verification, tenant resolution, the Zendesk client, credential custody, audit logging. Integrations are **services** built on it.

**Archiving is the first service and the reason the platform exists.** Institutions are obliged to file citizen correspondence in their official archive. The archive service receives a request naming a ticket, fetches it from Zendesk, renders it to PDF, and uploads PDF and attachments into the institution's archive case. It can also create the case and write the case number back onto the ticket. Zendesk never sees archive credentials. Archives never see Zendesk credentials.

| | |
|---|---|
| Services | Archive and ticket update (production), ticket create. Others are added under `src/services/` without touching the platform. |
| Archive backends | OneSystems, GoPro |
| Tenants | One per Zendesk brand. Seven configured. |
| Production | One Node.js container on AWS ECS, run by Digital Iceland |
| Runtime dependency | jsPDF, and nothing else |
| Licence | Apache-2.0 |

## Documents

| Read this | When you want to |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Understand how a request moves through the system and why it behaves the way it does. |
| [OPERATIONS.md](OPERATIONS.md) | Deploy, roll back, add a tenant, rotate a secret, read the audit log, diagnose a failure. |

## Endpoints

| Method | Path | Called by | Auth |
|---|---|---|---|
| `POST` | `/v1/webhook` | Zendesk trigger | Zendesk HMAC-SHA256 signature |
| `POST` | `/v1/cases` | Málaskrá sidebar app | `X-Api-Key` |
| `POST` | `/v1/attachments` | Málaskrá sidebar app | `X-Api-Key` |
| `POST` | `/v1/tickets/update` | Zendesk trigger | Zendesk HMAC-SHA256 signature |
| `POST` | `/v1/tickets/create` | A system outside Zendesk (e.g. a web form's backend) | `X-Api-Key`, plus a required `Idempotency-Key` |
| `GET` | `/v1/audit` | Operator | `Authorization: Bearer <AUDIT_SECRET>` |
| `GET` | `/v1/health` | Load balancer | none |

Every archive POST (`/v1/webhook`, `/v1/cases`, `/v1/attachments`) carries the same three fields. `brand_id` selects the tenant; `doc_endpoint` selects which of that tenant's archives to file into.

```json
{
  "ticket_id": "12345",
  "brand_id": "11037960588818",
  "doc_endpoint": "onesystems"
}
```

`/v1/cases` additionally takes exactly one of `case_number` (file into an existing case) or `create` (create a case first). Its response is a fixed envelope with an `outcome` of `documented`, `orphan_case`, `create_failed`, `validation`, `auth`, `brand_mismatch` or `gopro_create_unsupported`. See [ARCHITECTURE.md](ARCHITECTURE.md#5-case-numbers-and-the-failure-rules) for what each means and why.

`/v1/tickets/update` belongs to a different service and takes a different shape: `brand_id` sits **inside** `ticket`, alongside the ticket id and whatever fields are to be set.

```json
{
  "ticket": {
    "id": "12345",
    "brand_id": "11037960588818",
    "status": "solved"
  }
}
```

It updates the ticket through the Zendesk API using a per-tenant OAuth client (Client Credentials grant) rather than the tenant's Basic-auth API token, so the access token never travels back through Zendesk's own trigger machinery. Everything in `ticket` except `id` and `brand_id` is forwarded to Zendesk as the fields to set. It is signed with its own webhook secret, independent of the archive webhook's — Zendesk generates one signing secret per webhook target and never lets it be set to a chosen value.

`/v1/tickets/create` creates a ticket for a caller outside Zendesk, such as a web form's backend server. Only `ticket.brand_id` is required: it selects the tenant, and the ticket is always created in that tenant's own brand. Any other Zendesk ticket field can be sent and is passed through.

```json
{
  "ticket": {
    "brand_id": 30303665547154,
    "subject": "...",
    "requester": { "name": "...", "email": "..." },
    "comment": { "html_body": "..." },
    "group_id": 1234
  }
}
```

The caller sends the tenant's API key in `X-Api-Key` and its own submission ID in `Idempotency-Key`; Zendesk ignores a repeat of the same key within two hours, so a retried request returns the original ticket rather than creating a second one. Because all brands share one Zendesk account, a few fields are restricted: `group_id` and `ticket_form_id` are kept only if they are on the tenant's allowed lists, and `assignee_id`, `requester_id`, `submitter_id`, `organization_id` and `comment.author_id` are always dropped. A dropped field never stops the ticket being created. The response is `201` with `{ success, ticket_id, brand_id, dropped_fields }`.

After every documentation attempt the gateway posts an internal note on the ticket with the result, and stamps custom fields if the tenant has them configured.

## Local development

Requires Node.js 20 or later.

```bash
npm ci
npm test              # 501 tests, under a second
npm run typecheck
```

To run the server locally you need a `.env` with every variable in [.env.example](.env.example) populated, because the tenant list in `src/tenants.config.ts` reads all of them at boot and refuses to start if any is missing. For most development work the tests are the faster loop; they use fixture secrets.

```bash
cp .env.example .env    # fill in values
npm run dev             # tsx --watch on port 8080
curl localhost:8080/v1/health
```
