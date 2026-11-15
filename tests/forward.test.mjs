import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createForwardReader,
  buildForwardNodes,
  formatForward,
  renderForwardText,
} from '../lib/forward.js'

/** 包一层 OneBot WS 成功响应（client.call 解析后就是这层）。 */
const okRes = (messages) => ({ status: 'ok', retcode: 0, data: { messages } })

test('renderForwardText：文本/@/图片/语音/表情/卡片/转发/视频/文件', () => {
  const msg = [
    { type: 'text', data: { text: '你看这个 ' } },
    { type: 'at', data: { qq: '123' } },
    { type: 'image', data: { url: 'http://x/1.png' } },
    { type: 'record', data: { url: 'http://x/1.amr' } },
    { type: 'video', data: { url: 'http://x/1.mp4' } },
    { type: 'file', data: { name: 'a.txt' } },
    { type: 'face', data: { id: 14 } },
    { type: 'mface', data: { summary: '狗头' } },
    { type: 'json', data: {} },
    { type: 'xml', data: {} },
    { type: 'forward', data: { id: 'res-inner' } },
    { type: 'reply', data: { id: '1' } },
    { type: 'shake', data: {} },
    null,
  ]
  assert.equal(renderForwardText(msg), '你看这个 @123[图片][语音][视频][文件][表情][表情][卡片][卡片][转发][shake]')
  assert.equal(renderForwardText('纯文本'), '纯文本')
  assert.equal(renderForwardText(null), '')
  assert.equal(renderForwardText(undefined), '')
  assert.equal(renderForwardText([{ type: 'text' }]), '')
})

test('createForwardReader：get_forward_msg 成功（res_id）→ 节点/正文/时间正确', async () => {
  const calls = []
  const client = {
    call: async (action, params, opts) => {
      calls.push({ action, params, opts })
      return okRes([
        {
          user_id: 1001,
          time: 1700000000,
          sender: { user_id: 1001, nickname: '甲' },
          message: [{ type: 'text', data: { text: '你好' } }],
        },
        {
          user_id: 1002,
          time: 1700000001,
          sender: { user_id: 1002, nickname: '乙', card: '老乙' },
          message: [
            { type: 'text', data: { text: '看这个' } },
            { type: 'image', data: { url: 'http://x/1.png' } },
            { type: 'forward', data: { id: 'inner' } },
          ],
        },
      ])
    },
  }
  const reader = createForwardReader({ getClient: () => client })
  const fwd = await reader.resolve({ id: 'res-1' })
  assert.deepEqual(calls[0], { action: 'get_forward_msg', params: { id: 'res-1' }, opts: { timeoutMs: 3000 } })
  assert.equal(fwd.id, 'res-1')
  assert.deepEqual(fwd.nodes, [
    { senderId: '1001', senderName: '甲', text: '你好', at: 1700000000000 },
    { senderId: '1002', senderName: '老乙', text: '看这个[图片][转发]', at: 1700000001000 },
  ])
  assert.equal(fwd.text, '[合并转发 2 条] 1. 甲：你好 2. 老乙：看这个[图片][转发]')
  assert.equal(reader.stats.ok, 1)

  // timeoutMs 可配置
  const slow = createForwardReader({ getClient: () => client, timeoutMs: 50 })
  await slow.resolve({ id: 'res-2' })
  assert.equal(calls[1].opts.timeoutMs, 50)
})

test('createForwardReader：message_id 变体 / 同时给两个时 id 优先 / node 段形态', async () => {
  const calls = []
  const client = {
    call: async (action, params) => {
      calls.push({ action, params })
      return okRes([
        {
          type: 'node',
          data: {
            user_id: 9001,
            nickname: '节点甲',
            time: 1700000000,
            content: [{ type: 'text', data: { text: 'node 内容' } }],
          },
        },
      ])
    },
  }
  const reader = createForwardReader({ getClient: () => client })
  const byMid = await reader.resolve({ messageId: -123 })
  assert.deepEqual(calls[0].params, { message_id: '-123' })
  assert.equal(byMid.id, '-123')
  assert.deepEqual(byMid.nodes[0], { senderId: '9001', senderName: '节点甲', text: 'node 内容', at: 1700000000000 })

  const both = await reader.resolve({ id: 'res-9', messageId: -1 })
  assert.deepEqual(calls[1].params, { id: 'res-9' })
  assert.equal(both.id, 'res-9')
})

