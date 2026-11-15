import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchPublicBrief, formatPublicBrief } from '../lib/public-brief.js'
import { createRouter } from '../lib/router.js'
import { openBridgeDb } from '../lib/store.js'

const parsed = (over = {}) => ({ channel: 'qq', kind: 'group', contactId: '707380948', contactName: '测试群', senderName: '主人', text: '在吗', at: 1000, messageId: 'm1', ...over })
const modeOf = (m) => ({ current: () => m })

test('publicBrief：只调 publicBrief({limit:3})，返回 [汐的近况] 前缀', async () => {
  const calls = []
  const memory = {
    publicBrief: async (x) => { calls.push(['publicBrief', x]); return ['最近在学做菜', '昨天看完了那部电影'] },
    recall: async () => { throw new Error('不应该调用 owner 记忆') },
  }
  const text = await fetchPublicBrief({ getMemory: () => memory })
  assert.deepEqual(calls, [['publicBrief', { limit: 3 }]])
  assert.equal(text, '[汐的近况]\n最近在学做菜\n昨天看完了那部电影')
})

test('publicBrief：缺失/空/抛错 → 空串，不抛', async () => {
  assert.equal(await fetchPublicBrief({ getMemory: () => null }), '')
  assert.equal(await fetchPublicBrief({ getMemory: () => ({}) }), '')
  assert.equal(await fetchPublicBrief({ getMemory: () => ({ publicBrief: async () => [] }) }), '')
  assert.equal(await fetchPublicBrief({ getMemory: () => ({ publicBrief: async () => '' }) }), '')
  assert.equal(await fetchPublicBrief({ getMemory: () => ({ publicBrief: async () => { throw new Error('x') } }) }), '')
})

test('formatPublicBrief：字符串/数组/对象都转成多行', () => {
  assert.equal(formatPublicBrief('一句话'), '一句话')
  assert.equal(formatPublicBrief([{ text: 'a' }, 'b', { content: 'c' }]), 'a\nb\nc')
  assert.equal(formatPublicBrief({ brief: 'obj' }), 'obj')
  assert.equal(formatPublicBrief(42), '')
})

test('群 @：近况在群上下文前、群上下文在本条消息前', async () => {
  const got = []
  const agent = { followup: async (m) => got.push(m), session: { log: [{ type: 'turn/end', data: { reason: 'done' } }] } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: false }) }
  const r = createRouter({
    store: openBridgeDb(':memory:'),
    sessions,
    mode: modeOf('send'),
    getPublicBrief: async () => '[汐的近况]\n最近在学做菜',
    getGroupContext: async () => '[群聊上下文·最近 1 条]\n主人: 上一句',
  })
  r.deliver(parsed({ wantGroupContext: true }))
  await r.idle()
  const text = got[0].content[0].text
  assert.ok(text.startsWith('[汐的近况]\n最近在学做菜\n\n[群聊上下文·最近 1 条]'), text.slice(0, 80))
  assert.ok(text.indexOf('[汐的近况]') < text.indexOf('[群聊上下文'))
  assert.ok(text.indexOf('[群聊上下文') < text.indexOf('[QQ·群'))
})

test('群 @：近况为空 → 只有上下文；服务缺失不影响投递', async () => {
  const got = []
  const agent = { followup: async (m) => got.push(m), session: { log: [] } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 's', created: false }) }
  const r = createRouter({
    store: openBridgeDb(':memory:'),
    sessions,
    mode: modeOf('send'),
    getPublicBrief: async () => '',
    getGroupContext: async () => '[群聊上下文·最近 1 条]\n主人: 上一句',
  })
  r.deliver(parsed({ wantGroupContext: true }))
  await r.idle()
  assert.ok(!got[0].content[0].text.includes('[汐的近况]'))
  assert.ok(got[0].content[0].text.startsWith('[群聊上下文'))

  const got2 = []
  const agent2 = { followup: async (m) => got2.push(m), session: { log: [] } }
  const r2 = createRouter({ store: openBridgeDb(':memory:'), sessions: { ensure: async () => ({ ok: true, agent: agent2, sessionId: 's' }) }, mode: modeOf('send') })
  r2.deliver(parsed({ wantGroupContext: true }))
  await r2.idle()
  assert.equal(got2.length, 1)
})

test('私聊不带 [汐的近况]（即使 wantGroupContext 被误设）', async () => {
  const got = []
  const agent = { followup: async (m) => got.push(m), session: { log: [] } }
  const r = createRouter({
    store: openBridgeDb(':memory:'),
    sessions: { ensure: async () => ({ ok: true, agent, sessionId: 's' }) },
    mode: modeOf('send'),
    getPublicBrief: async () => '[汐的近况]\n不应出现',
    getGroupContext: async () => '[群聊上下文]\n不应出现',
  })
  r.deliver(parsed({ kind: 'private', contactId: '2971030080', wantGroupContext: true }))
  await r.idle()
  assert.ok(!got[0].content[0].text.includes('[汐的近况]'))
  assert.ok(!got[0].content[0].text.includes('[群聊上下文]'))
})
