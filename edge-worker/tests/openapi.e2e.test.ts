import { describe, it, expect } from 'vitest'
import SwaggerParser from '@apidevtools/swagger-parser'
import { fetch } from 'undici'

const WORKERS_BASE = process.env.WORKERS_BASE || 'https://edge-api.aihof757.workers.dev'
const RUST_BASE    = process.env.RUST_BASE    || 'http://localhost:8080'

describe('OpenAPI contracts stay valid', () => {
  it('Workers /doc is valid OpenAPI', async () => {
    const res = await fetch(`${WORKERS_BASE}/doc`)
    expect(res.ok).toBe(true)
    const spec: unknown = await res.json()
    await SwaggerParser.validate(spec as any)
  }, 20_000) 

  it('Rust /api-docs/openapi.json is valid OpenAPI', async () => {
    const res = await fetch(`${RUST_BASE}/api-docs/openapi.json`)
    expect(res.ok).toBe(true)
    const spec: unknown = await res.json()
    await SwaggerParser.validate(spec as any)
  })
})
