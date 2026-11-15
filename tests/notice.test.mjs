import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNoticeEvent, describeNotice } from '../lib/notice.js'

const T = 1793900000 // 2026-11-16 前后的秒级时间

/** 构造最小 notice 事件。 */
function evt(fields = {}) {
  return { post_type: 'notice', time: T, self_id: 2190097528, ...fields }
}

/** 构造已解析的 notice（给 describeNotice 用）。 */
function parsed(kind, fields = {}) {
  return {
    kind,
    subType: '',
    groupId: '',
    userId: '',
    operatorId: '',
    targetId: '',
    messageId: '',
    duration: 0,
    fileName: '',
    fileSize: 0,
    fileId: '',
    at: 0,
    selfId: '',
    ...fields,
  }
}

test('friend_recall：统一结构 + 秒转毫秒', () => {
  assert.deepEqual(
    parseNoticeEvent({ post_type: 'notice', notice_type: 'friend_recall', time: T, self_id: 2190097528, user_id: 123456, message_id: 88 }),
    {
      kind: 'friend_recall',
      subType: '',
      groupId: '',
      userId: '123456',
      operatorId: '',
      targetId: '',
      messageId: '88',
      duration: 0,
      fileName: '',
      fileSize: 0,
      fileId: '',
      at: 1793900000000,
      selfId: '2190097528',
    },
  )
})

test('group_recall：发送者与操作者分开', () => {
  const n = parseNoticeEvent(evt({ notice_type: 'group_recall', group_id: 707380948, user_id: 111, operator_id: 222, message_id: 333 }))
  assert.equal(n.kind, 'group_recall')
  assert.equal(n.groupId, '707380948')
  assert.equal(n.userId, '111')
  assert.equal(n.operatorId, '222')
  assert.equal(n.messageId, '333')
})

test('group_increase：approve / invite 子类型', () => {
  for (const subType of ['approve', 'invite']) {
    const n = parseNoticeEvent(evt({ notice_type: 'group_increase', sub_type: subType, group_id: 707380948, user_id: 111, operator_id: 222 }))
    assert.equal(n.kind, 'group_increase')
    assert.equal(n.subType, subType)
    assert.equal(n.groupId, '707380948')
    assert.equal(n.userId, '111')
    assert.equal(n.operatorId, '222')
  }
})

test('group_decrease：leave / kick / kick_me 子类型', () => {
  for (const subType of ['leave', 'kick', 'kick_me']) {
    const n = parseNoticeEvent(evt({ notice_type: 'group_decrease', sub_type: subType, group_id: 707380948, user_id: 111, operator_id: 222 }))
    assert.equal(n.kind, 'group_decrease')
    assert.equal(n.subType, subType)
    assert.equal(n.userId, '111')
    assert.equal(n.operatorId, '222')
  }
})

test('group_ban：ban 带时长 / lift_ban 时长为 0', () => {
  const ban = parseNoticeEvent(evt({ notice_type: 'group_ban', sub_type: 'ban', group_id: 707380948, user_id: 111, operator_id: 222, duration: 600 }))
  assert.equal(ban.kind, 'group_ban')
  assert.equal(ban.subType, 'ban')
  assert.equal(ban.duration, 600)
  assert.equal(ban.operatorId, '222')

  const lift = parseNoticeEvent(evt({ notice_type: 'group_ban', sub_type: 'lift_ban', group_id: 707380948, user_id: 111, operator_id: 222, duration: 0 }))
  assert.equal(lift.subType, 'lift_ban')
  assert.equal(lift.duration, 0)
})

test('group_ban：缺 sub_type 时按 duration 推断', () => {
  assert.equal(parseNoticeEvent(evt({ notice_type: 'group_ban', duration: 60 })).subType, 'ban')
  assert.equal(parseNoticeEvent(evt({ notice_type: 'group_ban', duration: 0 })).subType, 'lift_ban')
})

test('group_admin：set / unset', () => {
  const set = parseNoticeEvent(evt({ notice_type: 'group_admin', sub_type: 'set', group_id: 707380948, user_id: 111 }))
  assert.equal(set.kind, 'group_admin')
  assert.equal(set.subType, 'set')
  assert.equal(set.groupId, '707380948')
  assert.equal(set.userId, '111')

  const unset = parseNoticeEvent(evt({ notice_type: 'group_admin', sub_type: 'unset', group_id: 707380948, user_id: 111 }))
  assert.equal(unset.subType, 'unset')
})

