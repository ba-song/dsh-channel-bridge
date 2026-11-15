import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessions } from '../lib/sessions.js'
import { openBridgeDb } from '../lib/store.js'
import { createGroupBuckets } from '../lib/group-buckets.js'
import { shouldRouteToHome } from '../lib/unified.js'

const ROOT = mkdtempSync(join(tmpdir(), 'multi-'))
const cfg = { cwdRoot: ROOT, privateCwd: join(ROOT, 'qq-私聊'), groupCwd: join(ROOT, 'qq-群'), cwd: join(ROOT, 'qq') }
const model = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
const pGroup = (id) => ({ channel: 'qq', kind: 'group', contactId: id, contactName: `群${id}` })
const pPriv = (id) => ({ channel: 'qq', kind: 'private', contactId: id, senderId: id, contactName: `人${id}` })

function harness() {
  const store = openBridgeDb(':memory:')
  const creates = []
  const live = new Map()
  const agents = {
    get: (id) => live.get(id),
    resume: async () => { throw new Error('no') },
    create: async (o) => {
      creates.push(o)
      const agent = { id: o.sessionId, session: { id: o.sessionId, log: [] }, followup: async () => {} }
      live.set(o.sessionId, agent)
      return agent
    },
  }
  const s = createSessions({ getAgents: () => agents, getModel: model, store, cfg })
  return { s, store, creates }
}

test('两个群 → 两个独立 session 与 cwd（目录自动创建）', async () => {
  const h = harness()
  const a = await h.s.ensure(pGroup('111'))
  const b = await h.s.ensure(pGroup('222'))
  assert.notEqual(a.sessionId, b.sessionId)
  assert.equal(a.sessionId, h.creates[0].sessionId)
  assert.equal(b.sessionId, h.creates[1].sessionId)
  assert.equal(h.creates[0].meta.cwd, join(cfg.groupCwd, '111'))
  assert.equal(h.creates[1].meta.cwd, join(cfg.groupCwd, '222'))
  assert.ok(existsSync(join(cfg.groupCwd, '111')))
  assert.ok(existsSync(join(cfg.groupCwd, '222')))
  assert.equal(h.store.getSession('qq', 'group:111').session_id, a.sessionId)
  assert.equal(h.store.getSession('qq', 'group:222').session_id, b.sessionId)
})

test('两个陌生私聊 → 两个独立 session 与 cwd', async () => {
  const h = harness()
  const a = await h.s.ensure(pPriv('3333'))
  const b = await h.s.ensure(pPriv('4444'))
  assert.notEqual(a.sessionId, b.sessionId)
  assert.equal(h.creates[0].meta.cwd, join(cfg.privateCwd, '3333'))
  assert.equal(h.creates[1].meta.cwd, join(cfg.privateCwd, '4444'))
  assert.ok(existsSync(join(cfg.privateCwd, '3333')))
})

test('同一个群连续两条 → 同一 session（不重复建）', async () => {
  const h = harness()
  const a = await h.s.ensure(pGroup('555'))
  const b = await h.s.ensure(pGroup('555'))
  assert.equal(a.sessionId, b.sessionId)
  assert.equal(h.creates.length, 1)
})

test('窗口按群独立：一个群开窗/消耗不影响另一个群', () => {
  const closed = []
  const buckets = createGroupBuckets({ digest: { save: (x) => closed.push(x) }, messages: 2, idleMs: 60000 })
  const a = buckets.get('111', '群A')
  const b = buckets.get('222', '群B')
  a.window.open()
  assert.equal(a.window.isOpen(), true)
  assert.equal(b.window.isOpen(), false)
  buckets.noteMessage(a, { speaker: '甲', text: 'a1', at: 1 })
  assert.equal(buckets.noteMessage(b, { speaker: '乙', text: 'b1', at: 2 }), undefined)
  assert.equal(b.messages.length, 0)
  a.window.consume()
  a.window.consume() // A 用完关窗
  assert.equal(a.window.isOpen(), false)
  assert.equal(closed.length, 1)
  assert.equal(closed[0].groupId, '111')
  assert.equal(b.window.isOpen(), false) // B 一直没开
  assert.equal(buckets.size(), 2)
})

test('主人私聊 → home；陌生私聊 → 自己房间；群不走 home', () => {
  const owner = [{ channel: 'qq', kind: 'private', contactId: '2971030080', senderId: '2971030080', isOwner: true }]
  assert.equal(shouldRouteToHome(owner[0], { unified: true, ownerIds: ['2971030080'] }), true)
  assert.equal(shouldRouteToHome(pPriv('5555'), { unified: true, ownerIds: ['2971030080'] }), false)
  assert.equal(shouldRouteToHome({ ...pPriv('2971030080'), isOwner: false }, { unified: true, ownerIds: ['2971030080'] }), true)
  assert.equal(shouldRouteToHome(pGroup('111'), { unified: true, ownerIds: ['2971030080'] }), false)
  assert.equal(shouldRouteToHome(owner[0], { unified: false, ownerIds: ['2971030080'] }), false)
})
