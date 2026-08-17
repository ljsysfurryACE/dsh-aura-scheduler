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

export type SensorKind = 'file' | 'process' | 'http' | 'port'

export interface SensorSpec {
  readonly kind: SensorKind
  /** file: absolute path; process: pgrep pattern; http: URL; port: "[host:]port". */
  readonly target: string
  /** Optional regex. file/process: fire on no-match → match transitions. http: response body match. */
  readonly pattern?: string
  /** Seconds between probes, clamped [5, 86400]. */
  readonly intervalSeconds: number
}

export interface SensorProbe {
  readonly state: string
  readonly snapshot: string
}

/** Minimal fs/pgrep/http probe engine — no dsh dependencies, testable standalone. */
export class SensorEngine {
  private last: Map<string, SensorProbe> = new Map()

  /** Probe one sensor spec; returns true when a fire-worthy transition happened. */
  async probe(spec: SensorSpec, now = Date.now()): Promise<boolean> {
    const key = `${spec.kind}:${spec.target}`
    const current = await this._read(spec)
    const prev = this.last.get(key)
    this.last.set(key, current)

    if (!prev) return false // baseline, no fire on first probe
    // Fire on state transition: absent → present, no-match → match
    return prev.state !== current.state
  }

  reset(): void { this.last.clear() }

  private async _read(spec: SensorSpec): Promise<SensorProbe> {
    try {
      switch (spec.kind) {
        case 'file': return await this._probeFile(spec)
        case 'process': return await this._probeProcess(spec)
        case 'http': return await this._probeHttp(spec)
        case 'port': return await this._probePort(spec)
        default: return { state: 'unknown', snapshot: '' }
      }
    } catch (e) {
      return { state: 'error', snapshot: String(e) }
    }
  }

  private async _probeFile(spec: SensorSpec): Promise<SensorProbe> {
    // Node 18+ has fs/promises; import lazily to keep browser/edge bundling safe.
    const fs = await import('node:fs/promises')
    try {
      const st = await fs.stat(spec.target)
      const content = st.size > 4096 ? '' : await fs.readFile(spec.target, 'utf8').catch(() => '')
      const match = spec.pattern ? new RegExp(spec.pattern).test(content) : true
      return { state: match ? 'match' : 'no-match', snapshot: `${st.size}b` }
    } catch {
      return { state: 'absent', snapshot: '' }
    }
  }

  private async _probeProcess(spec: SensorSpec): Promise<SensorProbe> {
    const { exec } = await import('node:child_process')
    return new Promise((resolve) => {
      exec(`pgrep -f ${JSON.stringify(spec.target)}`, (err, stdout) => {
        const alive = !err && stdout.trim().length > 0
        const match = spec.pattern ? new RegExp(spec.pattern).test(stdout) : true
        resolve({ state: alive ? (match ? 'match' : 'no-match') : 'absent', snapshot: stdout.trim().slice(0, 200) })
      })
    })
  }

  private async _probeHttp(spec: SensorSpec): Promise<SensorProbe> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(spec.target, { signal: ctrl.signal })
      const body = await res.text()
      const match = spec.pattern ? new RegExp(spec.pattern).test(body) : res.ok
      return { state: match ? 'match' : 'no-match', snapshot: `http ${res.status}` }
    } catch {
      return { state: 'unreachable', snapshot: '' }
    } finally {
      clearTimeout(t)
    }
  }

  private async _probePort(spec: SensorSpec): Promise<SensorProbe> {
    const net = await import('node:net')
    return new Promise((resolve) => {
      const [host = '127.0.0.1', portStr = ''] = spec.target.split(':')
      const port = Number(portStr)
      const sock = net.createConnection({ host, port })
      sock.setTimeout(3000)
      sock.once('connect', () => { sock.destroy(); resolve({ state: 'open', snapshot: `${host}:${port}` }) })
      sock.once('timeout', () => { sock.destroy(); resolve({ state: 'closed', snapshot: '' }) })
      sock.once('error', () => resolve({ state: 'closed', snapshot: '' }))
    })
  }
}

export default SensorEngine
