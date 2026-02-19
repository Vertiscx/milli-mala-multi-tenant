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
