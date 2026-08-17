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
export interface WebhookHubOptions {
    /** HMAC secret shared with callers (default: auto-generated). */
    secret?: string;
    /** Max calls per minute per hook (default 60). */
    rateLimit?: number;
}
export interface WebhookHub {
    readonly secret: string;
    register(name: string, handler: (payload: unknown) => Promise<void> | void): Promise<string>;
    unregister(name: string): void;
    /** Handle an incoming request body + auth header. Returns 200/401/429/404. */
    handle(name: string, signature: string | undefined, bodyText: string): Promise<number>;
    list(): string[];
}
export declare function createWebhookHub(options?: WebhookHubOptions): WebhookHub;
