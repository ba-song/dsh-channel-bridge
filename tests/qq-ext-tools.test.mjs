import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.js'
import { openBridgeDb } from '../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'qq-ext-'))
const pdf = join(dir, 'a.pdf')
writeFileSync(pdf, Buffer.from('PDFDATA'))
const mp4 = join(dir, 'a.mp4')
writeFileSync(mp4, Buffer.from('MP4DATA'))
const bigPdf = join(dir, 'big.pdf')
writeFileSync(bigPdf, 'x')
truncateSync(bigPdf, 9 * 1024 * 1024) // 超过 8MB 文件上限
const txt = join(dir, 'a.txt')
writeFileSync(txt, 'hello')
const exe = join(dir, 'a.exe')
writeFileSync(exe, 'MZ')

function setup({ modeValue = 'send', sendOk = true, contactName = '主人' } = {}) {
  const store = openBridgeDb(':memory:')
  store.upsertContact({ channel: 'qq', contact: '2971030080', kind: 'private', name: contactName, at: Date.now() })
  store.upsertContact({ channel: 'qq', contact: '707380948', kind: 'group', name: '测试群', at: Date.now() })
  const calls = []
  const sent = []
  const sender = {
    callAction: async (action, params) => {
      calls.push({ action, params })
      return { ok: sendOk, data: sendOk ? { message_id: 42, file_id: 'fid' } : {}, code: sendOk ? undefined : 'E_SEND_FAILED' }
    },
    sendSegments: async ({ kind, contactId, message }) => {
      sent.push({ kind, contactId, message })
      return sendOk ? { ok: true, messageId: 'mid-1' } : { ok: false, code: 'E_SEND_FAILED' }
    },
  }
  const defs = []
  registerTools({
    tools: { register: (d) => defs.push(d) },
    cfg: { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 3600 * 1000 }, qq: { rateMs: 0 }, selfId: '2190097528' },
    mode: { current: () => modeValue },
    sender,
    store,
    log: null,
    forwardReader: {
      resolve: async ({ id, messageId }) => (id === 'fw-1' || messageId === 99)
        ? { id: String(id ?? messageId), nodes: [{ senderId: '1', senderName: '甲', text: '你好', at: 1 }], text: '[合并转发 1 条] 1. 甲：你好' }
        : null,
    },
  })
  const tool = (name) => defs.find((d) => d.name === name)
  return { store, calls, sent, tool }
}

const exec = { agent: { session: { header: { cwd: '/sdcard/DSHA/渠道/qq' } } } }

test('dy_qq_poke：私聊拍对方 / 群拍指定成员 / 群缺 userId 拒绝', async () => {
  const h = setup()
  const priv = await h.tool('dy_qq_poke').execute({ kind: 'private', contactId: '2971030080' }, exec)
  assert.equal(priv.ok, true)
  assert.deepEqual(h.calls[0], { action: 'friend_poke', params: { user_id: 2971030080 } })

  const grp = await h.tool('dy_qq_poke').execute({ kind: 'group', contactId: '707380948', userId: '12345' }, exec)
  assert.equal(grp.ok, true)
  assert.deepEqual(h.calls[1], { action: 'group_poke', params: { group_id: 707380948, user_id: 12345 } })

  const bad = await h.tool('dy_qq_poke').execute({ kind: 'group', contactId: '707380948' }, exec)
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /userId/)
  assert.equal(h.calls.length, 2)
})

test('dy_qq_reaction：加/取消表情回应', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_reaction').execute({ messageId: -123, emojiId: '76' }, exec)
  assert.equal(r.ok, true)
  assert.deepEqual(h.calls[0], { action: 'set_msg_emoji_like', params: { message_id: -123, emoji_id: '76', set: true } })
  await h.tool('dy_qq_reaction').execute({ messageId: -123, emojiId: '76', set: false }, exec)
  assert.equal(h.calls[1].params.set, false)
})

test('dy_qq_forward_msg：node 结构正确 / 空 items 拒绝', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_forward_msg').execute({ kind: 'private', contactId: '2971030080', items: [{ senderName: '甲', text: '第一句' }, { text: '第二句' }] }, exec)
  assert.equal(r.ok, true)
  const c = h.calls.find((x) => x.action === 'send_private_forward_msg')
  assert.equal(c.params.user_id, 2971030080)
  assert.equal(c.params.messages.length, 2)
  assert.equal(c.params.messages[0].type, 'node')
  assert.deepEqual(c.params.messages[0].data.content[0], { type: 'text', data: { text: '第一句' } })

  const bad = await h.tool('dy_qq_forward_msg').execute({ kind: 'private', contactId: '2971030080', items: [] }, exec)
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /items/)
})

test('dy_qq_get_forward：读到节点 / 读不到 / 无参数', async () => {
  const h = setup()
  const ok = await h.tool('dy_qq_get_forward').execute({ id: 'fw-1' }, exec)
  assert.equal(ok.ok, true)
  assert.match(ok.detail, /合并转发 1 条/)
  const miss = await h.tool('dy_qq_get_forward').execute({ id: 'nope' }, exec)
  assert.equal(miss.ok, false)
  const none = await h.tool('dy_qq_get_forward').execute({}, exec)
  assert.equal(none.ok, false)
  assert.match(none.detail, /id/)
})

