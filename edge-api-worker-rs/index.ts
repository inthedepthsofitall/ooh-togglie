import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { swaggerUI } from '@hono/swagger-ui'
import { z, ZodError } from 'zod'

/* ========================= TYPES ========================= */

type Env = {
  DB: D1Database
  ASSETS: { fetch: (req: Request) => Promise<Response> }
  RL_LIMIT?: string
  RL_WINDOW?: string
  DISABLE_RATE_LIMIT?: string

  API_KEY?: string
  EDGE_API_KEY?: string

  ADMIN_USER?: string
  ADMIN_PASS?: string

  DEMO_MODE?: string
  ROLLOUT_PCT?: string

  RUST_BASE?: string

  SHOW_DOCS?: string
  SHOW_ADMIN?: string


}

const EnvSchema = z
  .object({
    RL_LIMIT: z.string().regex(/^\d+$/).optional(),
    RL_WINDOW: z.string().regex(/^\d+$/).optional(),
    DISABLE_RATE_LIMIT: z.enum(['0', '1']).optional(),
    API_KEY: z.string().min(8).optional(),
    EDGE_API_KEY: z.string().min(8).optional(),
    ADMIN_USER: z.string().optional(),
    ADMIN_PASS: z.string().optional(),
    DEMO_MODE: z.string().optional(),
    ROLLOUT_PCT: z.string().regex(/^\d+$/).optional(),
    RUST_BASE: z.string().url().optional(),
    SHOW_DOCS: z.string().optional(),
    SHOW_ADMIN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.API_KEY && !env.EDGE_API_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'API_KEY or EDGE_API_KEY is required' })
    }
    if (env.ROLLOUT_PCT) {
      const n = Number(env.ROLLOUT_PCT)
      if (n < 0 || n > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ROLLOUT_PCT must be 0..100' })
    }
  })

/* ========================= D1 HELPERS ========================= */

async function d1All<T>(c: any, sql: string, params: any[] = []): Promise<T[]> {
  const res = await c.env.DB.prepare(sql).bind(...params).all()
  return (res.results ?? []) as T[]
}
async function d1First<T>(c: any, sql: string, params: any[] = []): Promise<T | null> {
  const res = await c.env.DB.prepare(sql).bind(...params).first()
  return (res ?? null) as T | null
}
async function d1Run(c: any, sql: string, params: any[] = []): Promise<void> {
  await c.env.DB.prepare(sql).bind(...params).run()
}

/* ========================= ROW TYPES ========================= */

type FlagRow = {
  id: string
  key: string
  description: string | null
  enabled: number // stored as 0/1 in sqlite
  version: number
  updated_at: string
}
type FlagEvalRow = { key: string; enabled: number; version: number }
type ItemRow = { id: string; name: string }

/* ========================= UTILS ========================= */

function etagFrom(obj: unknown) {
  const s = JSON.stringify(obj)
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `W/"${(h >>> 0).toString(16)}"`
}

function apiKeyMatches(c: any) {
  const sent = c.req.header('x-api-key') || ''
  const want = c.env.API_KEY || c.env.EDGE_API_KEY || ''
  return !!sent && !!want && sent === want
}

function rustBase(c: any): string {
  const base = c.env.RUST_BASE
  if (!base) throw new Error('RUST_BASE is not configured on the Worker')
  return base.replace(/\/+$/, '')
}

function demoOn(c: any) {
  return (c.env.DEMO_MODE || '') === '1'
}


function showAdmin(c: any) {
  // default ON unless explicitly disabled
  return (c.env.SHOW_ADMIN || '1') === '1'
}

/* ========================= RATE LIMIT (IN-MEM) =========================
   NOTE: This is per-isolate only. If you want durable RL, plug in Upstash later.
*/

const rlBuckets = new Map<string, { count: number; resetUnix: number }>()
async function rateLimit(
  c: any,
  key: string,
  limit: number,
  windowSec: number
): Promise<{ ok: boolean; count: number; resetUnix: number }> {
  if (c.env.DISABLE_RATE_LIMIT === '1') {
    return { ok: true, count: 0, resetUnix: Math.ceil(Date.now() / 1000) + windowSec }
  }

  const now = Math.floor(Date.now() / 1000)
  const windowId = Math.floor(now / windowSec)
  const bucketKey = `rl:${key}:${windowId}`
  const resetUnix = windowId * windowSec + windowSec

  const b = rlBuckets.get(bucketKey)
  if (!b) {
    rlBuckets.set(bucketKey, { count: 1, resetUnix })
    return { ok: true, count: 1, resetUnix }
  }

  b.count++
  return { ok: b.count <= limit, count: b.count, resetUnix: b.resetUnix }
}

/* ========================= METRICS (IN-MEM) ========================= */

let HTTP_REQUESTS_TOTAL = 0
let HTTP_401_TOTAL = 0
let HTTP_429_TOTAL = 0

const json = (c: any, status: number, body: unknown) => {
  c.status(status)
  return c.json(body)
}
const Unauthorized = (c: any) => {
  HTTP_401_TOTAL++
  return json(c, 401, { error: 'Unauthorized' })
}
const tooMany = (c: any, retry: number) => {
  HTTP_429_TOTAL++
  c.header('Retry-After', String(retry))
  return json(c, 429, { error: 'Too Many Requests', retry_after: retry })
}

