import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'tests/**',
        '*.config.*',
        'src/worker.ts', // Cloudflare Worker entrypoint — tested separately (runtime-parity)
        'src/index.ts' // Node server entrypoint — tested separately (runtime-parity)
      ]
    }
  }
})