test('group_upload：file.name/size/id 映射', () => {
  const n = parseNoticeEvent(evt({ notice_type: 'group_upload', group_id: 707380948, user_id: 111, file: { id: 'fid-1', name: '报告.pdf', size: 2048, busid: 102 } }))
  assert.equal(n.kind, 'group_upload')
  assert.equal(n.groupId, '707380948')
  assert.equal(n.userId, '111')
  assert.equal(n.fileName, '报告.pdf')
  assert.equal(n.fileSize, 2048)
  assert.equal(n.fileId, 'fid-1')
})

test('group_upload：缺 file / size 非法时降级', () => {
  const empty = parseNoticeEvent(evt({ notice_type: 'group_upload', group_id: 1, user_id: 2 }))
  assert.equal(empty.fileName, '')
  assert.equal(empty.fileSize, 0)
  assert.equal(empty.fileId, '')

  const bad = parseNoticeEvent(evt({ notice_type: 'group_upload', file: { name: 'a.zip', size: 'abc' } }))
  assert.equal(bad.fileName, 'a.zip')
  assert.equal(bad.fileSize, 0)
})

test('friend_add：userId', () => {
  const n = parseNoticeEvent(evt({ notice_type: 'friend_add', user_id: 123456 }))
  assert.equal(n.kind, 'friend_add')
  assert.equal(n.userId, '123456')
})

test('notify/poke 群聊：发起者与目标', () => {
  const n = parseNoticeEvent(evt({ notice_type: 'notify', sub_type: 'poke', group_id: 707380948, user_id: 111, target_id: 222 }))
  assert.equal(n.kind, 'poke')
  assert.equal(n.subType, 'poke')
  assert.equal(n.groupId, '707380948')
  assert.equal(n.userId, '111')
  assert.equal(n.targetId, '222')
})

test('notify/poke 私聊：userId 取发起者 sender_id（不是对方）', () => {
  const n = parseNoticeEvent(evt({ notice_type: 'notify', sub_type: 'poke', self_id: 999, user_id: 888, sender_id: 111, target_id: 999 }))
  assert.equal(n.kind, 'poke')
  assert.equal(n.groupId, '')
  assert.equal(n.userId, '111')
  assert.equal(n.targetId, '999')
  assert.equal(n.selfId, '999')
  assert.equal(describeNotice(n), '拍了拍你')
})

test('notify 其它 sub_type：kind=unknown', () => {
  const n = parseNoticeEvent(evt({ notice_type: 'notify', sub_type: 'input_status', user_id: 111 }))
  assert.equal(n.kind, 'unknown')
  assert.equal(n.subType, 'input_status')
  assert.equal(n.userId, '111')
})

test('未知 notice_type 返回 null', () => {
  assert.equal(parseNoticeEvent(evt({ notice_type: 'group_essence', group_id: 1, user_id: 2 })), null)
  assert.equal(parseNoticeEvent(evt({ notice_type: 'mystery' })), null)
  assert.equal(parseNoticeEvent(evt({})), null)
})

test('非 notice / 非对象事件返回 null', () => {
  for (const value of [
    null, undefined, 'notice', 42, [],
    { post_type: 'message', message_type: 'private' },
    { post_type: 'message_sent' },
    { post_type: 'meta_event' },
    { post_type: 'request' },
  ]) {
    assert.equal(parseNoticeEvent(value), null, JSON.stringify(value))
  }
})

test('缺字段：所有字段降级为空串 / 0', () => {
  assert.deepEqual(parseNoticeEvent({ post_type: 'notice', notice_type: 'group_increase' }), {
    kind: 'group_increase',
    subType: '',
    groupId: '',
    userId: '',
    operatorId: '',
    targetId: '',
    messageId: '',
    duration: 0,
    fileName: '',
    fileSize: 0,
    fileId: '',
    at: 0,
    selfId: '',
  })
})