/* ========================= APP + CORS ========================= */

const app = new OpenAPIHono<{ Bindings: Env }>()
// app.get('/__fingerprint', (c) => c.text('HONO EDGE API ✅'))


const ALLOW_ORIGINS = new Set<string>([
  'https://togglie.aihof757.workers.dev',
  'http://localhost:5173',
])

app.use('*', async (c, next) => {
  EnvSchema.parse(c.env)
  await next()
})

app.use(
  '*',
  cors({
    origin: (origin) => (origin && ALLOW_ORIGINS.has(origin) ? origin : undefined),
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowHeaders: ['content-type', 'x-api-key'],
    exposeHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-Pagination-Limit',
      'X-Pagination-Offset',
      'Link',
      'ETag',
      'X-Request-Id',
    ],
    credentials: false,
    maxAge: 86400,
  })
)

const SLOW_REQ_MS = 500
app.use('*', async (c, next) => {
  const reqId = c.req.header('cf-ray') || (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))
  const t0 = Date.now()
  await next()
  const dt = Date.now() - t0
  c.header('X-Request-Id', reqId)
  if (dt > SLOW_REQ_MS) {
    console.warn('slow-req', { ms: dt, path: c.req.path, method: c.req.method, reqId })
  }
})

/* ========================= WARMUP ========================= */

app.get('/_warm', async (c) => {
  try {
    await d1First<{ one: number }>(c, 'SELECT 1 as one')
  } catch {}
  return c.text('ok')
})

app.get('/__fingerprint', (c) => c.text('HONO EDGE API ✅ v2 ' + new Date().toISOString()))


/* ========================= SCHEMAS ========================= */

const Item = z.object({ id: z.string(), name: z.string() })
const NewItem = z.object({ name: z.string().min(1).max(100) })
const IdParam = z.object({ id: z.string().min(1) })

const Flag = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable().optional(),
  enabled: z.boolean(),
  version: z.number(),
  updated_at: z.string(),
})
const NewFlag = z.object({
  key: z.string().min(1),
  description: z.string().max(500).optional().nullable(),
  enabled: z.boolean().optional(),
})
const UpdateFlag = z.object({
  description: z.string().max(500).optional().nullable(),
  enabled: z.boolean().optional(),
})
const EvalReq = z.object({
  flag_key: z.string().min(1),
  user: z.object({ id: z.string().optional() }).optional(),
})
const EvalRes = z.object({
  key: z.string(),
  enabled: z.boolean(),
  version: z.number(),
  reason: z.string(),
})
const EventItem = z.object({
  ts: z.string().optional(),
  flag_key: z.string(),
  decision: z.string(),
  user_id: z.string().optional(),
})
const EventsBody = z.object({ events: z.array(EventItem).min(1).max(100) })

/* ========================= SYSTEM ========================= */

app.openapi(
  createRoute({ method: 'get', path: '/v1/health', tags: ['system'], responses: { 200: { description: 'OK' } } }),
  async (c) => {
    HTTP_REQUESTS_TOTAL++
    try {
      await d1First<{ one: number }>(c, 'SELECT 1 as one')
      return json(c, 200, { ok: true, db: 'up' })
    } catch {
      return json(c, 200, { ok: true, db: 'down' })
    }
  }
)

app.openapi(
  createRoute({ method: 'get', path: '/v1/healthz', tags: ['system'], responses: { 200: { description: 'OK' } } }),
  async (c) => {
    const dbOk = await d1First<{ one: number }>(c, 'SELECT 1 as one').then(() => true).catch(() => false)
    const flagsCount = dbOk
      ? await d1First<{ n: number }>(c, 'SELECT COUNT(*) as n FROM flags').then((x) => Number(x?.n ?? 0)).catch(() => 0)
      : 0
    return json(c, 200, { ok: dbOk, db: dbOk, flags: flagsCount })
  }
)

app.openapi(
  createRoute({ method: 'get', path: '/metrics', tags: ['system'], responses: { 200: { description: 'Prometheus' } } }),
  async (c) => {
    HTTP_REQUESTS_TOTAL++
    const body =
      [
        '# HELP http_requests_total Total HTTP requests',
        '# TYPE http_requests_total counter',
        `http_requests_total ${HTTP_REQUESTS_TOTAL}`,
        '# HELP http_401_total Total 401 responses (this isolate)',
        '# TYPE http_401_total counter',
        `http_401_total ${HTTP_401_TOTAL}`,
        '# HELP http_429_total Total 429 responses (this isolate)',
        '# TYPE http_429_total counter',
        `http_429_total ${HTTP_429_TOTAL}`,
      ].join('\n') + '\n'
    return c.text(body)
  }
)

