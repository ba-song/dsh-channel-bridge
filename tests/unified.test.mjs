import test from 'node:test'
import assert from 'node:assert/strict'
import { createUnified } from '../lib/unified.js'
import { openBridgeDb } from '../lib/store.js'

const parsed = (over = {}) => ({ channel: 'qq', kind: 'private', contactId: '2971030080', contactName: '饲养员', text: '在吗', at: 1793871366000, messageId: 'm1', ...over })

function fakeHome(result = { delivered: true }) {
  const calls = []
  return { calls, deliver: async (p) => { calls.push(p); return typeof result === 'function' ? result(p) : result } }
}

test('unified：私聊进 dyHome，参数齐全（含顺序）', async () => {
  const home = fakeHome()
  const u = createUnified({ cfg: { unified: true }, store: openBridgeDb(':memory:'), getHome: () => home })
  const r = await u.deliver(parsed())
  assert.equal(r.code, 'DELIVERED_HOME')
  assert.equal(home.calls.length, 1)
  const call = home.calls[0]
  assert.equal(call.channel, 'qq')
  assert.equal(call.kind, 'private')
  assert.equal(call.contactId, '2971030080')
  assert.equal(call.contactName, '饲养员')
  assert.equal(call.at, 1793871366000)
  assert.equal(call.messageId, 'm1')
  assert.equal(call.priority, 'normal')
  // prompt：人物头 + 正文 + 完整规则（由 autonomy 挂常驻上下文后剥掉）
  assert.match(call.text, /^\[QQ·私聊·饲养员\(2971030080\)\] 在吗\n\n【这个房间的规矩】/)
  assert.ok(call.text.includes('把同一句原样写一遍'))
  assert.equal(u.stats.delivered, 1)
})

test('unified：群聊不走 home（E_NOT_PRIVATE）', async () => {
  const home = fakeHome()
  const u = createUnified({ cfg: { unified: true }, store: openBridgeDb(':memory:'), getHome: () => home })
  const r = await u.deliver(parsed({ kind: 'group', contactId: '707380948' }))
  assert.equal(r.code, 'E_NOT_PRIVATE')
  assert.equal(home.calls.length, 0)
})

test('unified：dyHome 缺失 → E_HOME_UNAVAILABLE，不回退', async () => {
  const u = createUnified({ cfg: { unified: true }, store: openBridgeDb(':memory:'), getHome: () => null })
  const r = await u.deliver(parsed())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_HOME_UNAVAILABLE')
  assert.equal(u.stats.homeUnavailable, 1)
})

test('unified：未开启 → E_UNIFIED_OFF（默认关）', async () => {
  const home = fakeHome()
  const u = createUnified({ cfg: { unified: false }, store: openBridgeDb(':memory:'), getHome: () => home })
  assert.equal(u.enabled, false)
  const r = await u.deliver(parsed())
  assert.equal(r.code, 'E_UNIFIED_OFF')
  assert.equal(home.calls.length, 0)
})

test('unified：handoverText 只传一次', async () => {
  const home = fakeHome()
  const store = openBridgeDb(':memory:')
  let taken = 0
  const handover = {
    take: () => (taken++ === 0 ? '17:00 [主人] 一句' : ''),
    markDone: () => store.setMeta('handover.done', 'yes'),
  }
  const u = createUnified({ cfg: { unified: true }, store, getHome: () => home, handover })
  await u.deliver(parsed({ messageId: 'm1' }))
  await u.deliver(parsed({ messageId: 'm2' }))
  assert.equal(home.calls[0].handoverText, '17:00 [主人] 一句')
  assert.equal('handoverText' in home.calls[1], false)
  assert.equal(u.stats.handoverSent, 1)
  assert.ok(store.getMeta('handover.done'))
})

test('unified：home.deliver 抛错 → E_HOME_DELIVER_FAILED，且不标记交接完成', async () => {
  const store = openBridgeDb(':memory:')
  let marked = false
  const handover = { take: () => '交接内容', markDone: () => { marked = true } }
  const u = createUnified({
    cfg: { unified: true },
    store,
    getHome: () => ({ deliver: async () => { throw new Error('boom') } }),
    handover,
  })
  const r = await u.deliver(parsed())
  assert.equal(r.code, 'E_HOME_DELIVER_FAILED')
  assert.equal(marked, false)
  assert.equal(u.stats.failed, 1)
})

