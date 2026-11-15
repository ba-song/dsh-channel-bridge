import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconciler } from '../lib/reconcile.js'
import { openBridgeDb } from '../lib/store.js'

const T0 = Date.parse('2026-11-06T11:00:00Z')
const sec = (ms) => Math.floor(ms / 1000)
const msg = (id, atMs, text = '在吗', uid = 11111111) => ({ message_id: id, time: sec(atMs), user_id: uid, sender: { nickname: '主人' }, message: [{ type: 'text', data: { text } }] })

function setup({ history = [], deliverImpl = null, lastSeen = T0 } = {}) {
  const store = openBridgeDb(':memory:')
  store.upsertContact({ contact: '2971030080', kind: 'private', name: '主人', at: lastSeen })
  const calls = []
  const client = {
    call: async (action, params) => {
      calls.push({ action, params })
      return { status: 'ok', retcode: 0, data: { messages: history } }
    },
  }
  const delivered = []
  const messages = []
  const reconciler = createReconciler({
    cfg: { selfId: '2190097528', reconcile: { enabled: true, everyMs: 60000, count: 20 } },
    store,
    getClient: () => client,
    deliverOne: async (parsed) => {
      if (deliverImpl) return deliverImpl(parsed)
      delivered.push(parsed)
      return { ok: true, delivered: true }
    },
    onMessage: (p) => messages.push(p.messageId),
    log: null,
    now: () => T0 + 120000,
  })
  return { store, client, calls, delivered, messages, reconciler }
}

test('对账发现漏 1 条 → 投 1 次、落库、游标前进', async () => {
  const h = setup({ history: [msg('A', T0 + 60000, '哈哈，还没呢')] })
  await h.reconciler.runOnce()
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0].messageId, 'A')
  assert.equal(h.delivered[0].text, '哈哈，还没呢')
  assert.equal(h.store.counts().inbound, 1)
  assert.equal(h.store.contactOf('qq', '2971030080', 'private').last_seen_at, T0 + 60000)
  assert.deepEqual(h.messages, ['A']) // health 复位回调
  assert.equal(h.reconciler.stats.delivered, 1)
  // 请求参数：20 条私聊历史
  assert.equal(h.calls[0].action, 'get_friend_msg_history')
  assert.equal(h.calls[0].params.count, 20)
})

test('已投过的 → 0 投递（hasMessageId 闸）', async () => {
  const h = setup({ history: [msg('A', T0 + 60000)] })
  h.store.insertEvent({ at: T0 + 60000, channel: 'qq', kind: 'private', contact: '2971030080', direction: 'in', text: '已投', messageId: 'A' })
  await h.reconciler.runOnce()
  assert.equal(h.delivered.length, 0)
  assert.equal(h.reconciler.stats.skipped, 1)
})

test('SL 不推事件但历史有 2 条 → 按时间顺序补投', async () => {
  const h = setup({ history: [msg('B', T0 + 120000, '第二'), msg('A', T0 + 60000, '第一')] })
  await h.reconciler.runOnce()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['A', 'B'])
  assert.equal(h.store.contactOf('qq', '2971030080', 'private').last_seen_at, T0 + 120000)
})

test('投递失败 → 不推进游标、失败计数、下轮重试成功', async () => {
  let fail = true
  const h = setup({
    history: [msg('A', T0 + 60000)],
    deliverImpl: async (p) => {
      if (fail) return { ok: false, code: 'E_HOME_UNAVAILABLE' }
      h.delivered.push(p)
      return { ok: true, delivered: true }
    },
  })
  await h.reconciler.runOnce()
  assert.equal(h.delivered.length, 0)
  assert.equal(h.reconciler.stats.failed, 1)
  assert.equal(h.store.contactOf('qq', '2971030080', 'private').last_seen_at, T0) // 没动
  assert.equal(h.store.counts().inbound, 0)
  fail = false
  await h.reconciler.runOnce()
  assert.equal(h.delivered.length, 1)
  assert.equal(h.store.contactOf('qq', '2971030080', 'private').last_seen_at, T0 + 60000)
})

test('自己发的消息与 ≤last_seen 的都不投', async () => {
  const h = setup({
    history: [
      msg('S', T0 + 60000, '她说的', 2190097528),
      { ...msg('OLD', T0 - 60000, '旧的'), self_id: 2190097528 },
    ],
  })
  await h.reconciler.runOnce()
  assert.equal(h.delivered.length, 0)
})