/* ========================= FLAGS ========================= */

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/flags',
    tags: ['flags'],
    responses: {
      200: { description: 'List', content: { 'application/json': { schema: z.array(Flag) } } },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    if (!apiKeyMatches(c)) return Unauthorized(c)

    const rows = await d1All<FlagRow>(
      c,
      `SELECT id, key, description, enabled, version, updated_at
       FROM flags
       ORDER BY updated_at DESC
       LIMIT 200`
    )

    c.header('Cache-Control', 'public, max-age=10')
    return c.json(
      rows.map((r) => ({
        ...r,
        enabled: !!r.enabled,
      }))
    )
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/flags/{key}',
    tags: ['flags'],
    request: { params: z.object({ key: z.string().min(1) }) },
    responses: {
      200: { description: 'Flag', content: { 'application/json': { schema: Flag } } },
      401: { description: 'Unauthorized' },
      404: { description: 'Not Found' },
      429: { description: 'Rate limited' },
    },
  }),
  async (c) => {
    if (!apiKeyMatches(c)) return Unauthorized(c)
    const { key } = z.object({ key: z.string().min(1) }).parse(c.req.param())

    const LIMIT = Number(c.env.RL_LIMIT ?? 60)
    const WINDOW = Number(c.env.RL_WINDOW ?? 60)
    const caller = c.req.header('x-api-key') || c.req.header('cf-connecting-ip') || 'anon'
    const { ok, count, resetUnix } = await rateLimit(c, `flag:${caller}`, LIMIT, WINDOW)

    c.header('X-RateLimit-Limit', String(LIMIT))
    c.header('X-RateLimit-Remaining', String(Math.max(0, LIMIT - count)))
    c.header('X-RateLimit-Reset', String(resetUnix))
    if (!ok) return tooMany(c, WINDOW)

    const row = await d1First<FlagRow>(
      c,
      `SELECT id, key, description, enabled, version, updated_at
       FROM flags
       WHERE key = ?
       LIMIT 1`,
      [key]
    )
    if (!row) return json(c, 404, { error: 'Not found' })

    const flag = { ...row, enabled: !!row.enabled }
    c.header('Cache-Control', 'public, max-age=30')

    const tag = etagFrom(flag)
    if (c.req.header('if-none-match') === tag) return c.body(null, 304)
    c.header('ETag', tag)

    return c.json(flag)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/flags',
    tags: ['flags'],
    request: { body: { content: { 'application/json': { schema: NewFlag } } } },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: Flag } } },
      400: { description: 'Invalid body' },
      401: { description: 'Unauthorized' },
      409: { description: 'Key exists' },
    },
  }),
  async (c) => {
    if (!apiKeyMatches(c)) return Unauthorized(c)

    try {
      const body = NewFlag.parse(await c.req.json())
      const id = crypto.randomUUID()
      const enabled = body.enabled ? 1 : 0

      await d1Run(
        c,
        `INSERT INTO flags (id, key, description, enabled, version, updated_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'))`,
        [id, body.key, body.description ?? null, enabled]
      )

      const row = await d1First<FlagRow>(
        c,
        `SELECT id, key, description, enabled, version, updated_at
         FROM flags WHERE key = ? LIMIT 1`,
        [body.key]
      )

      c.header('Location', `/v1/flags/${body.key}`)
      return c.json(
        {
          ...(row ?? { id, key: body.key, description: body.description ?? null, enabled, version: 1, updated_at: new Date().toISOString() }),
          enabled: !!(row?.enabled ?? enabled),
        },
        201
      )
    } catch (e: any) {
      if (e instanceof ZodError) return json(c, 400, { error: e.errors })
      // sqlite duplicate unique constraint
      if (String(e?.message || '').toLowerCase().includes('unique')) return c.json({ error: 'Flag key already exists' }, 409)
      return c.json({ error: 'Server error' }, 500)
    }
  }
)

app.openapi(
  createRoute({
    method: 'put',
    path: '/v1/flags/{key}',
    tags: ['flags'],
    request: {
      params: z.object({ key: z.string().min(1) }),
      body: { content: { 'application/json': { schema: UpdateFlag } } },
    },
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: Flag } } },
      401: { description: 'Unauthorized' },
      404: { description: 'Not Found' },
    },
  }),
  async (c) => {
    if (!apiKeyMatches(c)) return Unauthorized(c)

    const { key } = z.object({ key: z.string().min(1) }).parse(c.req.param())
    const patch = UpdateFlag.parse(await c.req.json())

    const enabledParam = patch.enabled === undefined ? null : patch.enabled ? 1 : 0

    await d1Run(
      c,
      `UPDATE flags SET
         description = COALESCE(?, description),
         enabled     = COALESCE(?, enabled),
         version     = version + 1,
         updated_at  = datetime('now')
       WHERE key = ?`,
      [patch.description ?? null, enabledParam, key]
    )

    const row = await d1First<FlagRow>(
      c,
      `SELECT id, key, description, enabled, version, updated_at
       FROM flags WHERE key = ? LIMIT 1`,
      [key]
    )
    if (!row) return c.json({ error: 'Not found' }, 404)

    return c.json({ ...row, enabled: !!row.enabled })
  }
)

