import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplay } from '../lib/replay.js'
import { openBridgeDb } from '../lib/store.js'

const T0 = Date.parse('2026-11-05T01:00:00Z')
const sec = (ms) => Math.floor(ms / 1000)

function setup({ lastSeen = T0, kind = 'private', mode = 'send', history = [], throwIt = false, cfg = {} } = {}) {
  const store = openBridgeDb(':memory:')
  const contact = kind === 'group' ? '707380948' : '11111111'
  store.upsertContact({ contact, kind, name: '某人', at: lastSeen })
  const calls = []
  const client = {
    call: async (action, params) => {
      calls.push({ action, params })
      if (throwIt) throw Object.assign(new Error('boom'), { code: 'E_NOT_CONNECTED' })
      return { status: 'ok', retcode: 0, data: { messages: history } }
    },
  }
  const delivered = []
  const replay = createReplay({
    cfg: { selfId: '2190097528', replay: { count: 20, windowMs: 2 * 3600 * 1000, ...cfg } },
    store,
    getClient: () => client,
    deliver: (p) => delivered.push(p),
    mode: { current: () => mode },
    now: () => T0 + 10 * 60 * 1000,
  })
  return { store, client, replay, delivered, calls, contact }
}

const msg = (id, atMs, text = 'hi') => ({ message_id: id, time: sec(atMs), user_id: 11111111, sender: { nickname: '某人' }, message: [{ type: 'text', data: { text } }] })

test('只补未见过的（message_id 去重）', async () => {
  const history = [msg(1, T0 + 60000), msg(2, T0 + 120000), msg(3, T0 + 180000)]
  const h = setup({ history })
  h.store.insertEvent({ at: T0 + 120000, channel: 'qq', direction: 'in', messageId: '2', text: 'already' })
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 2)
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['1', '3'])
  assert.equal(h.delivered[0].replay, true)
  assert.match(h.delivered[0].replayLabel, /^\d{2}:\d{2}$/)
  assert.equal(h.calls[0].action, 'get_friend_msg_history')
  assert.equal(h.calls[0].params.user_id, h.contact)
})

test('群用 get_group_msg_history + group_id（显式 replay.groups=true，旧行为）', async () => {
  const h = setup({ kind: 'group', history: [msg(9, T0 + 60000)], cfg: { groups: true } })
  await h.replay.replayOnConnect()
  assert.equal(h.calls[0].action, 'get_group_msg_history')
  assert.equal(h.calls[0].params.group_id, '707380948')
  assert.equal(h.delivered[0].kind, 'group')
})

test('首次见到（last_seen=0）：默认只记起点，不补历史', async () => {
  const h = setup({ lastSeen: 0, history: [msg(1, T0 + 60000)] })
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 0)
  assert.equal(h.replay.stats.baseline, 1)
  assert.ok(h.store.contactOf('qq', '11111111', 'private').last_seen_at > 0)
})

test('onFirstSeen=true 时才补历史', async () => {
  const h = setup({ lastSeen: 0, history: [msg(1, T0 + 60000)], cfg: { onFirstSeen: true } })
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 1)
})

test('observe 不补收、不调历史接口', async () => {
  const h = setup({ mode: 'observe', history: [msg(1, T0 + 60000)] })
  await h.replay.replayOnConnect()
  assert.equal(h.calls.length, 0)
  assert.equal(h.delivered.length, 0)
})

test('历史接口失败：只记失败，不抛', async () => {
  const h = setup({ throwIt: true, history: [] })
  await h.replay.replayOnConnect()
  assert.equal(h.replay.stats.failed, 1)
  assert.equal(h.delivered.length, 0)
})

test('超过 2 小时窗的不补', async () => {
  const old = msg(1, T0 - 3 * 3600 * 1000)   // 3 小时前：过了游标，但超出补收窗口
  const fresh = msg(2, T0 + 9 * 60 * 1000)
  const h = setup({ lastSeen: T0 - 4 * 3600 * 1000, history: [old, fresh], cfg: { windowMs: 2 * 3600 * 1000 } })
  await h.replay.replayOnConnect()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['2'])
})

test('单飞：并发触发只跑一次', async () => {
  const h = setup({ history: [msg(1, T0 + 60000)] })
  await Promise.all([h.replay.replayOnConnect(), h.replay.replayOnConnect()])
  assert.equal(h.calls.length, 1)
})

