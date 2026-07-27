/**
 * Simple structured logger for Google Cloud Functions and Docker
 */

import { getConfig } from './config.js'
import type { Logger } from './types.js'

const LOG_LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function createLogger(component: string): Logger {
  const config = getConfig()
  const minLevel = LOG_LEVELS[config.service.logLevel] || LOG_LEVELS.info

  const log = (level: string, message: string, data: Record<string, unknown> = {}): void => {
    if (LOG_LEVELS[level] < minLevel) return

    const entry = {
      severity: level.toUpperCase(),
      component,
      message,
      timestamp: new Date().toISOString(),
      ...data
    }

    // Google Cloud Functions expects JSON logs on stdout
    console.log(JSON.stringify(entry))
  }

  return {
    debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data)
  }
}

/**
 * Cap upstream response bodies before they enter log lines or Error
 * messages — doc systems can return multi-KB HTML error pages, and
 * successful responses may carry case metadata that has no business
 * being persisted unbounded in logs.
 */
const BODY_LOG_CAP = 2048
export function capBody(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > BODY_LOG_CAP
    ? `${s.slice(0, BODY_LOG_CAP)}… [truncated ${s.length - BODY_LOG_CAP} chars]`
    : s ?? ''
}
