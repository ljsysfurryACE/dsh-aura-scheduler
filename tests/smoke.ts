/**
 * Smoke test for dsh-aura-scheduler v2 (sensors + webhook + off-peak).
 * Run: node lib/tests/smoke.js  (after tsc build)
 */
import { SensorEngine } from '../src/sensors.ts'
import { createWebhookHub } from '../src/webhook.ts'
import { AuraSchedulerService } from '../src/index.ts'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  // ===== 1. SensorEngine: file 传感器 =====
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = path.join(os.tmpdir(), `aura-test-${Date.now()}`)
  await fs.mkdir(tmp, { recursive: true })
  const target = path.join(tmp, 'signal.txt')

  const engine = new SensorEngine()
  // baseline probe (file absent)
  await engine.probe({ kind: 'file', target, intervalSeconds: 5 })
  // create the file → should fire
  await fs.writeFile(target, 'hello signal')
  const fired = await engine.probe({ kind: 'file', target, intervalSeconds: 5 })
  check('file 传感器: 文件出现触发', fired === true, `state 翻转 absent→match`)
  // no change → should NOT fire
  const fired2 = await engine.probe({ kind: 'file', target, intervalSeconds: 5 })
  check('file 传感器: 无变化不触发', fired2 === false)

  // ===== 2. WebhookHub: HMAC 验证 =====
  const hub = createWebhookHub({ secret: 'test-secret' })
  let received = null
  const url = await hub.register('test-hook', (payload) => { received = payload })
  check('webhook: 注册返回路由', url.startsWith('/aura-webhook/test-hook'), url)

  // 正确签名
  const crypto = await import('node:crypto')
  const body = JSON.stringify({ ping: true })
  const name = 'test-hook'
  const token = url.split('token=')[1]
  const sig = crypto.createHmac('sha256', 'test-secret').update(`${name}:${token}:${body}`).digest('hex')
  const status = await hub.handle(name, sig, body)
  check('webhook: 正确签名 → 200 + handler 收到', status === 200 && received?.ping === true, `status=${status}`)

  // 错误签名
  const bad = await hub.handle(name, 'deadbeef', body)
  check('webhook: 错误签名 → 401', bad === 401, `status=${bad}`)

  // 未知路由
  const nf = await hub.handle('nope', 'x', '')
  check('webhook: 未知路由 → 404', nf === 404, `status=${nf}`)

  // ===== 3. AuraSchedulerService: off-peak 模式 =====
  // mock ctx
  const ctx = { logger: { info: () => {}, debug: () => {}, warn: () => {} }, set: () => {}, provide: () => {}, emit: () => {} }
  const svc = new AuraSchedulerService(ctx, { auto: false, offPeakOnly: true })
  svc.stop()
  check('service: 构造成功', svc.status().running === false)
  check('service: offPeak 字段存在', 'offPeak' in svc.status())
  check('service: webhookHub 就绪', svc.webhook.list().length === 0)

  // force tick 应该能绕过 off-peak
  const forced = await svc.tickNow()
  check('service: force tick 绕过 off-peak', forced === true)

  // ===== 4. 集成: 注册 webhook → 触发 → proactive =====
  const svc2 = new AuraSchedulerService(ctx, { auto: false, cooldown: 1 })
  const route = await svc2.addWebhook('demo', 'check the server')
  check('service: addWebhook 返回路由', route.includes('/aura-webhook/demo'))

  const crypto2 = await import('node:crypto')
  const token2 = route.split('token=')[1]
  const sig2 = crypto2.createHmac('sha256', svc2.webhook.secret).update(`demo:${token2}:${JSON.stringify({})}`).digest('hex')
  const st2 = await svc2.webhook.handle('demo', sig2, JSON.stringify({}))
  check('service: webhook → proactive 触发', st2 === 200, `status=${st2}, proactiveCount=${svc2.status().proactiveCount}`)

  // cleanup
  await fs.rm(tmp, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败项:', failed.map((f) => f.name).join(', '))
    process.exit(1)
  }
  console.log('✅ ALL SMOKE TESTS PASSED')
}

main().catch((e) => { console.error('❌ smoke test 崩溃:', e); process.exit(1) })
