import test from 'node:test'
import assert from 'node:assert/strict'
import { createHealth } from '../lib/health.js'

const T0 = Date.parse('2026-11-06T04:00:00Z')
function setup({ opened = true, history = true, silentMs = 30 * 60 * 1000 } = {}) {
  let t = T0
  const forced = []
  const logs = []
  const health = createHealth({
    silentMs,
    now: () => t,
    log: { warn: (m) => logs.push(m) },
    hasHistory: () => history,
    forceReconnect: () => { forced.push(t); return true },
  })
  return { health, forced, logs, at: () => t, advance: (ms) => { t += ms }, set: (v) => { t = v } }
}

test('只有 message 事件刷新 lastMessage；meta 不刷新（没有 noteMessage 就不变）', () => {
  const h = setup()
  h.health.noteMessage()
  assert.equal(h.health.stats.lastMessageAt, T0)
  h.advance(10 * 60 * 1000)
  // 模拟只来 meta 事件：不调用 noteMessage → 时间戳不变、状态已按旧时间算
  assert.equal(h.health.stats.lastMessageAt, T0)
  h.health.noteMessage()
  assert.equal(h.health.stats.lastMessageAt, T0 + 10 * 60 * 1000)
})

test('30 分钟阈值边界：29:59 OK，30:00 SILENT', () => {
  const h = setup()
  h.health.noteMessage()
  h.advance(30 * 60 * 1000 - 1000)
  assert.equal(h.health.status({ opened: true }), 'OK')
  h.advance(1000)
  assert.equal(h.health.status({ opened: true }), 'SILENT')
})

test('DOWN 优先：未连接时即使超时也是 DOWN', () => {
  const h = setup()
  h.health.noteMessage()
  h.advance(60 * 60 * 1000)
  assert.equal(h.health.status({ opened: false }), 'DOWN')
})

test('没有入站历史 → 不判 SILENT（刚启动不算假在线）', () => {
  const h = setup({ history: false })
  h.health.noteMessage()
  h.advance(60 * 60 * 1000)
  assert.equal(h.health.status({ opened: true }), 'OK')
})

test('SILENT 先强连一次；仍静默就每 silentMs 再强连一次（不是无限连刷）', () => {
  const h = setup()
  h.health.noteMessage()
  h.advance(31 * 60 * 1000)
  const r1 = h.health.check({ opened: true })
  assert.equal(r1.status, 'SILENT')
  assert.equal(r1.forced, true)
  assert.equal(h.forced.length, 1)
  assert.equal(h.health.stats.forcedReconnects, 1)
  assert.ok(h.logs.some((x) => x.includes('假在线')))

  // 刚强连完：不立刻重复，只按 warnEveryMs 告警
  const r2 = h.health.check({ opened: true })
  assert.equal(r2.forced, false)
  assert.equal(h.forced.length, 1)
  h.advance(6 * 60 * 1000)
  h.health.check({ opened: true })
  assert.equal(h.forced.length, 1)
  assert.ok(h.logs.some((x) => x.includes('仍在静默')))

  // 距上次强连满 30 分钟 → 第二次强连（2026-11-07 18:30 事故后放宽）
  h.advance(24 * 60 * 1000)
  const r3 = h.health.check({ opened: true })
  assert.equal(r3.forced, true)
  assert.equal(h.forced.length, 2)
  assert.equal(h.health.stats.forcedReconnects, 2)
})

test('强连失败 → 按 retryMs（默认 5 分钟）重试，不干等一轮 silentMs', () => {
  let t = T0
  const forced = []
  const logs = []
  const health = createHealth({
    silentMs: 30 * 60 * 1000,
    retryMs: 5 * 60 * 1000,
    now: () => t,
    log: { warn: (m) => logs.push(m) },
    hasHistory: () => true,
    forceReconnect: () => {
      forced.push(t)
      return false
    },
  })
  health.noteMessage()
  t += 31 * 60 * 1000
  const r1 = health.check({ opened: true })
  assert.equal(r1.forced, true)
  assert.equal(r1.ok, false)
  assert.ok(logs.some((x) => x.includes('强制重连失败')))
  t += 4 * 60 * 1000
  assert.equal(health.check({ opened: true }).forced, false)
  t += 2 * 60 * 1000 // 距上次失败 6 分钟 > retryMs
  const r2 = health.check({ opened: true })
  assert.equal(r2.forced, true)
  assert.equal(forced.length, 2)
})

test('收到 message 后重置：下一次静默可以再强连一次', () => {
  const h = setup()
  h.health.noteMessage()
  h.advance(31 * 60 * 1000)
  h.health.check({ opened: true })
  assert.equal(h.forced.length, 1)
  h.health.noteMessage() // 来消息了
  assert.equal(h.health.status({ opened: true }), 'OK')
  h.advance(31 * 60 * 1000)
  h.health.check({ opened: true })
  assert.equal(h.forced.length, 2)
  assert.equal(h.health.stats.forcedReconnects, 2)
})

test('silentSince = 最后一条 message + 阈值', () => {
  const h = setup()
  h.health.noteMessage()
  assert.equal(h.health.silentSince(), T0 + 30 * 60 * 1000)
})
