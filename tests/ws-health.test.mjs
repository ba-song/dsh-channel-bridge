import test from 'node:test'
import assert from 'node:assert/strict'
import { createBridgeClient } from '../lib/ws.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class FakeWS {
  static all = []
  constructor(url, opts) {
    this.url = url
    this.opts = opts
    this.h = {}
    this.sent = []
    this.terminated = 0
    this.closed = 0
    this.readyState = 0
    FakeWS.all.push(this)
  }
  on(ev, fn) {
    ;(this.h[ev] ||= []).push(fn)
  }
  emit(ev, ...args) {
    for (const fn of this.h[ev] || []) fn(...args)
  }
  send(text) {
    this.sent.push(text)
  }
  close() {
    this.closed += 1
    this.emit('close', 1000, 'bye')
  }
  terminate() {
    this.terminated += 1
    this.emit('close', 1005, 'term')
  }
}

function make({ health = {}, nowRef = { t: 1_000_000 } } = {}) {
  FakeWS.all = []
  const client = createBridgeClient({
    url: 'ws://127.0.0.1:3001/',
    token: 'tok',
    WebSocketImpl: FakeWS,
    reconnect: { baseMs: 10, maxMs: 20, jitter: 0 },
    health: { auto: false, ...health },
    now: () => nowRef.t,
  })
  return { client, nowRef, ws: () => FakeWS.all[FakeWS.all.length - 1] }
}

test('status 字段：opened/attempts/connects/lastFrameAt/lastEventAt 兼容', () => {
  const { client, ws, nowRef } = make()
  client.start()
  assert.equal(ws().opts.headers.Authorization, 'Bearer tok')
  ws().emit('open')
  nowRef.t += 2000
  ws().emit('message', JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }))
  const s = client.status()
  assert.equal(s.opened, true)
  assert.equal(s.connects, 1)
  assert.equal(s.messages, 1)
  assert.equal(s.lastFrameAt, nowRef.t)
  assert.equal(s.lastEventAt, nowRef.t)
  client.stop()
})

test('action 回包也算帧：刷新 lastFrameAt（不再被误判掉线）', async () => {
  const { client, ws, nowRef } = make({ health: { staleMs: 180000, heartbeatMs: 0 } })
  client.start()
  const first = ws()
  first.emit('open')
  const t0 = client.status().lastFrameAt
  nowRef.t += 100000
  const p = client.call('get_status', {})
  const payload = JSON.parse(first.sent[0])
  first.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: payload.echo }))
  await p
  assert.ok(client.status().lastFrameAt > t0)
  client.tick() // 帧是新的 → 不该断
  assert.equal(first.terminated, 0)
  client.stop()
})

test('180s 无帧但心跳一直成功 → 不重连', async () => {
  const { client, ws, nowRef } = make({ health: { staleMs: 180000, heartbeatMs: 1000, heartbeatTimeoutMs: 30 } })
  client.start()
  const first = ws()
  first.emit('open')
  nowRef.t += 200000
  client.tick()
  const echo = JSON.parse(first.sent[0]).echo
  first.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo }))
  await sleep(60)
  assert.equal(client.status().heartbeatFails, 0)
  client.tick()
  assert.equal(first.terminated, 0)
  assert.equal(client.status().hardResets, 0)
  client.stop()
})

test('心跳连续 2 次失败但仍有帧 → 仍不重连', async () => {
  const { client, ws, nowRef } = make({ health: { staleMs: 180000, heartbeatMs: 1000, heartbeatTimeoutMs: 20 } })
  client.start()
  const first = ws()
  first.emit('open')
  nowRef.t += 2000
  client.tick()
  await sleep(45)
  assert.equal(client.status().heartbeatFails, 1)
  nowRef.t += 2000
  client.tick()
  await sleep(45)
  assert.equal(client.status().heartbeatFails, 2)
  first.emit('message', JSON.stringify({ post_type: 'meta_event' })) // 有帧就还算活
  client.tick()
  assert.equal(first.terminated, 0)
  client.stop()
})

test('180s 无帧 + 心跳连续 2 次失败 → 才主动断开', async () => {
  const { client, ws, nowRef } = make({ health: { staleMs: 180000, heartbeatMs: 1000, heartbeatTimeoutMs: 20 } })
  client.start()
  const first = ws()
  first.emit('open')
  nowRef.t += 200000 // 早就无帧
  client.tick() // 心跳 #1（hbFails 0→1，暂不断）
  await sleep(45)
  assert.equal(first.terminated, 0)
  nowRef.t += 200000
  client.tick() // 心跳 #2（hbFails 1→2，仍不断）
  await sleep(45)
  assert.equal(first.terminated, 0)
  nowRef.t += 2000
  client.tick() // 无帧 + 2 次失败 → 断
  assert.equal(first.terminated, 1)
  assert.equal(client.status().hardResets, 1)
  client.stop()
})

test('心跳收到回包 → 失败计数归零', async () => {
  const { client, ws, nowRef } = make({ health: { staleMs: 180000, heartbeatMs: 1000, heartbeatTimeoutMs: 30 } })
  client.start()
  const first = ws()
  first.emit('open')
  nowRef.t += 2000
  client.tick()
  const echo = JSON.parse(first.sent[0]).echo
  first.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { online: true }, echo }))
  await sleep(10)
  assert.equal(client.status().heartbeatFails, 0)
  assert.ok(client.status().lastHeartbeatOkAt > 0)
  client.stop()
})

test('stop 之后 tick 不再动作', () => {
  const { client, ws, nowRef } = make({ health: { staleMs: 1 } })
  client.start()
  ws().emit('open')
  client.stop()
  nowRef.t += 10_000
  client.tick()
  assert.equal(ws().terminated, 0)
})
