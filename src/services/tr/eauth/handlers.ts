/**
 * TR e-auth: the agent asks TR to push an e-ID request ("rafræn
 * skilríki") to a citizen's phone and sees whether it was confirmed.
 *
 *   POST /v1/tr/eauth/attempts  { brand_id, ticket_id, phoneNumberOrNationalId }
 *        → { attemptId, securityCode, expiresAt }
 *   POST /v1/tr/eauth/status    { brand_id, attemptId } → attempt view
 *   POST /v1/tr/eauth/cancel    { brand_id, attemptId } → attempt view
 *
 * Start-then-poll because the agent must see the code before TR answers,
 * and a 60–120 s request would likely hit the load balancer's idle
 * timeout. TR's call is made exactly once per attempt and never retried
 * (a resend would push a second request to the citizen's phone).
 *
 * Attempts are bound to the agent who started them and to the brand. Any
 * other caller gets `expired`, so an attempt ID is never confirmed to
 * exist.
 */

import { createLogger } from '../../../platform/logger.js'
import type { GatewayRequest } from '../../../platform/http/routes.js'
import type { HandlerResult, Logger } from '../../../platform/types.js'
import { authenticateTrRequest, isTrContext, parseTicketId, type TrContext } from '../shared/request.js'
import { maskTarget, parseEidTarget } from '../shared/kennitala.js'
import { postHuld } from '../shared/huldClient.js'
import { writeTrAudit } from '../shared/audit.js'
import { AttemptStore, MAX_PENDING_PER_AGENT, type Attempt, type FinishedAttempt } from './attempts.js'
import { SlidingWindowLimiter } from './rateLimit.js'
import { deriveHashValue, generateSecurityCode } from './securityCode.js'
import { mapEidOutcome } from './mapper.js'
import { checkTicketBrand, writeInternalNote } from './zendesk.js'
import { buildNote } from './note.js'

const logger: Logger = createLogger('tr.eauth')

const EID_PATH = '/authentication/rafraen-skilriki'

const limiter = new SlidingWindowLimiter()
const store = new AttemptStore(onFinish)
// In-flight background work (TR calls, then notes and audits); lets
// tests wait for it to settle.
const settling = new Set<Promise<void>>()

/** Test seam: drop all attempts and rate-limit history. */
export function resetEauthState(): void {
  store.clear()
  limiter.clear()
  settling.clear()
}

/** Test seam: wait for background TR calls, notes and audits to finish. */
export async function settleEauth(): Promise<void> {
  while (settling.size) await Promise.all([...settling])
}

function track(work: Promise<void>): void {
  settling.add(work)
  void work.finally(() => settling.delete(work))
}

function onFinish(attempt: FinishedAttempt): void {
  const { status, endedAt } = attempt
  track((async () => {
    attempt.note = 'pending'
    const body = buildNote({
      status,
      reason: attempt.reason,
      targetMasked: attempt.targetMasked,
      nationalId: attempt.nationalId,
      agentEmail: attempt.agentEmail,
      attemptId: attempt.id,
      endedAt: new Date(endedAt)
    })
    const written = await writeInternalNote(attempt.brandId, attempt.subdomain, attempt.zendeskOAuth, attempt.ticketId, body)
    attempt.note = written ? 'written' : 'failed'
    await writeTrAudit(attempt.auditStore, {
      service: 'tr.eauth',
      brand_id: attempt.brandId,
      ticket_id: attempt.ticketId,
      agent_email: attempt.agentEmail,
      target_masked: attempt.targetMasked,
      outcome: attempt.reason ? `${status}:${attempt.reason}` : status,
      duration_ms: endedAt - attempt.createdAt,
      attempt_id: attempt.id,
      note_written: written
    })
  })().catch(err => {
    logger.error('e-auth finish work failed', { brand_id: attempt.brandId, error: (err as Error).message })
  }))
}

function view(a: Attempt): Record<string, unknown> {
  return {
    status: a.status,
    ...(a.status === 'verified' ? { nationalId: a.nationalId } : {}),
    ...(a.reason ? { reason: a.reason } : {}),
    note: a.note,
    expiresAt: new Date(a.expiresAt).toISOString()
  }
}

/** The caller's own attempt, or undefined (reported as expired). */
function ownAttempt(req: GatewayRequest, ctx: TrContext): Attempt | undefined {
  const id = req.body.attemptId
  if (typeof id !== 'string' || id.length > 64) return undefined
  const a = store.get(id)
  return a && a.brandId === ctx.brandId && a.agentEmail === ctx.agent.email ? a : undefined
}

const EXPIRED: HandlerResult = { status: 200, body: { status: 'expired', note: 'none' } }

