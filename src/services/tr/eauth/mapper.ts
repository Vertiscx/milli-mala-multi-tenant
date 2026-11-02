/**
 * Huld e-ID result → one fixed outcome. The fail-closed rule lives here
 * and only here (moved from tr-smari's mapper.ts and EidPanel.tsx).
 *
 * verified only when ALL hold:
 *  - Huld answered 2xx with an explicit success flag (true / "true"),
 *  - the reply carries a valid kennitala,
 *  - when the push went to a kennitala, the reply's kennitala is that one.
 * Everything else — declines, errors, timeouts, malformed or ambiguous
 * replies — is failed.
 *
 * TR has not yet sent real response samples: the accepted key spellings
 * match what the TR Smári app assumed. Update this file and its
 * tests when TR's samples arrive.
 */

import type { HuldResult } from '../shared/huldClient.js'
import { isValidKennitala, normalizeKennitala, type EidTarget } from '../shared/kennitala.js'

export type FailReason = 'declined' | 'timeout' | 'error' | 'mismatch'

export type EidOutcome =
  | { status: 'verified'; nationalId: string }
  | { status: 'failed'; reason: FailReason }

type Raw = Record<string, unknown>

function pick(obj: Raw, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  }
  return undefined
}

function unwrap(raw: unknown): Raw | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Raw
  const inner = pick(obj, ['data', 'result'])
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Raw) : obj
}

// A rejected or declined authentication is likely a 4xx client error;
// that is a failed verification, not a transport error.
const DECLINE_STATUSES = new Set([400, 409, 422])

export function mapEidOutcome(result: HuldResult, target: EidTarget): EidOutcome {
  if (!result.ok) {
    if (result.kind === 'timeout') return { status: 'failed', reason: 'timeout' }
    if (result.kind === 'http' && DECLINE_STATUSES.has(result.status)) return { status: 'failed', reason: 'declined' }
    return { status: 'failed', reason: 'error' }
  }

  const r = unwrap(result.data)
  if (!r) return { status: 'failed', reason: 'error' }

  const flag = pick(r, ['success', 'verified', 'authenticated', 'isAuthenticated', 'tokst'])
  if (flag !== true && flag !== 'true') return { status: 'failed', reason: 'declined' }

  const rawId = pick(r, ['nationalId', 'kennitala', 'verifiedNationalId', 'ssn'])
  const nationalId = typeof rawId === 'string' || typeof rawId === 'number' ? normalizeKennitala(String(rawId)) : null
  if (!nationalId || !isValidKennitala(nationalId)) return { status: 'failed', reason: 'error' }

  if (target.kind === 'kennitala' && nationalId !== target.value) return { status: 'failed', reason: 'mismatch' }
  return { status: 'verified', nationalId }
}
