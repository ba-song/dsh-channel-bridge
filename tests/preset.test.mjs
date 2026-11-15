import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessions } from '../lib/sessions.js'
import { openBridgeDb } from '../lib/store.js'

const model = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ROOT = mkdtempSync(join(tmpdir(), 'preset-'))
const PRIV = join(ROOT, 'qq-私聊')
const cfg = (over = {}) => ({ cwd: join(ROOT, 'qq'), cwdRoot: ROOT, privateCwd: PRIV, groupCwd: join(ROOT, 'qq-群'), agentPreset: 'standard', ...over })
const privCwd = (id = '2971030080') => join(PRIV, id)
const parsed = { channel: 'qq', kind: 'private', contactId: '2971030080' }

function recorder() {
  const creates = []
  const resumes = []
  let persisted = null
  return {
    creates,
    resumes,
    agents: {
      get: () => undefined,
      async create(args) {
        creates.push(args)
        persisted = args.sessionId
        return { followup: async () => {} }
      },
      async resume(args) {
        resumes.push(args)
        if (!persisted) throw new Error('no session')
        return { followup: async () => {} }
      },
    },
  }
}

test('新建会话：meta 带 agentPreset=standard', async () => {
  const r = recorder()
  const s = createSessions({ getAgents: () => r.agents, getModel: model, store: openBridgeDb(':memory:'), cfg: cfg() })
  await s.ensure(parsed)
  assert.equal(r.creates.length, 1)
  assert.deepEqual(r.creates[0].meta, { cwd: privCwd(), agentPreset: 'standard' })
  assert.equal(s.stats.lastPreset, 'standard')
})

test('配置可覆盖 agentPreset（例如 ptc）', async () => {
  const r = recorder()
  const s = createSessions({ getAgents: () => r.agents, getModel: model, store: openBridgeDb(':memory:'), cfg: cfg({ agentPreset: 'ptc' }) })
  await s.ensure(parsed)
  assert.equal(r.creates[0].meta.agentPreset, 'ptc')
})

test('agentPreset 留空 → meta 里不出现该键', async () => {
  const r = recorder()
  const s = createSessions({ getAgents: () => r.agents, getModel: model, store: openBridgeDb(':memory:'), cfg: cfg({ agentPreset: '' }) })
  await s.ensure(parsed)
  assert.deepEqual(r.creates[0].meta, { cwd: privCwd() })
  assert.equal('agentPreset' in r.creates[0].meta, false)
})

test('群聊新建也带 preset，cwd 是 qq-群', async () => {
  const r = recorder()
  const s = createSessions({ getAgents: () => r.agents, getModel: model, store: openBridgeDb(':memory:'), cfg: cfg() })
  await s.ensure({ channel: 'qq', kind: 'group', contactId: '707380948' })
  assert.equal(r.creates[0].meta.cwd, join(ROOT, 'qq-群', '707380948'))
  assert.equal(r.creates[0].meta.agentPreset, 'standard')
})

test('resume 路径不传 agentPreset / meta（不改旧会话头）', async () => {
  const store = openBridgeDb(':memory:')
  store.saveSession({ channel: 'qq', kind: 'private:2971030080', sessionId: 'S-OLD', cwd: privCwd() })
  const r = recorder()
  r.agents.resume = async (args) => {
    r.resumes.push(args)
    return { followup: async () => {} }
  }
  const s = createSessions({ getAgents: () => r.agents, getModel: model, store, cfg: cfg() })
  const out = await s.ensure(parsed)
  assert.equal(out.via, 'resume')
  assert.equal(r.resumes.length, 1)
  assert.equal('meta' in r.resumes[0], false)
  assert.equal('agentPreset' in r.resumes[0], false)
  assert.equal(r.creates.length, 0)
  assert.equal(s.stats.lastPreset, null)
})

test('配置默认值：agentPreset=standard', async () => {
  const { loadConfig } = await import('../lib/config.js')
  assert.equal(loadConfig({}).agentPreset, 'standard')
})
