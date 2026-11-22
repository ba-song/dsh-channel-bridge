import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../lib/router.js'
import { openBridgeDb } from '../lib/store.js'

const parsed = (over = {}) => ({ channel: 'qq', kind: 'private', contactId: '2971030080', contactName: '饲养员', senderName: '饲养员', text: '早', at: 1000, messageId: 'm1', ...over })
const modeOf = (m) => ({ current: () => m })

function fakeSessions(behavior = 'ok') {
  const got = []
  const agent = { followup: async (msg) => { got.push(msg) } }
  return {
    got,
    ensure: async (p) => {
      if (behavior === 'fail') return { ok: false, code: 'NO_MODEL', detail: 'no model' }
      return { ok: true, agent, sessionId: 'sess-1', created: false }
    },
  }
}

test('observe：不投递', async () => {
  const sessions = fakeSessions()
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('observe') })
  assert.equal(r.deliver(parsed()), 'MODE_OBSERVE')
  await r.idle()
  assert.equal(sessions.got.length, 0)
})

test('deliver：followup 一条，content 是数组、带 UUID、source.kind=user（GUI 正常气泡）', async () => {
  const sessions = fakeSessions()
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('deliver') })
  assert.equal(r.deliver(parsed()), 'QUEUED')
  await r.idle()
  assert.equal(sessions.got.length, 1)
  const m = sessions.got[0]
  assert.match(m.id, /^[0-9a-f-]{36}$/)
  assert.equal(m.role, 'user')
  assert.ok(Array.isArray(m.content))
  assert.equal(m.content[0].type, 'text')
  assert.match(m.content[0].text, /^\[QQ·私聊·饲养员\(2971030080\)\] 早/)
  assert.equal(m.source.kind, 'user')
  assert.equal(m.source.channel, 'qq')
  assert.equal(m.source.contact, '2971030080')
  assert.equal(m.source.contactId, '2971030080')
  assert.equal(m.source.contactKind, 'private')
  assert.ok(Object.isFrozen(m))
})

test('同渠道串行：两条按顺序', async () => {
  const order = []
  const agent = { followup: async (m) => { order.push(m.content[0].text); await new Promise((r) => setTimeout(r, 5)) } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: false }) }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send') })
  r.deliver(parsed({ text: 'a', messageId: '1' }))
  r.deliver(parsed({ text: 'b', messageId: '2' }))
  await r.idle()
  assert.equal(order.length, 2)
  assert.match(order[0], /^\[QQ·私聊·饲养员\(2971030080\)\] a/)
  assert.match(order[1], /^\[QQ·私聊·饲养员\(2971030080\)\] b/)
})

test('新会话上下文 builder 接收当前消息的完整会话范围', async () => {
  let received = null
  const agent = { followup: async () => {}, session: { log: [] } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 'sess-new', created: true }) }
  const r = createRouter({
    store: openBridgeDb(':memory:'),
    sessions,
    mode: modeOf('send'),
    contextBuilder: (scope) => { received = scope; return '' },
  })
  const current = parsed({ channel: 'qq', kind: 'group', contactId: '707380948', senderId: '42', messageId: 'scope-1' })
  r.deliver(current)
  await r.idle()
  assert.equal(received, current)
})

test('投递失败：不 followup、计入 deliverFail', async () => {
  const sessions = fakeSessions('fail')
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send') })
  r.deliver(parsed())
  await r.idle()
  assert.equal(r.stats.deliverFail, 1)
  assert.equal(sessions.got.length, 0)
})

test('队列满：拒绝并计数', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const sessions = { ensure: async () => { await gate; return { ok: true, agent: { followup: async () => {} }, sessionId: 's' } } }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send'), maxQueue: 1 })
  r.deliver(parsed({ messageId: 'm1' }))   // 正在投递（占住 worker，不在队列里）
  r.deliver(parsed({ messageId: 'm2' }))   // 进队列，队列长度 1
  assert.equal(r.deliver(parsed({ messageId: 'm3' })), 'QUEUE_FULL')
  release()
  await r.idle()
  assert.equal(r.stats.queueFull, 1)
})

test('deliver 模式：提示词带「只读」一行', async () => {
  const sessions = fakeSessions()
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('deliver') })
  r.deliver(parsed())
  await r.idle()
  assert.match(sessions.got[0].content[0].text, /（通道当前只读，发送会被拦）/)
})

test('noteSilent：2 秒内同人只记一条 silent', () => {
  const store = openBridgeDb(':memory:')
  let t = 5000
  const r = createRouter({ store, sessions: fakeSessions(), mode: modeOf('send'), now: () => t })
  assert.equal(r.noteSilent(parsed()), true)
  assert.equal(r.noteSilent(parsed()), false)
  t += 2500
  assert.equal(r.noteSilent(parsed()), true)
  assert.equal(store.counts().silent, 2)
})

test('agent 回合报 working-directory 错误 → 不当作已回复、计数 + warn', async () => {
  const warns = []
  const agent = {
    followup: async () => {},
    session: {
      log: [{ type: 'turn/end', data: { reason: 'error', message: 'working-directory: directory does not exist: "/sdcard/DSHA/渠道/qq-群"' } }],
    },
  }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 'sess-1', created: false }) }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send'), log: { info: () => {}, warn: (m) => warns.push(m) } })
  r.deliver(parsed({ kind: 'group', contactId: '707380948' }))
  await r.idle()
  assert.equal(r.stats.agentErrors, 1)
  assert.equal(r.stats.delivered, 0)
  assert.ok(warns.some((w) => w.includes('working-directory')))
})