export async function handleStartAttempt(req: GatewayRequest): Promise<HandlerResult> {
  const ctx = await authenticateTrRequest(req, 'eauth')
  if (!isTrContext(ctx)) return ctx
  const eauth = ctx.tr.eauth!

  const ticketId = parseTicketId(req.body.ticket_id)
  if (!ticketId) return { status: 400, body: { outcome: 'invalid_ticket' } }
  const rawTarget = req.body.phoneNumberOrNationalId
  const target = typeof rawTarget === 'string' ? parseEidTarget(rawTarget) : null
  if (!target) return { status: 400, body: { outcome: 'invalid_target' } }

  const now = Date.now()
  const { perAgent, perTarget } = eauth.rateLimits
  const agentKey = `${ctx.brandId}:agent:${ctx.agent.email}`
  const targetKey = `${ctx.brandId}:target:${target.value}`
  limiter.prune(Math.max(perAgent.windowSeconds, perTarget.windowSeconds) * 1000, now)
  if (store.pendingFor(ctx.brandId, ctx.agent.email) >= MAX_PENDING_PER_AGENT ||
      !limiter.allows(agentKey, perAgent.max, perAgent.windowSeconds * 1000, now) ||
      !limiter.allows(targetKey, perTarget.max, perTarget.windowSeconds * 1000, now)) {
    logger.warn('e-auth rate limited', { brand_id: ctx.brandId, agent: ctx.agent.email, target: maskTarget(target) })
    return { status: 429, body: { outcome: 'rate_limited' } }
  }
  // Counted before the first await, so parallel requests can't all pass
  // the check before any of them is recorded. A start that later fails
  // (wrong brand, Zendesk down) still counts, which also caps how many
  // ticket lookups one agent can trigger.
  limiter.record(agentKey, now)
  limiter.record(targetKey, now)

  const subdomain = req.tenantConfig.zendesk.subdomain
  const ticketCheck = await checkTicketBrand(ctx.brandId, subdomain, eauth.zendeskOAuth, ticketId)
  if (ticketCheck === 'brand_mismatch') return { status: 400, body: { outcome: 'brand_mismatch' } }
  if (ticketCheck === 'error') return { status: 502, body: { outcome: 'error' } }

  const attempt = store.create({
    brandId: ctx.brandId,
    subdomain,
    ticketId,
    agentEmail: ctx.agent.email,
    targetMasked: maskTarget(target),
    zendeskOAuth: eauth.zendeskOAuth,
    auditStore: req.auditStore
  }, eauth.attemptTtlSeconds * 1000, now)
  if (!attempt) {
    logger.error('e-auth attempt store full', { brand_id: ctx.brandId })
    return { status: 503, body: { outcome: 'error' } }
  }

  const securityCode = generateSecurityCode()
  const hashValue = deriveHashValue(securityCode, eauth.hashValueMode)

  // Background: the response returns now with the code; the outcome lands
  // on the attempt when TR answers (or the attempt is cancelled/expires).
  track(postHuld(ctx.brandId, ctx.tr, EID_PATH,
    { phoneNumberOrNationalId: target.value, securityCode, hashValue },
    { timeoutMs: eauth.timeoutSeconds * 1000, retryOn401: false, signal: attempt.abort.signal })
    .then(result => {
      if (!result.ok && result.kind === 'aborted') return // cancelled or expired first
      store.finish(attempt.id, mapEidOutcome(result, target))
    })
    .catch(err => {
      logger.error('e-auth background call failed', { brand_id: ctx.brandId, error: (err as Error).message })
      store.finish(attempt.id, { status: 'failed', reason: 'error' })
    }))

  logger.info('e-auth attempt started', { brand_id: ctx.brandId, ticket_id: ticketId, target: attempt.targetMasked })
  return {
    status: 200,
    body: { attemptId: attempt.id, securityCode, expiresAt: new Date(attempt.expiresAt).toISOString() }
  }
}

export async function handleAttemptStatus(req: GatewayRequest): Promise<HandlerResult> {
  const ctx = await authenticateTrRequest(req, 'eauth')
  if (!isTrContext(ctx)) return ctx
  const attempt = ownAttempt(req, ctx)
  return attempt ? { status: 200, body: view(attempt) } : EXPIRED
}

export async function handleCancelAttempt(req: GatewayRequest): Promise<HandlerResult> {
  const ctx = await authenticateTrRequest(req, 'eauth')
  if (!isTrContext(ctx)) return ctx
  const attempt = ownAttempt(req, ctx)
  if (!attempt) return EXPIRED
  store.finish(attempt.id, { status: 'cancelled' })
  return { status: 200, body: view(attempt) }
}
