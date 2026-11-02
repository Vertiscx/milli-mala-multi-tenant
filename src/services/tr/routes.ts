import type { ServiceRoute } from '../../platform/http/routes.js'
import { smariRoutes } from './smari/routes.js'
import { eauthRoutes } from './eauth/routes.js'

// TR's services. Each route checks for itself that its sub-service is
// switched on for the tenant, so listing them here is safe for every brand.
export const trRoutes: ServiceRoute[] = [...smariRoutes, ...eauthRoutes]
