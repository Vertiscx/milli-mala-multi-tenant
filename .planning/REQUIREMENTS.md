# Requirements: Milli-mála Gateway — Manual Documentation via Gateway

**Defined:** 2026-05-15
**Core Value:** `POST /v1/cases` documents a ticket end-to-end synchronously with a locked failure order that never silently loses a created case.

## v1 Requirements

### G1 — Behavior-preserving pipeline extraction

- [ ] **G1-01**: `fetchTicketInfo`, `renderPdf`, `resolveCaseNumber`, `postToCase`, `writeAudit` + a `documentTicket()` orchestrator extracted into `src/documentTicket.ts` (plus small module additions)
- [ ] **G1-02**: `handleWebhook` delegates to the extracted pipeline and returns the same `HandlerResult` as before
- [ ] **G1-03**: Regression net — existing `tests/*` pass UNCHANGED; `npm test`, `npm run typecheck`, `npm run build` all green
- [ ] **G1-04**: No behavior change observable from any endpoint (proof: unchanged test suite)

### G2 — New building blocks (unwired)

- [ ] **G2-01**: `OneSystemsClient.createCase()` → `POST /api/OneRecord/CreateCaseUid`, contract ported verbatim from app `src/clients/onesystems/cases.ts` (kennitala digits-only, body mapping, 5-shape caseNumber waterfall, `{errorCode,errorMessage}` → throw)
- [ ] **G2-02**: `ZendeskClient.setTicketCustomField()` → `PUT /tickets/{id}.json` (first gateway Zendesk write; add `requestWrite()`)
- [ ] **G2-03**: `DEPLOYMENT.md` notes tenant token needs ticket-write scope
- [ ] **G2-04**: Unit tests extend `tests/onesystems.test.ts` + `tests/zendesk.test.ts`; new code is NOT wired into any handler

### G3 — `POST /v1/cases` (composes G1+G2)

- [ ] **G3-01**: `src/cases.ts` `handleCases` mirroring `src/attachments.ts` (verifyApiKey, ticket_id validation, resolveEndpoint, fail-closed brand cross-check)
- [ ] **G3-02**: Locked order — fetchTicketInfo → renderPdf → (create? createCase : use case_number) → if created: setTicketCustomField + stamp last_status → postToCase → stamp last_status=OK + last_export
- [ ] **G3-03**: 7 outcome codes — `documented | create_failed | orphan_case | validation | auth | brand_mismatch | gopro_create_unsupported`
- [ ] **G3-04**: Wired into BOTH `src/index.ts` and `src/worker.ts`
- [ ] **G3-05**: New `tests/cases.test.ts` covering each outcome + locked-ordering assertions; `npm run build` green

## v2 Requirements

(Cross-repo app-side work — owned by the `malaskra_v3` milestone, not this one)

- **A1**: Gateway client `createCase` in app + `src/types/gateway.ts` SHA-bump to local gateway HEAD covering G1–G3
- **A2**: Switch OneSystems manual path to `createCase`

## Out of Scope

| Feature | Reason |
|---------|--------|
| Gateway folder reshuffle + shared dispatch | Parked — not needed for this milestone |
| Automatic create-on-webhook | Parked — manual path only |
| GoPro case creation | No GoPro createCase capability → `gopro_create_unsupported` |
| `last_status` history | Parked |
| Moving OneSystems fetch into the gateway | Parked |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| G1-01..G1-04 | Phase 1 | Pending |
| G2-01..G2-04 | Phase 2 | Pending |
| G3-01..G3-05 | Phase 3 | Pending |
