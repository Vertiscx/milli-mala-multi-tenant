# Contributing

_Last updated: 2026-09-02._

## Two repositories

Work happens on the **Vertiscx fork**. Production deploys from **island-is upstream**. Upstream receives one squashed pull request per change, only when it is finished and reviewed on the fork.

```
Vertiscx/milli-mala-multi-tenant          island-is/milli-mala-multi-tenant
  feature branch ──▶ PR ──▶ main   ──squash──▶  PR ──▶ main ──▶ manual deploy
```

The fork's `main` is periodically synced from upstream with a merge commit titled `Merge island-is main into Vertiscx main (sync through #N)`.

## Rules

1. **One concern per PR.** A tenant addition, a bug fix, and a refactor are three PRs. Reviewers upstream are not on our team and should never have to untangle a diff.
2. **Code only goes upstream.** Nothing under `.planning/` and no internal notes. Documentation changes go upstream only when they describe the shipped system.
3. **Tests pass before any PR.** `npm test` and `npm run typecheck`. CI runs both on Node 20 and 22, plus CodeQL upstream.
4. **Never push secrets.** Not in code, not in `.env.example`, not in a test fixture, not in a PR description. Test fixtures use obviously fake values that still satisfy the length rules.
5. **Behaviour changes need a test that fails without them.** The pipeline has strict rules about error precedence and response shapes; a refactor that quietly reorders a check will break a tenant.

## Workflow

```bash
git fetch fork
git checkout -b feat/<short-name> fork/main
# work, commit
npm test && npm run typecheck
git push -u fork feat/<short-name>
gh pr create -R Vertiscx/milli-mala-multi-tenant --base main
```

After review and merge on the fork:

```bash
git fetch fork origin
git checkout -b upstream/<short-name> origin/main
git merge --squash fork/main          # or cherry-pick the specific commits
git commit                            # one commit, conventional message
git push -u fork upstream/<short-name>
gh pr create -R island-is/milli-mala-multi-tenant --base main --head Vertiscx:upstream/<short-name>
```

Then, once upstream merges, sync the fork:

```bash
git checkout main && git fetch origin
git merge origin/main -m "Merge island-is main into Vertiscx main (sync through #N)"
git push fork main
```

and delete the finished branches on both sides.

## Commit messages

Conventional prefix, imperative mood, lowercase after the colon, no trailer.

```
feat(tenants): add Sýslumenn tenant on a OneSystems endpoint
fix(zendesk): restore the 30s timeout on attachment downloads
refactor(archive): split documentTicket into pipeline stages
docs: replace the seven architecture docs with one
```

Icelandic characters are preserved everywhere: commit messages, code comments, test fixtures, PDF output.

## Adding an archive backend

The only place that knows which archive product it is talking to is `src/services/archive/docClient.ts`. A new backend needs:

1. `src/services/archive/<name>.ts` implementing `DocClient` (`uploadDocument`), and optionally `createCase`.
2. A branch in `createDocClient`.
3. The new value in the `type` union in `src/platform/types.ts`.
4. A credential-validation clause in `validateEndpoint` in `src/platform/tenant.ts`.
5. Tests mirroring `tests/gopro.test.ts`.

Nothing in the pipeline changes.

## Adding a tenant

Covered step by step in [OPERATIONS.md](OPERATIONS.md#5-adding-a-tenant). The code part is one block in `src/tenants.config.ts` and one block in `.env.example`.

## Code conventions

- TypeScript strict. ES modules with `.js` import suffixes.
- `src/platform/` never imports from `src/services/`.
- Error responses are fixed strings. Never return an upstream error body or an exception message to the caller.
- Every log line carries `brand_id`. No ticket content, names, emails or kennitala in logs.
- Secrets are compared with SHA-256 then `timingSafeEqual`.
- A new failure mode gets an explicit outcome value, an audit entry, and an internal note on the ticket.
