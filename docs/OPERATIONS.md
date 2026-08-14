# Operations

Day-to-day running of milli-mala in production. For the pre-deployment
security and architecture overview see [`HANDOVER.md`](../HANDOVER.md)
(Icelandic). For first-time infrastructure setup see
[`DEPLOYMENT.md`](../DEPLOYMENT.md).

## What runs in production

A single Node.js 20 Docker container on **AWS ECS**, `eu-west-1`.

| | |
|---|---|
| Cluster | `tooling-prod` |
| Service | `prod-milli-mala-multi-tenant` |
| Image registry | `821090935708.dkr.ecr.eu-west-1.amazonaws.com/milli-mala-multi-tenant` |
| Port | 8080 |
| Health check | `GET /v1/health` |

The repository also contains a Cloudflare Workers entrypoint
(`src/worker.ts`). It is **not deployed** — ignore it when operating the
service.

Stateless: no database, no cache, no persistent storage. The audit log is
optional and writes to stdout unless a volume is configured.

## 1. Reviewing a pull request

Everything that changes behaviour lands in the repository and goes through
normal review. Secrets never do.

**A new tenant (institution) is a code change.** It adds an entry to
`src/tenants.config.ts` containing the non-secret shape of that tenant:
Zendesk subdomain, archive system base URLs, PDF settings, brand id. Review
it as you would any config change — the values are not sensitive.

Alongside it, the tenant's **secrets** arrive out-of-band as flat
environment variables for you to provision. Which ones are needed is visible
from the `requireEnv()` calls in the new entry.

**What to look for in the diff:**

- Endpoints are registered in `src/services/archive/routes.ts`. A new route
  appearing there is a new externally reachable surface — worth a closer look.
- Outbound hosts are restricted to `*.zendesk.com` and `*.zdassets.com` plus
  the per-tenant archive URLs. A change widening that is a security change.
- `src/platform/env.ts` defines how required variables are read. A new
  `requireEnv()` call means the container will refuse to start until that
  variable exists in the environment — coordinate before merging.

## 2. Credentials

All secrets are flat environment variables provisioned on ECS. None are in
the repository.

**The authoritative list is [`.env.example`](../.env.example)** — it is kept
current and commented. Read that file first; this document deliberately does
not duplicate the list.

Broadly, each tenant carries: a Zendesk API token, archive system
credentials (OneSystems appKey or GoPro password), and a Málaskrá API key.

**Fail-fast behaviour:** `requireEnv()` in `src/platform/env.ts` throws at
startup if a required variable is missing or empty, and the container will
not come up. This is deliberate — a visible boot failure beats a silent
failure on the first real request. If a deploy comes up unhealthy
immediately after a tenant was added, a missing variable is the first thing
to check.

**Rotation** requires no code change: update the environment variable on the
service and redeploy (below) so the new task picks it up.

## 3. Deploying, redeploying and rolling back

Pipeline: [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml),
running on `arc-shared` and assuming an AWS role via OIDC.

### What triggers a deploy

| Trigger | Behaviour |
|---|---|
| A pull request **merged** into `main` | Builds a new image tagged with the short commit SHA, deploys it |
| A pushed tag matching `v*` | Builds an image tagged with the version, deploys it |
| Manual **workflow_dispatch** | With no input, builds from the current ref. With an `image_tag` input, **skips the build entirely** and deploys that existing image |

Note that pushing directly to `main` does *not* deploy — only a merged PR does.

### To redeploy without changing code

Run the workflow manually (`workflow_dispatch`) and leave `image_tag` empty
to rebuild, or supply an existing tag to redeploy that image as-is. Use this
after rotating a credential, so the service restarts with the new value.

### To roll back

Run `workflow_dispatch` with `image_tag` set to the previously good tag —
normally the short SHA of the last known-good commit. The build is skipped,
the task definition is re-registered pointing at that image, and the service
is updated. This is the fastest path back and does not require a revert
commit.

Images are in ECR under the repository above; list the available tags there
to find the one you want.

### What the deploy actually does

Reads the current ECS task definition, rewrites the container image tag,
registers a new revision, calls `update-service`, then blocks on
`aws ecs wait services-stable`. A green run therefore means the new tasks
reached a stable state — not merely that the image was pushed.

### After a deploy

- Confirm the workflow run finished green.
- Check `GET /v1/health` returns 200.
- Watch stdout (structured JSON) for startup errors — a missing environment
  variable surfaces here immediately.

### Known flakiness

The pipeline has historically failed on the first attempt and succeeded on a
straight re-run, with no change in between. **Before investigating a failed
deploy as an environment or boot problem, check the run history and try a
re-run:**

```
gh run list --repo island-is/milli-mala-multi-tenant --workflow deploy.yml
```

If a re-run also fails, it is a real failure — then check the container
startup logs for a `requireEnv` error.
