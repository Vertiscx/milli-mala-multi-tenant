# Milli-mála

**Multi-tenant gateway between Zendesk and the document archives of Icelandic public institutions.**

_Last updated: 2026-09-02._

Institutions handle citizen correspondence in Zendesk and are obliged to file it in their official archive. Milli-mála does the filing: it receives a signed request naming a ticket, fetches the ticket from Zendesk, renders it to PDF, and uploads PDF and attachments into the institution's archive case. It can also create the archive case and write the case number back onto the ticket.

It holds credentials for both sides so neither side has to. Zendesk never sees archive credentials. Archives never see Zendesk credentials.

| | |
|---|---|
| Archive backends | OneSystems, GoPro |
| Tenants | One per Zendesk brand. Seven configured. |
| Production | One Node.js container on AWS ECS, run by Digital Iceland |
| Runtime dependency | jsPDF, and nothing else |
| Licence | Apache-2.0 |

## Documents

| Read this | When you want to |
|---|---|
| [ONBOARDING.md](ONBOARDING.md) | Join the project. Reading order, people, open decisions. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Understand how a request moves through the system and why it behaves the way it does. |
| [OPERATIONS.md](OPERATIONS.md) | Deploy, roll back, add a tenant, rotate a secret, read the audit log, diagnose a failure. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Change the code. Branching, tests, how work reaches the upstream repository. |

## Endpoints

| Method | Path | Called by | Auth |
|---|---|---|---|
| `POST` | `/v1/webhook` | Zendesk trigger | Zendesk HMAC-SHA256 signature |
| `POST` | `/v1/cases` | Málaskrá sidebar app | `X-Api-Key` |
| `POST` | `/v1/attachments` | Málaskrá sidebar app | `X-Api-Key` |
| `GET` | `/v1/audit` | Operator | `Authorization: Bearer <AUDIT_SECRET>` |
| `GET` | `/v1/health` | Load balancer | none |

Every POST carries the same three fields. `brand_id` selects the tenant; `doc_endpoint` selects which of that tenant's archives to file into.

```json
{
  "ticket_id": "12345",
  "brand_id": "11037960588818",
  "doc_endpoint": "onesystems"
}
```

`/v1/cases` additionally takes exactly one of `case_number` (file into an existing case) or `create` (create a case first). Its response is a fixed envelope with an `outcome` of `documented`, `orphan_case`, `create_failed`, `validation`, `auth`, `brand_mismatch` or `gopro_create_unsupported`. See [ARCHITECTURE.md](ARCHITECTURE.md#5-case-numbers-and-the-failure-rules) for what each means and why.

After every documentation attempt the gateway posts an internal note on the ticket with the result, and stamps custom fields if the tenant has them configured.

## Local development

Requires Node.js 20 or later.

```bash
npm ci
npm test              # 422 tests, under a second
npm run typecheck
```

To run the server locally you need a `.env` with every variable in [.env.example](.env.example) populated, because the tenant list in `src/tenants.config.ts` reads all of them at boot and refuses to start if any is missing. For most development work the tests are the faster loop; they use fixture secrets.

```bash
cp .env.example .env    # fill in values
npm run dev             # tsx --watch on port 8080
curl localhost:8080/v1/health
```

## Repositories

- **[Vertiscx/milli-mala-multi-tenant](https://github.com/Vertiscx/milli-mala-multi-tenant)** is where work happens.
- **[island-is/milli-mala-multi-tenant](https://github.com/island-is/milli-mala-multi-tenant)** is the upstream that production deploys from. It receives squashed pull requests from the fork. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **[Vertiscx/malaskra_v2](https://github.com/Vertiscx/malaskra_v2)** is the Zendesk sidebar app that calls `/v1/cases` and `/v1/attachments`.