test('dy_qq_members / dy_qq_group_info / dy_qq_friends：只读调用', async () => {
  const h = setup()
  // 给 callAction 覆盖返回
  h.calls.length = 0
  const sender = {
    callAction: async (action, params) => {
      h.calls.push({ action, params })
      if (action === 'get_group_member_list') return { ok: true, data: [{ user_id: 1, nickname: '甲', card: '群名片', role: 'owner', last_sent_time: 1700000000 }] }
      if (action === 'get_group_info') return { ok: true, data: { group_name: '测试群', member_count: 10, max_member_count: 200 } }
      if (action === '_get_group_notice') return { ok: true, data: [{ notice_id: 'n1', notice: { title: '公告', text: '内容', sender_name: '管理', publish_time: 1700000000 } }] }
      if (action === 'get_friend_list') return { ok: true, data: [{ user_id: 2, nickname: '乙', remark: '备注' }] }
      return { ok: false, code: 'E_SEND_FAILED' }
    },
    sendSegments: async () => ({ ok: true }),
  }
  const defs = []
  registerTools({
    tools: { register: (d) => defs.push(d) },
    cfg: { owner: { qqIds: ['2971030080'] }, qq: { rateMs: 0 } },
    mode: { current: () => 'send' },
    sender,
    store: h.store,
    log: null,
  })
  const tool = (n) => defs.find((d) => d.name === n)
  const m = await tool('dy_qq_members').execute({ groupId: '707380948' })
  assert.equal(m.ok, true)
  assert.match(m.detail, /群名片/)
  const gi = await tool('dy_qq_group_info').execute({ groupId: '707380948' })
  assert.equal(gi.ok, true)
  assert.match(gi.detail, /公告/)
  const fr = await tool('dy_qq_friends').execute({})
  assert.equal(fr.ok, true)
  assert.match(fr.detail, /备注/)
})

test('dy_qq_custom_face：list 只读 / send 发送', async () => {
  const h = setup()
  const list = await h.tool('dy_qq_custom_face').execute({ action: 'list' }, exec)
  assert.equal(list.ok, true)
  assert.equal(h.calls[0].action, 'fetch_custom_face')
  const send = await h.tool('dy_qq_custom_face').execute({ action: 'send', kind: 'private', contactId: '2971030080', emojiId: 'abc' }, exec)
  assert.equal(send.ok, true)
  assert.equal(h.calls[1].action, 'send_custom_face')
  assert.equal(h.calls[1].params.emoji_id, 'abc')
})

test('dy_qq_friend：blacklist/report 不支持；delete 需 confirm；remark 走 set_friend_remark', async () => {
  const h = setup()
  const bl = await h.tool('dy_qq_friend').execute({ action: 'blacklist', userId: '1' }, exec)
  assert.equal(bl.ok, false)
  assert.match(bl.detail, /E_UNSUPPORTED/)
  const rep = await h.tool('dy_qq_friend').execute({ action: 'report', userId: '1' }, exec)
  assert.equal(rep.ok, false)

  const d0 = await h.tool('dy_qq_friend').execute({ action: 'delete', userId: '1' }, exec)
  assert.equal(d0.ok, false)
  assert.match(d0.detail, /E_CONFIRM_REQUIRED/)
  const d1 = await h.tool('dy_qq_friend').execute({ action: 'delete', userId: '1', confirm: true }, exec)
  assert.equal(d1.ok, true)
  assert.equal(h.calls.at(-1).action, 'delete_friend')

  const r = await h.tool('dy_qq_friend').execute({ action: 'remark', userId: '2', remark: '新备注', confirm: true }, exec)
  assert.equal(r.ok, true)
  assert.deepEqual(h.calls.at(-1), { action: 'set_friend_remark', params: { user_id: 2, remark: '新备注' } })

  const a0 = await h.tool('dy_qq_friend').execute({ action: 'add', userId: '3', confirm: true }, exec)
  assert.equal(a0.ok, false)
  assert.match(a0.detail, /flag/)
})

test('dy_qq_file：合法 pdf → upload_private_file(base64)；超限/白名单外拒绝', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_file').execute({ kind: 'private', contactId: '2971030080', path: pdf }, exec)
  assert.equal(r.ok, true)
  const c = h.calls.at(-1)
  assert.equal(c.action, 'upload_private_file')
  assert.ok(c.params.file.startsWith('base64://'))
  assert.equal(Buffer.from(c.params.file.slice('base64://'.length), 'base64').toString(), 'PDFDATA')

  const tooBig = await h.tool('dy_qq_file').execute({ kind: 'private', contactId: '2971030080', path: bigPdf }, exec)
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.detail, /E_TOO_LARGE/)
  const badExt = await h.tool('dy_qq_file').execute({ kind: 'private', contactId: '2971030080', path: exe }, exec)
  assert.equal(badExt.ok, false)
  assert.match(badExt.detail, /E_FORMAT/)
})

test('dy_qq_video：合法 mp4 → video 段（唯一段）；非视频拒绝', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_video').execute({ kind: 'private', contactId: '2971030080', path: mp4 }, exec)
  assert.equal(r.ok, true)
  const seg = h.sent[0].message
  assert.equal(seg.length, 1) // SL 要求 video 必须是唯一段
  assert.equal(seg[0].type, 'video')
  assert.ok(seg[0].data.file.startsWith('base64://'))

  const bad = await h.tool('dy_qq_video').execute({ kind: 'private', contactId: '2971030080', path: txt }, exec)
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /E_FORMAT/)
})