test('时间：秒/毫秒统一，非法值回 0', () => {
  assert.equal(parseNoticeEvent(evt({ notice_type: 'friend_add', time: 1793900000 })).at, 1793900000000)
  assert.equal(parseNoticeEvent(evt({ notice_type: 'friend_add', time: 1793900000123 })).at, 1793900000123)
  assert.equal(parseNoticeEvent(evt({ notice_type: 'friend_add', time: 'abc' })).at, 0)
  assert.equal(parseNoticeEvent(evt({ notice_type: 'friend_add', time: 0 })).at, 0)
  assert.equal(parseNoticeEvent({ post_type: 'notice', notice_type: 'friend_add' }).at, 0)
})

test('parseNoticeEvent 不修改入参', () => {
  const input = evt({ notice_type: 'group_ban', sub_type: 'ban', group_id: 1, user_id: 2, operator_id: 3, duration: 600 })
  const before = JSON.stringify(input)
  parseNoticeEvent(input)
  assert.equal(JSON.stringify(input), before)
})

test('describeNotice：撤回', () => {
  assert.equal(describeNotice(parsed('friend_recall')), '撤回了消息')
  assert.equal(describeNotice(parsed('group_recall', { operatorId: '222' })), '撤回了消息')
})

test('describeNotice：拍一拍你 / 拍一拍某人', () => {
  assert.equal(describeNotice(parsed('poke')), '拍了拍你')
  assert.equal(describeNotice(parsed('poke', { targetId: '12345' })), '拍了拍 12345')
  assert.equal(describeNotice(parsed('poke', { targetId: '12345', selfId: '12345' })), '拍了拍你')
  // 调用方可显式传自己的 QQ
  assert.equal(describeNotice(parsed('poke', { targetId: '777' }), { selfId: '777' }), '拍了拍你')
})

test('describeNotice：进群 / 退群 / 被踢 / 解散', () => {
  assert.equal(describeNotice(parsed('group_increase', { subType: 'approve' })), '加入了群')
  assert.equal(describeNotice(parsed('group_decrease', { subType: 'leave' })), '退出了群')
  assert.equal(describeNotice(parsed('group_decrease', { subType: 'kick' })), '被踢出了群')
  assert.equal(describeNotice(parsed('group_decrease', { subType: 'kick_me' })), '被踢出了群')
  assert.equal(describeNotice(parsed('group_decrease', { subType: 'disband' })), '随群解散')
})

test('describeNotice：禁言时长格式化', () => {
  assert.equal(describeNotice(parsed('group_ban', { subType: 'ban', duration: 600 })), '被管理员禁言 10 分钟')
  assert.equal(describeNotice(parsed('group_ban', { subType: 'ban', duration: 90 })), '被管理员禁言 1 分 30 秒')
  assert.equal(describeNotice(parsed('group_ban', { subType: 'ban', duration: 45 })), '被管理员禁言 45 秒')
  assert.equal(describeNotice(parsed('group_ban', { subType: 'ban', duration: 0 })), '被管理员禁言')
  assert.equal(describeNotice(parsed('group_ban', { subType: 'lift_ban' })), '被解除禁言')
})

test('describeNotice：管理员 set / unset', () => {
  assert.equal(describeNotice(parsed('group_admin', { subType: 'set' })), '被设为管理员')
  assert.equal(describeNotice(parsed('group_admin', { subType: 'unset' })), '被取消管理员')
})

test('describeNotice：群文件', () => {
  assert.equal(describeNotice(parsed('group_upload', { fileName: '报告.pdf' })), '上传了文件 报告.pdf')
  assert.equal(describeNotice(parsed('group_upload')), '上传了文件')
})

test('describeNotice：加好友 / 未知 / 空', () => {
  assert.equal(describeNotice(parsed('friend_add')), '加你为好友')
  assert.equal(describeNotice(parsed('unknown')), '未知通知')
  assert.equal(describeNotice(null), '')
  assert.equal(describeNotice(undefined), '')
  assert.equal(describeNotice(42), '')
  assert.equal(describeNotice({}), '未知通知')
})

test('describeNotice：接 parseNoticeEvent 的真实路径', () => {
  const ban = parseNoticeEvent(evt({ notice_type: 'group_ban', sub_type: 'ban', group_id: 707380948, user_id: 111, operator_id: 222, duration: 600 }))
  assert.equal(describeNotice(ban), '被管理员禁言 10 分钟')
  const upload = parseNoticeEvent(evt({ notice_type: 'group_upload', group_id: 707380948, user_id: 111, file: { name: '报告.pdf', size: 1 } }))
  assert.equal(describeNotice(upload), '上传了文件 报告.pdf')
})
