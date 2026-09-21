/**
 * Health-check body.
 *
 * Kept in `platform/` rather than in the entry point so it can be imported
 * and tested without starting a server, and because what "healthy" means is
 * a platform concern, not an archive one.
 */

import type { TenantLoadFailure } from './types.js'

/**
 * Health check. Still 200 when tenants were skipped — the container is
 * serving the ones that loaded, and taking it out of the load balancer would
 * turn a partial outage into a total one. The `status` field is what says
 * whether anything is wrong, and `tenants.failed` gives monitoring a number
 * to alert on.
 *
 * The endpoint is unauthenticated, so the public body carries counts only.
 * Which tenant failed and why names institutions and environment variables,
 * so that detail is behind the same bearer token as the audit log.
 */
export function buildHealthBody(
  failures: TenantLoadFailure[],
  loadedTenants: number,
  includeDetail: boolean
): Record<string, unknown> {
  return {
    status: failures.length === 0 ? 'ok' : 'degraded',
    service: 'milli-mala',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    tenants: {
      loaded: loadedTenants,
      failed: failures.length,
      ...(includeDetail && failures.length > 0 ? { failures } : {}),
    },
  }
}
