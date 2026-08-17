"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebhookHub = createWebhookHub;
const node_crypto_1 = require("node:crypto");
const encoder = new TextEncoder();
function createWebhookHub(options = {}) {
    const secret = options.secret ?? randomSecret();
    const rateLimit = options.rateLimit ?? 60;
    const handlers = new Map();
    const calls = new Map();
    const routes = new Map();
    function checkRate(name) {
        const now = Date.now();
        const window = now - 60_000;
        const recent = (calls.get(name) ?? []).filter((t) => t > window);
        if (recent.length >= rateLimit) {
            calls.set(name, recent);
            return false;
        }
        recent.push(now);
        calls.set(name, recent);
        return true;
    }
    function verify(name, signature, bodyText) {
        if (!signature)
            return false;
        const expected = (0, node_crypto_1.createHmac)('sha256', secret).update(`${name}:${bodyText}`).digest('hex');
        try {
            const a = encoder.encode(signature);
            const b = encoder.encode(expected);
            return a.length === b.length && (0, node_crypto_1.timingSafeEqual)(a, b);
        }
        catch {
            return false;
        }
    }
    return {
        get secret() { return secret; },
        async register(name, handler) {
            const token = randomSecret(12);
            routes.set(name, token);
            handlers.set(name, handler);
            return `/aura-webhook/${encodeURIComponent(name)}?token=${token}`;
        },
        unregister(name) {
            handlers.delete(name);
            routes.delete(name);
            calls.delete(name);
        },
        async handle(name, signature, bodyText) {
            if (!handlers.has(name))
                return 404;
            if (!checkRate(name))
                return 429;
            const token = routes.get(name);
            if (!token)
                return 404;
            if (!verify(`${name}:${token}`, signature, bodyText))
                return 401;
            try {
                const payload = bodyText ? JSON.parse(bodyText) : {};
                await handlers.get(name)(payload);
                return 200;
            }
            catch {
                return 500;
            }
        },
        list() { return [...handlers.keys()]; },
    };
}
function randomSecret(len = 32) {
    const bytes = new Uint8Array(len);
    // Use crypto.getRandomValues (browser-safe) — node:crypto imported lazily above.
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
