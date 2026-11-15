import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMessageEvent, renderSegments, toMillis } from '../lib/parse.js'

const owner = { qqIds: ['2971030080'] }
const cfg = { selfId: '2190097528', owner, channel: 'qq' }

test('私聊：文本/名字/主人标记', () => {
  const p = parseMessageEvent({
    post_type: 'message', message_type: 'private', self_id: 2190097528,
    user_id: 2971030080, time: 1793900000, message_id: 11,
    sender: { nickname: '饲养员', card: '' },
    message: [{ type: 'text', data: { text: '早上好' } }],
  }, cfg)
  assert.equal(p.kind, 'private')
  assert.equal(p.contactId, '2971030080')
  assert.equal(p.contactName, '饲养员')
  assert.equal(p.text, '早上好')
  assert.equal(p.isOwner, true)
  assert.equal(p.at, 1793900000000)
})

test('私聊：card 优先于 nickname', () => {
  const p = parseMessageEvent({ post_type: 'message', message_type: 'private', self_id: 1, user_id: 2971030080, message_id: 1, sender: { card: '群名片', nickname: '昵称' }, message: 'hi' }, cfg)
  assert.equal(p.contactName, '群名片')
  assert.equal(p.text, 'hi')
})

test('群聊：contactId=群号、senderName 单独给', () => {
  const p = parseMessageEvent({
    post_type: 'message', message_type: 'group', self_id: 2190097528, user_id: 12345678,
    group_id: 707380948, group_name: '测试群', message_id: 22, time: 1793900000,
    sender: { card: '霸宋' }, message: [{ type: 'text', data: { text: '早' } }],
  }, cfg)
  assert.equal(p.kind, 'group')
  assert.equal(p.contactId, '707380948')
  assert.equal(p.contactName, '测试群')
  assert.equal(p.senderName, '霸宋')
  assert.equal(p.isOwner, false)
})

test('群名缺失 → 群_<号>', () => {
  const p = parseMessageEvent({ post_type: 'message', message_type: 'group', self_id: 1, user_id: 2, group_id: 707380948, message_id: 1, sender: {}, message: [] }, cfg)
  assert.equal(p.contactName, '群_707380948')
})

test('自己发的跳过', () => {
  assert.equal(parseMessageEvent({ post_type: 'message', message_type: 'private', self_id: 2190097528, user_id: 2190097528, message_id: 1, sender: {}, message: [] }, cfg), null)
})

test('message_sent / meta_event / notice 都跳过', () => {
  for (const post of ['message_sent', 'meta_event', 'notice', 'request']) {
    assert.equal(parseMessageEvent({ post_type: post, message_type: 'private', self_id: 1, user_id: 2, message_id: 1 }, cfg), null)
  }
})

test('缺 group_id / 缺 user_id 返回 null', () => {
  assert.equal(parseMessageEvent({ post_type: 'message', message_type: 'group', self_id: 1, user_id: 2, message_id: 1 }, cfg), null)
  assert.equal(parseMessageEvent({ post_type: 'message', message_type: 'private', self_id: 1, message_id: 1 }, cfg), null)
})

test('段渲染：图片/语音/@ 占位', () => {
  assert.equal(renderSegments([{ type: 'text', data: { text: '看图' } }, { type: 'image', data: { url: 'x' } }, { type: 'record', data: {} }, { type: 'at', data: { qq: '123' } }]), '看图[图片][语音]@123')
})

test('秒/毫秒时间统一', () => {
  assert.equal(toMillis(1793900000), 1793900000000)
  assert.equal(toMillis(1793900000000), 1793900000000)
})

test('owner 只看发言人（群里主人说话也算主人）', () => {
  const p = parseMessageEvent({ post_type: 'message', message_type: 'group', self_id: 1, user_id: 2971030080, group_id: 707380948, message_id: 1, sender: {}, message: [] }, cfg)
  assert.equal(p.isOwner, true)
  assert.equal(p.contactId, '707380948')
})
