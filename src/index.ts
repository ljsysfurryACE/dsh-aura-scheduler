/**
 * dsh-aura-scheduler v2 — proactive scheduling for DeepSeek Harness.
 *
 * v2 upgrades (learned from ecosystem competitors):
 *   - dsh-sentinel:    file/process/http/port sensors (watch → trigger)
 *   - EngramPulse:     webhook trigger (HMAC-verified, rate-limited)
 *   - dsh-automations: off-peak window (save money on DeepSeek pricing)
 *
 * Core value network (unchanged): V = α·urgency + β·relevance − δ·interruption
 * The system decides when the agent should proactively reach out — not the model.
 *
 * @module @agentframe/dsh-aura-scheduler
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SensorEngine, type SensorSpec } from './sensors.js'
import { createWebhookHub, type WebhookHub } from './webhook.js'

export interface AuraSchedulerConfig {
  /** Minimum interval between proactive messages (seconds). */
  minInterval: number
  /** Maximum interval (seconds). */
  maxInterval: number
  /** Quiet hours: [startHour, endHour] in 24h, e.g. [23, 8]. */
  quietHours: [number, number]
  /** Alpha (urgency weight), beta (relevance), delta (interruption penalty). */
  alpha: number
  beta: number
  relevance: number
  delta: number
  /** Cooldown after last proactive message (seconds). */
  cooldown: number
  /** Callback invoked when the agent should proactively speak. */
  onProactive: string
  /** Auto-start the heartbeat. */
  auto: boolean
  /** Sensors: array of SensorSpec, e.g. [{kind:'file',target:'/tmp/x',intervalSeconds:30}] */
  sensors: SensorSpec[]
  /** Webhook secret (optional, auto-generated if absent). */
  webhookSecret: string
  /** Off-peak window: [startHour, endHour] when proactive is CHEAPER, e.g. [2,7]. */
  offPeakHours: [number, number]
  /** Only act during off-peak when true (save money mode). */
  offPeakOnly: boolean
}

const DEFAULT_CONFIG: AuraSchedulerConfig = {
  minInterval: 1800,
  maxInterval: 7200,
  quietHours: [23, 8],
  alpha: 0.4,
  beta: 0.4,
  relevance: 0.5,
  delta: 0.2,
  cooldown: 600,
  onProactive: '',
  auto: true,
  sensors: [],
  webhookSecret: '',
  offPeakHours: [2, 7],
  offPeakOnly: false,
}

/**
 * AuraSchedulerService — exposes ctx.aura (schedule/tick/status/sensors/webhook).
 */
export class AuraSchedulerService {
  static inject: string[] = []

  static Config: z<AuraSchedulerConfig> = z.object({
    minInterval: z.number().default(1800),
    maxInterval: z.number().default(7200),
    quietHours: z.tuple([z.number(), z.number()]).default([23, 8] as [number, number]),
    alpha: z.number().default(0.4),
    beta: z.number().default(0.4),
    relevance: z.number().default(0.5),
    delta: z.number().default(0.2),
    cooldown: z.number().default(600),
    onProactive: z.string().default(''),
    auto: z.boolean().default(true),
    sensors: z.array(z.object({
      kind: z.string().default('file'),
      target: z.string().default(''),
      pattern: z.string().default(''),
      intervalSeconds: z.number().default(30),
    })).default([]),
    webhookSecret: z.string().default(''),
    offPeakHours: z.tuple([z.number(), z.number()]).default([2, 7] as [number, number]),
    offPeakOnly: z.boolean().default(false),
  })

  readonly config: AuraSchedulerConfig
  readonly webhook: WebhookHub
  readonly sensors: SensorEngine

  private timer: ReturnType<typeof setInterval> | null = null
  private sensorTimer: ReturnType<typeof setInterval> | null = null
  private lastProactiveAt = 0
  private heartbeatCount = 0
  private proactiveCount = 0
  private sensorFires: Record<string, number> = {}
  private webhookFires = 0
  private readonly ctx: Context

  constructor(ctx: Context, config: Partial<AuraSchedulerConfig> = {}) {
    this.ctx = ctx
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.sensors = new SensorEngine()
    this.webhook = createWebhookHub({ secret: this.config.webhookSecret || undefined })
    ;(ctx as any).provide?.('aura')
    ctx.set('aura', this)
    if (this.config.auto) this.start()
  }

  // ===== Public API (ctx.aura) =====

