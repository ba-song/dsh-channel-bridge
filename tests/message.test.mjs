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

test('blocks：图片直投作为第二个 content（text 在前）', () => {
  const img = { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1 } }
  const m = buildChannelMessage('看图', parsed, { blocks: [img] })
  assert.equal(m.content.length, 2)
  assert.equal(m.content[0].type, 'text')
  assert.equal(m.content[0].text, '看图')
  assert.deepEqual(m.content[1], img)
  assert.ok(Object.isFrozen(m.content[1]))
})

test('blocks：非法项被忽略，不影响纯文本消息', () => {
  const m = buildChannelMessage('hi', parsed, { blocks: [null, {}, { type: '' }] })
  assert.equal(m.content.length, 1)
  assert.equal(m.content[0].type, 'text')
})
