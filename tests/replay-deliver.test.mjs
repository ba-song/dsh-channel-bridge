import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplayDeliverer } from '../lib/replay-deliver.js'
import { openBridgeDb } from '../lib/store.js'

const parsed = (over = {}) => ({ channel: 'qq', kind: 'private', contactId: '2971030080', senderId: '2971030080', contactName: '饲养员', text: '补收一句', at: 1793871366000, messageId: 'r1', replay: true, isOwner: true, ...over })
const flush = () => new Promise((r) => setTimeout(r, 5))

function setup({ unifiedOn = true } = {}) {
  const store = openBridgeDb(':memory:')
  const routed = []
  const router = { deliver: (p) => { routed.push(p); return 'QUEUED' } }
  const homes = []
  const unified = {
    enabled: unifiedOn,
    deliver: async (p) => { homes.push(p); return { ok: true, code: 'DELIVERED_HOME', delivered: true } },
  }
  const counters = { homeDelivered: 0, legacyDelivered: 0 }
  const deliver = createReplayDeliverer({ unified, ownerIds: ['2971030080'], store, router, counters })
  return { store, router, unified, counters, deliver, routed, homes }
}

test('unified：补收走 dyHome，不投旧会话', async () => {
  const h = setup({ unifiedOn: true })
  const v = h.deliver(parsed())
  assert.equal(v, 'QUEUED')
  await flush()
  assert.equal(h.homes.length, 1)
  assert.equal(h.routed.length, 0) // 旧会话一次都没投
  assert.equal(h.counters.homeDelivered, 1)
  assert.equal(h.counters.legacyDelivered, 0)
  assert.equal(h.store.counts().inbound, 1) // 仍落库（审计/去重）
})

test('unified：群聊补收仍走旧会话（不受影响）', async () => {
  const h = setup({ unifiedOn: true })
  h.deliver(parsed({ kind: 'group', contactId: '707380948' }))
  await flush()
  assert.equal(h.homes.length, 0)
  assert.equal(h.routed.length, 1)
  assert.equal(h.counters.legacyDelivered, 1)
})

test('非 unified：补收走旧会话（回归）', async () => {
  const h = setup({ unifiedOn: false })
  h.deliver(parsed())
  await flush()
  assert.equal(h.homes.length, 0)
  assert.equal(h.routed.length, 1)
  assert.equal(h.counters.legacyDelivered, 1)
  assert.equal(h.counters.homeDelivered, 0)
})

test('unified 转 home 失败 → 不计数、不投旧会话', async () => {
  const store = openBridgeDb(':memory:')
  const routed = []
  const counters = { homeDelivered: 0, legacyDelivered: 0 }
  const deliver = createReplayDeliverer({
    unified: { enabled: true, deliver: async () => ({ ok: false, code: 'E_HOME_UNAVAILABLE' }) },
    ownerIds: ['2971030080'],
    store,
    router: { deliver: (p) => { routed.push(p); return 'QUEUED' } },
    counters,
  })
  deliver(parsed())
  await flush()
  assert.equal(routed.length, 0)
  assert.equal(counters.homeDelivered, 0)
  assert.equal(counters.legacyDelivered, 0)
})

test('unified 补收：库里已有 message_id → 0 投递，dupSkipped+1', async () => {
  const h = setup({ unifiedOn: true })
  h.store.insertEvent({ at: 1793871366000, channel: 'qq', kind: 'private', contact: '2971030080', direction: 'in', text: '已经收过', messageId: 'r1' })
  const v = h.deliver(parsed())
  assert.equal(v, 'SKIPPED_DUP')
  await flush()
  assert.equal(h.homes.length, 0)
  assert.equal(h.routed.length, 0)
  assert.equal(h.counters.dupSkipped, 1)
  assert.equal(h.counters.homeDelivered, 0)
})

test('unified 补收：新 message_id → 正常进 home', async () => {
  const h = setup({ unifiedOn: true })
  assert.equal(h.deliver(parsed({ messageId: 'brand-new' })), 'QUEUED')
  await flush()
  assert.equal(h.homes.length, 1)
  assert.equal(h.counters.homeDelivered, 1)
  assert.equal(h.counters.dupSkipped, 0)
})

test('legacy 补收同样查重（跨轮换/跨重启一致）', async () => {
  const h = setup({ unifiedOn: false })
  h.store.insertEvent({ at: 1, channel: 'qq', kind: 'private', contact: '1', direction: 'in', text: 'x', messageId: 'r1' })
  assert.equal(h.deliver(parsed()), 'SKIPPED_DUP')
  assert.equal(h.routed.length, 0)
  assert.equal(h.counters.dupSkipped, 1)
  assert.equal(h.counters.legacyDelivered, 0)
})

test('unified：陌生私聊补收走自己的房间，不进 home', async () => {
  const h = setup({ unifiedOn: true })
  h.deliver(parsed({ contactId: '999999', senderId: '999999', isOwner: false, messageId: 'stranger-1' }))
  await flush()
  assert.equal(h.homes.length, 0)
  assert.equal(h.routed.length, 1)
  assert.equal(h.counters.legacyDelivered, 1)
})
