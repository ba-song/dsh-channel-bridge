import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessions } from '../lib/sessions.js'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ROOT = mkdtempSync(join(tmpdir(), 'sess-root-'))
const cfg = { cwdRoot: ROOT, privateCwd: join(ROOT, 'qq-私聊'), groupCwd: join(ROOT, 'qq-群'), cwd: join(ROOT, 'qq') }
const privCwd = (id = '2971030080') => join(cfg.privateCwd, id)
const model = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
const parsed = { channel: 'qq', kind: 'private', contactId: '2971030080' }

function memoryStore(row = null) {
  const st = { row }
  return { getSession: () => st.row, saveSession: (x) => { st.row = { channel: x.channel, session_id: x.sessionId, cwd: x.cwd } }, _st: st }
}

test('首次：agents.create（带 sessionId/meta.cwd/agentOptions）', async () => {
  const calls = []
  const agents = { create: async (o) => { calls.push(['create', o]); return { followup: async () => {} } }, resume: async () => { throw new Error('should not') } }
  const s = createSessions({ getAgents: () => agents, getModel: model, store: memoryStore(), cfg })
  const r = await s.ensure(parsed)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].meta.cwd, privCwd())
  assert.deepEqual(calls[0][1].agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.match(calls[0][1].sessionId, /^[0-9a-f-]{36}$/)
})

test('已有会话：resumeSessionId（async 等到了）', async () => {
  const calls = []
  let waited = false
  const agents = {
    resume: async (o) => { await new Promise((r) => setTimeout(r, 5)); waited = true; calls.push(['resume', o]); return { followup: async () => {} } },
    create: async () => { throw new Error('should not') },
  }
  const s = createSessions({ getAgents: () => agents, getModel: model, store: memoryStore({ session_id: 's1' }), cfg })
  const r = await s.ensure(parsed)
  assert.equal(waited, true)
  assert.equal(r.created, false)
  assert.equal(calls[0][1].resumeSessionId, 's1')
})

test('resume 失败 → 改建新会话', async () => {
  const agents = { resume: async () => { throw new Error('bad') }, create: async () => ({ followup: async () => {} }) }
  const s = createSessions({ getAgents: () => agents, getModel: model, store: memoryStore({ session_id: 'dead' }), cfg })
  const r = await s.ensure(parsed)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
})

test('拿不到模型 → NO_MODEL，不建会话', async () => {
  let created = 0
  const agents = { create: async () => { created += 1 } }
  const s = createSessions({ getAgents: () => agents, getModel: () => null, store: memoryStore(), cfg })
  const r = await s.ensure(parsed)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_MODEL')
  assert.equal(created, 0)
})

test('没有 agents → E_NO_AGENTS', async () => {
  const s = createSessions({ getAgents: () => null, getModel: model, store: memoryStore(), cfg })
  const r = await s.ensure(parsed)
  assert.equal(r.code, 'E_NO_AGENTS')
})

import { existsSync, writeFileSync } from 'node:fs'

test('群 cwd 不存在 → 自动 mkdir -p 后建会话', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sess-cwd-'))
  const groupCwd = join(base, 'qq-群')
  assert.equal(existsSync(groupCwd), false)
  const calls = []
  const agents = { create: async (o) => { calls.push(o); return { followup: async () => {} } }, resume: async () => { throw new Error('no') } }
  const s = createSessions({
    getAgents: () => agents,
    getModel: model,
    store: memoryStore(),
    cfg: { cwd: join(base, 'qq'), groupCwd, privateCwd: join(base, 'qq-私聊'), cwdRoot: base },
  })
  const r = await s.ensure({ channel: 'qq', kind: 'group', contactId: '707380948' })
  assert.equal(r.ok, true)
  assert.equal(existsSync(groupCwd), true)
  assert.equal(calls[0].meta.cwd, join(groupCwd, '707380948'))
})

test('cwd 建不出来 → E_CWD，不建会话', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sess-cwd2-'))
  const blocker = join(base, 'blocker')
  writeFileSync(blocker, 'file')
  let created = 0
  const agents = { create: async () => { created += 1; return { followup: async () => {} } }, resume: async () => { throw new Error('no') } }
  const s = createSessions({
    getAgents: () => agents,
    getModel: model,
    store: memoryStore(),
    cfg: { cwd: join(blocker, 'sub'), groupCwd: join(blocker, 'sub'), privateCwd: join(blocker, 'sub'), cwdRoot: base },
  })
  const r = await s.ensure({ channel: 'qq', kind: 'private', contactId: '2971030080' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_CWD')
  assert.equal(created, 0)
})

test('私聊 cwd 已存在：照常建会话（不受影响）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sess-cwd3-'))
  const calls = []
  const agents = { create: async (o) => { calls.push(o); return { followup: async () => {} } }, resume: async () => { throw new Error('no') } }
  const s = createSessions({ getAgents: () => agents, getModel: model, store: memoryStore(), cfg: { cwd: base, privateCwd: base, cwdRoot: base } })
  const r = await s.ensure(parsed)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
})
