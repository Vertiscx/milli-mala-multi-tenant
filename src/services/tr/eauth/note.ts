/**
 * Text of the internal note written when an attempt ends.
 * Icelandic; masked targets only. Exact wording to be confirmed with TR.
 */

import { maskKennitala } from '../shared/kennitala.js'
import type { FailReason } from './mapper.js'

export type TerminalStatus = 'verified' | 'failed' | 'cancelled' | 'expired'

const STATUS_TEXT: Record<TerminalStatus, string> = {
  verified: 'Staðfest',
  failed: 'Ekki staðfest',
  cancelled: 'Hætt við',
  expired: 'Rann út á tíma'
}

const REASON_TEXT: Record<FailReason, string> = {
  declined: 'Auðkenningu hafnað eða ekki lokið',
  timeout: 'Ekkert svar barst innan tímamarka',
  error: 'Villa í samskiptum við TR',
  mismatch: 'Kennitala í svari passar ekki við þá sem sent var á'
}

export interface NoteInput {
  status: TerminalStatus
  reason?: FailReason
  targetMasked: string
  nationalId?: string
  agentEmail: string
  attemptId: string
  endedAt: Date
}

// Reykjavík is UTC year-round.
function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} kl. ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export function buildNote(n: NoteInput): string {
  const lines = [
    'Auðkenning með rafrænum skilríkjum (TR)',
    `Niðurstaða: ${STATUS_TEXT[n.status]}`
  ]
  if (n.status === 'failed' && n.reason) lines.push(`Ástæða: ${REASON_TEXT[n.reason]}`)
  lines.push(`Sent á: ${n.targetMasked}`)
  if (n.status === 'verified' && n.nationalId) lines.push(`Staðfest kennitala: ${maskKennitala(n.nationalId)}`)
  lines.push(
    `Starfsmaður: ${n.agentEmail}`,
    `Tími: ${formatTime(n.endedAt)}`,
    `Auðkenni: ${n.attemptId}`,
    '',
    'Skráð sjálfvirkt af Milli-mála.'
  )
  return lines.join('\n')
}