test('createForwardReader：status/retcode 不成功 → null + 只记 id 不记正文', async () => {
  const warns = []
  const log = { warn: (line) => warns.push(String(line)) }
  const client = {
    call: async () => ({
      status: 'failed',
      retcode: 100,
      data: { messages: [{ sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '机密正文' } }] }] },
    }),
  }
  const reader = createForwardReader({ getClient: () => client, log })
  assert.equal(await reader.resolve({ id: 'res-bad' }), null)
  assert.equal(reader.stats.fail, 1)
  assert.ok(warns.some((w) => w.includes('id=res-bad')))
  assert.ok(warns.every((w) => !w.includes('机密正文')))

  // retcode 非 0 也算失败
  const reader2 = createForwardReader({ getClient: () => ({ call: async () => ({ status: 'ok', retcode: 100, data: { messages: [] } }) }), log })
  assert.equal(await reader2.resolve({ id: 'res-2' }), null)
  assert.equal(reader2.stats.fail, 1)
})

test('createForwardReader：抛错/超时 → null 不抛；无 client → null', async () => {
  const warns = []
  const log = { warn: (line) => warns.push(String(line)) }
  const throwing = createForwardReader({
    getClient: () => ({ call: async () => { throw Object.assign(new Error('action get_forward_msg 超时'), { code: 'E_TIMEOUT' }) } }),
    log,
  })
  assert.equal(await throwing.resolve({ id: 'res-timeout' }), null)
  assert.equal(throwing.stats.fail, 1)
  assert.ok(warns.some((w) => w.includes('E_TIMEOUT') && w.includes('id=res-timeout')))

  const noClient = createForwardReader({ getClient: () => null, log })
  assert.equal(await noClient.resolve({ id: 'res-noclient' }), null)
  assert.equal(noClient.stats.noClient, 1)
  assert.ok(warns.some((w) => w.includes('id=res-noclient')))

  const badGetClient = createForwardReader({ getClient: () => { throw new Error('boom') }, log })
  assert.equal(await badGetClient.resolve({ id: 'res-throw' }), null)
  assert.equal(badGetClient.stats.fail, 1)
})

test('createForwardReader：空 id / 空消息列表 → null（不抛）', async () => {
  const reader = createForwardReader({ getClient: () => ({ call: async () => okRes([]) }) })
  assert.equal(await reader.resolve(), null)
  assert.equal(await reader.resolve({ id: '   ', messageId: '' }), null)
  assert.equal(reader.stats.empty, 2)

  const empty = createForwardReader({ getClient: () => ({ call: async () => okRes([]) }) })
  assert.equal(await empty.resolve({ id: 'res-empty' }), null)
  assert.equal(empty.stats.empty, 1)
  assert.equal(empty.stats.ok, 0)
})

test('buildForwardNodes：OneBot v11 node 结构 + 过滤空文本', () => {
  const nodes = buildForwardNodes([
    { senderName: '甲', senderId: '123', text: '你好' },
    { senderName: '乙', senderId: '456', text: '   ' },
    { senderName: '', senderId: '789', text: ' 世界 ' },
    null,
    'bad',
  ])
  assert.deepEqual(nodes, [
    { type: 'node', data: { name: '甲', uin: '123', content: [{ type: 'text', data: { text: '你好' } }] } },
    { type: 'node', data: { name: '789', uin: '789', content: [{ type: 'text', data: { text: '世界' } }] } },
  ])
  assert.deepEqual(buildForwardNodes([]), [])
  assert.deepEqual(buildForwardNodes(null), [])
})

test('formatForward：空/单条/名称缺省/空正文', () => {
  assert.equal(formatForward(null), '[合并转发]')
  assert.equal(formatForward({ nodes: [] }), '[合并转发]')
  assert.equal(
    formatForward({ nodes: [{ senderName: '甲', senderId: '123', text: '你好' }] }),
    '[合并转发 1 条] 1. 甲：你好',
  )
  assert.equal(
    formatForward({ nodes: [{ senderName: '', senderId: '123', text: '' }] }),
    '[合并转发 1 条] 1. 123：[空消息]',
  )
})

test('formatForward：maxNodes 截断并注明剩余，maxChars 整行截断', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ senderName: `人${i + 1}`, senderId: String(i + 1), text: `第${i + 1}句` }))
  const short = formatForward({ nodes }, { maxNodes: 2, maxChars: 1000 })
  assert.ok(short.startsWith('[合并转发 10 条] 1. 人1：第1句 2. 人2：第2句'))
  assert.ok(short.includes('…（还有 8 条）'))
  assert.ok(!short.includes('第3句'))

  const long = formatForward({ nodes: [{ senderName: '甲', text: '字'.repeat(700) }] })
  assert.equal([...long].length, 601)
  assert.ok(long.endsWith('…'))
  assert.ok(long.startsWith('[合并转发 1 条] 1. 甲：字字'))

  const tiny = formatForward({ nodes }, { maxNodes: 10, maxChars: 20 })
  assert.equal([...tiny].length, 21)
  assert.ok(tiny.endsWith('…'))
})
