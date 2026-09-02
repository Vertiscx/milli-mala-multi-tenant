# Onboarding

_Last updated: 2026-09-02._

You are joining a small, security-reviewed integration service that runs inside Digital Iceland's platform and is built and maintained by Vertis. This page tells you what to read, in what order, who is involved, and which questions are still open so you do not spend time re-deriving them.

## What it is, in four sentences

Milli-mála is a multi-tenant gateway for Zendesk integrations in the Icelandic public sector: it proves a request came from Zendesk or an authorised app, works out which institution it belongs to, holds the credentials for whatever system is on the other side, runs the integration, and records what happened. Integrations are services built on that shared platform. The first service, and the only one in production, is archiving: institutions are legally obliged to file citizen correspondence in their official archive, so the service turns a ticket into a PDF and files it into the institution's archive case, creating the case if needed. Zendesk never sees archive credentials and archives never see Zendesk credentials.

The name means "between cases". Write it with the accent in prose.

## Reading order

About two hours in total.

1. **[README.md](README.md)**, ten minutes. Endpoints, request shape, repositories.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)**, forty minutes. Read section 5 twice. The case-number and failure rules are where the domain knowledge lives, and they explain most of the design decisions you will otherwise find odd.
3. **[OPERATIONS.md](OPERATIONS.md)**, thirty minutes. Especially section 3 on how deploys actually happen and section 5 on adding a tenant. These are the two things you will do most.
4. **[CONTRIBUTING.md](CONTRIBUTING.md)**, ten minutes. The two-repository model.
5. **The code**, thirty minutes, in this order: `src/index.ts`, `src/services/archive/routes.ts`, `src/services/archive/webhook.ts`, `src/services/archive/documentTicket.ts`, `src/services/archive/docClient.ts`. That is the whole spine. Everything else is a stage or an adapter.
6. **`npm test`**. Watch it pass. Open `tests/pipeline.guards.test.ts` to see the failure rules as executable statements.

## People

| Who | Role in this project |
|---|---|
| Brynjólfur (Vertis) | Product owner. Decides priorities, owns institution relationships, decides what goes upstream and when. |
| Gunnsteinn (Vertis) | Technical operations. Day-to-day ops, tenant onboarding, secret hand-offs, triage, technical discussions with Digital Iceland and institutions. |
| Digital Iceland DevOps | Run the ECS service and Parameter Store. Press the deploy button. Reachable through the shared Slack channel. |
| island-is reviewers | Review and merge squashed PRs into the upstream repository. Not on our team; keep PRs small and self-explanatory. |
| Institution admins | Own their Zendesk brand configuration: webhook, trigger, Málaskrá app install. |

## Vocabulary

| Term | Meaning |
|---|---|
| Tenant | One institution's configuration: one Zendesk brand, its credentials, its archive. |
| Brand | A customer-facing identity inside one Zendesk account. Several brands share an account, and custom fields are account-level, so brands on the same account share field IDs. |
| Málaskrá | "Case register". The Zendesk sidebar app agents use to file a ticket manually. Also the general word for the archive register. |
| OneSystems, GoPro | The two archive products supported. Workpoint is a third that has been discussed. |
| Kennitala | Icelandic national ID number. Personal data. Never in logs. |
| Case number | The archive's reference for a case. Read from a ticket custom field, or created by the gateway, or `ZD-<ticket>` as a fallback for GoPro. |
| Orphan case | A case that was created in the archive but the follow-up upload failed. Reported as 207 with the number, never lost. |
| Trigger | A Zendesk rule that fires the webhook. Must be one-shot or it loops. |
| Upstream, fork | `island-is` is upstream and deploys production. `Vertiscx` is the fork where work happens. |
| d3v | Vertis's Zendesk sandbox for testing. Never a production target. |

## Open decisions

These are known and deliberately unresolved. Do not treat them as settled, and do not re-investigate them from scratch; ask.

| Decision | State |
|---|---|
| Durable audit store | The audit log lives in a directory inside the container and resets on deploy. Agreed as the top technical gap. Not yet scheduled. |
| Tenants as code | Each institution is a code change plus seven secrets plus a deploy. Agreed it should move to a config file or table. Not yet designed. |
| Cloudflare Workers path | Exists in the tree, not in production, doubles maintenance. Leaning towards removal. |
| Deploy trigger | Merged fork PRs always show a failed deploy run because of an IAM limitation. Either fix the workflow's trigger or accept manual dispatch as the model. |
| Workpoint adapter | Third archive backend. Blocked on vendor information. |
| Email-inspection service | A second service was built on the platform in July 2026. Its main capability was superseded by a Zendesk feature and deprecated. The platform skeleton and a "forward-note" idea remain on unmerged branches. Not on the roadmap until an institution asks for it. |

## Habits that matter here

- **Secrets move through Bitwarden Send only.** Not Slack, not PRs, not planning notes, not this file.
- **Subdomain is not hostname.** `digitaliceland`, never `digitaliceland.zendesk.com`. This has caused an outage-shaped mistake once already.
- **Deploy only after secrets are confirmed.** One missing variable crashes the container for every tenant.
- **A red "Build and Deploy" on a merged PR is normal.** It means nothing was deployed, not that something broke.
- **Icelandic characters are preserved everywhere.** Never normalise þ, ð, æ, ö to ASCII.
