/**
 * In-memory e-ID attempts and their state machine.
 *
 * pending → verified | failed | cancelled | expired, exactly once: the
 * first terminal transition wins and later ones (a late TR answer after
 * cancel, a timer after verify) are ignored. Each terminal transition
 * aborts any in-flight TR call and fires `onFinish` once, which writes the
 * internal note and the audit entry.
 *
 * Valid while the gateway runs as one ECS task. A restart drops pending
 * attempts; the app then sees `expired` and the agent starts again.
 */

import { randomBytes } from 'node:crypto'
import type { AuditStore, TrEauthConfig } from '../../../platform/types.js'
import type { FailReason } from './mapper.js'
import type { TerminalStatus } from './note.js'

export type AttemptStatus = 'pending' | TerminalStatus
export type NoteState = 'none' | 'pending' | 'written' | 'failed'

export interface Attempt {
  id: string
  brandId: string
  subdomain: string
  ticketId: string
  agentEmail: string
  targetMasked: string
  status: AttemptStatus
  reason?: FailReason
  nationalId?: string
  createdAt: number
  expiresAt: number
  endedAt?: number
  note: NoteState
  abort: AbortController
  expiryTimer?: ReturnType<typeof setTimeout>
  // What onFinish needs to write the note and the audit entry.
  zendeskOAuth: TrEauthConfig['zendeskOAuth']
  auditStore?: AuditStore
}

/** What onFinish receives: an attempt that has just reached its final state. */
export type FinishedAttempt = Attempt & { status: TerminalStatus; endedAt: number }

export interface Finish {
  status: TerminalStatus
  reason?: FailReason
  nationalId?: string
}

// Terminal attempts stay readable this long after they expire, so a slow
// poll still sees the outcome.
const RETAIN_AFTER_EXPIRY_MS = 10 * 60_000
// Hard memory bound. Finished attempts are evicted (oldest first) to make
// room, so only pending attempts can fill it — and those are capped per
// agent and last at most attemptTtlSeconds, so one agent can't lock
// everyone else out.
export const MAX_ATTEMPTS = 5_000
export const MAX_PENDING_PER_AGENT = 3

export class AttemptStore {
  private attempts = new Map<string, Attempt>()

  constructor(private onFinish: (attempt: FinishedAttempt) => void) {}

  get size(): number {
    return this.attempts.size
  }

  /** Pending attempts this agent has open on this brand. */
  pendingFor(brandId: string, agentEmail: string): number {
    let n = 0
    for (const a of this.attempts.values()) {
      if (a.status === 'pending' && a.brandId === brandId && a.agentEmail === agentEmail) n++
    }
    return n
  }

  /** Returns null only when the store is full of pending attempts. */
  create(input: Omit<Attempt, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'note' | 'abort'>, ttlMs: number, now = Date.now()): Attempt | null {
    if (this.attempts.size >= MAX_ATTEMPTS) this.sweep(now)
    if (this.attempts.size >= MAX_ATTEMPTS) this.evictFinished()
    if (this.attempts.size >= MAX_ATTEMPTS) return null

    const attempt: Attempt = {
      ...input,
      id: randomBytes(16).toString('base64url'), // 128-bit, unguessable
      status: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
      note: 'none',
      abort: new AbortController()
    }
    attempt.expiryTimer = setTimeout(() => this.finish(attempt.id, { status: 'expired' }), ttlMs)
    attempt.expiryTimer.unref?.()
    this.attempts.set(attempt.id, attempt)
    return attempt
  }

  get(id: string): Attempt | undefined {
    return this.attempts.get(id)
  }

  /** First terminal transition wins. Returns whether this call won. */
  finish(id: string, outcome: Finish, now = Date.now()): boolean {
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.status !== 'pending') return false
    attempt.status = outcome.status
    attempt.reason = outcome.reason
    attempt.nationalId = outcome.status === 'verified' ? outcome.nationalId : undefined
    attempt.endedAt = now
    clearTimeout(attempt.expiryTimer)
    attempt.abort.abort()
    this.onFinish(attempt as FinishedAttempt)
    return true
  }

  /** Drop terminal attempts past their retention, and any stale pending ones. */
  sweep(now = Date.now()): void {
    for (const [id, a] of this.attempts) {
      if (now > a.expiresAt + RETAIN_AFTER_EXPIRY_MS) {
        clearTimeout(a.expiryTimer)
        this.attempts.delete(id)
      }
    }
  }

  /** Make room by dropping the oldest finished attempt. */
  private evictFinished(): void {
    let oldest: Attempt | undefined
    for (const a of this.attempts.values()) {
      if (a.status !== 'pending' && (!oldest || (a.endedAt ?? 0) < (oldest.endedAt ?? 0))) oldest = a
    }
    if (oldest) this.attempts.delete(oldest.id)
  }

  clear(): void {
    for (const a of this.attempts.values()) {
      clearTimeout(a.expiryTimer)
      a.abort.abort()
    }
    this.attempts.clear()
  }
}
