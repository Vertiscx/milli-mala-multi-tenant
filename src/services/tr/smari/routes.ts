import type { ServiceRoute } from '../../../platform/http/routes.js'
import { handleClientLookup } from './clientLookup.js'

export const smariRoutes: ServiceRoute[] = [
  { method: 'POST', path: '/v1/tr/smari/clientlookup', handler: handleClientLookup },
]
