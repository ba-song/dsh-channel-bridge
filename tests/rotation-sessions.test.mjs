import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessions } from '../lib/sessions.js'
import { openBridgeDb } from '../lib/store.js'

const model = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ROOT = mkdtempSync(join(tmpdir(), 'rot-sess-'))
const cfg = { cwd: join(ROOT, 'qq'), cwdRoot: ROOT, privateCwd: join(ROOT, 'qq-私聊'), groupCwd: join(ROOT, 'qq-群'), agentPreset: 'standard', rotation: { enabled: true, threshold: 650000, ratio: 0.62, seedMessages: 50, handoffMaxChars: 12000 } }
const KEY = 'private:2971030080'
const parsed = { channel: 'qq', kind: 'private', contactId: '2971030080' }

const userEvt = (text) => ({ type: 'user/message', data: { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const asstEvt = (text, tokens) => ({ type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { id: `a-${text}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } }, ...(tokens ? { usage: { inputTokens: tokens } } : {}) } })

function setup({ oldLog, createImpl = null } = {}) {
  const store = openBridgeDb(':memory:')
  store.saveSession({ channel: 'qq', kind: KEY, sessionId: 'S-OLD', cwd: cfg.cwd, at: 1 })
  const oldAgent = { id: 'S-OLD', session: { id: 'S-OLD', log: oldLog }, followup: async () => {} }
  const created = []
  const agents = {
    get: (id) => (id === 'S-OLD' ? oldAgent : undefined),
    resume: async () => { throw new Error('should not resume') },
    create: async (args) => {
      created.push(args)
      if (createImpl) return createImpl(args)
      const id = args.sessionId
      const agent = { id, session: { id, log: [] }, followup: async () => {} }
      return agent
    },
  }
  const sessions = createSessions({ getAgents: () => agents, getModel: model, store, cfg })
  return { store, sessions, created, agents }
}

test('到阈值 → 轮换：带 seed（提示+50 条）、prev_session_id 记录、agentPreset 带上', async () => {
  const log = []
  for (let i = 0; i < 70; i += 1) log.push(i % 2 === 0 ? userEvt(`u${i}`) : asstEvt(`a${i}`, 700000))
  const h = setup({ oldLog: log })
  const r = await h.sessions.ensure(parsed)
  assert.equal(r.ok, true)
  assert.equal(r.rotated, true)
  assert.equal(r.seeded, 50)
  assert.equal(h.created.length, 1)
  const args = h.created[0]
  assert.equal(args.meta.agentPreset, 'standard')
  assert.equal(args.meta.isSeeded, true)
  assert.equal(args.inheritedEventCount, 51)
  assert.equal(args.seed.length, 51)
  assert.equal(args.seed[0].data.source.kind, 'handoff-note')
  assert.equal(args.seed[0].data.role, 'user')
  // 旧会话不删，prev 记下来
  const row = h.store.getSession('qq', KEY)
  assert.equal(row.prev_session_id, 'S-OLD')
  assert.equal(row.session_id, r.sessionId)
  assert.equal(h.sessions.stats.rotated, 1)
})

test('未到阈值 → 不轮换（继续用旧会话）', async () => {
  const h = setup({ oldLog: [userEvt('hi'), asstEvt('yo', 1000)] })
  const r = await h.sessions.ensure(parsed)
  assert.equal(r.sessionId, 'S-OLD')
  assert.equal(r.rotated, undefined)
  assert.equal(h.created.length, 0)
  assert.equal(h.sessions.stats.rotated, 0)
})

test('seed 不可用（create 带 seed 抛错）→ 退化 A：不带 seed 新建 + 交接卡入库', async () => {
  const log = [userEvt('第一句'), asstEvt('回一句', 700000), userEvt('最后一句')]
  const h = setup({
    oldLog: log,
    createImpl: (args) => {
      if (args.seed) throw new Error('seed not supported')
      const id = args.sessionId
      return { id, session: { id, log: [] }, followup: async () => {} }
    },
  })
  const r = await h.sessions.ensure(parsed)
  assert.equal(r.rotated, true)
  assert.equal(r.fallback, true)
  assert.match(r.handoffText, /^【上次聊到】/)
  const row = h.store.getSession('qq', KEY)
  assert.equal(row.prev_session_id, 'S-OLD')
  assert.match(row.handoff_text, /【上次聊到】/)
  assert.equal(h.sessions.stats.rotateFallback, 1)
  assert.equal(h.created.length, 2) // 先 seed 失败，再普通 create
})

test('两种 create 都失败 → 保持旧会话，不抛', async () => {
  const log = [asstEvt('x', 700000)]
  const h = setup({ oldLog: log, createImpl: () => { throw new Error('all down') } })
  const r = await h.sessions.ensure(parsed)
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'S-OLD')
  assert.equal(h.store.getSession('qq', KEY).session_id, 'S-OLD')
})

test('forceRotate：立刻换会话（seed 50+提示、prev 记录、返回值齐全）', async () => {
  const log = []
  for (let i = 0; i < 60; i += 1) log.push(i % 2 === 0 ? userEvt(`u${i}`) : asstEvt(`a${i}`, 100))
  const h = setup({ oldLog: log })
  const r = await h.sessions.forceRotate({ channel: 'qq', kind: 'private' })
  assert.equal(r.ok, true)
  assert.equal(r.oldSessionId, 'S-OLD')
  assert.notEqual(r.newSessionId, 'S-OLD')
  assert.equal(r.seeded, 50)
  assert.equal(r.count, 50)
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0].meta.agentPreset, 'standard')
  assert.equal(h.created[0].meta.isSeeded, true)
  assert.equal(h.created[0].seed.length, 51)
  assert.equal(h.created[0].seed[0].data.source.kind, 'handoff-note')
  const row = h.store.getSession('qq', KEY)
  assert.equal(row.prev_session_id, 'S-OLD')
  assert.equal(row.session_id, r.newSessionId)
})

test('forceRotate：回合进行中 → E_BUSY（不建会话）', async () => {
  const h = setup({ oldLog: [userEvt('hi'), { type: 'turn/start', data: { turn: 1 } }] })
  const r = await h.sessions.forceRotate({ channel: 'qq', kind: 'private' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_BUSY')
  assert.equal(h.created.length, 0)
  assert.equal(h.store.getSession('qq', KEY).session_id, 'S-OLD')
})

test('forceRotate：agent.status=running 也判忙', async () => {
  const h = setup({ oldLog: [] })
  h.agents.get = () => ({ status: 'running', session: { log: [] }, followup: async () => {} })
  const r = await h.sessions.forceRotate({ channel: 'qq', kind: 'private' })
  assert.equal(r.code, 'E_BUSY')
})

test('forceRotate：seed 失败 → 退化 A（交接卡 + fallback 标记）', async () => {
  const h = setup({
    oldLog: [userEvt('第一句'), asstEvt('回一句', 100), userEvt('最后一句')],
    createImpl: (args) => {
      if (args.seed) throw new Error('seed not supported')
      return { id: args.sessionId, session: { id: args.sessionId, log: [] }, followup: async () => {} }
    },
  })
  const r = await h.sessions.forceRotate({ channel: 'qq', kind: 'private' })
  assert.equal(r.ok, true)
  assert.equal(r.fallback, true)
  assert.equal(r.seeded, 0)
  assert.match(r.handoffText, /^【上次聊到】/)
  const row = h.store.getSession('qq', KEY)
  assert.equal(row.prev_session_id, 'S-OLD')
  assert.match(row.handoff_text, /【上次聊到】/)
})

test('forceRotate：没有会话行 → E_NO_SESSION', async () => {
  const store = openBridgeDb(':memory:')
  const sessions = createSessions({ getAgents: () => ({ create: async () => ({}) }), getModel: model, store, cfg })
  const r = await sessions.forceRotate({ channel: 'qq', kind: 'private' })
  assert.equal(r.code, 'E_NO_SESSION')
})
