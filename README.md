# Edge API — Feature Flags on Cloudflare Workers

A **minimal, edge-native feature-flag service** built on **Cloudflare Workers** with a **Neon Postgres** backend.

It supports deterministic percentage-based rollouts, strict API authentication for production, and a public demo UI that lets anyone test flag evaluations in real time.

This project is intentionally small, fast, and production-lean.

---

## Architecture Overview

This service runs entirely at the Cloudflare edge.

- **Client / Demo UI**
  - Static HTML served via Workers assets
  - Calls `/demo/eval` for public, no-auth evaluations

- **Edge API (Cloudflare Workers + Hono)**
  - Validates requests
  - Enforces API key auth for production routes
  - Computes rollout decisions deterministically
  - Emits rate-limit headers

- **Database (Neon Postgres)**
  - Stores feature flags and versions
  - Accessed via serverless HTTP driver

Demo traffic never exposes secrets; production traffic always requires `x-api-key`.

---

## Live Deployment (workers.dev)

- **API root**
  https://edge-api.aihof757.workers.dev/

- **Demo UI (public, no auth)**
  https://edge-api.aihof757.workers.dev/demo

- **OpenAPI spec**
  `GET /doc`

- **Environment debug (demo-safe)**
  `GET /debug/env`

> No custom domain is used on purpose — this is a frictionless public demo running entirely on Workers.

---

## Highlights

- **Percent rollouts**
  Stable hash of `user.id` → deterministic enable/disable decisions
  Controlled by `ROLLOUT_PCT` (0–100)

- **Edge-native performance**
  Hono + Cloudflare Workers (global execution, no server cold starts)

- **Demo-friendly auth model**
  - Production routes require `x-api-key`
  - Demo routes work without secrets when `DEMO_MODE=1`

- **Rate-limit visibility**
  `X-RateLimit-*` headers exposed on evaluation paths

- **Schema-first API**
  OpenAPI generated directly from Zod schemas

- **Static demo UI**
  Served via Workers assets (no frontend build step)

---

## Auth Model

| Route Type        | Auth Required |
|------------------|---------------|
| `/v1/flags/*`     | `x-api-key` |
| `/v1/evaluate`   | `x-api-key` (skipped in demo mode) |
| `/demo/*`        | Public (demo only) |
| `/docs`          | Optional |
| `/debug/env`     | Demo-safe |

This allows safe public demos while keeping production APIs locked.

---

## Core API Endpoints

### Flag Management (auth required)

```

GET  /v1/flags
POST /v1/flags
PUT  /v1/flags/{key}

```

### Evaluation (production)

```

POST /v1/evaluate

````

**Request**
```json
{
  "flag_key": "welcome_banner",
  "user": { "id": "user-123" }
}
````

**Response**

```json
{
  "key": "welcome_banner",
  "enabled": true,
  "version": 1,
  "reason": "rollout_100%"
}
```

---

## Demo Evaluation (no auth)

```
GET /demo/eval?flag=welcome_banner&user=user-123
```

Returns the same evaluation result plus rate-limit headers.

---

## Curl Examples

```bash
# Create a flag (production)
curl -X POST "https://edge-api.aihof757.workers.dev/v1/flags" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"key":"welcome_banner","enabled":true}'
```

```bash
# Evaluate (production)
curl -X POST "https://edge-api.aihof757.workers.dev/v1/evaluate" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"flag_key":"welcome_banner","user":{"id":"user-123"}}'
```

```bash
# Evaluate (demo, no auth)
curl "https://edge-api.aihof757.workers.dev/demo/eval?flag=welcome_banner&user=user-123"
```

---

## How Percent Rollout Works

1. Read `ROLLOUT_PCT` (default: 100)
2. Hash `user.id` into a stable value `0–99`
3. Enable the flag if:

   * The flag itself is enabled
   * `hash < ROLLOUT_PCT`

This guarantees consistent behavior per user across requests.

---

## Tech Stack

* **Runtime:** Cloudflare Workers (Hono)
* **Database:** Neon Postgres (serverless HTTP driver)
* **Validation:** TypeScript + Zod
* **API Docs:** OpenAPI (`/doc`)
* **Static UI:** Workers assets binding
* **Rate limiting:** In-memory (Upstash optional)

---

## Local Development

```bash
npm install
npm run dev
```

```bash
npm run deploy
```

---

## Secrets (production only)

```bash
npx wrangler secret put API_KEY
npx wrangler secret put NEON_DATABASE_URL
```

Optional:

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

---

## Why this project exists

This project demonstrates:

* Edge-first backend design
* Real-world auth tradeoffs (demo vs production)
* Deterministic rollout logic
* Clean API contracts
* Practical Cloudflare Workers usage

This is deployable infrastructure, not a toy example.

```

