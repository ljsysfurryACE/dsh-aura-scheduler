/**
 * Webhook trigger for dsh-aura-scheduler.
 *
 * Learned from EngramPulse: external callers can POST to wake the agent.
 * We add HMAC verification (EngramPulse's is optional) + rate limiting.
 *
 * Usage:
 *   const hooks = new WebhookHub({ secret })
 *   const url = await hooks.register('my-webhook', async (payload) => { ... })
 *   // POST /aura-webhook/my-webhook?token=...  → handler(payload)
 * @module @agentframe/dsh-aura-scheduler/webhook
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface WebhookHubOptions {
  /** HMAC secret shared with callers (default: auto-generated). */
  secret?: string
  /** Max calls per minute per hook (default 60). */
  rateLimit?: number
}

export interface WebhookHub {
  readonly secret: string
  register(name: string, handler: (payload: unknown) => Promise<void> | void): Promise<string>
  unregister(name: string): void
  /** Handle an incoming request body + auth header. Returns 200/401/429/404. */
  handle(name: string, signature: string | undefined, bodyText: string): Promise<number>
  list(): string[]
}

const encoder = new TextEncoder()

export function createWebhookHub(options: WebhookHubOptions = {}): WebhookHub {
  const secret = options.secret ?? randomSecret()
  const rateLimit = options.rateLimit ?? 60
  const handlers = new Map<string, (payload: unknown) => Promise<void> | void>()
  const calls = new Map<string, number[]>()
  const routes = new Map<string, string>()

  function checkRate(name: string): boolean {
    const now = Date.now()
    const window = now - 60_000
    const recent = (calls.get(name) ?? []).filter((t) => t > window)
    if (recent.length >= rateLimit) { calls.set(name, recent); return false }
    recent.push(now)
    calls.set(name, recent)
    return true
  }

  function verify(name: string, signature: string | undefined, bodyText: string): boolean {
    if (!signature) return false
    const expected = createHmac('sha256', secret).update(`${name}:${bodyText}`).digest('hex')
    try {
      const a = encoder.encode(signature)
      const b = encoder.encode(expected)
      return a.length === b.length && timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  return {
    get secret() { return secret },
    async register(name, handler) {
      const token = randomSecret(12)
      routes.set(name, token)
      handlers.set(name, handler)
      return `/aura-webhook/${encodeURIComponent(name)}?token=${token}`
    },
    unregister(name) {
      handlers.delete(name)
      routes.delete(name)
      calls.delete(name)
    },
    async handle(name, signature, bodyText) {
      if (!handlers.has(name)) return 404
      if (!checkRate(name)) return 429
      const token = routes.get(name)
      if (!token) return 404
      if (!verify(`${name}:${token}`, signature, bodyText)) return 401
      try {
        const payload = bodyText ? JSON.parse(bodyText) : {}
        await handlers.get(name)!(payload)
        return 200
      } catch {
        return 500
      }
    },
    list() { return [...handlers.keys()] },
  }
}

function randomSecret(len = 32): string {
  const bytes = new Uint8Array(len)
  // Use crypto.getRandomValues (browser-safe) — node:crypto imported lazily above.
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
