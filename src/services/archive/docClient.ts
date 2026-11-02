/**
 * Shared factory for document system clients.
 * Used by both webhook and attachments handlers.
 */

import { OneSystemsClient } from './onesystems.js'
import { GoProClient } from './gopro.js'
import type { EndpointConfig } from '../../platform/types.js'
import type { DocClient } from './types.js'

/**
 * Build a DocClient from an EndpointConfig.
 * Throws if required credentials are missing for the endpoint type.
 */
export function createDocClient(ep: EndpointConfig, user?: string): DocClient {
  if (ep.type === 'gopro') {
    if (!ep.apiKey) {
      throw new Error('GoPro endpoint missing apiKey')
    }
    return new GoProClient(ep.baseUrl, ep.apiKey, {
      tokenTtlMs: ep.tokenTtlMs,
      origin: ep.origin
    })
  }
  if (!ep.appKey) {
    throw new Error('OneSystems endpoint missing appKey')
  }
  return new OneSystemsClient(ep.baseUrl, ep.appKey, {
    tokenTtlMs: ep.tokenTtlMs,
    user: user || 'Zendesk'
  })
}
