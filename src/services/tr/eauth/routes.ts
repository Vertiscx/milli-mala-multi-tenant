import type { ServiceRoute } from '../../../platform/http/routes.js'
import { handleAttemptStatus, handleCancelAttempt, handleStartAttempt } from './handlers.js'

// All POST: the platform route table is POST-only, so status takes its
// attemptId in the body too.
export const eauthRoutes: ServiceRoute[] = [
  { method: 'POST', path: '/v1/tr/eauth/attempts', handler: handleStartAttempt },
  { method: 'POST', path: '/v1/tr/eauth/status', handler: handleAttemptStatus },
  { method: 'POST', path: '/v1/tr/eauth/cancel', handler: handleCancelAttempt },
]
