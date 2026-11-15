import test from 'node:test'
import assert from 'node:assert/strict'
import { openBridgeDb } from '../lib/store.js'
import { deriveRelationship, classifyTier, silenceDecision } from '../lib/relationship.js'

test('关系四维：主人开局就高，陌生人低', () => {
  const owner = deriveRelationship({ msg_count: 0 }, { isOwner: true })
  const stranger = deriveRelationship({ msg_count: 0 }, { isOwner: false })
  assert.ok(owner.trust > stranger.trust)
  assert.equal(classifyTier(owner, { isOwner: true }), 'owner')
  assert.equal(classifyTier(stranger), 'stranger')
})

test('沉默策略：默认关；开了主人不沉默、低信任私聊沉默', () => {
  const row = { msg_count: 0, trust: 0.2, closeness: 0.2 }
  assert.equal(silenceDecision({ row, cfg: { enabled: false } }).silent, false)
  assert.equal(silenceDecision({ row, isOwner: true, cfg: { enabled: true, silence: { enabled: true } } }).silent, false)
  assert.equal(silenceDecision({ row, cfg: { enabled: true, silence: { enabled: true } } }).reason, 'private-low-trust')
  assert.equal(silenceDecision({ row, kind: 'group', mentioned: true, cfg: { enabled: true, silence: { enabled: true } } }).silent, false)
})

test('store：入站累积 msg_count 与四维', () => {
  const store = openBridgeDb(':memory:')
  store.upsertContact({ channel: 'qq', contact: '1', kind: 'private', name: 'a', at: 1000 })
  const a = store.contactOf('qq', '1', 'private')
  store.upsertContact({ channel: 'qq', contact: '1', kind: 'private', name: 'a', at: 2000 })
  const b = store.contactOf('qq', '1', 'private')
  assert.equal(Number(b.msg_count), Number(a.msg_count) + 1)
  assert.ok(Number(b.familiarity) >= Number(a.familiarity))
})
