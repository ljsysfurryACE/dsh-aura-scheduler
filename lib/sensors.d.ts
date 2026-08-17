/**
 * dsh-aura-scheduler v2 — proactive scheduling + sensors + webhook + off-peak.
 *
 * Upgraded with capabilities learned from the ecosystem:
 *   - dsh-sentinel: file/process/http sensors (watch conditions → trigger)
 *   - EngramPulse:  webhook trigger + result write-back to memory
 *   - dsh-automations: off-peak window (save money on DeepSeek pricing)
 *
 * Core stays: value network V = α·urgency + β·relevance − δ·interruption
 * @module @agentframe/dsh-aura-scheduler/sensors
 */
export type SensorKind = 'file' | 'process' | 'http' | 'port';
export interface SensorSpec {
    readonly kind: SensorKind;
    /** file: absolute path; process: pgrep pattern; http: URL; port: "[host:]port". */
    readonly target: string;
    /** Optional regex. file/process: fire on no-match → match transitions. http: response body match. */
    readonly pattern?: string;
    /** Seconds between probes, clamped [5, 86400]. */
    readonly intervalSeconds: number;
}
export interface SensorProbe {
    readonly state: string;
    readonly snapshot: string;
}
/** Minimal fs/pgrep/http probe engine — no dsh dependencies, testable standalone. */
export declare class SensorEngine {
    private last;
    /** Probe one sensor spec; returns true when a fire-worthy transition happened. */
    probe(spec: SensorSpec, now?: number): Promise<boolean>;
    reset(): void;
    private _read;
    private _probeFile;
    private _probeProcess;
    private _probeHttp;
    private _probePort;
}
export default SensorEngine;
