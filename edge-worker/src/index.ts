import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import { z, ZodError } from 'zod'
import { neon } from '@neondatabase/serverless'
import { Redis } from '@upstash/redis/cloudflare'

// Env bindings
type Env = {
  NEON_DATABASE_URL: string
  UPSTASH_REDIS_REST_URL: string
  UPSTASH_REDIS_REST_TOKEN: string
  RL_LIMIT?: string
  RL_WINDOW?: string
  DISABLE_RATE_LIMIT?: string
  API_KEY?: string
}

function requireApiKey(c: any) {
  const sent = c.req.header('x-api-key') || ''
  const want = c.env.API_KEY || ''
  return sent && want && sent === want
}

const app = new OpenAPIHono<{ Bindings: Env }>()
const ALLOW_ORIGINS = new Set<string>([
  'https://ooh-togglie.com',
  'http://localhost:5173',
])

app.use(
  '*',
  cors({
    // Hono typing expects (origin, ctx) => string | null | undefined
    origin: (origin: string | undefined) =>
      origin && ALLOW_ORIGINS.has(origin) ? origin : undefined,
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['content-type', 'x-api-key'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    credentials: false,
    maxAge: 86400,
  })
)

// minimal metrics
let HTTP_REQUESTS_TOTAL = 0;
let HTTP_401_TOTAL = 0;
let HTTP_429_TOTAL = 0;

const renderMetrics = () =>
  [
    '# HELP http_requests_total Total HTTP requests',
    '# TYPE http_requests_total counter',
    `http_requests_total ${HTTP_REQUESTS_TOTAL}`,
    '# HELP http_401_total Total 401 responses',
    '# TYPE http_401_total counter',
    `http_401_total ${HTTP_401_TOTAL}`,
    '# HELP http_429_total Total 429 responses',
    '# TYPE http_429_total counter',
    `http_429_total ${HTTP_429_TOTAL}`,
  ].join('\n') + '\n';

// rate limit helper
async function rateLimit(
  c: any,
  key: string,
  limit = 60,
  windowSec = 60
): Promise<{ ok: boolean; count: number; resetUnix: number }> {
  if (c.env.DISABLE_RATE_LIMIT === '1') {
    return { ok: true, count: 0, resetUnix: Math.ceil(Date.now() / 1000) + windowSec }
  }
  if (!c.env.UPSTASH_REDIS_REST_URL || !c.env.UPSTASH_REDIS_REST_TOKEN) {
    return { ok: true, count: 0, resetUnix: Math.ceil(Date.now() / 1000) + windowSec }
  }

  try {
    const redis = new Redis({ url: c.env.UPSTASH_REDIS_REST_URL, token: c.env.UPSTASH_REDIS_REST_TOKEN })
    const now = Math.floor(Date.now() / 1000)
    const windowKey = `rl:${key}:${Math.floor(now / windowSec)}`
    const count = await redis.incr(windowKey)
    if (count === 1) await redis.expire(windowKey, windowSec)
    const ok = count <= limit
    const resetUnix = Math.floor(now / windowSec) * windowSec + windowSec
    return { ok, count, resetUnix }
  } catch {
    return { ok: true, count: 0, resetUnix: Math.ceil(Date.now() / 1000) + windowSec }
  }
}

const json = (c: any, status: number, body: unknown) => {
  c.status(status);
  return c.json(body);
};
const Unauthorized = (c: any) => {
  HTTP_401_TOTAL++;
  bumpMetric(c, 'm:http_401_total');
  return json(c, 401, { error: 'Unauthorized' });
};

const tooMany = (c: any, retry: number) => {
  HTTP_429_TOTAL++;
  c.header('Retry-After', String(retry));
  bumpMetric(c, 'm:http_429_total');
  return json(c, 429, { error: 'Too Many Requests', retry_after: retry });
};
const getRedis = (c: any) => {
  if (!c.env.UPSTASH_REDIS_REST_URL || !c.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({ url: c.env.UPSTASH_REDIS_REST_URL, token: c.env.UPSTASH_REDIS_REST_TOKEN });
};

// fire-and-forget metric bump (never block requests)
const bumpMetric = (c: any, key: string) => {
  try {
    const r = getRedis(c);
    if (!r) return;
    // don’t await on purpose; log & forget
    r.incr(key).catch(() => {});
  } catch {}
};


// Schemas
const Item = z.object({ id: z.string().uuid(), name: z.string() })
const NewItem = z.object({ name: z.string().min(1).max(100) })

// Health
app.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['system'],
    responses: { 200: { description: 'OK' } },
  }),
  (c) => {
    HTTP_REQUESTS_TOTAL++
    return c.text('OK')
  }
)


// Metrics
app.openapi(
  createRoute({
    method: 'get',
    path: '/metrics',
    tags: ['system'],
    responses: { 200: { description: 'Prometheus metrics' } },
  }),
  async (c) => {
    HTTP_REQUESTS_TOTAL++;

    let r401 = 0, r429 = 0;
    try {
      const r = getRedis(c);
      if (r) {
        const [a, b] = await Promise.all([
          r.get<number>('m:http_401_total').catch(() => 0),
          r.get<number>('m:http_429_total').catch(() => 0),
        ]);
        r401 = Number(a || 0);
        r429 = Number(b || 0);
      }
    } catch {
      // ignore — we still serve in-memory metrics
    }

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
        '# HELP http_401_total_durable Total 401 responses (durable)',
        '# TYPE http_401_total_durable counter',
        `http_401_total_durable ${r401}`,
        '# HELP http_429_total_durable Total 429 responses (durable)',
        '# TYPE http_429_total_durable counter',
        `http_429_total_durable ${r429}`,
      ].join('\n') + '\n';

    return c.text(body);
  }
);



