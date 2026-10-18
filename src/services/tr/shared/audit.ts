/**
 * Metadata-only audit for TR services. Targets are masked
 * before they get here; tokens, security codes and hash values never do.
 * Same key layout and 90-day TTL as the archive audit, so /v1/audit can
 * list TR entries by brand and by ticket.
 */

import { createLogger } from '../../../platform/logger.js'
import type { AuditStore, Logger } from '../../../platform/types.js'

const logger: Logger = createLogger('tr.audit')

const AUDIT_TTL_SECONDS = 90 * 24 * 60 * 60

export interface TrAuditEntry {
  service: 'tr.smari' | 'tr.eauth'
  brand_id: string
  ticket_id: string | null
  agent_email: string
  target_masked: string
  outcome: string
  duration_ms: number
  attempt_id?: string
  note_written?: boolean
}

export async function writeTrAudit(auditStore: AuditStore | undefined, entry: TrAuditEntry): Promise<void> {
  const record = { timestamp: new Date().toISOString(), ...entry }
  logger.info('AUDIT', record as unknown as Record<string, unknown>)
  if (!auditStore) return
  const ts = record.timestamp.replace(/[:.]/g, '-')
  const ticket = entry.ticket_id ?? 'none'
  try {
    await auditStore.put(`audit:${entry.brand_id}:${ts}:${ticket}`, JSON.stringify(record), { expirationTtl: AUDIT_TTL_SECONDS })
    if (entry.ticket_id) {
      await auditStore.put(`ticket:${entry.brand_id}:${entry.ticket_id}:${ts}`, JSON.stringify(record), { expirationTtl: AUDIT_TTL_SECONDS })
    }
  } catch (err) {
    logger.warn('Failed to persist TR audit entry', { brand_id: entry.brand_id, error: (err as Error).message })
  }
}
