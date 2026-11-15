import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMessageEvent } from '../lib/parse.js'
import { shouldDeliverGroup } from '../lib/mention.js'

const selfId = '2190097528'
const groupEvt = (message) => ({ post_type: 'message', message_type: 'group', self_id: Number(selfId), user_id: 2971030080, group_id: 707380948, message_id: 1, time: 1793900000, sender: { nickname: '主人' }, message })
const cfg = { selfId, owner: { qqIds: ['2971030080'] } }

test('parse：at 段收集到 mentions；CQ 字符串兜底也能解析', () => {
  const p1 = parseMessageEvent(groupEvt([{ type: 'text', data: { text: '看这个' } }, { type: 'at', data: { qq: selfId } }]), cfg)
  assert.deepEqual(p1.mentions, [selfId])
  const p2 = parseMessageEvent({ ...groupEvt('x'), message: undefined, raw_message: '[CQ:at,qq=12345] hi' }, cfg)
  assert.deepEqual(p2.mentions, ['12345'])
  const p3 = parseMessageEvent(groupEvt([{ type: 'text', data: { text: '没 at' } }]), cfg)
  assert.deepEqual(p3.mentions, [])
})

test('群：@ 机器人 → 投', () => {
  const p = parseMessageEvent(groupEvt([{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text: ' 在吗' } }]), cfg)
  assert.equal(shouldDeliverGroup(p, { selfId }).ok, true)
})

test('群：没 @ → 不投；@ 别人 → 不投', () => {
  const p1 = parseMessageEvent(groupEvt([{ type: 'text', data: { text: '随便聊聊' } }]), cfg)
  assert.deepEqual(shouldDeliverGroup(p1, { selfId }), { ok: false, reason: 'no-mention' })
  const p2 = parseMessageEvent(groupEvt([{ type: 'at', data: { qq: '12345678' } }, { type: 'text', data: { text: ' 你看' } }]), cfg)
  assert.deepEqual(shouldDeliverGroup(p2, { selfId }), { ok: false, reason: 'at-other' })
})

test('私聊不受影响；requireMention:false 全投', () => {
  const priv = parseMessageEvent({ post_type: 'message', message_type: 'private', self_id: Number(selfId), user_id: 2971030080, message_id: 2, time: 1793900000, sender: {}, message: [{ type: 'text', data: { text: '在吗' } }] }, cfg)
  assert.equal(shouldDeliverGroup(priv, { selfId }).ok, true)
  const g = parseMessageEvent(groupEvt([{ type: 'text', data: { text: '没 at' } }]), cfg)
  assert.equal(shouldDeliverGroup(g, { selfId, requireMention: false }).ok, true)
})

test('selfId 缺失 → 保守不投且要 warn', () => {
  const g = parseMessageEvent(groupEvt([{ type: 'at', data: { qq: '1' } }]), { ...cfg, selfId: '' })
  const r = shouldDeliverGroup(g, { selfId: '' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-self')
  assert.equal(r.warn, true)
})

test('mentionNames 只是兜底：文字里 @昵称 也算（at 段优先）', () => {
  const g = parseMessageEvent(groupEvt([{ type: 'text', data: { text: '@小汐 在吗' } }]), cfg)
  assert.equal(shouldDeliverGroup(g, { selfId, mentionNames: ['小汐'] }).ok, true)
  assert.equal(shouldDeliverGroup(g, { selfId }).ok, false)
})
