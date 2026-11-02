/**
 * The single seam for calls to TR's Huld API. Phase 3 (X-road) replaces
 * the transport here and nothing else.
 *
 * Never throws for upstream trouble: every outcome comes back as a
 * HuldResult so callers can map it to a fixed answer. Response bodies are
 * never logged — they carry personal data.
 */

import { createLogger } from '../../../platform/logger.js'
import type { Logger, TrServiceConfig } from '../../../platform/types.js'
import { clearTrToken, getTrAccessToken } from './trAuth0.js'

const logger: Logger = createLogger('tr.huld')

export type HuldResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; kind: 'http'; status: number; data: unknown }
  | { ok: false; kind: 'timeout' | 'aborted' | 'network' | 'auth' }

export interface HuldCallOptions {
  timeoutMs: number
  // e-ID must stay false: a resend would push a second request to the
  // citizen's phone.
  retryOn401: boolean
  // Lets e-auth abort an in-flight e-ID call when the agent cancels.
  signal?: AbortSignal
}

export async function postHuld(
  brandId: string,
  tr: Pick<TrServiceConfig, 'huld' | 'auth0'>,
  path: string,
  body: unknown,
  opts: HuldCallOptions
): Promise<HuldResult> {
  let token: string
  try {
    token = await getTrAccessToken(brandId, tr.auth0)
  } catch {
    return { ok: false, kind: 'auth' }
  }

  // Cancelled while the token was being fetched: never reach Huld (for
  // e-ID that would push to the citizen's phone after "Hætta við").
  if (opts.signal?.aborted) return { ok: false, kind: 'aborted' }

  // A plain timer rather than AbortSignal.timeout: its timer is unref'd and
  // the e-ID wait (up to minutes) must not depend on that.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, opts.timeoutMs)
  const onCancel = () => controller.abort()
  opts.signal?.addEventListener('abort', onCancel, { once: true })

  let response: Response
  try {
    response = await fetch(`${tr.huld.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch {
    if (opts.signal?.aborted) return { ok: false, kind: 'aborted' }
    if (timedOut) return { ok: false, kind: 'timeout' }
    logger.warn('Huld request failed', { brand_id: brandId, path })
    return { ok: false, kind: 'network' }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onCancel)
  }

  if (response.status === 401) {
    // A token can be revoked or expire early; drop it for the next call.
    clearTrToken(brandId)
    if (opts.retryOn401) return postHuld(brandId, tr, path, body, { ...opts, retryOn401: false })
  }

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    logger.warn('Huld returned an error status', { brand_id: brandId, path, status: response.status })
    return { ok: false, kind: 'http', status: response.status, data }
  }
  return { ok: true, status: response.status, data }
}
