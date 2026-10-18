/**
 * Per-key fixed-window rate limiter, held in memory.
 *
 * State is per process (Node) or per isolate (Workers), so with N running
 * instances a key can make up to N × limit requests per window. The
 * RateLimiter interface is the seam for a shared store (Redis, Durable
 * Object) if that ever matters. Only authenticated key IDs are tracked, so
 * the map is bounded by the number of configured keys.
 */

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

export interface RateLimiter {
  consume(keyId: string): RateLimitResult
}

interface Window {
  start: number
  count: number
}

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  consume(keyId: string): RateLimitResult {
    const now = this.now()
    let window = this.windows.get(keyId)
    if (!window || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 }
      this.windows.set(keyId, window)
    }
    if (window.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((window.start + this.windowMs - now) / 1000) }
    }
    window.count++
    return { allowed: true, retryAfterSeconds: 0 }
  }
}
