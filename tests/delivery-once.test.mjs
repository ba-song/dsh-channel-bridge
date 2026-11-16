/**
 * 交付五态账本（A14）单测：
 * - 并发同 msg_key 两次 → 真实发送计数 = 1（第二个 already:true，不重发）
 * - 重开 db 后 queued 行仍在（账本落盘，不靠内存）
 * - 五态流转 thinking→generated→queued→sent / failed / interrupted
 * - 部分唯一索引 one_inflight 真的存在且由 DB 兜底
 * - 已 sent 之后同 key 允许再插（重发语义，attempts 递增）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KNOWN_STATES, openBridgeDb } from '../lib/store.js'
import { DELIVERY_NOTE, createDeliveries, requestKeyOf } from '../lib/delivery.js'
import { createSender } from '../lib/sender.js'
import { registerTools } from '../lib/tools.js'

const DIR = mkdtempSync(join(tmpdir(), 'bridge-delivery-'))
let seq = 0
const dbFile = () => join(DIR, `bridge-${++seq}.db`)
const detailOf = (r) => JSON.parse(r.detail)

function makeClient({ delay = 10, fail = false } = {}) {
  const calls = []
  return {
    calls,
    async call(action, params) {
      calls.push({ action, params })
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      if (fail) throw Object.assign(new Error('boom'), { code: 'E_SEND_FAILED' })
      return { data: { message_id: `mid-${calls.length}` } }
    },
  }
}

const cfg = { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 3600 * 1000 } }

test('requestKeyOf：同内容同 key，不同内容/不同联系人不同 key', () => {
  const a = requestKeyOf({ kind: 'private', contactId: '1', text: 'hi' })
  const b = requestKeyOf({ kind: 'private', contactId: '1', text: 'hi' })
  const c = requestKeyOf({ kind: 'private', contactId: '2', text: 'hi' })
  const d = requestKeyOf({ kind: 'private', contactId: '1', text: 'hi!' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('并发同 msg_key 两次 → 真实发送计数 1，第二个 already:true 且不重发', async () => {
  const store = openBridgeDb(dbFile())
  const deliveries = createDeliveries({ store })
  const client = makeClient({ delay: 20 })
  const sender = createSender({ getClient: () => client, deliveries })

  const args = { kind: 'private', contactId: '2971030080', text: '并发同一句话' }
  const [a, b] = await Promise.all([sender.sendText(args), sender.sendText({ ...args })])

  assert.equal(client.calls.length, 1, '同一内容在途时只允许一次真实发送')
  const dupe = [a, b].find((r) => r.already)
  const sent = [a, b].find((r) => r.ok && !r.already)
  assert.ok(dupe, '第二个必须是 already')
  assert.equal(dupe.ok, false)
  assert.equal(dupe.code, 'E_ALREADY_DELIVERING')
  assert.equal(dupe.state, 'queued')
  assert.equal(dupe.deliveryNote, DELIVERY_NOTE)
  assert.ok(sent, '第一个必须真的发出')
  assert.equal(sent.state, 'sent')
  assert.equal(sent.messageId, 'mid-1')

  const rows = store.listDeliveries({ peerId: '2971030080' })
  assert.equal(rows.length, 1, '在途冲突不额外插行')
  assert.equal(rows[0].state, 'sent')
  assert.equal(rows[0].attempts, 1)
  assert.equal(store.deliveryCounts().sent, 1)
  store.close()
})

test('重开 db 后 queued 行仍在（落盘，不靠内存）', () => {
  const file = dbFile()
  const s1 = openBridgeDb(file)
  const d1 = createDeliveries({ store: s1 })
  const r = d1.begin({ peerId: 'peer-a', msgKey: 'key-a', channel: 'qq' })
  assert.equal(r.ok, true)
  assert.equal(r.state, 'queued')
  s1.close()

  const s2 = openBridgeDb(file)
  const row = s2.getDelivery({ peerId: 'peer-a', msgKey: 'key-a' })
  assert.ok(row, 'queued 行必须还在')
  assert.equal(row.state, 'queued')
  assert.equal(row.channel, 'qq')
  // 未发态仍然占位：重开后同 key 不允许再插
  const again = createDeliveries({ store: s2 }).begin({ peerId: 'peer-a', msgKey: 'key-a' })
  assert.equal(again.already, true)
  assert.equal(again.id, row.id)
  s2.close()
})

test('五态流转：thinking→generated→queued→sent，failed/interrupted 各成终态', () => {
  const store = openBridgeDb(dbFile())
  const d = createDeliveries({ store })

  const t = d.begin({ peerId: 'u1', msgKey: 'm1', state: 'thinking' })
  assert.equal(t.ok, true)
  d.mark(t.id, 'generated')
  assert.equal(d.get({ peerId: 'u1', msgKey: 'm1' }).state, 'generated')
  d.mark(t.id, 'queued')
  assert.equal(d.get({ peerId: 'u1', msgKey: 'm1' }).state, 'queued')
  d.mark(t.id, 'sent')
  assert.equal(d.get({ peerId: 'u1', msgKey: 'm1' }).state, 'sent')

  const f = d.begin({ peerId: 'u1', msgKey: 'm2' })
  d.mark(f.id, 'failed', { error: 'E_OFFLINE: 未连上 NapCat' })
  const frow = d.get({ peerId: 'u1', msgKey: 'm2' })
  assert.equal(frow.state, 'failed')
  assert.match(frow.last_error, /E_OFFLINE/)

  const i = d.begin({ peerId: 'u1', msgKey: 'm3' })
  d.mark(i.id, 'interrupted')
  assert.equal(d.get({ peerId: 'u1', msgKey: 'm3' }).state, 'interrupted')

  // 非法状态一律拒绝，不写库
  assert.equal(d.mark(t.id, 'nope'), null)
  assert.equal(d.get({ peerId: 'u1', msgKey: 'm1' }).state, 'sent')
  assert.deepEqual(store.deliveryCounts(), {
    total: 3,
    thinking: 0,
    generated: 0,
    queued: 0,
    sent: 1,
    interrupted: 1,
    failed: 1,
  })
  store.close()
})

test('部分唯一索引 one_inflight 存在，且 DB 自己会挡住第二条未发态', () => {
  const store = openBridgeDb(dbFile())
  const row = store.raw
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name='one_inflight'`)
    .get()
  assert.ok(row, 'one_inflight 索引必须建出来')
  assert.match(String(row.sql), /WHERE state IN \('thinking','generated','queued'\)/)

  const d = createDeliveries({ store })
  const a = d.begin({ peerId: 'p', msgKey: 'k' })
  assert.equal(a.ok, true)
  assert.throws(
    () =>
      store.raw
        .prepare(`INSERT INTO deliveries(peer_id,msg_key,channel,state,attempts,last_error,created_at,updated_at) VALUES (?,?,?,?,1,'',0,0)`)
        .run('p', 'k', 'qq', 'queued'),
    /UNIQUE|constraint/i,
    'DB 层必须拒绝第二条未发态',
  )
  // 不同 peer / 不同 key 不受影响
  assert.equal(d.begin({ peerId: 'p', msgKey: 'k2' }).ok, true)
  assert.equal(d.begin({ peerId: 'q', msgKey: 'k' }).ok, true)
  store.close()
})

test('已 sent 之后同 key 允许再插（重发语义，attempts 递增）；already 不递增', () => {
  const store = openBridgeDb(dbFile())
  const d = createDeliveries({ store })
  const first = d.begin({ peerId: 'p', msgKey: 'k' })
  assert.equal(first.attempts, 1)
  const dupe = d.begin({ peerId: 'p', msgKey: 'k' })
  assert.equal(dupe.already, true)
  assert.equal(dupe.id, first.id, 'already 指向在途那一行')
  d.mark(first.id, 'sent')
  const second = d.begin({ peerId: 'p', msgKey: 'k' })
  assert.equal(second.ok, true)
  assert.notEqual(second.id, first.id, '重发是新行')
  assert.equal(second.attempts, 2)
  d.mark(second.id, 'sent')
  assert.equal(store.listDeliveries({ peerId: 'p' }).length, 2)
  assert.equal(store.deliveryCounts().sent, 2)
  store.close()
})

test('发送失败 → 账本 failed（保留 code），返回体带 state/deliveryNote', async () => {
  const store = openBridgeDb(dbFile())
  const deliveries = createDeliveries({ store })
  const client = makeClient({ delay: 0, fail: true })
  const sender = createSender({ getClient: () => client, deliveries })
  const r = await sender.sendText({ kind: 'private', contactId: '2971030080', text: '会失败的一句' })
  assert.equal(r.ok, false)
  assert.equal(r.state, 'failed')
  assert.equal(r.deliveryNote, DELIVERY_NOTE)
  const row = store.listDeliveries({ peerId: '2971030080' })[0]
  assert.equal(row.state, 'failed')
  assert.match(row.last_error, /E_SEND_FAILED/)
  // 失败不算在途：同内容可以再发（新行）
  client.calls.length = 0
  const retry = createSender({ getClient: () => makeClient({ delay: 0 }), deliveries })
  const r2 = await retry.sendText({ kind: 'private', contactId: '2971030080', text: '会失败的一句' })
  assert.equal(r2.ok, true)
  assert.equal(r2.state, 'sent')
  store.close()
})

test('未注入 deliveries 时 sender 行为完全照旧（只增不破）', async () => {
  const client = makeClient({ delay: 0 })
  const sender = createSender({ getClient: () => client })
  const r = await sender.sendText({ kind: 'private', contactId: '1', text: 'hi' })
  assert.deepEqual(Object.keys(r).sort(), ['messageId', 'ok'])
  const seg = await sender.sendSegments({ kind: 'private', contactId: '1', message: [{ type: 'text', data: { text: 'x' } }] })
  assert.deepEqual(Object.keys(seg).sort(), ['messageId', 'ok'])
  assert.equal(client.calls.length, 2)
})

// ---------------- dy_say 接线（真实 sender + 账本 + 假客户端） ----------------
function sayHarness({ file, fail = false, delay = 10 } = {}) {
  const tools = { defs: [], register(d) { this.defs.push(d) } }
  const store = openBridgeDb(file ?? dbFile())
  const client = makeClient({ delay, fail })
  const deliveries = createDeliveries({ store })
  const sender = createSender({ getClient: () => client, deliveries })
  registerTools({
    tools,
    cfg,
    mode: { current: () => 'send' },
    sender,
    store,
    log: null,
    status: () => ({ mode: 'send', opened: true }),
    outbound: 'tool',
  })
  const say = tools.defs.find((d) => d.name === 'dy_say')
  return { store, client, deliveries, sender, say, call: (args) => say.execute(args, {}) }
}

test('dy_say 成功：返回体带 state=sent 与 deliveryNote，账本一行 sent', async () => {
  const h = sayHarness({ delay: 0 })
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '晚安，早点睡' })
  const d = detailOf(r)
  assert.equal(r.ok, true)
  assert.equal(d.delivered, true)
  assert.equal(d.state, 'sent')
  assert.match(d.deliveryNote, /已发出 ≠ 对方已看到/)
  assert.equal(h.client.calls.length, 1)
  const rows = h.store.listDeliveries({ peerId: '2971030080' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'sent')
  h.store.close()
})

test('dy_say 并发同文：只真发一次，另一个 already:true + delivered:false', async () => {
  const h = sayHarness({ delay: 20 })
  const args = { channel: 'qq', contactId: '2971030080', kind: 'private', text: '并发同一条' }
  const [r1, r2] = await Promise.all([h.call({ ...args }), h.call({ ...args })])
  assert.equal(h.client.calls.length, 1, '并发双发必须只发一次')

  const bodies = [detailOf(r1), detailOf(r2)]
  const dupe = bodies.find((b) => b.already === true)
  const sent = bodies.find((b) => b.already !== true)
  assert.ok(dupe, '必须有一个 already')
  assert.equal(dupe.code, 'ALREADY_DELIVERING')
  assert.equal(dupe.delivered, false, '没发就是没发')
  assert.equal(dupe.state, 'queued')
  assert.match(dupe.deliveryNote, /已发出 ≠ 对方已看到/)
  assert.equal(dupe.queued, false, '重复发送不写 outbox')
  assert.ok(sent)
  assert.equal(sent.delivered, true)
  assert.equal(sent.state, 'sent')
  assert.equal(h.store.listDeliveries({ peerId: '2971030080' }).length, 1)
  h.store.close()
})

test('dy_say 掉线：账本 failed，返回体 state=failed 且 forwarded queued 语义不变', async () => {
  const h = sayHarness({ fail: true, delay: 0 })
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '掉线时说的话' })
  const d = detailOf(r)
  assert.equal(r.ok, false)
  assert.equal(d.code, 'E_SEND_FAILED')
  assert.equal(d.delivered, false)
  assert.equal(d.state, 'failed')
  assert.match(d.deliveryNote, /已发出 ≠ 对方已看到/)
  const row = h.store.listDeliveries({ peerId: '2971030080' })[0]
  assert.equal(row.state, 'failed')
  h.store.close()
})

test('KNOWN_STATES 与文档一致（六态，含 interrupted）', () => {
  assert.deepEqual([...KNOWN_STATES].sort(), ['failed', 'generated', 'interrupted', 'queued', 'sent', 'thinking'])
})

test.after(() => {
  rmSync(DIR, { recursive: true, force: true })
})