test('单飞：并发 runOnce 只跑一轮', async () => {
  const h = setup({ history: [msg('A', T0 + 60000)] })
  await Promise.all([h.reconciler.runOnce(), h.reconciler.runOnce()])
  assert.equal(h.calls.length, 1)
})

test('节奏可配置：start 用 everyMs（默认 60000）', () => {
  const intervals = []
  const h = setup()
  const r = createReconciler({
    cfg: { reconcile: { everyMs: 15000 } },
    store: h.store,
    getClient: () => h.client,
    setInterval: (fn, ms) => { intervals.push(ms); return { unref() {} } },
    clearInterval: () => {},
  })
  r.start()
  assert.deepEqual(intervals, [15000])
  const r2 = createReconciler({ store: h.store, getClient: () => h.client, setInterval: (fn, ms) => { intervals.push(ms); return { unref() {} } }, clearInterval: () => {} })
  r2.start()
  assert.equal(intervals[1], 60000)
})

test('日志口径：每轮「本轮拉取」是当轮条数，累计另列', async () => {
  const lines = []
  const store = openBridgeDb(':memory:')
  store.upsertContact({ contact: '2971030080', kind: 'private', name: '主人', at: T0 })
  const history = Array.from({ length: 20 }, (_, i) => msg(`H${i}`, T0 + (i + 1) * 60000))
  const client = { call: async () => ({ status: 'ok', data: { messages: history } }) }
  const r = createReconciler({
    cfg: { selfId: '2190097528', reconcile: { everyMs: 60000, count: 20 } },
    store,
    getClient: () => client,
    deliverOne: async () => ({ ok: true, delivered: true }),
    log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
    now: () => T0 + 120000,
  })
  await r.runOnce()
  await r.runOnce()
  const sums = lines.filter((l) => l.includes('对账：本轮拉取'))
  assert.equal(sums.length, 2)
  assert.match(sums[0], /本轮拉取 20 条/)
  assert.match(sums[0], /累计拉取 20/)
  assert.match(sums[1], /本轮拉取 20 条/) // 第二轮仍是 20，不是 40
  assert.match(sums[1], /累计拉取 40/)
  assert.match(sums[1], /新投 0/) // 第一轮已投过，第二轮 0 新投
})

test('E_SEND_FAILED → 联系人退避 1 小时：下轮不拉、warn 只一次、不计 failed', async () => {
  let t = T0
  const warns = []
  const calls = []
  const store = openBridgeDb(':memory:')
  store.upsertContact({ contact: '2010741172', kind: 'private', name: '陌生人', at: T0 - 3600000 })
  const client = {
    call: async (action, params) => {
      calls.push(params.user_id)
      throw Object.assign(new Error('E_SEND_FAILED'), { code: 'E_SEND_FAILED' })
    },
  }
  const r = createReconciler({
    cfg: { reconcile: { everyMs: 60000, backoffMs: 3600000, activeDays: 7 } },
    store,
    getClient: () => client,
    deliverOne: async () => ({ ok: true }),
    log: { info: () => {}, warn: (m) => warns.push(m) },
    now: () => t,
  })
  await r.runOnce()
  assert.equal(r.stats.contactSkipped, 1)
  assert.equal(r.stats.failed, 0) // 非好友不计 failed
  assert.equal(warns.filter((w) => w.includes('退避')).length, 1)
  await r.runOnce()
  assert.equal(calls.length, 1) // 第二轮不再拉
  assert.equal(r.stats.backoffSkipped, 1)
  assert.equal(warns.filter((w) => w.includes('退避')).length, 1) // warn 只一次
  // 恢复窗口后可重试
  t += 3600001
  await r.runOnce()
  assert.equal(calls.length, 2)
  assert.equal(r.stats.contactSkipped, 2)
})

