/**
 * POST /v1/tr/smari/clientlookup — TR customer card for a kennitala.
 *
 * Body: { brand_id, nationalId, ticket_id? }. ticket_id is recorded in
 * the audit only; a read-only lookup needs no ticket check.
 * employeeEmail sent to TR is always the verified agent's, never from the
 * body.
 *
 * Returns { outcome: 'found', customer } | { outcome: 'not_found' } |
 * { outcome: 'invalid_national_id' } (400) | { outcome: 'error' } (502).
 */

import type { GatewayRequest } from '../../../platform/http/routes.js'
import type { HandlerResult } from '../../../platform/types.js'
import { authenticateTrRequest, isTrContext, parseTicketId } from '../shared/request.js'
import { isValidKennitala, maskKennitala, normalizeKennitala } from '../shared/kennitala.js'
import { postHuld } from '../shared/huldClient.js'
import { writeTrAudit } from '../shared/audit.js'
import { mapClientLookup } from './mapper.js'

const LOOKUP_TIMEOUT_MS = 20_000

export async function handleClientLookup(req: GatewayRequest): Promise<HandlerResult> {
  const ctx = await authenticateTrRequest(req, 'smari')
  if (!isTrContext(ctx)) return ctx

  const started = Date.now()
  const raw = req.body.nationalId
  if (typeof raw !== 'string' || !isValidKennitala(raw)) {
    return { status: 400, body: { outcome: 'invalid_national_id' } }
  }
  const nationalId = normalizeKennitala(raw)
  const ticketId = parseTicketId(req.body.ticket_id)

  const result = await postHuld(ctx.brandId, ctx.tr, '/clientlookup',
    { nationalId, employeeEmail: ctx.agent.email },
    { timeoutMs: LOOKUP_TIMEOUT_MS, retryOn401: true })

  let response: HandlerResult
  if (result.ok) {
    const customer = mapClientLookup(result.data)
    response = customer
      ? { status: 200, body: { outcome: 'found', customer } }
      : { status: 200, body: { outcome: 'not_found' } }
  } else if (result.kind === 'http' && result.status === 404) {
    response = { status: 200, body: { outcome: 'not_found' } }
  } else {
    response = { status: 502, body: { outcome: 'error' } }
  }

  await writeTrAudit(req.auditStore, {
    service: 'tr.smari',
    brand_id: ctx.brandId,
    ticket_id: ticketId,
    agent_email: ctx.agent.email,
    target_masked: maskKennitala(nationalId),
    outcome: String(response.body.outcome),
    duration_ms: Date.now() - started
  })
  return response
}
