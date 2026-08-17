// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/sensors.ts
var SensorEngine = class {
  last = /* @__PURE__ */ new Map();
  /** Probe one sensor spec; returns true when a fire-worthy transition happened. */
  async probe(spec, now = Date.now()) {
    const key = `${spec.kind}:${spec.target}`;
    const current = await this._read(spec);
    const prev = this.last.get(key);
    this.last.set(key, current);
    if (!prev) return false;
    return prev.state !== current.state;
  }
  reset() {
    this.last.clear();
  }
  async _read(spec) {
    try {
      switch (spec.kind) {
        case "file":
          return await this._probeFile(spec);
        case "process":
          return await this._probeProcess(spec);
        case "http":
          return await this._probeHttp(spec);
        case "port":
          return await this._probePort(spec);
        default:
          return { state: "unknown", snapshot: "" };
      }
    } catch (e) {
      return { state: "error", snapshot: String(e) };
    }
  }
  async _probeFile(spec) {
    const fs = await import("node:fs/promises");
    try {
      const st = await fs.stat(spec.target);
      const content = st.size > 4096 ? "" : await fs.readFile(spec.target, "utf8").catch(() => "");
      const match = spec.pattern ? new RegExp(spec.pattern).test(content) : true;
      return { state: match ? "match" : "no-match", snapshot: `${st.size}b` };
    } catch {
      return { state: "absent", snapshot: "" };
    }
  }
  async _probeProcess(spec) {
    const { exec } = await import("node:child_process");
    return new Promise((resolve) => {
      exec(`pgrep -f ${JSON.stringify(spec.target)}`, (err, stdout) => {
        const alive = !err && stdout.trim().length > 0;
        const match = spec.pattern ? new RegExp(spec.pattern).test(stdout) : true;
        resolve({ state: alive ? match ? "match" : "no-match" : "absent", snapshot: stdout.trim().slice(0, 200) });
      });
    });
  }
  async _probeHttp(spec) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8e3);
    try {
      const res = await fetch(spec.target, { signal: ctrl.signal });
      const body = await res.text();
      const match = spec.pattern ? new RegExp(spec.pattern).test(body) : res.ok;
      return { state: match ? "match" : "no-match", snapshot: `http ${res.status}` };
    } catch {
      return { state: "unreachable", snapshot: "" };
    } finally {
      clearTimeout(t);
    }
  }
  async _probePort(spec) {
    const net = await import("node:net");
    return new Promise((resolve) => {
      const [host = "127.0.0.1", portStr = ""] = spec.target.split(":");
      const port = Number(portStr);
      const sock = net.createConnection({ host, port });
      sock.setTimeout(3e3);
      sock.once("connect", () => {
        sock.destroy();
        resolve({ state: "open", snapshot: `${host}:${port}` });
      });
      sock.once("timeout", () => {
        sock.destroy();
        resolve({ state: "closed", snapshot: "" });
      });
      sock.once("error", () => resolve({ state: "closed", snapshot: "" }));
    });
  }
};