/* =================== EVALUATE + EVENTS =================== */

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/evaluate',
    tags: ['flags'],
    request: { body: { content: { 'application/json': { schema: EvalReq } } } },
    responses: {
      200: { description: 'Evaluation', content: { 'application/json': { schema: EvalRes } } },
      401: { description: 'Unauthorized' },
      404: { description: 'Not Found' },
      429: { description: 'Rate limited' },
    },
  }),
  async (c) => {
    if (!apiKeyMatches(c)) return Unauthorized(c)
    const { flag_key, user } = EvalReq.parse(await c.req.json())

    const LIMIT = Number(c.env.RL_LIMIT ?? 60)
    const WINDOW = Number(c.env.RL_WINDOW ?? 60)
    const caller = c.req.header('x-api-key') || c.req.header('cf-connecting-ip') || 'anon'
    const rl = await rateLimit(c, `eval:${caller}`, LIMIT, WINDOW)

    c.header('X-RateLimit-Limit', String(LIMIT))
    c.header('X-RateLimit-Remaining', String(Math.max(0, LIMIT - rl.count)))
    c.header('X-RateLimit-Reset', String(rl.resetUnix))
    if (!rl.ok) return tooMany(c, WINDOW)

    const flag = await d1First<FlagEvalRow>(c, `SELECT key, enabled, version FROM flags WHERE key = ? LIMIT 1`, [flag_key])
    if (!flag) return c.json({ error: 'Not found' }, 404)

    const pct = Math.max(0, Math.min(100, Number(c.env.ROLLOUT_PCT ?? 10)))
    const uid = user?.id ?? 'anon'
    const hash = Math.abs([...uid].reduce((a, ch) => (((a << 5) - a) + ch.charCodeAt(0)) | 0, 0)) % 100
    const enabled = !!flag.enabled && hash < pct

    const res: z.infer<typeof EvalRes> = {
      key: flag.key,
      enabled,
      version: flag.version,
      reason: `rollout_${pct}%`,
    }

    return c.json(res)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/events',
    tags: ['flags'],
    request: { body: { content: { 'application/json': { schema: EventsBody } } } },
    responses: { 202: { description: 'Accepted' }, 401: { description: 'Unauthorized' } },
  }),
  async (c) => {
    if (!apiKeyMatches(c)) return Unauthorized(c)

    const body = EventsBody.parse(await c.req.json())
    const apiKey = c.req.header('x-api-key') || 'unknown'

    // simple batch insert loop
    for (const e of body.events) {
      await d1Run(
        c,
        `INSERT INTO events (id, ts, api_key, flag_key, decision, user_id)
         VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`,
        [crypto.randomUUID(), e.ts ?? null, apiKey, e.flag_key, e.decision, e.user_id ?? null]
      )
    }

    return c.body(null, 202)
  }
)

/* ========================= ITEMS ========================= */

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/items',
    tags: ['items'],
    responses: {
      200: { description: 'List items', content: { 'application/json': { schema: z.array(Item) } } },
      401: { description: 'Unauthorized' },
      429: { description: 'Rate limited' },
    },
  }),
  async (c) => {
    HTTP_REQUESTS_TOTAL++
    if (!apiKeyMatches(c)) return Unauthorized(c)

    const qs = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(c.req.query())

    const LIMIT = Number(c.env.RL_LIMIT ?? 60)
    const WINDOW = Number(c.env.RL_WINDOW ?? 60)
    const caller = c.req.header('x-api-key') || c.req.header('cf-connecting-ip') || 'anon'
    const { ok, count, resetUnix } = await rateLimit(c, `items:${caller}`, LIMIT, WINDOW)

    c.header('X-RateLimit-Limit', String(LIMIT))
    c.header('X-RateLimit-Remaining', String(Math.max(0, LIMIT - count)))
    c.header('X-RateLimit-Reset', String(resetUnix))
    c.header('X-Pagination-Limit', String(qs.limit))
    c.header('X-Pagination-Offset', String(qs.offset))

    const base = new URL(c.req.url)
    const next = new URL(base)
    next.searchParams.set('limit', String(qs.limit))
    next.searchParams.set('offset', String(qs.offset + qs.limit))
    const prev = new URL(base)
    prev.searchParams.set('limit', String(qs.limit))
    prev.searchParams.set('offset', String(Math.max(0, qs.offset - qs.limit)))
    c.header('Link', `<${next.toString()}>; rel="next", <${prev.toString()}>; rel="prev"`)

    if (!ok) return tooMany(c, WINDOW)

    const rows = await d1All<ItemRow>(
      c,
      `SELECT id, name
       FROM items
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [qs.limit, qs.offset]
    )

    c.header('Cache-Control', 'public, max-age=3')
    return c.json(rows)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/items',
    tags: ['items'],
    request: { body: { content: { 'application/json': { schema: NewItem } } } },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: Item } } },
      400: { description: 'Invalid body' },
      401: { description: 'Unauthorized' },
      413: { description: 'Payload Too Large' },
      415: { description: 'Unsupported Media Type' },
      429: { description: 'Rate limited' },
    },
  }),
  async (c) => {
    try {
      HTTP_REQUESTS_TOTAL++
      if (!apiKeyMatches(c)) return Unauthorized(c)

      const LIMIT = Number(c.env.RL_LIMIT ?? 60)
      const WINDOW = Number(c.env.RL_WINDOW ?? 60)
      const caller = c.req.header('x-api-key') || c.req.header('cf-connecting-ip') || 'anon'
      const { ok, count, resetUnix } = await rateLimit(c, `items:${caller}`, LIMIT, WINDOW)

      c.header('X-RateLimit-Limit', String(LIMIT))
      c.header('X-RateLimit-Remaining', String(Math.max(0, LIMIT - count)))
      c.header('X-RateLimit-Reset', String(resetUnix))
      if (!ok) return tooMany(c, WINDOW)

      const ct = (c.req.header('content-type') || '').toLowerCase()
      if (!ct.includes('application/json')) return json(c, 415, { error: 'Unsupported Media Type' })

      const raw = await c.req.text()
      if (raw.length > 10_000) return json(c, 413, { error: 'Payload Too Large', max: 10_000 })

      const parsed = NewItem.parse(JSON.parse(raw))
      const id = crypto.randomUUID()

      await d1Run(c, `INSERT INTO items (id, name, created_at) VALUES (?, ?, datetime('now'))`, [id, parsed.name])

      c.header('Location', `/v1/items/${id}`)
      return json(c, 201, { id, name: parsed.name })
    } catch (e) {
      if (e instanceof ZodError) return json(c, 400, { error: e.errors })
      return json(c, 500, { error: 'Server error' })
    }
  }
)

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/items/{id}',
    tags: ['items'],
    request: { params: IdParam },
    responses: { 204: { description: 'Deleted' }, 401: { description: 'Unauthorized' } },
  }),
  async (c) => {
    if (!apiKeyMatches(c)) return Unauthorized(c)
    const { id } = IdParam.parse(c.req.param())
    await d1Run(c, `DELETE FROM items WHERE id = ?`, [id])
    return c.body(null, 204)
  }
)

/* ========== Rust API proxy (for dashboard) ========== */

app.get('/rust/items', async (c) => {
  const base = rustBase(c)
  const res = await fetch(`${base}/v1/items`)
  const body = await res.text()
  return new Response(body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  })
})

app.post('/rust/items', async (c) => {
  const base = rustBase(c)
  const body = await c.req.text()
  const res = await fetch(`${base}/v1/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const out = await res.text()
  return new Response(out, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  })
})

