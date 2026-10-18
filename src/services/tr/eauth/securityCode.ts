/**
 * 4-digit security code shown to the agent and sent to TR, generated on
 * the gateway (moved from tr-smari/src/securityCode.ts, where the browser
 * made it). crypto.randomInt is uniform, so no rejection sampling needed.
 */

import { createHash, randomInt } from 'node:crypto'
import type { TrEauthConfig } from '../../../platform/types.js'

export function generateSecurityCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0')
}

// TR's request has both securityCode and hashValue; their exact meaning is
// pending confirmation from TR, so the derivation is a per-tenant setting.
export function deriveHashValue(code: string, mode: TrEauthConfig['hashValueMode']): string {
  return mode === 'sha256' ? createHash('sha256').update(code).digest('hex') : code
}
