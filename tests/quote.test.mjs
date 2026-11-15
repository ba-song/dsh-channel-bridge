import test from 'node:test'
import assert from 'node:assert/strict'
import { extractReplyId, parseMessageEvent } from '../lib/parse.js'
import { renderQuoteText, formatQuote, createQuoteResolver } from '../lib/quote.js'
import { buildChannelPrompt } from '../lib/prompt.js'
import { createRouter } from '../lib/router.js'
import { openBridgeDb } from '../lib/store.js'
import { createSender } from '../lib/sender.js'

const base = { channel: 'qq', kind: 'private', contactId: '2971030080', contactName: '饲养员', senderName: '饲养员', at: 1, text: '在吗' }

test('extractReplyId：段数组 / CQ 字符串 / 无 reply', () => {
  assert.equal(extractReplyId([{ type: 'reply', data: { id: '-1157182485' } }, { type: 'text', data: { text: '在吗' } }]), '-1157182485')
  assert.equal(extractReplyId([{ type: 'text', data: { text: '在吗' } }, { type: 'reply', data: { id: '42' } }]), '42')
  assert.equal(extractReplyId('[CQ:reply,id=123]在吗'), '123')
  assert.equal(extractReplyId([{ type: 'text', data: { text: '在吗' } }]), '')
  assert.equal(extractReplyId('普通文本'), '')
  assert.equal(extractReplyId(null), '')
})

test('parseMessageEvent：replyId 透传（私聊/群），正文不掺占位', () => {
  const evt = {
    post_type: 'message',
    message_type: 'private',
    self_id: 1,
    user_id: 2,
    time: 1700000000,
    message_id: 10,
    message: [{ type: 'reply', data: { id: '9' } }, { type: 'text', data: { text: '回你' } }],
    sender: { nickname: '甲' },
  }
  const p = parseMessageEvent(evt, {})
  assert.equal(p.replyId, '9')
  assert.equal(p.text, '回你')
  const g = parseMessageEvent({ ...evt, message_type: 'group', group_id: 3 }, {})
  assert.equal(g.replyId, '9')
  // 没有 reply 段时字段为空串（兼容旧事件）
  const plain = parseMessageEvent({ ...evt, message: [{ type: 'text', data: { text: '在吗' } }] }, {})
  assert.equal(plain.replyId, '')
})

test('renderQuoteText：文本/@/图片/语音/表情/卡片', () => {
  const msg = [
    { type: 'text', data: { text: '你看这个 ' } },
    { type: 'at', data: { qq: '123' } },
    { type: 'image', data: { url: 'x' } },
    { type: 'record', data: {} },
    { type: 'face', data: { id: 14 } },
    { type: 'mface', data: { summary: '狗头' } },
    { type: 'json', data: {} },
    { type: 'reply', data: { id: '1' } },
  ]
  assert.equal(renderQuoteText(msg), '你看这个 @123[图片][语音][表情:微笑][表情包:狗头][卡片]')
  assert.equal(renderQuoteText('原文'), '原文')
  assert.equal(renderQuoteText(null), '')
})

test('formatQuote：带名字、按展示上限截断；无 quote 返回空串', () => {
  assert.equal(formatQuote({ senderName: '霸宋', text: '原来的话' }), '[引用 霸宋：原来的话]')
  assert.equal(formatQuote(null), '')
  assert.equal(formatQuote({ text: '' }), '')
  const long = formatQuote({ senderName: '甲', text: '字'.repeat(200) })
  assert.ok([...long].length < 90)
  assert.ok(long.endsWith('…]'))
})

