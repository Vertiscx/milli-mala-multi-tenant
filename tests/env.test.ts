import { describe, it, expect } from 'vitest'
import { requireEnv, optionalNumberEnv } from '../src/env.js'

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

describe('optionalNumberEnv', () => {
  it('returns undefined when the variable is unset', () => {
    expect(optionalNumberEnv('MISSING', {})).toBeUndefined()
  })

  it('returns undefined when the variable is an empty string', () => {
    expect(optionalNumberEnv('FOO', { FOO: '' })).toBeUndefined()
  })

  it('parses a positive integer string to a number', () => {
    expect(optionalNumberEnv('FOO', { FOO: '123456' })).toBe(123456)
  })

  it('throws for a non-numeric value, mentioning the var name', () => {
    expect(() => optionalNumberEnv('TEMPLATE_FIELD_ID', { TEMPLATE_FIELD_ID: 'abc' }))
      .toThrow('TEMPLATE_FIELD_ID')
  })

  it('throws for zero (must be a positive integer)', () => {
    expect(() => optionalNumberEnv('FOO', { FOO: '0' })).toThrow('positive integer')
  })

  it('throws for a negative value', () => {
    expect(() => optionalNumberEnv('FOO', { FOO: '-5' })).toThrow('positive integer')
  })

  it('throws for a non-integer value', () => {
    expect(() => optionalNumberEnv('FOO', { FOO: '12.5' })).toThrow('positive integer')
  })

  it('accepts an injected env record (does not read process.env when one is passed)', () => {
    process.env.__TEST_OPTIONAL_NUMBER_ENV__ = '999'
    try {
      expect(optionalNumberEnv('__TEST_OPTIONAL_NUMBER_ENV__', {})).toBeUndefined()
    } finally {
      delete process.env.__TEST_OPTIONAL_NUMBER_ENV__
    }
  })

  it('reads from process.env by default', () => {
    process.env.__TEST_OPTIONAL_NUMBER_ENV__ = '42'
    try {
      expect(optionalNumberEnv('__TEST_OPTIONAL_NUMBER_ENV__')).toBe(42)
    } finally {
      delete process.env.__TEST_OPTIONAL_NUMBER_ENV__
    }
  })
})
