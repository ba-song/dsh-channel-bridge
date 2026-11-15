import test from 'node:test'
import assert from 'node:assert/strict'
import { computeUsage, shouldRotate, collectRecentMessages, buildSeed, buildHandoffText, HANDOFF_NOTE } from '../lib/rotation.js'

const T = 1793900000000
const userEvt = (text, sourceKind = 'user') => ({ type: 'user/message', time: T, data: { id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind } } })
const asstEvt = (text, usage) => ({ type: 'assistant/message', time: T, data: { turn: 1, step: 1, stream: [], message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } }, ...(usage ? { usage } : {}) } })

test('计量：prompt_tokens 取最近 assistant usage.inputTokens，context_window 取 request/context', () => {
  const events = [
    asstEvt('a', { inputTokens: 100, outputTokens: 5 }),
    { type: 'request/context', data: { contextWindow: 1000000 } },
    asstEvt('b', { inputTokens: 480000, outputTokens: 5 }),
  ]
  assert.deepEqual(computeUsage(events), { promptTokens: 480000, contextWindow: 1000000 })
  assert.deepEqual(computeUsage([]), { promptTokens: 0, contextWindow: 0 })
})

test('触发：>=650k 或 (context_window>0 且 ratio>=0.62)', () => {
  assert.equal(shouldRotate({ promptTokens: 650000, contextWindow: 1000000 }), true)
  assert.equal(shouldRotate({ promptTokens: 500000, contextWindow: 1000000 }), false, '500k 不再触发')
  assert.equal(shouldRotate({ promptTokens: 499999, contextWindow: 1000000 }), false)
  assert.equal(shouldRotate({ promptTokens: 700000, contextWindow: 1000000 }, { threshold: 900000, ratio: 0.7 }), true)
  assert.equal(shouldRotate({ promptTokens: 600000, contextWindow: 1000000 }, { threshold: 900000, ratio: 0.7 }), false)
  assert.equal(shouldRotate({ promptTokens: 0, contextWindow: 0 }), false)
})

test('只收真实对话：跳过 runtime-context/plugin/briefing，assistant 只取 text', () => {
  const events = [
    userEvt('真用户'),
    userEvt('运行时', 'runtime-context'),
    userEvt('插件', 'plugin:dy-memory'),
    asstEvt('她的回复'),
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
    userEvt('第二句'),
  ]
  const msgs = collectRecentMessages(events, 50)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.deepEqual(msgs.map((m) => m.content[0].text), ['真用户', '她的回复', '第二句'])
})

test('seed：首条是 handoff-note 提示，其余最近 50 条、顺序一致、seq 连续', () => {
  const events = []
  for (let i = 0; i < 60; i += 1) events.push(i % 2 === 0 ? userEvt(`u${i}`) : asstEvt(`a${i}`))
  const { seed, messages, lastIsUser } = buildSeed(events, { limit: 50 })
  assert.equal(seed[0].data.source.kind, 'handoff-note')
  assert.equal(seed[0].data.content[0].text, HANDOFF_NOTE)
  assert.equal(seed[0].role, undefined) // 事件信封，消息在 data 里
  assert.equal(seed[0].data.role, 'user')
  assert.equal(messages, 50)
  assert.equal(seed.length, 51)
  seed.forEach((e, i) => assert.equal(e.seq, i))
  const texts = seed.slice(1).map((e) => (e.type === 'user/message' ? e.data.content[0].text : e.data.message.content[0].text))
  assert.deepEqual(texts, events.slice(-50).map((e) => (e.type === 'user/message' ? e.data.content[0].text : e.data.message.content[0].text)))
  assert.equal(lastIsUser, false) // 60 条是 u…a 结尾
})

test('seed：最后一条是主人发来（未回）时最后一条就是 user', () => {
  const events = [userEvt('在吗'), asstEvt('在'), userEvt('帮我看看')]
  const { seed, lastIsUser } = buildSeed(events, { limit: 50 })
  assert.equal(lastIsUser, true)
  assert.equal(seed.at(-1).type, 'user/message')
  assert.equal(seed.at(-1).data.content[0].text, '帮我看看')
})

test('seed：assistant 事件带 turn/step/stream（宿主 seed 校验要）', () => {
  const { seed } = buildSeed([userEvt('问'), asstEvt('答')], { limit: 50 })
  const a = seed.find((e) => e.type === 'assistant/message')
  assert.equal(typeof a.data.turn, 'number')
  assert.equal(typeof a.data.step, 'number')
  assert.ok(Array.isArray(a.data.stream))
  assert.equal(a.surfaceOp, 'append')
})

test('交接卡（A 退化）：不超过 maxChars，带【上次聊到】', () => {
  const events = []
  for (let i = 0; i < 80; i += 1) events.push(userEvt('长'.repeat(200)))
  const text = buildHandoffText(events, { maxChars: 1000 })
  assert.match(text, /^【上次聊到】/)
  assert.ok([...text].length <= 1000 + 20)
  assert.equal(buildHandoffText([], {}), '')
})

test('seed 里不含历史遗留的规则块（跟 home 一样不重复注入）', () => {
  const dirty = userEvt('真消息\n\n【这个房间的规矩】\n- 只有 dy_say 能送到对方；')
  const events = [dirty, asstEvt('回答\n\n【这个房间的规矩】\n- 只有 dy_say')]
  const { seed } = buildSeed(events, { limit: 50 })
  const texts = seed.map((e) => (e.type === 'user/message' ? e.data.content[0].text : e.data.message.content[0].text))
  assert.ok(!texts.some((t) => t.includes('【这个房间的规矩】')))
  assert.ok(texts.includes('真消息'))
  assert.ok(texts.includes('回答'))
})
