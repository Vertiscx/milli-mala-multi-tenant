import { describe, it, expect } from 'vitest'
import { requireEnv } from '../src/env.js'

describe('requireEnv', () => {
  it('returns the value when the variable is set', () => {
    expect(requireEnv('FOO', { FOO: 'bar' })).toBe('bar')
  })

  it('throws when the variable is undefined', () => {
    expect(() => requireEnv('MISSING', {})).toThrow('Missing required environment variable: MISSING')
  })

  it('throws when the variable is an empty string', () => {
    expect(() => requireEnv('FOO', { FOO: '' })).toThrow('Missing required environment variable: FOO')
  })

  it('includes the variable name in the error message', () => {
    expect(() => requireEnv('ZENDESK_API_TOKEN', {})).toThrow('ZENDESK_API_TOKEN')
  })

  it('reads from process.env by default', () => {
    process.env.__TEST_REQUIRE_ENV__ = 'present'
    try {
      expect(requireEnv('__TEST_REQUIRE_ENV__')).toBe('present')
    } finally {
      delete process.env.__TEST_REQUIRE_ENV__
    }
  })
})
