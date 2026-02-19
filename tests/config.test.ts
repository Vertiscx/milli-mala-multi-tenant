import { describe, it, expect, beforeEach } from 'vitest'
import { getConfig, resetConfig } from '../src/config.js'

describe('Config Module', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    resetConfig()
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
  })

  describe('getConfig', () => {
    it('should parse PORT as integer', () => {
      process.env.PORT = '3000'
      const config = getConfig()
      expect(config.service.port).toBe(3000)
    })

    it('should default PORT to 8080', () => {
      const config = getConfig()
      expect(config.service.port).toBe(8080)
    })

    it('should read LOG_LEVEL', () => {
      process.env.LOG_LEVEL = 'debug'
      const config = getConfig()
      expect(config.service.logLevel).toBe('debug')
    })

    it('should default LOG_LEVEL to info', () => {
      const config = getConfig()
      expect(config.service.logLevel).toBe('info')
    })

    it('should read AUDIT_SECRET', () => {
      process.env.AUDIT_SECRET = 'my-secret'
      const config = getConfig()
      expect(config.auditSecret).toBe('my-secret')
    })

    it('should default AUDIT_SECRET to empty string', () => {
      const config = getConfig()
      expect(config.auditSecret).toBe('')
    })

    it('should accept an env parameter to override process.env', () => {
      const env = {
        PORT: '9090',
        LOG_LEVEL: 'warn',
        AUDIT_SECRET: 'env-secret'
      }
      const config = getConfig(env)
      expect(config.service.port).toBe(9090)
      expect(config.service.logLevel).toBe('warn')
      expect(config.auditSecret).toBe('env-secret')
    })

    it('should cache config on subsequent calls', () => {
      process.env.PORT = '3000'
      const config1 = getConfig()

      process.env.PORT = '4000'
      const config2 = getConfig()

      expect(config1).toBe(config2)
      expect(config2.service.port).toBe(3000)
    })

    it('should return fresh config after resetConfig', () => {
      process.env.PORT = '3000'
      getConfig()

      resetConfig()
      process.env.PORT = '4000'
      const config = getConfig()

      expect(config.service.port).toBe(4000)
    })
  })
})