// src/webhook.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var encoder = new TextEncoder();
function createWebhookHub(options = {}) {
  const secret = options.secret ?? randomSecret();
  const rateLimit = options.rateLimit ?? 60;
  const handlers = /* @__PURE__ */ new Map();
  const calls = /* @__PURE__ */ new Map();
  const routes = /* @__PURE__ */ new Map();
  function checkRate(name) {
    const now = Date.now();
    const window = now - 6e4;
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
    if (!signature) return false;
    const expected = createHmac("sha256", secret).update(`${name}:${bodyText}`).digest("hex");
    try {
      const a = encoder.encode(signature);
      const b = encoder.encode(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
  return {
    get secret() {
      return secret;
    },
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
      if (!handlers.has(name)) return 404;
      if (!checkRate(name)) return 429;
      const token = routes.get(name);
      if (!token) return 404;
      if (!verify(`${name}:${token}`, signature, bodyText)) return 401;
      try {
        const payload = bodyText ? JSON.parse(bodyText) : {};
        await handlers.get(name)(payload);
        return 200;
      } catch {
        return 500;
      }
    },
    list() {
      return [...handlers.keys()];
    }
  };
}
function randomSecret(len = 32) {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/index.ts
var DEFAULT_CONFIG = {
  minInterval: 1800,
  maxInterval: 7200,
  quietHours: [23, 8],
  alpha: 0.4,
  beta: 0.4,
  relevance: 0.5,
  delta: 0.2,
  cooldown: 600,
  onProactive: "",
  auto: true,
  sensors: [],
  webhookSecret: "",
  offPeakHours: [2, 7],
  offPeakOnly: false
};
var AuraSchedulerService = class {
  static inject = [];
  static Config = z.object({
    minInterval: z.number().default(1800),
    maxInterval: z.number().default(7200),
    quietHours: z.tuple([z.number(), z.number()]).default([23, 8]),
    alpha: z.number().default(0.4),
    beta: z.number().default(0.4),
    relevance: z.number().default(0.5),
    delta: z.number().default(0.2),
    cooldown: z.number().default(600),
    onProactive: z.string().default(""),
    auto: z.boolean().default(true),
    sensors: z.array(z.object({
      kind: z.string().default("file"),
      target: z.string().default(""),
      pattern: z.string().default(""),
      intervalSeconds: z.number().default(30)
    })).default([]),
    webhookSecret: z.string().default(""),
    offPeakHours: z.tuple([z.number(), z.number()]).default([2, 7]),
    offPeakOnly: z.boolean().default(false)
  });
  config;
  webhook;
  sensors;
  timer = null;
  sensorTimer = null;
  lastProactiveAt = 0;
  heartbeatCount = 0;
  proactiveCount = 0;
  sensorFires = {};
  webhookFires = 0;
  ctx;
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sensors = new SensorEngine();
    this.webhook = createWebhookHub({ secret: this.config.webhookSecret || void 0 });
    ctx.provide?.("aura");
    ctx.set("aura", this);
    if (this.config.auto) this.start();
  }
  // ===== Public API (ctx.aura) =====
  start() {
    if (this.timer) return;
    this._tick();
    this.timer = setInterval(() => this._tick(), 6e4);
    if (this.config.sensors.length > 0) this._startSensors();
    this.ctx.logger.info(
      `[aura] started: ${this.config.minInterval / 60}-${this.config.maxInterval / 60}min heartbeat, quiet ${this.config.quietHours[0]}:00-${this.config.quietHours[1]}:00` + (this.config.sensors.length ? `, ${this.config.sensors.length} sensors` : "") + (this.config.offPeakOnly ? `, off-peak only ${this.config.offPeakHours[0]}:00-${this.config.offPeakHours[1]}:00` : "")
    );
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sensorTimer) {
      clearInterval(this.sensorTimer);
      this.sensorTimer = null;
    }
  }
  status() {
    return {
      running: this.timer !== null,
      heartbeatCount: this.heartbeatCount,
      proactiveCount: this.proactiveCount,
      lastProactiveAt: this.lastProactiveAt,
      sensorFires: this.sensorFires,
      webhookFires: this.webhookFires,
      webhookRoutes: this.webhook.list(),
      offPeak: this._inOffPeak(),
      config: this.config
    };
  }
  /** Force a proactive tick (useful for tests / manual trigger). */
  async tickNow() {
    return this._maybeProactive(true);
  }
  /** Register a webhook trigger. Returns the URL to POST to. */
  async addWebhook(name, task) {
    const url = await this.webhook.register(name, async (payload) => {
      this.webhookFires++;
      this.ctx.logger.info(`[aura] webhook "${name}" fired, task: ${task}`);
      await this._maybeProactive(true, { source: "webhook", name, payload });
    });
    this.ctx.logger.info(`[aura] webhook route added: ${url}`);
    return url;
  }
  // ===== Internals =====
  _startSensors() {
    if (this.sensorTimer) return;
    for (const spec of this.config.sensors) {
      const interval = Math.max(5, Math.min(spec.intervalSeconds, 86400)) * 1e3;
      const probe = () => {
        void this.sensors.probe(spec).then((fired) => {
          if (fired) {
            this.sensorFires[`${spec.kind}:${spec.target}`] = (this.sensorFires[`${spec.kind}:${spec.target}`] ?? 0) + 1;
            this.ctx.logger.info(`[aura] sensor fired: ${spec.kind}:${spec.target}`);
            void this._maybeProactive(false, { source: "sensor", kind: spec.kind, target: spec.target });
          }
        });
      };
      probe();
      const id = setInterval(probe, interval);
      this._sensorTimers = this._sensorTimers ?? [];
      this._sensorTimers.push(id);
    }
  }
  _tick() {
    this.heartbeatCount++;
    void this._maybeProactive(false);
  }
  /** Aura value network + heartbeat policy. */
  _shouldAct(force) {
    const now = Date.now();
    if (!force && this._inQuietHours()) {
      this.ctx.logger.info("[aura] quiet hours, skip");
      return false;
    }
    if (!force && this.config.offPeakOnly && !this._inOffPeak()) {
      this.ctx.logger.info("[aura] off-peak only mode, waiting for cheaper window");
      return false;
    }
    if (!force && now - this.lastProactiveAt < this.config.cooldown * 1e3) {
      return false;
    }
    const idleRatio = Math.min((now - this.lastProactiveAt) / 1e3 / this.config.maxInterval, 1);
    const eagerness = this.config.alpha * idleRatio + this.config.beta * this.config.relevance;
    const interruption = this.config.delta * this._interruptionCost();
    const value = eagerness - interruption;
    this.ctx.logger.debug(`[aura] value=${value.toFixed(3)} (eager=${eagerness.toFixed(3)} intr=${interruption.toFixed(3)})`);
    if (force) return value > -0.1;
    const overdue = now - this.lastProactiveAt > this.config.maxInterval * 1e3;
    return value > 0.2 || overdue;
  }
  async _maybeProactive(force, meta = {}) {
    if (!this._shouldAct(force)) return false;
    this.lastProactiveAt = Date.now();
    this.proactiveCount++;
    const event = { at: (/* @__PURE__ */ new Date()).toISOString(), source: meta.source ?? "heartbeat", ...meta };
    const cb = this.config.onProactive;
    if (cb) {
      try {
        if (cb.startsWith("http")) {
          await fetch(cb, { method: "POST", body: JSON.stringify({ event: "proactive", ...event }) });
        } else {
          this.ctx.emit(cb, event);
        }
        this.ctx.logger.info(`[aura] proactive #${this.proactiveCount} delivered via ${cb}`);
      } catch (e) {
        this.ctx.logger.warn("[aura] proactive delivery failed:", e);
      }
    } else {
      this.ctx.logger.info(`[aura] proactive #${this.proactiveCount} (${event.source})`);
    }
    return true;
  }
  _inQuietHours() {
    const h = (/* @__PURE__ */ new Date()).getHours();
    const [start, end] = this.config.quietHours;
    if (start < end) return h >= start && h < end;
    return h >= start || h < end;
  }
  _inOffPeak() {
    const h = (/* @__PURE__ */ new Date()).getHours();
    const [start, end] = this.config.offPeakHours;
    if (start < end) return h >= start && h < end;
    return h >= start || h < end;
  }
  _interruptionCost() {
    return 0.3;
  }
};
var index_default = AuraSchedulerService;
export {
  AuraSchedulerService,
  index_default as default
};
