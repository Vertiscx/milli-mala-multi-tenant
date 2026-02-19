/**
 * File-based audit store for Node.js / Docker deployments.
 * Implements the minimal KV interface used by webhook.ts (put, list, get).
 * Stores entries as individual JSON files in a directory.
 */

import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditStore } from './types.js'

interface StoredEntry {
  value: string
  expiresAt: number | null
}

export class FileAuditStore implements AuditStore {
  private dir: string
  private _ready: Promise<void>

  constructor(dir = './audit-data') {
    this.dir = dir
    this._ready = mkdir(this.dir, { recursive: true }).catch(() => {})
  }

  private _keyToFile(key: string): string {
    return encodeURIComponent(key) + '.json'
  }

  private _fileToKey(file: string): string {
    return decodeURIComponent(file.replace(/\.json$/, ''))
  }

  async put(key: string, value: string, { expirationTtl }: { expirationTtl?: number } = {}): Promise<void> {
    await this._ready
    const entry: StoredEntry = {
      value,
      expiresAt: expirationTtl ? Date.now() + expirationTtl * 1000 : null
    }
    await writeFile(join(this.dir, this._keyToFile(key)), JSON.stringify(entry))
  }

  async get(key: string, format?: string): Promise<unknown> {
    await this._ready
    try {
      const raw = await readFile(join(this.dir, this._keyToFile(key)), 'utf8')
      const entry: StoredEntry = JSON.parse(raw)
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        await unlink(join(this.dir, this._keyToFile(key))).catch(() => {})
        return null
      }
      return format === 'json' ? JSON.parse(entry.value) : entry.value
    } catch {
      return null
    }
  }

  async list({ prefix = '', limit = 20 }: { prefix?: string; limit?: number } = {}): Promise<{ keys: { name: string }[] }> {
    await this._ready
    try {
      const files = await readdir(this.dir)
      const matching = files
        .filter(f => f.endsWith('.json'))
        .map(f => this._fileToKey(f))
        .filter(key => key.startsWith(prefix))
        .sort()
        .reverse()
        .slice(0, limit)
      return { keys: matching.map(name => ({ name })) }
    } catch {
      return { keys: [] }
    }
  }
}
