import test from 'node:test'
import assert from 'node:assert/strict'
import { createMirror } from '../lib/mirror.js'
import { openBridgeDb } from '../lib/store.js'

function fakeAgent(throws = false) {
  const appends = []
  return {
    appends,
    session: {
      id: 'S-MIRROR',
      log: [{ type: 'turn/start', data: { turn: 1 } }],
      append(type, data) {
        if (throws) throw new Error('surface rejected')
        appends.push({ type, data })
      },
    },
  }
}

const parts = (...texts) => texts.map((text, index) => ({ index, text, ok: true }))

test('成功：每段 append 一条 assistant/message，文本与 parts 逐一一致、顺序一致', () => {
  const agent = fakeAgent()
  const m = createMirror({ store: openBridgeDb(':memory:'), cfg: { mirror: { enabled: true } } })
  m.mirror({ agent, parts: parts('第一段', '第二段'), contactId: '2971030080' })
  assert.equal(agent.appends.length, 2)
  assert.deepEqual(agent.appends.map((a) => a.data.message.content[0].text), ['第一段', '第二段'])
  for (const a of agent.appends) {
    assert.equal(a.type, 'assistant/message')
    assert.equal(a.data.message.role, 'assistant')
    assert.equal(a.data.message.content.length, 1)
    assert.match(a.data.message.id, /^[0-9a-f-]{36}$/)
  }
  assert.equal(m.stats.host, 2)
  assert.equal(m.stats.hostOk, true)
})

test('镜像文本不带任何前后缀（GUI 里就是纯原文）', () => {
  const agent = fakeAgent()
  const m = createMirror({ store: openBridgeDb(':memory:'), cfg: { mirror: { enabled: true } } })
  m.mirror({ agent, parts: parts('晚安，早点睡') })
  assert.equal(agent.appends[0].data.message.content[0].text, '晚安，早点睡')
})

test('多段：append 次数 == 段数', () => {
  const agent = fakeAgent()
  const m = createMirror({ store: openBridgeDb(':memory:'), cfg: { mirror: { enabled: true } } })
  const p = parts('一', '二', '三', '四')
  m.mirror({ agent, parts: p })
  assert.equal(agent.appends.length, 4)
})

test('同一段（同一 index）只镜像一次；不同段即使文字相同也各镜像一次', () => {
  const agent = fakeAgent()
  const m = createMirror({ store: openBridgeDb(':memory:'), cfg: { mirror: { enabled: true } } })
  m.mirror({ agent, parts: [{ index: 0, text: '重复' }, { index: 0, text: '重复' }, { index: 1, text: '别的' }] })
  assert.equal(agent.appends.length, 2)
  assert.deepEqual(agent.appends.map((a) => a.data.message.content[0].text), ['重复', '别的'])
})

test('append 抛错：不抛出、退化写 bridge.db mirror 表', () => {
  const agent = fakeAgent(true)
  const store = openBridgeDb(':memory:')
  const warns = []
  const m = createMirror({ store, log: { warn: (x) => warns.push(x) }, cfg: { mirror: { enabled: true } } })
  const r = m.mirror({ agent, parts: parts('发不回去的原文'), contactId: '2971030080' })
  assert.equal(r.ok, true)
  assert.equal(store.counts().mirror, 1)
  assert.equal(store.listMirror()[0].text, '发不回去的原文')
  assert.equal(m.stats.hostOk, false)
  assert.ok(warns.some((w) => w.includes('镜像写回失败')))
})

test('宿主没有 session.append：全部退化写库，status 标 ok:false + reason', () => {
  const store = openBridgeDb(':memory:')
  const m = createMirror({ store, cfg: { mirror: { enabled: true } } })
  const r = m.mirror({ agent: { session: {} }, parts: parts('A', 'B'), contactId: '1' })
  assert.equal(store.counts().mirror, 2)
  assert.equal(r.host, 0)
  assert.equal(m.stats.hostOk, false)
  assert.match(m.stats.lastReason, /append 不可用/)
})

test('关闭 mirror 时什么都不做', () => {
  const agent = fakeAgent()
  const store = openBridgeDb(':memory:')
  const m = createMirror({ store, cfg: { mirror: { enabled: false } } })
  m.mirror({ agent, parts: parts('x') })
  assert.equal(agent.appends.length, 0)
  assert.equal(store.counts().mirror, 0)
})

test('默认（不传 cfg）：mirror 关闭，一条都不写', () => {
  const agent = fakeAgent()
  const store = openBridgeDb(':memory:')
  const m = createMirror({ store })
  assert.equal(m.enabled, false)
  m.mirror({ agent, parts: parts('默认不该镜像') })
  assert.equal(agent.appends.length, 0)
  assert.equal(store.counts().mirror, 0)
})

test('默认 loadConfig：mirror.enabled === false；outbound 仍是 tool', async () => {
  const { loadConfig } = await import('../lib/config.js')
  const c = loadConfig({})
  assert.equal(c.mirror.enabled, false)
  assert.equal(c.outbound, 'tool')
  assert.equal(loadConfig({ mirror: { enabled: true } }).mirror.enabled, true)
})
