/**
 * replay 群聊停用（2026-11-10）：群消息改由 reconcileGroup（@ 门禁+去重）兜底，
 * replay 默认不再补群，避免门禁拦下的群消息被重连补收重新投一遍。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplay } from '../lib/replay.js'
import { openBridgeDb } from '../lib/store.js'

const T0 = Date.parse('2026-11-05T01:00:00Z')
const sec = (ms) => Math.floor(ms / 1000)
const msg = (id, atMs, text = 'hi') => ({
  message_id: id,
  time: sec(atMs),
  user_id: 11111111,
  sender: { nickname: '某人' },
  message: [{ type: 'text', data: { text } }],
})

function setup({ contacts = [{ contact: '707380948', kind: 'group' }], history = [], cfg = {} } = {}) {
  const store = openBridgeDb(':memory:')
  for (const c of contacts) store.upsertContact({ ...c, name: '某人', at: T0 })
  const calls = []
  const client = {
    call: async (action, params) => {
      calls.push({ action, params })
      return { status: 'ok', retcode: 0, data: { messages: history } }
    },
  }
  const delivered = []
  const logs = []
  const replay = createReplay({
    cfg: { selfId: '2190097528', replay: { count: 20, windowMs: 2 * 3600 * 1000, ...cfg } },
    store,
    getClient: () => client,
    deliver: (p) => {
      delivered.push(p)
      return 'QUEUED'
    },
    mode: { current: () => 'send' },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: () => T0 + 10 * 60 * 1000,
  })
  return { store, calls, delivered, logs, replay }
}

test('默认不补群：跳过群联系人，info 只打一次', async () => {
  const h = setup({ history: [msg(9, T0 + 60000)] })
  await h.replay.replayOnConnect()
  await h.replay.replayOnConnect()
  assert.equal(h.calls.length, 0, '群联系人不许调 get_group_msg_history')
  assert.equal(h.delivered.length, 0)
  assert.equal(h.replay.stats.groupSkipped, 2)
  const skipLogs = h.logs.filter((m) => m.includes('[channel-bridge] replay 不再补群（改用群对账+@门禁）'))
  assert.equal(skipLogs.length, 1, '进程内只提示一次')
})

test('群跳过不影响私聊：私聊照常补收', async () => {
  const h = setup({
    contacts: [
      { contact: '707380948', kind: 'group' },
      { contact: '11111111', kind: 'private' },
    ],
    history: [msg(1, T0 + 60000)],
  })
  await h.replay.replayOnConnect()
  assert.deepEqual(h.calls.map((c) => c.action), ['get_friend_msg_history'])
  assert.deepEqual(h.delivered.map((p) => [p.kind, p.messageId]), [['private', '1']])
  assert.equal(h.replay.stats.groupSkipped, 1)
})

test('replay.groups=true 时与旧版一致：补群并投递', async () => {
  const h = setup({ history: [msg(9, T0 + 60000)], cfg: { groups: true } })
  await h.replay.replayOnConnect()
  assert.equal(h.calls[0].action, 'get_group_msg_history')
  assert.equal(h.calls[0].params.group_id, '707380948')
  assert.equal(h.delivered[0].kind, 'group')
  assert.equal(h.replay.stats.groupSkipped, 0)
})
