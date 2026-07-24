/**
 * Shared outbound-HTTP seam. Every external call (Zendesk, OneSystems,
 * GoPro) goes through fetchWithTimeout so a hung upstream cannot pin a
 * request forever — without a timeout, Zendesk's webhook timeout fires
 * and retries while the original upload is still hanging, stacking
 * concurrent in-flight requests.
 */

/** Default timeout for all outbound HTTP calls. */
export const REQUEST_TIMEOUT_MS = 30_000

export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
}
