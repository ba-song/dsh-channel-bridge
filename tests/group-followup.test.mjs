import test from 'node:test'
import assert from 'node:assert/strict'
import { createFollowUpWindow, buildGroupContext } from '../lib/group-followup.js'

const T0 = Date.parse('2026-11-07T04:00:00Z')
function setup({ messages = 8, idleMs = 600000 } = {}) {
  let t = T0
  const logs = []
  const w = createFollowUpWindow({ messages, idleMs, now: () => t, log: { info: (m) => logs.push(m) } })
  return { w, logs, at: () => t, advance: (ms) => { t += ms } }
}

test('@ 开窗；窗口内消息消耗条数；8 条用完关窗', () => {
  const h = setup()
  assert.equal(h.w.isOpen(), false)
  h.w.open()
  assert.equal(h.w.isOpen(), true)
  for (let i = 0; i < 8; i += 1) {
    assert.equal(h.w.isOpen(), true)
    assert.equal(h.w.consume(), true)
  }
  assert.equal(h.w.isOpen(), false)
  assert.ok(h.logs.some((l) => l.includes('消息数用完')))
  assert.equal(h.w.consume(), false)
})

test('她的群回复续窗（刷新 idle + 重置剩余）', () => {
  const h = setup()
  h.w.open()
  for (let i = 0; i < 5; i += 1) h.w.consume()
  h.advance(9 * 60 * 1000)
  assert.equal(h.w.renew(), true)
  assert.equal(h.w.isOpen(), true)
  for (let i = 0; i < 8; i += 1) assert.equal(h.w.consume(), true)
  assert.equal(h.w.isOpen(), false)
})

test('10 分钟 idle 关窗', () => {
  const h = setup()
  h.w.open()
  h.advance(600000 - 1000)
  assert.equal(h.w.isOpen(), true)
  h.advance(1000)
  assert.equal(h.w.isOpen(), false)
  assert.ok(h.logs.some((l) => l.includes('10 分钟')))
})

test('@ 上下文：最近 8 条、排除当前条、格式「昵称: 内容」、失败降级本地', async () => {
  const msgs = []
  for (let i = 0; i < 10; i += 1) {
    msgs.push({ message_id: String(i), sender: { nickname: `人${i}` }, message: [{ type: 'text', data: { text: `第${i}条` } }] })
  }
  const client = { call: async () => ({ data: { messages: msgs } }) }
  const ctx = await buildGroupContext({ getClient: () => client, groupId: '707380948', count: 8, excludeMessageId: '9' })
  const lines = ctx.split('\n')
  assert.equal(lines[0], '[群聊上下文·最近 8 条]')
  assert.equal(lines.length, 9)
  assert.equal(lines[1], '人1: 第1条') // 排除当前条 9 后取最近 8 条 = 1..8
  assert.ok(!ctx.includes('第9条'))
  assert.ok(ctx.includes('人8: 第8条'))

  const fallbackCtx = await buildGroupContext({
    getClient: () => ({ call: async () => { throw new Error('boom') } }),
    groupId: '1',
    count: 8,
    fallback: () => [{ sender: '本地', text: '降级一条' }],
  })
  assert.ok(fallbackCtx.includes('本地: 降级一条'))
})

test('上下文：拉取失败不抛；空历史返回空串', async () => {
  const empty = await buildGroupContext({ getClient: () => ({ call: async () => ({ data: { messages: [] } }) }), groupId: '1' })
  assert.equal(empty, '')
  const bad = await buildGroupContext({ getClient: () => null, groupId: '1', fallback: () => [] })
  assert.equal(bad, '')
})

test('真实定时器：安静到点主动关窗（不等下一条消息）', async () => {
  const closed = []
  const w = createFollowUpWindow({ messages: 8, idleMs: 40, onClose: (x) => closed.push(x) })
  w.open()
  assert.equal(w.isOpen(), true)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(w.stats.closed, 1)
  assert.equal(w.stats.lastCloseReason, 'idle')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].reason, 'idle')
  assert.equal(w.isOpen(), false)
})

test('定时器会被续窗重置：窗口内有动静就不关', async () => {
  const w = createFollowUpWindow({ messages: 8, idleMs: 60, onClose: () => {} })
  w.open()
  await new Promise((r) => setTimeout(r, 40))
  w.renew()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(w.stats.closed, 0) // 续窗后重新计时
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(w.stats.closed, 1)
})
