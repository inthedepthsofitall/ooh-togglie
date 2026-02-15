export type EdgeItem = {
  id: string
  name: string
  risk_level?: 'LOW' | 'MEDIUM' | 'HIGH'
  risk_score?: number
}

export type PaginationMeta = {
  limit: number
  offset: number
  rlLimit: number
  rlRemaining: number
  rlReset: number
}

export type ListItemsResult = {
  data: EdgeItem[]
  meta: PaginationMeta
}

export type CreateItemResult = {
  item: EdgeItem
  location: string | null
}

// --- ENV (browser) ---
// Option A: Vite-style: import.meta.env.VITE_EDGE_API_...
// Option B: runtime injection: window.__EDGE_API_KEY / window.__EDGE_API_BASE (no rebuild)

function getBase(): string {
  const injected =
    typeof window !== 'undefined' ? ((window as any).__EDGE_API_BASE as string | undefined) : undefined
  if (injected && injected.trim()) return injected.trim().replace(/\/+$/, '')

  const viteBase = (import.meta as any)?.env?.VITE_EDGE_API_BASE as string | undefined
  if (viteBase && viteBase.trim()) return viteBase.trim().replace(/\/+$/, '')

  return 'https://edge-api.aihof757.workers.dev'

}

function getApiKey(): string {
  const injected =
    typeof window !== 'undefined' ? ((window as any).__EDGE_API_KEY as string | undefined) : undefined
  if (injected && injected.trim()) return injected.trim()

  const viteKey = (import.meta as any)?.env?.VITE_EDGE_API_KEY as string | undefined
  if (viteKey && viteKey.trim()) return viteKey.trim()

  return ''
}

async function readErrorBody(r: Response): Promise<string> {
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  try {
    if (ct.includes('application/json')) return JSON.stringify(await r.json())
    return await r.text()
  } catch {
    return ''
  }
}

function assertKey(apiKey: string) {
  if (!apiKey) {
    throw new Error(
      'Missing API key. Set VITE_EDGE_API_KEY (Vite) or inject window.__EDGE_API_KEY at runtime.'
    )
  }
}

export async function listItems(limit = 25, offset = 0): Promise<ListItemsResult> {
  const BASE = getBase()
  const API_KEY = getApiKey()
  assertKey(API_KEY)

  const url = new URL('/v1/items', BASE)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('offset', String(offset))

  const r = await fetch(url.toString(), { headers: { 'x-api-key': API_KEY } })

  if (!r.ok) {
    const body = await readErrorBody(r)
    throw new Error(`List failed: ${r.status}${body ? ` :: ${body}` : ''}`)
  }

  const data = (await r.json()) as EdgeItem[]

  const meta: PaginationMeta = {
    limit: Number(r.headers.get('x-pagination-limit') ?? limit),
    offset: Number(r.headers.get('x-pagination-offset') ?? offset),
    rlLimit: Number(r.headers.get('x-ratelimit-limit') ?? 0),
    rlRemaining: Number(r.headers.get('x-ratelimit-remaining') ?? 0),
    rlReset: Number(r.headers.get('x-ratelimit-reset') ?? 0),
  }

  return { data, meta }
}

export async function createItem(name: string): Promise<CreateItemResult> {
  const BASE = getBase()
  const API_KEY = getApiKey()
  assertKey(API_KEY)

  const r = await fetch(new URL('/v1/items', BASE).toString(), {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })

  if (r.status === 201) {
    return { item: (await r.json()) as EdgeItem, location: r.headers.get('location') }
  }

  const body = await readErrorBody(r)
  throw new Error(`Create failed: ${r.status}${body ? ` :: ${body}` : ''}`)
}
