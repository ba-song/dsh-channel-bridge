import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessions } from '../lib/sessions.js'
import { openBridgeDb } from '../lib/store.js'
import { buildSeed, buildHandoffText, HANDOFF_NOTE } from '../lib/rotation.js'

const ROOT = mkdtempSync(join(tmpdir(), 'handoff-brief-'))
const cfg = {
  cwd: join(ROOT, 'qq'),
  cwdRoot: ROOT,
  privateCwd: join(ROOT, 'qq-私聊'),
  groupCwd: join(ROOT, 'qq-群'),
  agentPreset: 'standard',
  rotation: { enabled: true, threshold: 650000, ratio: 0.62, seedMessages: 50, handoffMaxChars: 12000 },
}
const model = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
const privCwd = (id = '2971030080') => join(cfg.privateCwd, id)
const groupCwd = (id = '707380948') => join(cfg.groupCwd, id)
const parsedPrivate = { channel: 'qq', kind: 'private', contactId: '2971030080' }
const parsedGroup = { channel: 'qq', kind: 'group', contactId: '707380948' }
const KEY_PRIV = 'private:2971030080'
const KEY_GROUP = 'group:707380948'

const userEvt = (text, time = 1793900000000) => ({
  type: 'user/message',
  time,
  data: { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const asstEvt = (text, tokens, time = 1793900000000) => ({
  type: 'assistant/message',
  time,
  data: {
    turn: 1,
    step: 1,
    stream: [],
    message: { id: `a-${text}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    ...(tokens ? { usage: { inputTokens: tokens } } : {}),
  },
})

function fakeMemory(impl = () => ({ ok: true, text: '【交接简报】主人在做 QQ 全功能；最近在聊空间接口。' })) {
  const calls = []
  return {
    calls,
    handoffBrief(arg) {
      calls.push(arg)
      return impl(arg)
    },
  }
}

function setup({ oldLog = [], oldSessionId = 'S-OLD', memory = null, readArchive = null, createImpl = null, kind = KEY_PRIV } = {}) {
  const store = openBridgeDb(':memory:')
  store.saveSession({ channel: 'qq', kind, sessionId: oldSessionId, cwd: kind === KEY_GROUP ? groupCwd() : privCwd(), at: 1 })
  const oldAgent = { id: oldSessionId, session: { id: oldSessionId, header: { id: oldSessionId, cwd: privCwd() }, log: oldLog }, followup: async () => {} }
  const created = []
  const agents = {
    get: (id) => (id === oldSessionId ? oldAgent : undefined),
    resume: async () => { throw new Error('resume down') },
    create: async (args) => {
      created.push(args)
      if (createImpl) return createImpl(args)
      return { id: args.sessionId, session: { id: args.sessionId, log: [] }, followup: async () => {} }
    },
  }
  const sessions = createSessions({
    getAgents: () => agents,
    getModel: model,
    store,
    cfg,
    getMemory: () => memory,
    readArchive: readArchive ?? (() => []),
  })
  return { store, sessions, created, agents, oldAgent }
}

const countRaw = (seed) => seed.filter((e) => (e.type === 'user/message' && e.data.source.kind === 'user') || e.type === 'assistant/message').length

test('buildSeed：简报插在 handoff-note 之后；50 条原话仍在；seq 连续；messages 只算原话', () => {
  const events = []
  for (let i = 0; i < 60; i += 1) events.push(i % 2 === 0 ? userEvt(`u${i}`) : asstEvt(`a${i}`))
  const { seed, messages, hasBrief } = buildSeed(events, { limit: 50, brief: '【交接简报】只有这一句' })
  assert.equal(messages, 50)
  assert.equal(hasBrief, true)
  assert.equal(seed[0].data.source.kind, 'handoff-note')
  assert.equal(seed[0].data.content[0].text, HANDOFF_NOTE)
  assert.equal(seed[1].type, 'user/message')
  assert.equal(seed[1].data.source.kind, 'handoff-brief')
  assert.equal(seed[1].data.content[0].text, '【交接简报】只有这一句')
  assert.equal(seed.length, 52)
  assert.equal(countRaw(seed), 50)
  seed.forEach((e, i) => assert.equal(e.seq, i))
})

test('buildSeed：简报为空/空白 → 与旧行为一致（1+50，无 handoff-brief）', () => {
  const events = [userEvt('hi'), asstEvt('yo')]
  for (const brief of ['', '   ', null, undefined]) {
    const { seed, messages, hasBrief } = buildSeed(events, { limit: 50, brief })
    assert.equal(messages, 2)
    assert.equal(hasBrief, false)
    assert.equal(seed.length, 3)
    assert.ok(!seed.some((e) => e.data?.source?.kind === 'handoff-brief'))
    seed.forEach((e, i) => assert.equal(e.seq, i))
  }
})

test('buildHandoffText：简报最前，后接【上次聊到】；无简报时首行仍是【上次聊到】', () => {
  const events = [userEvt('第一句'), asstEvt('回一句'), userEvt('最后一句')]
  const withBrief = buildHandoffText(events, { brief: '【交接简报】要点 A' })
  assert.match(withBrief, /^【交接简报】要点 A\n\n【上次聊到】/)
  assert.match(withBrief, /主人：最后一句/)
  const noBrief = buildHandoffText(events, {})
  assert.match(noBrief, /^【上次聊到】/)
  assert.equal(buildHandoffText([], { brief: '只有简报' }), '只有简报')
  assert.equal(buildHandoffText([], {}), '')
})

test('轮换（到阈值）：带 50 条原话 + 简报 seed，header/cwd/kind/contactId 正确', async () => {
  const log = []
  for (let i = 0; i < 70; i += 1) log.push(i % 2 === 0 ? userEvt(`u${i}`) : asstEvt(`a${i}`, 700000))
  const memory = fakeMemory()
  const h = setup({ oldLog: log, memory })
  const r = await h.sessions.ensure(parsedPrivate)
  assert.equal(r.ok, true)
  assert.equal(r.rotated, true)
  assert.equal(r.seeded, 50)
  assert.equal(h.created.length, 1)
  const args = h.created[0]
  assert.equal(args.meta.isSeeded, true)
  assert.equal(args.inheritedEventCount, 52)
  assert.equal(args.seed.length, 52)
  assert.equal(args.seed[1].data.source.kind, 'handoff-brief')
  assert.equal(countRaw(args.seed), 50)
  args.seed.forEach((e, i) => assert.equal(e.seq, i))
  assert.equal(memory.calls.length, 1)
  const c = memory.calls[0]
  assert.equal(c.kind, 'private')
  assert.equal(c.contactId, '2971030080')
  assert.equal(c.cwd, privCwd())
  assert.equal(c.header.id, 'S-OLD')
  assert.equal(c.header.cwd, privCwd())
  assert.equal(c.recent.length, 50)
  assert.deepEqual(Object.keys(c).sort(), ['contactId', 'cwd', 'header', 'kind', 'maxChars', 'recent'])
  assert.equal(c.recent.at(-1).role, 'assistant')
  assert.equal(typeof c.recent.at(-1).text, 'string')
  assert.equal(h.sessions.stats.lastRotation.brief, true)
})

test('轮换：memory 抛错/返回 ok:false/空文本 → 不阻断，seed 仍 50 条、无简报', async () => {
  const log = [userEvt('第一句'), asstEvt('回一句', 700000), userEvt('最后一句')]
  for (const impl of [() => { throw new Error('memory down') }, () => ({ ok: false, text: 'x' }), () => ({ ok: true, text: '   ' })]) {
    const memory = fakeMemory(impl)
    const h = setup({ oldLog: log, memory })
    const r = await h.sessions.ensure(parsedPrivate)
    assert.equal(r.ok, true)
    assert.equal(r.rotated, true)
    assert.equal(r.seeded, 3)
    assert.equal(h.created[0].seed.length, 4)
    assert.ok(!h.created[0].seed.some((e) => e.data?.source?.kind === 'handoff-brief'))
  }
})

test('首次会话（无 prevId）：不调记忆、不带 seed', async () => {
  const memory = fakeMemory()
  const store = openBridgeDb(':memory:')
  const created = []
  const agents = {
    get: () => undefined,
    resume: async () => { throw new Error('no') },
    create: async (o) => { created.push(o); return { id: o.sessionId, session: { id: o.sessionId, log: [] }, followup: async () => {} } },
  }
  const sessions = createSessions({ getAgents: () => agents, getModel: model, store, cfg, getMemory: () => memory, readArchive: () => [] })
  const r = await sessions.ensure(parsedPrivate)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.via, 'create')
  assert.equal(created.length, 1)
  assert.equal(created[0].seed, undefined)
  assert.equal(memory.calls.length, 0)
})

test('resume 失败 + 有旧档案：读 archive 后带 seed 新建（50 原话+简报），记录 prev', async () => {
  const archive = []
  for (let i = 0; i < 60; i += 1) archive.push(i % 2 === 0 ? userEvt(`old${i}`) : asstEvt(`olda${i}`))
  const memory = fakeMemory()
  const archiveCalls = []
  const h = setup({
    oldSessionId: 'S-DEAD',
    memory,
    readArchive: (arg) => { archiveCalls.push(arg); return archive },
    createImpl: (args) => ({ id: args.sessionId, session: { id: args.sessionId, log: [] }, followup: async () => {} }),
  })
  // 让步骤 2 拿不到 live agent，必须走 resume 失败的 4a 分支
  h.agents.get = () => undefined
  const r = await h.sessions.ensure(parsedPrivate)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.via, 'create-seeded')
  assert.equal(r.seeded, 50)
  assert.equal(r.prevSessionId, 'S-DEAD')
  assert.equal(archiveCalls.length, 1)
  assert.equal(archiveCalls[0].sessionId, 'S-DEAD')
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0].seed.length, 52)
  assert.equal(h.created[0].seed[1].data.source.kind, 'handoff-brief')
  assert.equal(h.created[0].meta.isSeeded, true)
  assert.equal(h.store.getSession('qq', KEY_PRIV).prev_session_id, 'S-DEAD')
  assert.equal(memory.calls[0].kind, 'private')
  assert.equal(memory.calls[0].contactId, '2971030080')
})

test('resume 失败 + seed 建会话失败 → 空建 + 交接卡（简报在前），可下轮注入', async () => {
  const archive = [userEvt('旧一'), asstEvt('旧答'), userEvt('旧二')]
  const memory = fakeMemory(() => ({ ok: true, text: '【交接简报】旧话题' }))
  const h = setup({
    oldSessionId: 'S-DEAD',
    memory,
    readArchive: () => archive,
    createImpl: (args) => {
      if (args.seed) throw new Error('seed unsupported')
      return { id: args.sessionId, session: { id: args.sessionId, log: [] }, followup: async () => {} }
    },
  })
  h.agents.get = () => undefined
  const r = await h.sessions.ensure(parsedPrivate)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.via, 'create-fallback')
  assert.match(r.handoffText, /^【交接简报】旧话题\n\n【上次聊到】/)
  assert.equal(h.created.length, 2)
  assert.equal(h.created[1].seed, undefined)
  const row = h.store.getSession('qq', KEY_PRIV)
  assert.match(row.handoff_text, /^【交接简报】旧话题/)
  assert.equal(row.prev_session_id, 'S-DEAD')
})

test('群：只传 kind=group + 群号，记忆返回空则无简报（陌生人不泄漏）', async () => {
  const log = [userEvt('群友甲：在吗'), asstEvt('在', 700000), userEvt('群友乙：晚上好')]
  const memory = fakeMemory(() => ({ ok: false, text: '不该出现的内容' }))
  const h = setup({ oldLog: log, memory, kind: KEY_GROUP })
  const r = await h.sessions.ensure(parsedGroup)
  assert.equal(r.ok, true)
  assert.equal(r.rotated, true)
  assert.equal(memory.calls.length, 1)
  assert.equal(memory.calls[0].kind, 'group')
  assert.equal(memory.calls[0].contactId, '707380948')
  assert.equal(memory.calls[0].cwd, groupCwd())
  assert.ok(!h.created[0].seed.some((e) => e.data?.source?.kind === 'handoff-brief'))
  assert.equal(h.created[0].seed.length, 4)
})

test('buildHandoffText：简报超长时整卡仍 ≤ maxChars', () => {
  const text = buildHandoffText([userEvt('hello')], { maxChars: 30, brief: '长'.repeat(100) })
  assert.ok([...text].length <= 30)
  assert.match(text, /^长/)
})

test('resume 失败 + 档案未落盘：退回缓存旧 agent 事件 seed', async () => {
  const oldLog = [userEvt('缓存一'), asstEvt('缓存答'), userEvt('缓存二')]
  const memory = fakeMemory(() => ({ ok: true, text: '【交接简报】缓存话题' }))
  const h = setup({ oldLog, memory, readArchive: () => [] })
  // 先让旧 agent 进缓存
  const first = await h.sessions.ensure(parsedPrivate)
  assert.equal(first.ok, true)
  // 之后宿主里不再 live，resume 也失败 → 应退回缓存事件
  h.agents.get = () => undefined
  const r = await h.sessions.ensure(parsedPrivate)
  assert.equal(r.ok, true)
  assert.equal(r.via, 'create-seeded')
  assert.equal(r.seeded, 3)
  assert.equal(h.created.at(-1).seed.length, 5)
  assert.equal(h.created.at(-1).seed[1].data.source.kind, 'handoff-brief')
})

test('交接简报不额外调模型：轮换路径只取一次 agentOptions', async () => {
  const log = []
  for (let i = 0; i < 70; i += 1) log.push(i % 2 === 0 ? userEvt(`u${i}`) : asstEvt(`a${i}`, 700000))
  let modelCalls = 0
  const memory = fakeMemory()
  const store = openBridgeDb(':memory:')
  store.saveSession({ channel: 'qq', kind: KEY_PRIV, sessionId: 'S-OLD', cwd: privCwd(), at: 1 })
  const oldAgent = { id: 'S-OLD', session: { id: 'S-OLD', header: { id: 'S-OLD', cwd: privCwd() }, log }, followup: async () => {} }
  const agents = {
    get: (id) => (id === 'S-OLD' ? oldAgent : undefined),
    resume: async () => { throw new Error('n/a') },
    create: async (o) => ({ id: o.sessionId, session: { id: o.sessionId, log: [] }, followup: async () => {} }),
  }
  const sessions = createSessions({
    getAgents: () => agents,
    getModel: () => { modelCalls += 1; return model() },
    store,
    cfg,
    getMemory: () => memory,
    readArchive: () => [],
  })
  const r = await sessions.ensure(parsedPrivate)
  assert.equal(r.rotated, true)
  assert.equal(modelCalls, 1)
  assert.equal(memory.calls.length, 1)
})
