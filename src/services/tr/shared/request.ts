/**
 * The gate every TR route passes first: tenant has a TR section, the
 * sidebar app's X-Api-Key matches, and the agent is identified.
 *
 * resolveAgent is the one place agent identity comes from, so another
 * way of identifying the agent can replace it without changes in the
 * services.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { GatewayRequest } from '../../../platform/http/routes.js'
import type { HandlerResult, TrServiceConfig } from '../../../platform/types.js'
import { verifyAgentToken, type VerifiedAgent } from './agentAuth.js'

export const AGENT_TOKEN_HEADER = 'x-agent-token'

export interface TrContext {
  brandId: string
  tr: TrServiceConfig
  agent: VerifiedAgent
}

// Same check as the archive service's Málaskrá key (SHA-256, then a
// constant-time compare), duplicated rather than imported: services
// don't import each other.
function verifyApiKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export async function resolveAgent(req: GatewayRequest, tr: TrServiceConfig): Promise<VerifiedAgent | null> {
  return verifyAgentToken(req.headers[AGENT_TOKEN_HEADER], tr.agentAuth)
}

const INVALID: HandlerResult = { status: 400, body: { error: 'Invalid request' } }
const UNAUTHORIZED: HandlerResult = { status: 401, body: { error: 'Unauthorized' } }

/**
 * Returns the request's TR context, or the response to send instead.
 * `service` is the sub-service the route belongs to; a tenant without it
 * switched on gets the same neutral 400 as an unknown brand.
 */
export async function authenticateTrRequest(
  req: GatewayRequest,
  service: 'smari'
): Promise<TrContext | HandlerResult> {
  const tr = req.tenantConfig.services.tr
  if (!tr || !tr[service]) return INVALID
  if (!verifyApiKey(req.headers['x-api-key'], tr.apiKey)) return UNAUTHORIZED
  const agent = await resolveAgent(req, tr)
  if (!agent) return UNAUTHORIZED
  return { brandId: req.tenantConfig.brand_id, tr, agent }
}

/** A Zendesk ticket ID from a request body (number or digit string), or null. */
export function parseTicketId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value
  return null
}

export function isTrContext(value: TrContext | HandlerResult): value is TrContext {
  return 'agent' in value
}