// GET /v1/items
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
    if (!requireApiKey(c)) return Unauthorized(c);

    const qs = z.object({
      limit:  z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(c.req.query());

    // Rate limit key: prefer API key, fallback to IP
    const who    = c.req.header('x-api-key') || c.req.header('cf-connecting-ip') || 'anon';
    const LIMIT  = Number(c.env.RL_LIMIT  ?? 60);
    const WINDOW = Number(c.env.RL_WINDOW ?? 60);
    const { ok, count, resetUnix } = await rateLimit(c, `items:${who}`, LIMIT, WINDOW);
    const remaining = Math.max(0, LIMIT - count);

    // Always emit rate-limit headers
    c.header('X-RateLimit-Limit',     String(LIMIT));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset',     String(resetUnix));
    if (!ok) {
      c.header('Retry-After', String(WINDOW));
      return tooMany(c, WINDOW);
    }

    // Query with pagination
    const sql = neon(c.env.NEON_DATABASE_URL);
    const rows = await sql`
      SELECT id::text, name
      FROM items
      ORDER BY created_at DESC
      LIMIT ${qs.limit} OFFSET ${qs.offset}
    `;

    // You defined OpenAPI response as array<Item>; return rows directly
    return c.json(rows);
  }
);

// POST /v1/items
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/items',
    tags: ['items'],
    request: { body: { content: { 'application/json': { schema: NewItem } } } },
    responses: {
      200: { description: 'Created', content: { 'application/json': { schema: Item } } },
      401: { description: 'Unauthorized' },
      400: { description: 'Invalid body' },
      415: { description: 'Unsupported Media Type' },
      413: { description: 'Payload Too Large' },
      429: { description: 'Rate limited' },
    },
  }),
  async (c) => {
    try {
      HTTP_REQUESTS_TOTAL++;
      if (!requireApiKey(c)) return Unauthorized(c);

      const who     = c.req.header('x-api-key') || c.req.header('cf-connecting-ip') || 'anon';
      const LIMIT   = Number(c.env.RL_LIMIT  ?? 60);
      const WINDOW  = Number(c.env.RL_WINDOW ?? 60);

      const { ok, count, resetUnix } = await rateLimit(c, `items:${who}`, LIMIT, WINDOW);
      const remaining = Math.max(0, LIMIT - count);

      // Always emit rate-limit headers
      c.header('X-RateLimit-Limit',     String(LIMIT));
      c.header('X-RateLimit-Remaining', String(remaining));
      c.header('X-RateLimit-Reset',     String(resetUnix));

      if (!ok) {
        return tooMany(c, WINDOW); // bumps 429 metric + sets Retry-After
      }

      // Content-Type guard
      const ct = (c.req.header('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) {
        return json(c, 415, { error: 'Unsupported Media Type' });
      }

      // Hard body-size cap (10 KB)
      const raw = await c.req.text();
      if (raw.length > 10_000) {
        return json(c, 413, { error: 'Payload Too Large', max: 10_000 });
      }

      // Parse + validate
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        return json(c, 400, { error: 'Invalid JSON' });
      }
      const parsed = NewItem.parse(parsedBody);

      // Insert
      const sql = neon(c.env.NEON_DATABASE_URL);
      const rows = await sql`
        INSERT INTO items (id, name)
        VALUES (gen_random_uuid(), ${parsed.name})
        RETURNING id::text, name
      `;
      return c.json(rows[0]);
    } catch (e) {
      if (e instanceof ZodError) {
        return json(c, 400, { success: false, error: e });
      }
      return json(c, 500, { error: 'Server error' });
    }
  }
);

// Docs (single block)
app.doc('/doc', {
  openapi: '3.1.0',
  info: { title: 'Edge API (Workers + Neon + Upstash)', version: '0.1.0' },
})
app.get('/docs', swaggerUI({ url: '/doc' }))

const IdParam = z.object({ id: z.string().uuid() });

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/items/{id}',
    tags: ['items'],
    request: { params: IdParam },
    responses: { 204: { description: 'Deleted' }, 401: { description: 'Unauthorized' } },
  }),
  async (c) => {
    if (!requireApiKey(c)) return Unauthorized(c);
    const { id } = IdParam.parse(c.req.param());
    const sql = neon(c.env.NEON_DATABASE_URL);
    await sql`DELETE FROM items WHERE id = ${id}::uuid`;
    return c.body(null, 204);
  }
);



export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
}


//  DEBUG: DB connectivity
// app.get('/debug/db', async (c) => {
//   try {
//     const sql = neon(c.env.NEON_DATABASE_URL)
//     const r = await sql`select now() as ts`
//     return c.json({ ok: true, ts: r[0].ts })
//   } catch (err: any) {
//     console.error('DEBUG DB failed:', err?.message || err)
//     return c.json({ ok: false, error: String(err) }, 500)
//   }
// })

// //  DEBUG: Redis connectivity
// app.get('/debug/redis', async (c) => {
//   try {
//     const url = c.env.UPSTASH_REDIS_REST_URL
//     const token = c.env.UPSTASH_REDIS_REST_TOKEN
//     if (!url || !token) return c.json({ ok: false, error: 'Upstash secrets not set' }, 500)
//     const redis = new Redis({ url, token })
//     const n = await redis.incr('debug:ping')
//     await redis.expire('debug:ping', 60)
//     return c.json({ ok: true, counter: n })
//   } catch (err: any) {
//     console.error('DEBUG Redis failed:', err?.message || err)
//     return c.json({ ok: false, error: String(err) }, 500)
//   }
// })

// export default app
