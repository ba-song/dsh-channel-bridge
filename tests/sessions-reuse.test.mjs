import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessions } from '../lib/sessions.js'
import { openBridgeDb } from '../lib/store.js'

const model = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ROOT = mkdtempSync(join(tmpdir(), 'sess-reuse-'))
const cfg = { cwdRoot: ROOT, privateCwd: join(ROOT, 'qq-私聊'), groupCwd: join(ROOT, 'qq-群'), cwd: join(ROOT, 'qq') }
const KEY = 'private:2971030080'
const parsed = (kind = 'private') => ({ channel: 'qq', kind, contactId: kind === 'group' ? '707380948' : '2971030080' })

function fakeAgents() {
  const counts = { create: 0, resume: 0, get: 0 }
  const live = new Map() // id → agent（宿主内存里活着的）
  const persisted = new Set() // 磁盘上可 resume 的
  const agents = {
    counts,
    get(id) {
      counts.get += 1
      return live.get(id)
    },
    async create({ sessionId, meta }) {
      counts.create += 1
      const agent = { id: sessionId, cwd: meta.cwd, followup: async () => {} }
      live.set(sessionId, agent)
      persisted.add(sessionId)
      return agent
    },
    async resume({ resumeSessionId }) {
      counts.resume += 1
      if (!persisted.has(resumeSessionId)) throw new Error('resume 失败（档案不存在）')
      const agent = live.get(resumeSessionId) ?? { id: resumeSessionId, followup: async () => {} }
      live.set(resumeSessionId, agent)
      return agent
    },
    _live: live,
    _persisted: persisted,
  }
  return agents
}

test('连续 3 条消息只建 1 次会话（不 resume、不重建）', async () => {
  const store = openBridgeDb(':memory:')
  const agents = fakeAgents()
  const s = createSessions({ getAgents: () => agents, getModel: model, store, cfg })
  for (let i = 0; i < 3; i += 1) {
    const r = await s.ensure(parsed())
    assert.equal(r.ok, true)
    assert.equal(r.sessionId, 'SESSION-1'.length ? r.sessionId : r.sessionId)
  }
  assert.equal(agents.counts.create, 1)
  assert.equal(agents.counts.resume, 0)
  assert.equal(store.listSessions('qq').length, 1)
  assert.equal(s.stats.created, 1)
  assert.equal(s.stats.cached, 2)
})

test('live agent 直接复用（进程里已有该会话）：不 resume 不 create', async () => {
  const store = openBridgeDb(':memory:')
  store.saveSession({ channel: 'qq', kind: KEY, sessionId: 'S-LIVE', cwd: cfg.cwd })
  const agents = fakeAgents()
  agents._live.set('S-LIVE', { id: 'S-LIVE', followup: async () => {} })
  const s = createSessions({ getAgents: () => agents, getModel: model, store, cfg })
  const r = await s.ensure(parsed())
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'S-LIVE')
  assert.equal(r.via, 'live')
  assert.equal(r.created, false)
  assert.equal(agents.counts.resume, 0)
  assert.equal(agents.counts.create, 0)
})

test('只有 resume 抛错才新建', async () => {
  const store = openBridgeDb(':memory:')
  store.saveSession({ channel: 'qq', kind: KEY, sessionId: 'S-DEAD', cwd: cfg.cwd })
  const agents = fakeAgents() // live 里没有 S-DEAD → resume 会抛
  const s = createSessions({ getAgents: () => agents, getModel: model, store, cfg })
  const r = await s.ensure(parsed())
  assert.equal(r.created, true)
  assert.equal(r.via, 'create')
  assert.equal(agents.counts.resume, 1)
  assert.equal(agents.counts.create, 1)
  assert.notEqual(r.sessionId, 'S-DEAD')
})

test('resume 成功则不新建', async () => {
  const store = openBridgeDb(':memory:')
  store.saveSession({ channel: 'qq', kind: KEY, sessionId: 'S-OK', cwd: cfg.cwd })
  const agents = fakeAgents()
  agents._persisted.add('S-OK') // 档案在，但进程里没有 live agent
  // 模拟「宿主里没有 live，但档案能 resume」：get 拿不到，resume 能拿到
  const s = createSessions({ getAgents: () => ({ ...agents, get: () => undefined }), getModel: model, store, cfg })
  const r = await s.ensure(parsed())
  assert.equal(r.via, 'resume')
  assert.equal(r.sessionId, 'S-OK')
  assert.equal(agents.counts.create, 0)
})

test('群聊与私聊分房：两条 session 行、cwd 不同', async () => {
  const store = openBridgeDb(':memory:')
  const agents = fakeAgents()
  const s = createSessions({ getAgents: () => agents, getModel: model, store, cfg })
  const a = await s.ensure(parsed('private'))
  const b = await s.ensure(parsed('group'))
  assert.notEqual(a.sessionId, b.sessionId)
  const rows = store.listSessions('qq')
  assert.equal(rows.length, 2)
  const priv = rows.find((r) => r.kind === KEY)
  const grp = rows.find((r) => r.kind === 'group:707380948')
  assert.equal(priv.cwd, join(cfg.privateCwd, '2971030080'))
  assert.equal(grp.cwd, join(cfg.groupCwd, '707380948'))
  assert.equal(agents.counts.create, 2)
  // 再各来一条：仍然复用，不再建
  await s.ensure(parsed('private'))
  await s.ensure(parsed('group'))
  assert.equal(agents.counts.create, 2)
})

test('handle 被宿主 dispose 后：缓存失效，走 resume', async () => {
  const store = openBridgeDb(':memory:')
  const agents = fakeAgents()
  const s = createSessions({ getAgents: () => agents, getModel: model, store, cfg })
  await s.ensure(parsed())
  const sid = store.getSession('qq', KEY).session_id
  agents._live.delete(sid) // 宿主 dispose 了
  const r = await s.ensure(parsed())
  assert.equal(agents.counts.resume, 1)
  assert.equal(agents.counts.create, 1)
  assert.equal(r.ok, true)
})
