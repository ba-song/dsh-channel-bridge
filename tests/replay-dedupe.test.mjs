import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplay } from '../lib/replay.js'
import { openBridgeDb } from '../lib/store.js'

const T0 = Date.parse('2026-11-05T01:00:00Z')
const sec = (ms) => Math.floor(ms / 1000)
const msg = (id, atMs, text = 'hi') => ({ message_id: id, time: sec(atMs), user_id: 11111111, sender: { nickname: '某人' }, message: [{ type: 'text', data: { text } }] })

/** deliver 模拟生产：先落库（带 message_id）再算投递成功。 */
function setup(history, { verdict = () => 'QUEUED', lastSeen = T0 } = {}) {
  const store = openBridgeDb(':memory:')
  store.upsertContact({ contact: '11111111', kind: 'private', name: '某人', at: lastSeen })
  const delivered = []
  const client = { call: async () => ({ status: 'ok', retcode: 0, data: { messages: history } }) }
  const replay = createReplay({
    cfg: { replay: { count: 20, windowMs: 2 * 3600 * 1000, timeZoneOffsetMinutes: 480 } },
    store,
    getClient: () => client,
    deliver: (p) => {
      const v = verdict(p)
      if (v === 'QUEUED') {
        store.insertEvent({ at: p.at, channel: 'qq', kind: 'private', contact: '11111111', direction: 'in', text: p.text, messageId: p.messageId })
        delivered.push(p)
      }
      return v
    },
    mode: { current: () => 'send' },
    now: () => T0 + 10 * 60 * 1000,
  })
  return { store, replay, delivered }
}

test('同一批历史重放两次：第二次 0 投递', async () => {
  const history = [msg(1, T0 + 60000), msg(2, T0 + 120000), msg(3, T0 + 180000)]
  const h = setup(history)
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 3)
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 3) // 没有新增
  assert.equal(h.replay.stats.lastRun.delivered, 0)
  assert.ok(h.replay.stats.lastRun.skipped >= 3)
})

test('同一批里重复 message_id 只投一次', async () => {
  const dup = msg(7, T0 + 60000)
  const h = setup([dup, { ...dup }])
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 1)
})

test('投递失败（QUEUE_FULL）不推进游标，下次还会重试', async () => {
  let allow = false
  const history = [msg(1, T0 + 60000), msg(2, T0 + 120000)]
  const h = setup(history, { verdict: (p) => (p.messageId === '2' && !allow ? 'QUEUE_FULL' : 'QUEUED') })
  await h.replay.replayOnConnect()
  const row = h.store.contactOf('qq', '11111111', 'private')
  assert.equal(row.last_seen_at, T0 + 60000) // 只推进到真投出去的 1
  allow = true
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 2)
  assert.equal(h.store.contactOf('qq', '11111111', 'private').last_seen_at, T0 + 120000)
})

test('observe 视角下投递不算成功（返回 MODE_OBSERVE）→ 游标不动', async () => {
  const history = [msg(1, T0 + 60000)]
  const h = setup(history, { verdict: () => 'MODE_OBSERVE' })
  await h.replay.replayOnConnect()
  assert.equal(h.delivered.length, 0)
  assert.equal(h.store.contactOf('qq', '11111111', 'private').last_seen_at, T0)
})
