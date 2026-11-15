import test from 'node:test'
import assert from 'node:assert/strict'
import { dedupeKey, createDedupe } from '../lib/dedupe.js'

test('key 形状：类型|群号|消息号', () => {
  assert.equal(dedupeKey({ message_type: 'private', message_id: 5 }), 'private|0|5')
  assert.equal(dedupeKey({ message_type: 'group', group_id: 707, message_id: 5 }), 'group|707|5')
})

test('没有 message_id 返回 null（不吞消息）', () => {
  assert.equal(dedupeKey({ message_type: 'private' }), null)
  const d = createDedupe({ max: 10 })
  assert.equal(d.seen(null), false)
  assert.equal(d.seen(null), false)
})

test('同 key 只放一次；不同群不撞', () => {
  const d = createDedupe({ max: 10 })
  assert.equal(d.seen('a'), false)
  assert.equal(d.seen('a'), true)
  assert.equal(d.seen('b'), false)
  assert.equal(d.size, 2)
})

test('超上限淘汰最旧', () => {
  const d = createDedupe({ max: 2 })
  d.seen('a'); d.seen('b'); d.seen('c')
  assert.equal(d.size, 2)
  assert.equal(d.has('a'), false)
  assert.equal(d.has('c'), true)
})

import { createInboundGate } from '../lib/dedupe.js'
import { openBridgeDb } from '../lib/store.js'

test('入站闸：同一条消息第二次拒绝（内存）', () => {
  const gate = createInboundGate({ store: openBridgeDb(':memory:'), dedupe: createDedupe({ max: 10 }) })
  const evt = { message_type: 'private', message_id: 42 }
  assert.equal(gate.accept(evt, { messageId: '42' }).ok, true)
  const second = gate.accept(evt, { messageId: '42' })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'dup-mem')
})

test('入站闸：进程重启（内存清空）后仍按库里 message_id 拒绝', () => {
  const store = openBridgeDb(':memory:')
  store.insertEvent({ at: 1, channel: 'qq', direction: 'in', messageId: '99', text: 'x' })
  const gate = createInboundGate({ store, dedupe: createDedupe({ max: 10 }) }) // 新进程 = 新内存
  const r = gate.accept({ message_type: 'private', message_id: 99 }, { messageId: '99' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'dup-db')
})

test('入站闸：没有 message_id 时不拦', () => {
  const gate = createInboundGate({ store: openBridgeDb(':memory:'), dedupe: createDedupe({ max: 10 }) })
  assert.equal(gate.accept({ message_type: 'private' }, { messageId: '' }).ok, true)
})
