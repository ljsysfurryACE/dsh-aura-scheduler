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
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SensorEngine, type SensorSpec } from './sensors.js';
import { type WebhookHub } from './webhook.js';
export interface AuraSchedulerConfig {
    /** Minimum interval between proactive messages (seconds). */
    minInterval: number;
    /** Maximum interval (seconds). */
    maxInterval: number;
    /** Quiet hours: [startHour, endHour] in 24h, e.g. [23, 8]. */
    quietHours: [number, number];
    /** Alpha (urgency weight), beta (relevance), delta (interruption penalty). */
    alpha: number;
    beta: number;
    relevance: number;
    delta: number;
    /** Cooldown after last proactive message (seconds). */
    cooldown: number;
    /** Callback invoked when the agent should proactively speak. */
    onProactive: string;
    /** Auto-start the heartbeat. */
    auto: boolean;
    /** Sensors: array of SensorSpec, e.g. [{kind:'file',target:'/tmp/x',intervalSeconds:30}] */
    sensors: SensorSpec[];
    /** Webhook secret (optional, auto-generated if absent). */
    webhookSecret: string;
    /** Off-peak window: [startHour, endHour] when proactive is CHEAPER, e.g. [2,7]. */
    offPeakHours: [number, number];
    /** Only act during off-peak when true (save money mode). */
    offPeakOnly: boolean;
}
/**
 * AuraSchedulerService — exposes ctx.aura (schedule/tick/status/sensors/webhook).
 */
export declare class AuraSchedulerService {
    static inject: string[];
    static Config: z<AuraSchedulerConfig>;
    readonly config: AuraSchedulerConfig;
    readonly webhook: WebhookHub;
    readonly sensors: SensorEngine;
    private timer;
    private sensorTimer;
    private lastProactiveAt;
    private heartbeatCount;
    private proactiveCount;
    private sensorFires;
    private webhookFires;
    private readonly ctx;
    constructor(ctx: Context, config?: Partial<AuraSchedulerConfig>);
    start(): void;
    stop(): void;
    status(): Record<string, unknown>;
    /** Force a proactive tick (useful for tests / manual trigger). */
    tickNow(): Promise<boolean>;
    /** Register a webhook trigger. Returns the URL to POST to. */
    addWebhook(name: string, task: string): Promise<string>;
    private _startSensors;
    private _tick;
    /** Aura value network + heartbeat policy. */
    private _shouldAct;
    private _maybeProactive;
    private _inQuietHours;
    private _inOffPeak;
    private _interruptionCost;
}
export default AuraSchedulerService;