test('agent 回合正常 → 照常算投递', async () => {
  const agent = { followup: async () => {}, session: { log: [{ type: 'turn/end', data: { reason: 'done' } }] } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: false }) }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send') })
  r.deliver(parsed())
  await r.idle()
  assert.equal(r.stats.delivered, 1)
  assert.equal(r.stats.agentErrors, 0)
})

test('群 @：wantGroupContext 时把上下文块拼在 prompt 前', async () => {
  const got = []
  const agent = { followup: async (m) => { got.push(m) }, session: { log: [{ type: 'turn/end', data: { reason: 'done' } }] } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: false }) }
  const r = createRouter({
    store: openBridgeDb(':memory:'),
    sessions,
    mode: modeOf('send'),
    getGroupContext: async () => '[群聊上下文·最近 2 条]\n甲: 上一句\n乙: 上一句2',
  })
  r.deliver(parsed({ kind: 'group', contactId: '707380948', wantGroupContext: true }))
  await r.idle()
  assert.equal(got.length, 1)
  assert.match(got[0].content[0].text, /^\[群聊上下文·最近 2 条\]\n甲: 上一句\n乙: 上一句2\n\n\[QQ·群/)
})

test('房间规矩：每条真实入站都带（私聊/群一致，2026-11-12 起）', async () => {
  const got = []
  let n = 0
  const agent = { followup: async (m) => got.push(m), session: { log: [] } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: n++ % 2 === 0 }) }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send') })
  for (const kind of ['private', 'group']) {
    r.deliver(parsed({ kind, messageId: `a-${kind}` }))
    await r.idle()
    r.deliver(parsed({ kind, messageId: `b-${kind}` }))
    await r.idle()
  }
  assert.ok(got[0].content[0].text.includes('【这个房间的规矩】'), '第一条应带规则')
  assert.ok(got[1].content[0].text.includes('【这个房间的规矩】'), '第二条也要带规则')
  // 群：新会话的那条（第 3 条）带，随后不带
  assert.ok(got[2].content[0].text.includes('【这个房间的规矩】'))
  assert.ok(got[3].content[0].text.includes('【这个房间的规矩】'))
})

test('房间规矩：轮换后仍每条都带', async () => {
  const got = []
  let n = 0
  const agent = { followup: async (m) => got.push(m), session: { log: [] } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: false, rotated: n++ === 0 }) }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send') })
  r.deliver(parsed({ messageId: 'x1' }))
  await r.idle()
  r.deliver(parsed({ messageId: 'x2' }))
  await r.idle()
  assert.ok(got[0].content[0].text.includes('【这个房间的规矩】'))
  assert.ok(got[1].content[0].text.includes('【这个房间的规矩】'))
})

test('房间规矩：补收/重放消息不带（即使会话是新建的）', async () => {
  const got = []
  const agent = { followup: async (m) => got.push(m), session: { log: [] } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: true }) }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send') })
  r.deliver(parsed({ replay: true, messageId: 'r1' }))
  await r.idle()
  r.deliver(parsed({ reconcile: true, messageId: 'r2' }))
  await r.idle()
  assert.ok(!got[0].content[0].text.includes('【这个房间的规矩】'))
  assert.ok(!got[1].content[0].text.includes('【这个房间的规矩】'))
})

test('房间规矩：挂 systemPrompt 常驻上下文后，消息里不再重复规则（2026-11-12）', async () => {
  const got = []
  const ctxs = []
  const agent = {
    followup: async (m) => got.push(m),
    session: { log: [] },
    ctx: { systemPrompt: { context: (spec) => { ctxs.push(spec); return () => {} } } },
  }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: true }) }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send') })
  r.deliver(parsed({ messageId: 'c1' }))
  await r.idle()
  r.deliver(parsed({ messageId: 'c2' }))
  await r.idle()
  assert.equal(ctxs.length, 1, '规则上下文只挂一次')
  assert.equal(ctxs[0].name, 'dy-room-rules')
  assert.ok(String(ctxs[0].text()).includes('【这个房间的规矩】'))
  assert.ok(got[0].content[0].text.includes('早'))
  assert.ok(!got[0].content[0].text.includes('【这个房间的规矩】'), '消息里不再重复规则')
  assert.ok(!got[1].content[0].text.includes('【这个房间的规矩】'))
})

test('群聊 inlineImage：followup 消息带 image block（text 在前）', async () => {
  const sessions = fakeSessions()
  const img = { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 9, width: 2, height: 3 } }
  const r = createRouter({
    store: openBridgeDb(':memory:'),
    sessions,
    mode: modeOf('send'),
    enrich: async () => ({ attachments: [], inlineImage: img }),
  })
  r.deliver(parsed({ kind: 'group', contactId: '707380948', contactName: '测试群', text: '看图' }))
  await r.idle()
  assert.equal(sessions.got.length, 1)
  const msg = sessions.got[0]
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.content[1].type, 'image')
  assert.deepEqual(msg.content[1], img)
})
