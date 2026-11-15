import test from 'node:test'
import assert from 'node:assert/strict'
import { splitForSend, createAuto, textOfAssistant } from '../lib/auto.js'
import { openBridgeDb } from '../lib/store.js'

const parsed = (over = {}) => ({ channel: 'qq', kind: 'private', contactId: '2971030080', contactName: '饲养员', text: '在吗', at: 1, messageId: 'm1', ...over })
const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const turnEnd = { type: 'turn/end', data: { reason: 'done' } }

function harness({ outbound = 'auto', timeoutMs = 180000, maxSegments = 4, maxLen = 60 } = {}) {
  const store = openBridgeDb(':memory:')
  const sent = []
  const sender = {
    sendText: async ({ text }) => {
      sent.push(text)
      return { ok: true, messageId: `mid-${sent.length}` }
    },
  }
  let t = 1_000_000
  const auto = createAuto({
    cfg: { outbound, auto: { maxLen, maxSegments, timeoutMs, pollMs: 1000 } },
    store,
    sender,
    now: () => t,
  })
  const agent = { session: { log: [] } }
  return {
    auto,
    store,
    sent,
    agent,
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    deliver: () => auto.noteDelivery({ agent, sessionId: 'S1', parsed: parsed() }),
  }
}

test('切分：30 字 → 1 段', () => {
  const text = '今天天气不错，我打算出去走走，顺便买点东西回来。'
  const segs = splitForSend(text)
  assert.equal(segs.length, 1)
  assert.ok([...segs[0]].length <= 60)
  assert.equal(segs[0], text)
})

test('切分：200 字无标点 → 2–4 段、每段 ≤60、顺序正确、不丢字', () => {
  const text = '啊'.repeat(200)
  const segs = splitForSend(text)
  assert.ok(segs.length >= 2 && segs.length <= 4, `段数 ${segs.length}`)
  for (const s of segs) assert.ok([...s].length <= 60, `段长 ${[...s].length}`)
  assert.equal(segs.join(''), text)
})

test('切分：按句切再合并（不把一句话拆碎）', () => {
  const segs = splitForSend('第一句。第二句！第三句？第四句。', { maxLen: 60 })
  assert.equal(segs.length, 1)
  assert.equal(segs[0], '第一句。第二句！第三句？第四句。')
})

test('auto：30 字 → sendText 1 次 + out 审计 1 条', async () => {
  const h = harness()
  h.deliver()
  h.agent.session.log.push(assistant('好，我在。'), turnEnd)
  h.auto.tick()
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(h.sent, ['好，我在。'])
  const out = h.store.raw.prepare(`SELECT * FROM channel_events WHERE direction='out'`).all()
  assert.equal(out.length, 1)
  assert.equal(out[0].text, null)
  assert.equal(out[0].text_len, [...'好，我在。'].length)
  assert.equal(JSON.parse(out[0].meta).auto, true)
})

test('auto：200 字 → 2–4 段、顺序正确、无丢字、每段 ≤60', async () => {
  const h = harness()
  h.deliver()
  h.agent.session.log.push(assistant('嗯'.repeat(200)), turnEnd)
  h.auto.tick()
  await new Promise((r) => setTimeout(r, 5))
  assert.ok(h.sent.length >= 2 && h.sent.length <= 4, `段数 ${h.sent.length}`)
  for (const s of h.sent) assert.ok([...s].length <= 60)
  assert.equal(h.sent.join(''), '嗯'.repeat(200))
})

test('auto：[SILENT] → 0 发送', async () => {
  const h = harness()
  h.deliver()
  h.agent.session.log.push(assistant('[SILENT]'), turnEnd)
  h.auto.tick()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.sent.length, 0)
  assert.equal(h.auto.stats.silent, 1)
})

test('auto：本回合 dy_say 发过同样内容 → 跳过自动', async () => {
  const h = harness()
  h.deliver()
  h.auto.noteToolSend({ channel: 'qq', contactId: '2971030080', text: '好，我在。' })
  h.agent.session.log.push(assistant('好，我在。'), turnEnd)
  h.auto.tick()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.sent.length, 0)
  assert.equal(h.auto.stats.skipped, 1)
})

test('auto：180s 没有 assistant 文本 → AUTO_SEND_TIMEOUT，不发也不重试', async () => {
  const h = harness({ timeoutMs: 180000 })
  h.deliver()
  h.advance(181000)
  h.auto.tick()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.sent.length, 0)
  assert.equal(h.auto.stats.timeouts, 1)
  assert.equal(h.auto.stats.lastReason, 'AUTO_SEND_TIMEOUT')
  h.auto.tick() // 不会重试
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.sent.length, 0)
  assert.equal(h.auto.watches.size, 0)
})

test('auto：turn 还没结束 → 不发（等下一次 tick）', async () => {
  const h = harness()
  h.deliver()
  h.agent.session.log.push(assistant('在的'))
  h.auto.tick()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.sent.length, 0)
  h.agent.session.log.push(turnEnd)
  h.auto.tick()
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(h.sent, ['在的'])
})

test('tool 模式：不登记、不发', async () => {
  const h = harness({ outbound: 'tool' })
  assert.equal(h.deliver(), false)
  assert.equal(h.auto.enabled, false)
  assert.equal(h.auto.watches.size, 0)
})

test('textOfAssistant：跳过非 text 块', () => {
  assert.equal(textOfAssistant({ message: { content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }] } }), 'ab')
  assert.equal(textOfAssistant({}), '')
})