  start(): void {
    if (this.timer) return
    this._tick() // immediate first check
    this.timer = setInterval(() => this._tick(), 60_000)
    if (this.config.sensors.length > 0) this._startSensors()
    this.ctx.logger.info(
      `[aura] started: ${this.config.minInterval / 60}-${this.config.maxInterval / 60}min heartbeat, quiet ${this.config.quietHours[0]}:00-${this.config.quietHours[1]}:00` +
      (this.config.sensors.length ? `, ${this.config.sensors.length} sensors` : '') +
      (this.config.offPeakOnly ? `, off-peak only ${this.config.offPeakHours[0]}:00-${this.config.offPeakHours[1]}:00` : ''),
    )
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.sensorTimer) { clearInterval(this.sensorTimer); this.sensorTimer = null }
  }

  status(): Record<string, unknown> {
    return {
      running: this.timer !== null,
      heartbeatCount: this.heartbeatCount,
      proactiveCount: this.proactiveCount,
      lastProactiveAt: this.lastProactiveAt,
      sensorFires: this.sensorFires,
      webhookFires: this.webhookFires,
      webhookRoutes: this.webhook.list(),
      offPeak: this._inOffPeak(),
      config: this.config,
    }
  }

  /** Force a proactive tick (useful for tests / manual trigger). */
  async tickNow(): Promise<boolean> {
    return this._maybeProactive(true)
  }

  /** Register a webhook trigger. Returns the URL to POST to. */
  async addWebhook(name: string, task: string): Promise<string> {
    const url = await this.webhook.register(name, async (payload) => {
      this.webhookFires++
      this.ctx.logger.info(`[aura] webhook "${name}" fired, task: ${task}`)
      await this._maybeProactive(true, { source: 'webhook', name, payload })
    })
    this.ctx.logger.info(`[aura] webhook route added: ${url}`)
    return url
  }

  // ===== Internals =====

  private _startSensors(): void {
    if (this.sensorTimer) return
    // Probe each sensor on its own interval (clamped 5s..86400s).
    for (const spec of this.config.sensors) {
      const interval = Math.max(5, Math.min(spec.intervalSeconds, 86400)) * 1000
      const probe = () => {
        void this.sensors.probe(spec).then((fired) => {
          if (fired) {
            this.sensorFires[`${spec.kind}:${spec.target}`] = (this.sensorFires[`${spec.kind}:${spec.target}`] ?? 0) + 1
            this.ctx.logger.info(`[aura] sensor fired: ${spec.kind}:${spec.target}`)
            void this._maybeProactive(false, { source: 'sensor', kind: spec.kind, target: spec.target })
          }
        })
      }
      probe() // baseline
      const id = setInterval(probe, interval)
      // Track for cleanup (single timer holder is fine for v2; multiple intervals ok).
      ;(this as any)._sensorTimers = (this as any)._sensorTimers ?? []
      ;(this as any)._sensorTimers.push(id)
    }
  }

  private _tick(): void {
    this.heartbeatCount++
    void this._maybeProactive(false)
  }

  /** Aura value network + heartbeat policy. */
  private _shouldAct(force: boolean): boolean {
    const now = Date.now()

    // Quiet hours (force bypasses).
    if (!force && this._inQuietHours()) {
      this.ctx.logger.info('[aura] quiet hours, skip')
      return false
    }

    // Off-peak only mode (force bypasses).
    if (!force && this.config.offPeakOnly && !this._inOffPeak()) {
      this.ctx.logger.info('[aura] off-peak only mode, waiting for cheaper window')
      return false
    }

    // Cooldown (force bypasses).
    if (!force && now - this.lastProactiveAt < this.config.cooldown * 1000) {
      return false
    }

    // Adaptive heartbeat: idle longer → higher eagerness.
    const idleRatio = Math.min((now - this.lastProactiveAt) / 1000 / this.config.maxInterval, 1)
    const eagerness = this.config.alpha * idleRatio + this.config.beta * this.config.relevance
    const interruption = this.config.delta * this._interruptionCost()

    // Value network: V = α·urgency + β·relevance − δ·interruption
    const value = eagerness - interruption
    this.ctx.logger.debug(`[aura] value=${value.toFixed(3)} (eager=${eagerness.toFixed(3)} intr=${interruption.toFixed(3)})`)

    if (force) return value > -0.1
    // Act when value crosses the bar OR heartbeat exceeded max interval.
    const overdue = now - this.lastProactiveAt > this.config.maxInterval * 1000
    return value > 0.2 || overdue
  }

  private async _maybeProactive(force: boolean, meta: Record<string, unknown> = {}): Promise<boolean> {
    if (!this._shouldAct(force)) return false
    this.lastProactiveAt = Date.now()
    this.proactiveCount++

    const event = { at: new Date().toISOString(), source: meta.source ?? 'heartbeat', ...meta }

    // Deliver via configured callback (e.g. "notify" event or a webhook URL).
    const cb = this.config.onProactive
    if (cb) {
      try {
        if (cb.startsWith('http')) {
          await fetch(cb, { method: 'POST', body: JSON.stringify({ event: 'proactive', ...event }) })
        } else {
          this.ctx.emit(cb as any, event)
        }
        this.ctx.logger.info(`[aura] proactive #${this.proactiveCount} delivered via ${cb}`)
      } catch (e) {
        this.ctx.logger.warn('[aura] proactive delivery failed:', e)
      }
    } else {
      this.ctx.logger.info(`[aura] proactive #${this.proactiveCount} (${event.source})`)
    }
    return true
  }

  private _inQuietHours(): boolean {
    const h = new Date().getHours()
    const [start, end] = this.config.quietHours
    if (start < end) return h >= start && h < end
    return h >= start || h < end
  }

  private _inOffPeak(): boolean {
    const h = new Date().getHours()
    const [start, end] = this.config.offPeakHours
    if (start < end) return h >= start && h < end
    return h >= start || h < end
  }

  private _interruptionCost(): number {
    // Placeholder: could read session activity / user presence.
    return 0.3
  }
}

export default AuraSchedulerService
