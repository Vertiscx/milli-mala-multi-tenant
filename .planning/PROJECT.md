# Milli-mála Gateway

## What This Is

Multi-tenant Zendesk → archive gateway (TypeScript; Cloudflare Worker / Docker / K8s) bridging Icelandic government institutions' Zendesk instances to their document systems (OneSystems, GoPro). This milestone adds a synchronous manual-documentation path so the Málaskrá app can document a ticket on demand through the gateway.

## Core Value

`POST /v1/cases` documents a ticket end-to-end synchronously — create-or-attach in the doc system — with a locked failure order that never silently loses a created case (orphan self-heal via the existing webhook).

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] G1: Behavior-preserving extraction of the webhook pipeline into shared services
- [ ] G2: New building blocks — `OneSystemsClient.createCase()` + `ZendeskClient.setTicketCustomField()` (unwired)
- [ ] G3: `POST /v1/cases` composing G1+G2 with locked failure order + 7 outcome codes

### Out of Scope

- Gateway folder reshuffle + shared dispatch — parked; not needed for this milestone
- Automatic create-on-webhook — parked; manual path only
- GoPro case creation — GoPro has no createCase capability (`gopro_create_unsupported`)
- `last_status` history — parked
- Moving the OneSystems fetch into the gateway — parked

## Context

- Plan of record: `~/.claude/plans/the-reason-we-used-generic-turtle.md` (Ultraplan reconciled — adopted verbatim intent, paths localized).
- Companion milestone in `malaskra_v3` (`feat/manual-documentation-via-gateway`) owns Step 0, PR-A1, PR-A2. The two milestones meet only at the cross-repo contract and the A1 SHA-bump after G1–G3 merge.
- Gateway repo synced to `fork/main` @ `462a8a6` (`Vertiscx/milli-mala-multi-tenant`); island-is is upstream source of truth.
- Action & doc-system resolution invariant (G3): Layer 1 `doc_endpoint` → `resolveEndpoint` → `createDocClient(ep)` branches on `ep.type` once. Layer 2 request shape (`create` vs `case_number`) = intent; capability presence = feasibility. No per-doc-system branching in `handleCases`/`documentTicket`.

## Constraints

- **Workflow**: `.planning/` is local-only via `.git/info/exclude` — never committed, zero upstream (island-is) footprint.
- **Git**: No `Co-Authored-By` trailer in commits. No "Generated with Claude Code" in PR bodies.
- **Push policy**: Do not push to the `Vertiscx` remote without explicit user approval.
- **Branching**: One branch per PR, sequential — `g1` off `main` → PR/merge → `g2` off updated `main` → `g3`. G1 must be reviewable in total isolation upstream.
- **Tech stack**: TypeScript strict, Node 20, single prod dependency (jsPDF). Dual runtime: `src/index.ts` (Node/Docker) + `src/worker.ts` (CF Worker) — G3 wires both.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| GSD scaffolded directly from locked plan (not full new-project) | Plan of record already locks requirements + roadmap; Socratic re-derivation redundant | — Pending |
| One sequential branch per PR off main | G1 (behavior-preserving) must be reviewable in isolation upstream | — Pending |
| Sync full pipeline + orphan self-heal via existing webhook | Never silently lose a created case | — Pending |

---
*Last updated: 2026-05-15 after milestone bootstrap*