test('补收后推进游标（last_seen_at）', async () => {
  const h = setup({ history: [msg(1, T0 + 60000), msg(2, T0 + 120000)] })
  await h.replay.replayOnConnect()
  const row = h.store.contactOf('qq', '11111111', 'private')
  assert.equal(row.last_seen_at, T0 + 120000)
  assert.equal(row.last_replay_id, '2')
})

test('自己的消息不补收（历史接口会带两边）', async () => {
  const history = [
    { message_id: 11, time: sec(T0 + 60000), user_id: 2190097528, message: [{ type: 'text', data: { text: '她自己说的' } }] },
    { message_id: 12, time: sec(T0 + 120000), user_id: 11111111, message: [{ type: 'text', data: { text: '主人说的' } }] },
  ]
  const h = setup({ history })
  await h.replay.replayOnConnect()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['12'])
  assert.equal(h.replay.stats.selfSkipped, 1)
})

test('轮换后游标不回退：只补 > last_seen 的，不重投旧的', async () => {
  const history = [
    { message_id: 21, time: sec(T0 - 60000), user_id: 11111111, message: [{ type: 'text', data: { text: '轮换前的旧话' } }] },
    { message_id: 22, time: sec(T0 + 60000), user_id: 11111111, message: [{ type: 'text', data: { text: '轮换后的新话' } }] },
  ]
  const h = setup({ history, lastSeen: T0 })
  await h.replay.replayOnConnect()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['22'])
  const row = h.store.contactOf('qq', '11111111', 'private')
  assert.equal(row.last_seen_at, T0 + 60000)
  // 再跑一次（模拟又一次轮换/重连）：不重投
  await h.replay.replayOnConnect()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['22'])
})

test('markContactSeen 只增不减（游标不回退）', async () => {
  const h = setup({ history: [] })
  h.store.markContactSeen({ channel: 'qq', contact: '11111111', kind: 'private', at: T0 + 600000 })
  h.store.markContactSeen({ channel: 'qq', contact: '11111111', kind: 'private', at: T0 })
  assert.equal(h.store.contactOf('qq', '11111111', 'private').last_seen_at, T0 + 600000)
})

const selfMsg = (id, atMs, text = '她说的') => ({ message_id: id, time: sec(atMs), user_id: 2190097528, message: [{ type: 'text', data: { text } }] })

test('最后一条是她发的 → 整批不补（skippedAnswered=1）', async () => {
  const history = [msg(31, T0 + 60000, '主人问'), selfMsg(32, T0 + 120000, '她答')]
  const h = setup({ history })
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 0)
  assert.equal(h.replay.stats.skippedAnswered, 1)
})

test('最后一条是主人 → 只投她最后一次发言之后的尾巴，更早的算已回复', async () => {
  const history = [
    msg(41, T0 + 60000, '旧问题'),
    selfMsg(42, T0 + 120000, '旧回答'),
    msg(43, T0 + 180000, '新问题1'),
    msg(44, T0 + 240000, '新问题2'),
  ]
  const h = setup({ history })
  await h.replay.replayOnConnect()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['43', '44'])
  assert.equal(h.replay.stats.alreadyReplied, 1) // 41 被回复过，不投
  assert.equal(h.replay.stats.skippedAnswered, 0)
})

test('窗口里全是主人消息（她从未回复）→ 全投', async () => {
  const history = [msg(51, T0 + 60000, '一'), msg(52, T0 + 120000, '二')]
  const h = setup({ history })
  await h.replay.replayOnConnect()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['51', '52'])
  assert.equal(h.replay.stats.alreadyReplied, 0)
})

test('尾巴规则之前仍先查重：库里有 id 的不进候选', async () => {
  const history = [msg(61, T0 + 60000, '已收过'), selfMsg(62, T0 + 120000), msg(63, T0 + 180000, '新的')]
  const h = setup({ history })
  h.store.insertEvent({ at: T0 + 60000, channel: 'qq', direction: 'in', text: '已收过', messageId: '61' })
  await h.replay.replayOnConnect()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['63'])
  assert.equal(h.replay.stats.alreadyReplied, 0) // 61 已被查重挡掉
})