test('createQuoteResolver：get_msg 成功 → 结构化 quote；失败/无 client → null 不抛', async () => {
  const calls = []
  const client = {
    call: async (action, params) => {
      calls.push({ action, params })
      return {
        data: {
          message_id: '-88',
          real_id: '-88',
          user_id: 2971030080,
          time: 1700000000,
          sender: { nickname: '霸宋' },
          message: [{ type: 'text', data: { text: '上一句' } }, { type: 'image', data: { url: 'x' } }],
        },
      }
    },
  }
  const r = createQuoteResolver({ getClient: () => client })
  const q = await r.resolve('-88', { selfId: '2190097528' })
  assert.deepEqual(calls[0], { action: 'get_msg', params: { message_id: -88 } })
  assert.equal(q.messageId, '-88')
  assert.equal(q.senderId, '2971030080')
  assert.equal(q.senderName, '霸宋')
  assert.equal(q.text, '上一句[图片]')
  assert.equal(q.at, 1700000000000)

  const failing = createQuoteResolver({ getClient: () => ({ call: async () => { throw Object.assign(new Error('boom'), { code: 'E_SEND_FAILED' }) } }) })
  assert.equal(await failing.resolve('1'), null)
  assert.equal(failing.stats.fail, 1)

  const noClient = createQuoteResolver({ getClient: () => null })
  assert.equal(await noClient.resolve('1'), null)
  assert.equal(noClient.stats.noClient, 1)

  const empty = createQuoteResolver({ getClient: () => client })
  assert.equal(await empty.resolve(''), null)
  assert.equal(empty.stats.empty, 1)
})

test('buildChannelPrompt：引用行插在正文前（私聊/群），无 quote 不变', () => {
  const q = { senderName: '霸宋', senderId: '2971030080', text: '原来的话', messageId: '7' }
  assert.equal(
    buildChannelPrompt({ ...base, quote: q }, { mode: 'send' }),
    '[QQ·私聊·饲养员(2971030080)] [引用 霸宋：原来的话] 在吗',
  )
  assert.equal(
    buildChannelPrompt({ ...base, kind: 'group', contactId: '707380948', contactName: '测试群', quote: q }, { mode: 'send' }),
    '[QQ·群·测试群(707380948)] [引用 霸宋：原来的话] 饲养员：在吗',
  )
  assert.equal(buildChannelPrompt({ ...base }, { mode: 'send' }), '[QQ·私聊·饲养员(2971030080)] 在吗')
})

test('router：enrich 返回 quote 时进正文；enrich 失败不影响正文', async () => {
  const got = []
  const agent = { followup: async (m) => { got.push(m) } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 'sess', created: false }) }
  const parsed = { ...base, text: '回你', messageId: 'm2', replyId: '7' }
  const r = createRouter({
    store: openBridgeDb(':memory:'),
    sessions,
    mode: { current: () => 'send' },
    enrich: async () => ({ quote: { senderName: '霸宋', text: '原来的话' } }),
  })
  r.deliver(parsed)
  await r.idle()
  assert.match(got[0].content[0].text, /\[引用 霸宋：原来的话\] 回你/)

  const got2 = []
  const r2 = createRouter({
    store: openBridgeDb(':memory:'),
    sessions: { ensure: async () => ({ ok: true, agent: { followup: async (m) => { got2.push(m) } }, sessionId: 's2' }) },
    mode: { current: () => 'send' },
    enrich: async () => { throw new Error('boom') },
  })
  r2.deliver(parsed)
  await r2.idle()
  assert.equal(got2.length, 1)
  assert.match(got2[0].content[0].text, /^\[QQ·私聊·饲养员\(2971030080\)\] 回你/)
})

test('sender：replyTo 生成 reply 段（第一段），无 replyTo 维持单 text 段', async () => {
  const calls = []
  const sender = createSender({
    getClient: () => ({
      call: async (action, params) => {
        calls.push({ action, params })
        return { data: { message_id: 123 } }
      },
    }),
  })
  const r = await sender.sendText({ kind: 'private', contactId: '2971030080', text: '回你', replyTo: '-88' })
  assert.equal(r.ok, true)
  assert.equal(calls[0].action, 'send_private_msg')
  assert.deepEqual(calls[0].params.message, [
    { type: 'reply', data: { id: '-88' } },
    { type: 'text', data: { text: '回你' } },
  ])

  calls.length = 0
  await sender.sendText({ kind: 'group', contactId: '707380948', text: '在' })
  assert.equal(calls[0].action, 'send_group_msg')
  assert.deepEqual(calls[0].params.message, [{ type: 'text', data: { text: '在' } }])
})
