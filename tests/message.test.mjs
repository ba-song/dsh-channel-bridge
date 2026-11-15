import test from 'node:test'
import assert from 'node:assert/strict'
import { buildChannelMessage } from '../lib/message.js'

const parsed = { channel: 'qq', kind: 'private', contactId: '2971030080', contactName: '饲养员', at: 123 }

test('source.kind=user（GUI 正常气泡）+ 渠道字段齐全', () => {
  const m = buildChannelMessage('hi', parsed, { id: 'fixed-uuid' })
  assert.equal(m.id, 'fixed-uuid')
  assert.equal(m.role, 'user')
  assert.equal(m.source.kind, 'user')
  assert.equal(m.source.channel, 'qq')
  assert.equal(m.source.contact, '2971030080')
  assert.equal(m.source.contactId, '2971030080')
  assert.equal(m.source.contactKind, 'private')
  assert.equal(m.source.messageKind, 'private')
  assert.equal(m.source.contactName, '饲养员')
  assert.equal(m.source.at, 123)
})

test('群消息 contact 是群号、contactKind=group', () => {
  const m = buildChannelMessage('x', { ...parsed, kind: 'group', contactId: '707380948', contactName: '测试群' })
  assert.equal(m.source.contact, '707380948')
  assert.equal(m.source.contactKind, 'group')
  assert.equal(m.source.kind, 'user')
})

test('content 永远是数组、对象冻结', () => {
  const m = buildChannelMessage('hi', parsed)
  assert.ok(Array.isArray(m.content))
  assert.equal(m.content[0].type, 'text')
  assert.ok(Object.isFrozen(m))
  assert.ok(Object.isFrozen(m.content))
  assert.match(m.id, /^[0-9a-f-]{36}$/)
})
