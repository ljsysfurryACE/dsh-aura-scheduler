# dsh-aura-scheduler

**Aura 主动调度插件** —— 让 DeepSeek Harness 的 Agent "知道什么时候该开口"。

官方 `dsh-schedule` 是**模型驱动**的：模型调用 `schedule_create` 创建提醒。
Aura 是**系统驱动**的：系统主动决定何时让 Agent 主动出击。

## 差异化

| 能力 | 官方 dsh-schedule | dsh-aura-scheduler |
|------|------------------|--------------------|
| 创建提醒 | ✓ 模型主动调用 | ✓ (可配合) |
| **系统主动出击** | × | ✓ **Aura 心跳** |
| 自适应频率 | × | ✓ 空闲越久越急切 |
| 价值网络 | × | ✓ V = α·u + β·r − δ·i |
| 静默时段 | × | ✓ 23:00-8:00 不打扰 |
| 反骚扰冷却 | × | ✓ |
| **传感器触发** (v2) | × | ✓ 文件/进程/HTTP/端口 监听 |
| **Webhook 触发** (v2) | × | ✓ HMAC 验证 + 限流 |
| **Off-peak 省钱** (v2) | × | ✓ 低谷时段才开口 |

## 接入

```yaml
- id: aura-scheduler
  name: '@agentframe/dsh-aura-scheduler'
  config:
    minInterval: 1800       # 30 min
    maxInterval: 7200       # 2 hours
    quietHours: [23, 8]     # 夜间静默
    alpha: 0.4              # 急切度权重
    beta: 0.4               # 相关性权重
    relevance: 0.5
    delta: 0.2              # 打扰惩罚
    cooldown: 600           # 反骚扰冷却 10min
    onProactive: notify     # 主动事件回调
    auto: true

    # ---- v2 新增 ----
    offPeakHours: [2, 7]    # 低谷时段 (省钱模式窗口)
    offPeakOnly: false      # true = 只在低谷时段开口
    sensors:                # 传感器 (文件/进程/HTTP/端口 状态翻转触发)
      - kind: file
        target: /tmp/aura-signal
        intervalSeconds: 30
    webhookSecret: ''       # webhook HMAC 密钥 (留空自动生成)
```

## v2 新能力（吸收生态竞品）

### 1. 传感器触发（学 dsh-sentinel）

监听文件/进程/HTTP/端口，状态变化（不存在→出现、无匹配→匹配）时触发主动开口：

```typescript
sensors: [
  { kind: 'file', target: '/tmp/important.txt', pattern: 'done', intervalSeconds: 30 },
  { kind: 'process', target: 'my-server', intervalSeconds: 60 },
  { kind: 'http', target: 'https://api.example.com/health', pattern: '"ok"', intervalSeconds: 300 },
  { kind: 'port', target: '127.0.0.1:8080', intervalSeconds: 60 },
]
```

### 2. Webhook 触发（学 EngramPulse）

外部系统 POST 唤醒 Agent，HMAC-SHA256 签名验证 + 每分钟限流：

```typescript
const url = await ctx.aura.addWebhook('deploy-finished', '检查部署结果并汇报')
// POST {url}  带 X-Aura-Signature 头 (HMAC)
```

### 3. Off-peak 省钱模式（学 dsh-automations）

`offPeakOnly: true` 时只在低谷时段（默认 2:00-7:00）主动开口，避开高峰价。

## 机制

```
每分钟心跳
  → 计算价值 V = α·(空闲率) + β·relevance − δ·interruption
  → 静默时段? 跳过
  → 冷却中? 跳过
  → V > 阈值 或 超过最大间隔? → 触发主动事件
  → onProactive 回调 (emit 事件 或 webhook POST)
```

## 验证（smoke test 12/12 全绿）

```
✅ file 传感器: 文件出现 → 触发 (状态翻转 absent→match)
✅ file 传感器: 无变化 → 不触发
✅ webhook: 注册返回路由 /aura-webhook/<name>?token=...
✅ webhook: 正确签名 → 200 + handler 收到
✅ webhook: 错误签名 → 401 (HMAC 防护)
✅ webhook: 未知路由 → 404
✅ service: 构造正常
✅ service: offPeak 模式就绪
✅ service: force tick 绕过 off-peak
✅ service: addWebhook 返回路由
✅ service: webhook → proactive 触发 (proactiveCount=1)
```

## License

GPL-3.0 © Cloud LTE Studio / AgentFrame
