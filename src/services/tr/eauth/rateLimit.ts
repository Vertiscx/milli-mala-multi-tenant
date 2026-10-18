/**
 * In-memory sliding-window rate limit for e-ID pushes, per agent and per
 * target. Like the attempts themselves, valid while the gateway runs as
 * one task.
 */

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>()

  /** True when one more hit fits in the window; does not record it. */
  allows(key: string, max: number, windowMs: number, now: number = Date.now()): boolean {
    return this.recent(key, windowMs, now).length < max
  }

  record(key: string, now: number = Date.now()): void {
    const list = this.hits.get(key) ?? []
    list.push(now)
    this.hits.set(key, list)
  }

  /** Drop keys with no hits inside `maxWindowMs`. */
  prune(maxWindowMs: number, now: number = Date.now()): void {
    for (const [key, list] of this.hits) {
      const kept = list.filter(t => now - t < maxWindowMs)
      if (kept.length === 0) this.hits.delete(key)
      else this.hits.set(key, kept)
    }
  }

  clear(): void {
    this.hits.clear()
  }

  private recent(key: string, windowMs: number, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter(t => now - t < windowMs)
    if (list.length) this.hits.set(key, list)
    else this.hits.delete(key)
    return list
  }
}