test('E_TIMEOUT（超时/断网）不算联系人错误：不退避 1 小时，下一轮就重拉补投', async () => {
  // 2026-11-07 18:30 事故回归：15s 超时曾被伪装成 E_SEND_FAILED，把主人退避 60 分钟，
  // 一条 QQ 消息整整一小时没进会话。
  let t = T0
  let fail = true
  const calls = []
  const warns = []
  const delivered = []
  const store = openBridgeDb(':memory:')
  store.upsertContact({ contact: '2971030080', kind: 'private', name: '主人', at: T0 - 3600000 })
  const client = {
    call: async (action, params) => {
      calls.push(params.user_id)
      if (fail) throw Object.assign(new Error('action get_friend_msg_history 超时'), { code: 'E_TIMEOUT' })
      return { status: 'ok', retcode: 0, data: { messages: [msg('T1', T0 + 60000)] } }
    },
  }
  const r = createReconciler({
    cfg: { selfId: '2190097528', reconcile: { everyMs: 60000, backoffMs: 3600000 } },
    store,
    getClient: () => client,
    deliverOne: async (parsed) => {
      delivered.push(parsed.messageId)
      return { ok: true, delivered: true }
    },
    log: { info: () => {}, warn: (m) => warns.push(m) },
    now: () => t,
  })
  await r.runOnce()
  assert.equal(r.stats.failed, 1) // 记失败
  assert.equal(r.stats.contactSkipped, 0) // 不当作非好友
  assert.equal(r.backoff.size, 0) // 不进 1 小时退避
  assert.equal(warns.filter((w) => w.includes('退避')).length, 0)
  assert.match(warns.join('\n'), /拉历史失败：E_TIMEOUT/)
  // 下一轮（60s 后）照常拉取；网络恢复后消息立刻补投
  fail = false
  t += 60000
  await r.runOnce()
  assert.equal(calls.length, 2)
  assert.deepEqual(delivered, ['T1'])
})

test('退避后恢复：拉到历史即清除退避、正常投递', async () => {
  let t = T0
  let fail = true
  const calls = []
  const delivered = []
  const store = openBridgeDb(':memory:')
  store.upsertContact({ contact: '2010741172', kind: 'private', name: '陌生人', at: T0 - 3600000 })
  const client = {
    call: async () => {
      calls.push(t)
      if (fail) throw Object.assign(new Error('E_SEND_FAILED'), { code: 'E_SEND_FAILED' })
      return { data: { messages: [msg('A', T0 + 60000)] } }
    },
  }
  const r = createReconciler({
    cfg: { reconcile: { backoffMs: 3600000 } },
    store,
    getClient: () => client,
    deliverOne: async (p) => { delivered.push(p.messageId); return { ok: true } },
    log: { info: () => {}, warn: () => {} },
    now: () => t,
  })
  await r.runOnce()
  assert.equal(r.backoff.size, 1)
  fail = false
  t += 3600001
  await r.runOnce()
  assert.equal(r.backoff.size, 0)
  assert.deepEqual(delivered, ['A'])
})

test('正常联系人不受退避影响（一个坏一个好）', async () => {
  const store = openBridgeDb(':memory:')
  store.upsertContact({ contact: '2010741172', kind: 'private', name: '陌生人', at: T0 - 3600000 })
  store.upsertContact({ contact: '2971030080', kind: 'private', name: '主人', at: T0 - 3600000 })
  const delivered = []
  const client = {
    call: async (action, params) => {
      if (params.user_id === '2010741172') throw Object.assign(new Error('E_SEND_FAILED'), { code: 'E_SEND_FAILED' })
      return { data: { messages: [msg('A', T0 + 60000)] } }
    },
  }
  const r = createReconciler({
    cfg: { reconcile: { everyMs: 60000 } },
    store,
    getClient: () => client,
    deliverOne: async (p) => { delivered.push(p.contactId); return { ok: true } },
    log: { info: () => {}, warn: () => {} },
    now: () => T0,
  })
  await r.runOnce()
  assert.deepEqual(delivered, ['2971030080'])
  assert.equal(r.stats.contactSkipped, 1)
})

test('只对账最近 N 天有消息的联系人（陌生人冷启动不扫）', async () => {
  const store = openBridgeDb(':memory:')
  store.upsertContact({ contact: '999999', kind: 'private', name: '很久没聊', at: T0 - 8 * 24 * 3600 * 1000 - 1000 })
  const calls = []
  const r = createReconciler({
    cfg: { reconcile: { activeDays: 7 } },
    store,
    getClient: () => ({ call: async (a, p) => { calls.push(p); return { data: { messages: [] } } } }),
    deliverOne: async () => ({ ok: true }),
    log: { info: () => {}, warn: () => {} },
    now: () => T0,
  })
  await r.runOnce()
  assert.equal(calls.length, 0)
  assert.equal(r.stats.staleSkipped, 1)
})
