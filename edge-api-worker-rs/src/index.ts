import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
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
  enabled: number
  version: number
  updated_at: string
}
type FlagEvalRow = { key: string; enabled: number; version: number }

/* ========================= UTILS ========================= */

function apiKeyMatches(c: any) {
  const sent = c.req.header('x-api-key') || ''
  const want = c.env.API_KEY || c.env.EDGE_API_KEY || ''
  return !!sent && !!want && sent === want
}

function demoOn(c: any) {
  return (c.env.DEMO_MODE || '') === '1'
}

function showDocs(c: any) {
  return (c.env.SHOW_DOCS ?? '1') !== '0'
}

/* ========================= RATE LIMIT (IN-MEM) ========================= */

const rlBuckets = new Map<string, { count: number; resetUnix: number }>()
async function rateLimit(c: any, key: string, limit: number, windowSec: number) {
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

/* ========================= APP + CORS ========================= */

const app = new OpenAPIHono<{ Bindings: Env }>()

const ALLOW_ORIGINS = new Set<string>([
  'https://edge-api.aihof757.workers.dev',
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

/* ========================= STATIC UI =========================
   Serve site/index.html at / and also allow /ui/... paths.
*/

app.get('/', async (c) => {
  if (!c.env.ASSETS?.fetch) return c.text('assets not configured', 500)
  const url = new URL(c.req.url)
  url.pathname = '/index.html'
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
})

app.get('/ui/*', async (c) => {
  if (!c.env.ASSETS?.fetch) return c.text('assets not configured', 500)
  const url = new URL(c.req.url)
  // /ui/ -> /, /ui/foo -> /foo
  url.pathname = url.pathname.replace(/^\/ui/, '') || '/'
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
})

/* ========================= SCHEMAS ========================= */

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
    if (!apiKeyMatches(c)) return c.json({ error: 'Unauthorized' }, 401)


    const rows = await d1All<FlagRow>(
      c,
      `SELECT id, key, description, enabled, version, updated_at
       FROM flags
       ORDER BY updated_at DESC
       LIMIT 200`
    )

    return c.json(rows.map((r) => ({ ...r, enabled: !!r.enabled })))
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
    if (!apiKeyMatches(c)) return c.json({ error: 'Unauthorized' }, 401)

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

      return c.json({ ...(row as any), enabled: !!(row?.enabled ?? enabled) }, 201)
    } catch (e: any) {
      if (e instanceof ZodError) return c.json({ error: e.errors }, 400)
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
    if (!apiKeyMatches(c)) return c.json({ error: 'Unauthorized' }, 401)

    const key = c.req.param('key')
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

/* ========================= EVALUATE ========================= */

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
    if (!apiKeyMatches(c)) return c.json({ error: 'Unauthorized' }, 401)

    const { flag_key, user } = EvalReq.parse(await c.req.json())

    const LIMIT = Number(c.env.RL_LIMIT ?? 60)
    const WINDOW = Number(c.env.RL_WINDOW ?? 60)
    const caller = c.req.header('x-api-key') || c.req.header('cf-connecting-ip') || 'anon'
    const rl = await rateLimit(c, `eval:${caller}`, LIMIT, WINDOW)

    c.header('X-RateLimit-Limit', String(LIMIT))
    c.header('X-RateLimit-Remaining', String(Math.max(0, LIMIT - rl.count)))
    c.header('X-RateLimit-Reset', String(rl.resetUnix))
    if (!rl.ok) return c.json({ error: 'Too Many Requests' }, 429)

    const flag = await d1First<FlagEvalRow>(c, `SELECT key, enabled, version FROM flags WHERE key = ? LIMIT 1`, [flag_key])
    if (!flag) return c.json({ error: 'Not found' }, 404)

    const pct = Math.max(0, Math.min(100, Number(c.env.ROLLOUT_PCT ?? 100)))
    const uid = user?.id ?? 'anon'
    const hash = Math.abs([...uid].reduce((a, ch) => (((a << 5) - a) + ch.charCodeAt(0)) | 0, 0)) % 100
    const enabled = !!flag.enabled && hash < pct

    return c.json({
      key: flag.key,
      enabled,
      version: flag.version,
      reason: `rollout_${pct}%`,
    })
  }
)

/* ========================= DEMO ========================= */

app.get('/demo/eval', async (c) => {
  if (!demoOn(c)) return c.json({ error: 'demo disabled' }, 404)

  const qs = z
    .object({ flag: z.string().min(1), user: z.string().min(1) })
    .parse(Object.fromEntries(new URL(c.req.url).searchParams))

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
})

/* ========================= DOCS ========================= */

app.doc('/doc', {
  openapi: '3.1.0',
  info: { title: 'Edge API (Workers + D1)', version: '0.1.0' },
})

const docsUI = swaggerUI({ url: '/doc' })
app.get('/docs', async (c, next) => {
  if (!showDocs(c)) return c.text('docs disabled', 404)
  const r = await (docsUI as any)(c, next)
  return r ?? c.text('docs handler returned no response', 500)
})

app.get('/debug/env', (c) => {
  const key = (c.env.API_KEY || c.env.EDGE_API_KEY || '')
  return c.json({
    has_API_KEY: !!c.env.API_KEY,
    has_EDGE_API_KEY: !!c.env.EDGE_API_KEY,
    key_prefix: key.slice(0, 8),
    DEMO_MODE: c.env.DEMO_MODE,
    SHOW_ADMIN: c.env.SHOW_ADMIN,
    SHOW_DOCS: c.env.SHOW_DOCS,
  })
})


/* ========================= EXPORT ========================= */

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    // IMPORTANT: no Hello World, ever.
    return app.fetch(req, env, ctx)
  },
}
