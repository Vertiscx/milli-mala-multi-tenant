# Roadmap: Milli-mála Gateway — Manual Documentation via Gateway

## Overview

Three sequential gateway PRs, one branch per PR off `main`. G1 extracts the existing webhook pipeline into shared services with zero behavior change (reviewable in isolation upstream). G2 adds new, fully unit-tested building blocks without wiring them. G3 composes G1+G2 into the new synchronous `POST /v1/cases` endpoint with the locked failure order and 7 outcome codes, wired into both runtimes. Each phase = one PR; merge before starting the next.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: G1 — Pipeline extraction** - Behavior-preserving extraction of the webhook pipeline into `src/documentTicket.ts` ✓ verified PASS (branch `g1`, not pushed)
- [x] **Phase 2: G2 — New building blocks** - `OneSystemsClient.createCase()` + `ZendeskClient.setTicketCustomField()`, unit-tested, unwired
- [x] **Phase 3: G3 — POST /v1/cases** - Synchronous endpoint composing G1+G2 with locked failure order + 7 outcome codes

## Phase Details

### Phase 1: G1 — Pipeline extraction
**Goal**: Extract the webhook pipeline into reusable services with provably zero behavior change.
**Depends on**: Nothing (first phase)
**Requirements**: G1-01, G1-02, G1-03, G1-04
**Success Criteria** (what must be TRUE):
  1. `fetchTicketInfo` / `renderPdf` / `resolveCaseNumber` / `postToCase` / `writeAudit` + `documentTicket()` live in `src/documentTicket.ts`
  2. `handleWebhook` delegates and returns an unchanged `HandlerResult`
  3. The entire existing `tests/*` suite passes UNCHANGED; `npm test`, `npm run typecheck`, `npm run build` all green
**Plans**: 1 plan
**Branch**: `g1` off `main`

Plans:
- [x] 01-PLAN.md — Extract documentTicket pipeline; thin handleWebhook delegator; risk-hardening tests; behavior-preserving proof ✓ (190/190 tests, typecheck+build green, zero index/worker/webhook-test changes, verifier PASS 9/9)

### Phase 2: G2 — New building blocks
**Goal**: Add `createCase` (OneSystems) and `setTicketCustomField` (Zendesk write) as tested, unwired building blocks.
**Depends on**: Phase 1 (merged to main)
**Requirements**: G2-01, G2-02, G2-03, G2-04
**Success Criteria** (what must be TRUE):
  1. `OneSystemsClient.createCase()` ports the app contract verbatim (kennitala digits-only, 5-shape caseNumber waterfall, error→throw)
  2. `ZendeskClient.setTicketCustomField()` performs `PUT /tickets/{id}.json` via new `requestWrite()`
  3. `DEPLOYMENT.md` documents the required ticket-write token scope
  4. New unit tests pass; nothing is wired into any handler
**Plans**: TBD
**Branch**: `g2` off updated `main`

Plans:
- [ ] 02-01: TBD (set by /gsd-plan-phase 2)

### Phase 3: G3 — POST /v1/cases
**Goal**: Ship the synchronous manual-documentation endpoint composing G1+G2.
**Depends on**: Phase 2 (merged to main)
**Requirements**: G3-01, G3-02, G3-03, G3-04, G3-05
**Success Criteria** (what must be TRUE):
  1. `src/cases.ts` `handleCases` mirrors `src/attachments.ts` (auth, validation, resolveEndpoint, fail-closed brand cross-check)
  2. The locked failure order is implemented exactly; all 7 outcome codes returned correctly
  3. Endpoint wired into BOTH `src/index.ts` and `src/worker.ts`
  4. `tests/cases.test.ts` covers each outcome + locked ordering; `npm run build` green
**Plans**: TBD
**Branch**: `g3` off updated `main`

Plans:
- [ ] 03-01: TBD (set by /gsd-plan-phase 3)
