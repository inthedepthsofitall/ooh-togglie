import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { neon } from '@neondatabase/serverless'
import { Redis } from '@upstash/redis'
import { Registry, Counter } from 'promjs'
import { z } from 'zod'
import { OpenAPIHono, createRoute, z as zodOpenApi, OpenAPIObjectBuilder } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'


// Env bindings
type Env = {
NEON_DATABASE_URL: string
UPSTASH_REDIS_REST_URL: string
UPSTASH_REDIS_REST_TOKEN: string
}


// App + CORS
const app = new OpenAPIHono<{ Bindings: Env }>()
app.use('*', cors())


// Metrics
const registry = new Registry()
const httpRequests = new Counter({ name: 'http_requests_total', help: 'Total HTTP requests' })
registry.register(httpRequests)


// Simple fixed-window rate limit via Upstash
async function rateLimit(redis: Redis, key: string, limit = 60, windowSec = 60) {
const now = Math.floor(Date.now() / 1000)
const windowKey = `rl:${key}:${Math.floor(now / windowSec)}`
const count = await redis.incr(windowKey)
if (count === 1) await redis.expire(windowKey, windowSec)
return count <= limit
}


// Schemas
const Item = z.object({ id: z.string().uuid(), name: z.string() })
const NewItem = z.object({ name: z.string().min(1).max(100) })


// Routes (OpenAPI)
app.openapi(
createRoute({
method: 'get', path: '/health', tags: ['system'],
responses: { 200: { description: 'OK' } },
}),
(c) => { httpRequests.inc(); return c.text('OK') }
)


app.openapi(
createRoute({
method: 'get', path: '/metrics', tags: ['system'],
responses: { 200: { description: 'Prometheus metrics' } },
}),
async (c) => { httpRequests.inc(); return c.text(registry.metrics()) }
)


app.openapi(
createRoute({
method: 'get', path: '/v1/items', tags: ['items'],
responses: {
200: { description: 'List items', content: { 'application/json': { schema: z.array(Item) } } },
429: { description: 'Rate limited' },
export default app