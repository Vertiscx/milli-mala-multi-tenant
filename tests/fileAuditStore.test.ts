import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAuditStore } from '../src/platform/fileAuditStore.js'

describe('FileAuditStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fas-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('put then get round-trips the raw value', async () => {
    const s = new FileAuditStore(dir)
    await s.put('audit:1', 'hello')
    expect(await s.get('audit:1')).toBe('hello')
  })

  it('get with format "json" parses the stored value', async () => {
    const s = new FileAuditStore(dir)
    await s.put('audit:2', JSON.stringify({ ok: true, n: 5 }))
    expect(await s.get('audit:2', 'json')).toEqual({ ok: true, n: 5 })
  })

  it('get returns null for a missing key', async () => {
    const s = new FileAuditStore(dir)
    expect(await s.get('nope')).toBeNull()
  })

  it('expired entries return null and are deleted', async () => {
    const s = new FileAuditStore(dir)
    await s.put('audit:exp', 'gone', { expirationTtl: -1 }) // already expired
    expect(await s.get('audit:exp')).toBeNull()
    // second read confirms the file was unlinked (still null, no throw)
    expect(await s.get('audit:exp')).toBeNull()
  })

  it('non-expiring entry persists (expiresAt null)', async () => {
    const s = new FileAuditStore(dir)
    await s.put('audit:keep', 'stay')
    expect(await s.get('audit:keep')).toBe('stay')
  })

  it('list filters by prefix, sorts descending, and respects limit', async () => {
    const s = new FileAuditStore(dir)
    await s.put('audit:b:1', 'x')
    await s.put('audit:b:2', 'y')
    await s.put('audit:b:3', 'z')
    await s.put('other:9', 'q')
    const all = await s.list({ prefix: 'audit:b:' })
    expect(all.keys.map(k => k.name)).toEqual(['audit:b:3', 'audit:b:2', 'audit:b:1'])
    const limited = await s.list({ prefix: 'audit:b:', limit: 2 })
    expect(limited.keys.map(k => k.name)).toEqual(['audit:b:3', 'audit:b:2'])
    expect((await s.list()).keys.length).toBe(4) // no prefix → everything
  })

  it('round-trips keys containing reserved/path characters', async () => {
    const s = new FileAuditStore(dir)
    const key = 'ticket:33979400825874:12/abc'
    await s.put(key, 'v')
    expect(await s.get(key)).toBe('v')
    expect((await s.list({ prefix: 'ticket:' })).keys[0].name).toBe(key)
  })

  it('get ignores non-JSON / corrupt files (returns null, no throw)', async () => {
    const s = new FileAuditStore(dir)
    await writeFile(join(dir, encodeURIComponent('audit:bad') + '.json'), 'not json{')
    expect(await s.get('audit:bad')).toBeNull()
  })

  it('init failure (uncreatable dir) → put throws, get null, list empty', async () => {
    // Create a *file*, then point the store at a path *under* that file —
    // mkdir recursive must fail (ENOTDIR), exercising the init-failed branch.
    const filePath = join(dir, 'block')
    await writeFile(filePath, 'x')
    const s = new FileAuditStore(join(filePath, 'sub'))
    await expect(s.put('k', 'v')).rejects.toThrow(/Audit store unavailable/)
    expect(await s.get('k')).toBeNull()
    expect(await s.list()).toEqual({ keys: [] })
  })
})