test('unified：主人私聊 → priority=owner', async () => {
  const home = fakeHome()
  const u = createUnified({ cfg: { unified: true, owner: { qqIds: ['2971030080'] } }, store: openBridgeDb(':memory:'), getHome: () => home })
  await u.deliver(parsed())
  assert.equal(home.calls[0].priority, 'owner')
})

test('unified：非主人私聊 → priority=normal；群聊不走 home', async () => {
  const home = fakeHome()
  const u = createUnified({ cfg: { unified: true, owner: { qqIds: ['2971030080'] } }, store: openBridgeDb(':memory:'), getHome: () => home })
  await u.deliver(parsed({ contactId: '12345678', contactName: '别人' }))
  assert.equal(home.calls[0].priority, 'normal')
  const g = await u.deliver(parsed({ kind: 'group', contactId: '707380948' }))
  assert.equal(g.code, 'E_NOT_PRIVATE')
  assert.equal(home.calls.length, 1)
})

test('unified：delivered===true 才写 handover.done', async () => {
  const home = fakeHome({ delivered: true })
  const store = openBridgeDb(':memory:')
  let marked = 0
  const handover = { take: () => '交接', markDone: () => { marked += 1; store.setMeta('handover.done', 'yes') } }
  const u = createUnified({ cfg: { unified: true }, store, getHome: () => home, handover })
  const r = await u.deliver(parsed())
  assert.equal(r.code, 'DELIVERED_HOME')
  assert.equal(u.stats.delivered, 1)
  assert.equal(marked, 1)
  assert.ok(store.getMeta('handover.done'))
})

test('unified：queued:true → 不写 done，下一条仍带 handover', async () => {
  const home = fakeHome({ queued: true })
  const store = openBridgeDb(':memory:')
  let marked = 0
  let taken = 0
  const handover = { take: () => (taken++ >= 0 ? '交接内容' : ''), markDone: () => { marked += 1 } }
  const u = createUnified({ cfg: { unified: true }, store, getHome: () => home, handover })
  const r1 = await u.deliver(parsed({ messageId: 'm1' }))
  assert.equal(r1.code, 'QUEUED_HOME')
  assert.equal(u.stats.queued, 1)
  assert.equal(marked, 0)
  assert.deepEqual(u.stats.lastResult, { delivered: false, queued: true, ok: undefined, code: null })
  const r2 = await u.deliver(parsed({ messageId: 'm2' }))
  assert.equal(home.calls[1].handoverText, '交接内容') // 仍带
  assert.equal(u.stats.delivered, 0)
})

test('unified：ok:false + code → failed++、不写 done、不重放', async () => {
  const home = fakeHome({ ok: false, code: 'E_HOME_BUSY' })
  const store = openBridgeDb(':memory:')
  let marked = 0
  const handover = { take: () => '交接', markDone: () => { marked += 1 } }
  const u = createUnified({ cfg: { unified: true }, store, getHome: () => home, handover })
  const r = await u.deliver(parsed())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_HOME_BUSY')
  assert.equal(u.stats.failed, 1)
  assert.equal(u.stats.lastError, 'E_HOME_BUSY')
  assert.equal(marked, 0)
  assert.equal(home.calls.length, 1) // 不重放
})

import { buildUnifiedText } from '../lib/unified.js'

test('unified 投递正文 = 人物头 + 正文 + 完整规则（tool 版）', () => {
  const text = buildUnifiedText(parsed(), {})
  assert.match(text, /^\[QQ·私聊·饲养员\(2971030080\)\] 在吗/)
  assert.ok(text.includes('【这个房间的规矩】'))
  assert.ok(text.includes('只有 dy_say 能送到对方'))
  assert.ok(text.includes('把同一句原样写一遍'))
  assert.ok(!text.includes('通道当前只读'))
})

test('unified 投递正文：mirror 开时用自动显示版规则', () => {
  const text = buildUnifiedText(parsed(), { mirrorEnabled: true })
  assert.ok(text.includes('对话页里会自动显示你发出去的原文'))
  assert.ok(!text.includes('把同一句原样写一遍'))
})