/* ========================= ADMIN ========================= */

function basicAuth(c: any) {
  const hdr = c.req.header('authorization') || ''
  if (!hdr.startsWith('Basic ')) return false
  const [u, p] = atob(hdr.slice(6)).split(':')
  return u === c.env.ADMIN_USER && p === c.env.ADMIN_PASS
}

async function readForm(c: any) {
  const t = await c.req.text()
  return Object.fromEntries(new URLSearchParams(t))
}

app.get('/admin', async (c) => {
  if (!showAdmin(c)) return c.body('admin disabled', 404)

  if (!basicAuth(c)) {
    c.header('WWW-Authenticate', 'Basic realm="admin"')
    return c.body('auth required', 401)
  }

  const url = new URL('v1/flags', c.req.url).toString().replace('/admin', '/v1/flags')
  const r = await fetch(url, { headers: { 'x-api-key': c.env.API_KEY || c.env.EDGE_API_KEY || '' } })
  const flags = await r.json()

  const html = `<!doctype html>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>edge-api admin</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;margin:24px;max-width:900px}
    header{display:flex;align-items:center;gap:12px;margin-bottom:16px}
    code,badge{background:#f5f5f7;padding:2px 6px;border-radius:6px}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
    form{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
    input,button{padding:8px 10px;border:1px solid #ddd;border-radius:8px}
    button{cursor:pointer}
  </style>
  <header>
    <h1 style="margin:0">Feature Flags</h1>
    <span>env: <code>workers</code></span>
  </header>

  <section>
    <h3 style="margin:8px 0">Create flag</h3>
    <form method="post" action="/admin/flags/create">
      <input name="key" placeholder="key" required />
      <input name="description" placeholder="description (optional)" />
      <label><input type="checkbox" name="enabled"> enabled</label>
      <button type="submit">Create</button>
    </form>
  </section>

  <section>
    <h3 style="margin:16px 0 8px">Existing flags</h3>
    <table>
      <thead><tr><th>key</th><th>enabled</th><th>version</th><th>updated</th><th>actions</th></tr></thead>
      <tbody>
        ${(Array.isArray(flags) ? flags : [])
          .map(
            (f: any) => `
          <tr>
            <td><code>${f.key}</code></td>
            <td>${f.enabled ? '✅' : '❌'}</td>
            <td>${f.version}</td>
            <td>${new Date(f.updated_at).toLocaleString()}</td>
            <td>
              <form method="post" action="/admin/flags/toggle" style="display:inline">
                <input type="hidden" name="key" value="${f.key}">
                <input type="hidden" name="enabled" value="${!f.enabled}">
                <button>Toggle</button>
              </form>
              <form method="post" action="/admin/flags/delete" style="display:inline" onsubmit="return confirm('Delete ${f.key}?')">
                <input type="hidden" name="key" value="${f.key}">
                <button>Delete</button>
              </form>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </section>`
  return c.html(html)
})

app.post('/admin/flags/create', async (c) => {
  if (!showAdmin(c)) return c.body('admin disabled', 404)

  if (!basicAuth(c)) {
    c.header('WWW-Authenticate', 'Basic realm="admin"')
    return c.body('auth required', 401)
  }
  const { key, description, enabled } = await readForm(c)
  const body = JSON.stringify({ key, description: description || null, enabled: !!enabled })
  const url = new URL('/v1/flags', c.req.url).toString().replace('/admin/flags/create', '/v1/flags')
  await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': c.env.API_KEY || c.env.EDGE_API_KEY || '', 'content-type': 'application/json' },
    body,
  })
  return c.redirect('/admin')
})

app.post('/admin/flags/toggle', async (c) => {
  if (!showAdmin(c)) return c.body('admin disabled', 404)

  if (!basicAuth(c)) {
    c.header('WWW-Authenticate', 'Basic realm="admin"')
    return c.body('auth required', 401)
  }
  const { key, enabled } = await readForm(c)
  const url = new URL(`/v1/flags/${encodeURIComponent(String(key))}`, c.req.url).toString()
    .replace('/admin/flags/toggle', `/v1/flags/${encodeURIComponent(String(key))}`)
  await fetch(url, {
    method: 'PUT',
    headers: { 'x-api-key': c.env.API_KEY || c.env.EDGE_API_KEY || '', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: String(enabled) === 'true' }),
  })
  return c.redirect('/admin')
})

app.post('/admin/flags/delete', async (c) => {
  if (!showAdmin(c)) return c.body('admin disabled', 404)

  if (!basicAuth(c)) {
    c.header('WWW-Authenticate', 'Basic realm="admin"')
    return c.body('auth required', 401)
  }
  const { key } = await readForm(c)

  // You didn't have DELETE /v1/flags/{key} implemented; keep admin "delete" as a no-op unless you add it.
  // If you want it, add an endpoint. For now, do direct DB delete:
  await d1Run(c, `DELETE FROM flags WHERE key = ?`, [String(key)])

  return c.redirect('/admin')
})

/* ========================= DEMO ========================= */

app.get('/debug/demo', (c) => c.json({ demo_on: demoOn(c), DEMO_MODE: c.env.DEMO_MODE ?? null }))

app.get('/demo', (c) => {
  if (!demoOn(c)) return c.body('demo disabled', 404)

  const html = `<!doctype html>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Edge Flags Demo</title>
  <style>
    :root{--bg:#0b0c10;--card:#16181d;--fg:#e6e6e6;--muted:#98a2b3;--ok:#22c55e;--no:#ef4444;--acc:#7c3aed}
    *{box-sizing:border-box} body{margin:0;background:linear-gradient(180deg,#0b0c10,#0f172a);color:var(--fg);font-family:Inter,system-ui,Segoe UI,Roboto,Arial}
    .wrap{max-width:980px;margin:32px auto;padding:0 16px}
    .card{background:var(--card);border:1px solid #1f2937;border-radius:16px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
    h1{font-size:22px;margin:0 0 12px} h2{font-size:16px;margin:0 0 8px;color:#e2e8f0}
    input,button{border-radius:10px;border:1px solid #2b3441;background:#0f172a;color:var(--fg);padding:10px 12px}
    button{cursor:pointer;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border-color:#1d4ed8}
    .grid{display:grid;gap:16px;grid-template-columns:1fr 1fr}
    .row{display:flex;gap:8px;align-items:center}
    .muted{color:var(--muted)}
    pre{margin:0;background:#0b1220;border:1px solid #1f2937;border-radius:12px;padding:12px;overflow:auto}
    .pill{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;background:#0b1220;border:1px solid #1f2937}
    .ok{color:var(--ok)} .no{color:var(--no)}
  </style>
  <div class="wrap">
    <div class="card">
      <h1>Edge Flags — Live Demo</h1>
      <div class="muted">Paste any URL, choose a flag key, and watch the decision + rate-limit headers. Rollout by stable hash.</div>
    </div>
    <div class="grid" style="margin-top:16px">
      <div class="card">
        <h2>Inputs</h2>
        <div class="row" style="margin-top:8px">
          <label style="width:84px" for="flag">Flag</label>
          <input id="flag" value="welcome_banner" style="flex:1" />
        </div>
        <div class="row" style="margin-top:8px">
          <label style="width:84px" for="uid">URL</label>
          <input id="uid" placeholder="https://example.com/page" style="flex:1" />
        </div>
        <div class="row" style="margin-top:12px;justify-content:flex-end">
          <button id="btn-eval">Evaluate</button>
        </div>
      </div>
      <div class="card">
        <h2>Metrics</h2>
        <div class="row" style="gap:12px;flex-wrap:wrap">
          <span class="pill">Decisions: <b id="m-total">0</b></span>
          <span class="pill ok">Enabled: <b id="m-en">0</b></span>
          <span class="pill no">Disabled: <b id="m-dis">0</b></span>
          <span class="pill">p95 Latency: <b id="m-p95">–</b> ms</span>
        </div>
        <div class="row" style="margin-top:8px;gap:8px">
          <span class="pill">RL Limit: <b id="h-limit">–</b></span>
          <span class="pill">RL Remaining: <b id="h-rem">–</b></span>
          <span class="pill">RL Reset: <b id="h-reset">–</b></span>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Result</h2>
      <pre id="eval-out" class="no">{ }</pre>
    </div>
  </div>
  <script type="module">
    const flag = document.querySelector('#flag');
    const uid  = document.querySelector('#uid');
    const out  = document.querySelector('#eval-out');
    const mTotal = document.querySelector('#m-total');
    const mEn = document.querySelector('#m-en');
    const mDis = document.querySelector('#m-dis');
    const mP95 = document.querySelector('#m-p95');
    const hLimit = document.querySelector('#h-limit');
    const hRem = document.querySelector('#h-rem');
    const hReset = document.querySelector('#h-reset');
    const latencies = [];
    async function fetchJSON(url) {
      const t0 = performance.now();
      const r = await fetch(url);
      const dt = performance.now() - t0;
      hLimit.textContent = r.headers.get('x-ratelimit-limit') ?? '–';
      hRem.textContent   = r.headers.get('x-ratelimit-remaining') ?? '–';
      hReset.textContent = r.headers.get('x-ratelimit-reset') ?? '–';
      if (!r.ok) throw new Error(\`\${r.status} \${await r.text()}\`);
      const json = await r.json();
      latencies.push(dt); if (latencies.length > 20) latencies.shift();
      const sorted = [...latencies].sort((a,b)=>a-b);
      const p95 = sorted[Math.floor(sorted.length * 0.95) - 1] ?? dt;
      mP95.textContent = Math.round(p95);
      return json;
    }
    async function runEval() {
      const f = (flag.value || '').trim();
      const u = (uid.value || '').trim() || 'https://demo-user';
      if (!f) { out.textContent = 'Missing flag'; out.className='no'; return; }
      try {
        const q = new URLSearchParams({ flag: f, user: u });
        const data = await fetchJSON('/demo/eval?' + q.toString());
        const t = Number(mTotal.textContent || '0') + 1;
        const en = Number(mEn.textContent || '0') + (data.result?.enabled ? 1 : 0);
        const dis = t - en;
        mTotal.textContent = String(t); mEn.textContent = String(en); mDis.textContent = String(dis);
        out.textContent = JSON.stringify(data, null, 2);
        out.className = data.result?.enabled ? 'ok' : 'no';
      } catch (e) { out.textContent = String(e); out.className = 'no'; }
    }
    document.querySelector('#btn-eval').onclick = runEval;
  </script>`
  return c.html(html)
})

app.get('/demo/eval', async (c) => {
  if (!demoOn(c)) {
    return new Response(JSON.stringify({ error: 'demo disabled' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const qs = z
    .object({ flag: z.string().min(1), user: z.string().min(1) })
    .parse(Object.fromEntries(new URL(c.req.url).searchParams))

  try {
    const evalUrl = new URL('/v1/evaluate', c.req.url)
    const evalReq = new Request(evalUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': c.env.API_KEY || c.env.EDGE_API_KEY || '',
      },
      body: JSON.stringify({ flag_key: qs.flag, user: { id: qs.user } }),
    })

    const r = await app.fetch(evalReq, c.env as Env, (c as any).executionCtx)
    const text = await r.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }

    const out = new Response(
      JSON.stringify({ inner_status: r.status, inner_content_type: r.headers.get('content-type'), result: parsed }),
      { status: r.status, headers: { 'content-type': 'application/json' } }
    )

    ;['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'].forEach((h) => {
      const v = r.headers.get(h)
      if (v) out.headers.set(h, v)
    })

    return out
  } catch (e: any) {
    return new Response(JSON.stringify({ error: 'proxy_failed', message: String(e) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
})

/* ========== Simple dashboard UI (root path) ========== */

app.get('/', (c) => {
  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>edge-api risk dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; background: #020617; color: #e5e7eb; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .card { background: #020617; border-radius: 0.75rem; padding: 1rem 1.25rem; border: 1px solid #1e293b; max-width: 760px; }
    label { display:block; font-size:0.875rem; color:#9ca3af; margin-bottom:0.25rem; }
    input { width:100%; padding:0.5rem 0.75rem; border-radius:0.5rem; border:1px solid #334155; background:#020617; color:#e5e7eb; }
    button { margin-top:0.75rem; padding:0.5rem 0.9rem; border-radius:9999px; border:none; background:#22c55e; color:#022c22; font-weight:600; cursor:pointer; }
    button:hover { filter:brightness(1.1); }
    table { width:100%; border-collapse:collapse; margin-top:1rem; }
    th, td { padding:0.5rem 0.25rem; font-size:0.875rem; border-bottom:1px solid #1f2937; }
    th { text-align:left; color:#9ca3af; font-weight:500; }
    .pill { display:inline-flex; align-items:center; padding:0.15rem 0.5rem; border-radius:9999px; font-size:0.75rem; font-weight:500; }
    .pill.low { background:#064e3b; color:#6ee7b7; }
    .pill.medium { background:#78350f; color:#fbbf24; }
    .pill.high { background:#7f1d1d; color:#fecaca; }
    .score-bar { height:0.4rem; border-radius:9999px; background:#020617; overflow:hidden; border:1px solid #1f2937; }
    .score-fill { height:100%; background:#22c55e; transform-origin:left; }
    .score-fill.medium { background:#f97316; }
    .score-fill.high { background:#ef4444; }
    .meta { font-size:0.8rem; color:#6b7280; margin-top:0.75rem; }
  </style>
</head>
<body>
  <h1>edge-api risk dashboard</h1>
  <p class="meta">Cloudflare Worker UI calling a Rust API. Items are scored and flagged in real time.</p>
  <div class="card">
    <form id="item-form">
      <label for="name">Item name</label>
      <input id="name" name="name" required placeholder="e.g. risky affiliate funnel" />
      <button type="submit">Create & score</button>
    </form>

    <div class="meta" id="status"></div>

    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Risk</th>
          <th>Score</th>
        </tr>
      </thead>
      <tbody id="items-body"></tbody>
    </table>
  </div>

  <script>
    const form = document.getElementById('item-form');
    const statusEl = document.getElementById('status');
    const tbody = document.getElementById('items-body');

    function levelClass(level) {
      switch (level) {
        case 'HIGH': return 'high';
        case 'MEDIUM': return 'medium';
        default: return 'low';
      }
    }

    async function loadItems() {
      const res = await fetch('/rust/items');
      if (!res.ok) {
        statusEl.textContent = 'Failed to load items.';
        return;
      }
      const items = await res.json();
      tbody.innerHTML = '';
      for (const item of items) {
        const tr = document.createElement('tr');

        const nameTd = document.createElement('td');
        nameTd.textContent = item.name;

        const riskTd = document.createElement('td');
        const pill = document.createElement('span');
        pill.className = 'pill ' + levelClass(item.risk_level || 'LOW');
        pill.textContent = item.risk_level || 'LOW';
        riskTd.appendChild(pill);

        const scoreTd = document.createElement('td');
        const bar = document.createElement('div');
        bar.className = 'score-bar';
        const fill = document.createElement('div');
        fill.className = 'score-fill ' + levelClass(item.risk_level || 'LOW');
        const score = typeof item.risk_score === 'number' ? item.risk_score : 0;
        fill.style.width = Math.max(5, Math.min(100, score)) + '%';
        bar.appendChild(fill);
        scoreTd.appendChild(bar);

        tr.appendChild(nameTd);
        tr.appendChild(riskTd);
        tr.appendChild(scoreTd);
        tbody.appendChild(tr);
      }
      statusEl.textContent = 'Loaded ' + items.length + ' item(s).';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('name');
      const name = input.value.trim();
      if (!name) return;

      statusEl.textContent = 'Creating...';
      const res = await fetch('/rust/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        statusEl.textContent = 'Create failed.';
        return;
      }
      input.value = '';
      await loadItems();
      statusEl.textContent = 'Item created & scored.';
    });

    loadItems().catch(() => {
      statusEl.textContent = 'Failed to load items on init.';
    });
  </script>
</body>
</html>`)
})

/* ========================= DOCS ========================= */
function showDocs(c: any) {
  // default ON unless explicitly "0"
  return (c.env.SHOW_DOCS ?? '1') !== '0'
}

app.doc('/doc', {
  openapi: '3.1.0',
  info: { title: 'Edge API (Workers + D1)', version: '0.1.0' },
})

const docsUI = swaggerUI({ url: '/doc' })

app.get('/docs', async (c, next) => {
  if (!showDocs(c)) return c.text('docs disabled', 404)
  // swaggerUI is a middleware: (c, next) => Response | void
  const r = await (docsUI as any)(c, next)
  return r ?? c.text('docs handler returned no response', 500)
})
/* ========================= EXPORT ========================= */

app.get('/ui/*', async (c) => {
  const url = new URL(c.req.url)
  url.pathname = url.pathname.replace(/^\/ui/, '') || '/'
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
})

app.notFound(async (c) => {
  if (c.req.method !== 'GET') return c.text('Not Found', 404)

  const pathname = new URL(c.req.url).pathname
  const apiPrefixes = ['/v1', '/admin', '/docs', '/demo', '/metrics', '/debug', '/_warm', '/rust']
  if (apiPrefixes.some((p) => pathname.startsWith(p))) return c.text('Not Found', 404)

  // ✅ If assets binding isn't present (local misconfig), just 404
  if (!c.env.ASSETS) return c.text('Not Found', 404)

  const asset = await c.env.ASSETS.fetch(c.req.raw)
  if (asset.status !== 404) return asset

  return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)))
})

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const res = await app.fetch(req, env, ctx)

    if (res.status !== 404) return res

    const { pathname } = new URL(req.url)
    const apiPrefixes = ['/v1', '/admin', '/docs', '/demo', '/metrics', '/debug', '/_warm', '/rust']
    const isApiLike = apiPrefixes.some((p) => pathname.startsWith(p))

    if (!isApiLike && req.method === 'GET' && env.ASSETS?.fetch) {
      const assetRes = await env.ASSETS.fetch(req)


      if (assetRes.status !== 404) return assetRes

      return env.ASSETS.fetch(
        new Request(new URL('/index.html', req.url), req)
      )
    }

    return res
  },
} satisfies ExportedHandler<Env>

