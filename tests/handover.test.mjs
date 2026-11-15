import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoverText, hhmm, createHandover } from '../lib/handover.js'
import { openBridgeDb } from '../lib/store.js'

const SINCE = Date.parse('2026-11-05T16:50:00+08:00')
const beijing = (hhmmStr, day = '2026-11-05') => Date.parse(`${day}T${hhmmStr}:00+08:00`)
const userEvt = (time, text, kind = 'user') => ({ type: 'user/message', time, data: { id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind } } })
const asstEvt = (time, text) => ({ type: 'assistant/message', time, data: { turn: 1, step: 1, stream: [], message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } })

test('16:50 边界：16:49 排除、16:50 与 16:51 加入', () => {
  const events = [userEvt(beijing('16:49'), '早一秒'), userEvt(beijing('16:50'), '正好'), userEvt(beijing('16:51'), '晚一秒')]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  assert.ok(!text.includes('早一秒'))
  assert.ok(text.includes('正好'))
  assert.ok(text.includes('晚一秒'))
  assert.equal(text.split('\n').length, 2)
})

test('格式：HH:MM [主人/汐] 文本，按时间顺序', () => {
  const events = [userEvt(beijing('17:01'), '主人在吗'), asstEvt(beijing('17:02'), '在的'), userEvt(beijing('17:03'), '好')]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  assert.equal(text, '17:01 [主人] 主人在吗\n17:02 [汐] 在的\n17:03 [主人] 好')
  assert.equal(hhmm(beijing('17:01')), '17:01')
})

test('过滤：runtime-context/plugin 不算，[SILENT] 不算，channel-inbound 算', () => {
  const events = [
    userEvt(beijing('17:10'), '运行时', 'runtime-context'),
    userEvt(beijing('17:11'), '插件注入', 'plugin:dy-memory'),
    userEvt(beijing('17:12'), 'QQ 来的', 'channel-inbound'),
    asstEvt(beijing('17:13'), '[SILENT]'),
    asstEvt(beijing('17:14'), '真回复'),
  ]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  assert.ok(!text.includes('运行时'))
  assert.ok(!text.includes('插件注入'))
  assert.ok(text.includes('QQ 来的'))
  assert.ok(!text.includes('[SILENT]'))
  assert.ok(text.includes('真回复'))
})

test('超长截断：≤maxChars，保留最新', () => {
  const events = []
  for (let i = 0; i < 40; i += 1) events.push(userEvt(beijing('17:00') + i * 60000, `第${i}条 ` + '啊'.repeat(200)))
  const text = buildHandoverText(events, { sinceMs: SINCE, maxChars: 1000 })
  assert.ok([...text].length <= 1000)
  assert.ok(text.includes('第39条'))
  assert.ok(!text.includes('第0条'))
})

test('createHandover：只取一次并缓存；markDone 后不再给', () => {
  const store = openBridgeDb(':memory:')
  let reads = 0
  const h = createHandover({
    cfg: { handover: { sessionId: 'S', since: '2026-11-05T16:50:00+08:00' } },
    store,
    readEvents: () => {
      reads += 1
      return [userEvt(beijing('17:00'), '一句')]
    },
  })
  const first = h.take()
  assert.match(first, /17:00 \[主人\] 一句/)
  assert.equal(h.take(), first) // 缓存，不再读文件
  assert.equal(reads, 1)
  assert.equal(h.alreadyDone(), false)
  h.markDone()
  assert.equal(h.alreadyDone(), true)
  assert.equal(h.take(), '')
  assert.ok(store.getMeta('handover.done'))
})

test('createHandover：已 done 则一开始就不读档案', () => {
  const store = openBridgeDb(':memory:')
  store.setMeta('handover.done', 'x')
  let reads = 0
  const h = createHandover({ cfg: { handover: { sessionId: 'S' } }, store, readEvents: () => { reads += 1; return [] } })
  assert.equal(h.take(), '')
  assert.equal(reads, 0)
})

import { collectArchiveItems, collectDbItems, mergeHandoverItems, formatHandover } from '../lib/handover.js'

const beijing6 = (hhmmStr, day = '2026-11-06') => Date.parse(`${day}T${hhmmStr}:00+08:00`)

test('两源合并：同一句在档案+事件表各一份 → 只出现一次', () => {
  const archive = [userEvt(beijing('17:00'), '同一句', 'channel-inbound')]
  const rows = [{ at: beijing('17:00'), text: '同一句', message_id: 'u' }]
  const merged = mergeHandoverItems(collectArchiveItems(archive, { sinceMs: SINCE }), collectDbItems(rows, { sinceMs: SINCE }))
  assert.equal(merged.length, 1)
  assert.equal(formatHandover(merged).split('\n').length, 1)
})

test('两源合并：只在事件表的新消息（今早两条）会出现', () => {
  const archive = [userEvt(beijing('17:00'), '档案里的旧话', 'channel-inbound')]
  const rows = [
    { at: beijing6('08:48'), text: '早上好大傻鱼', message_id: 'a1' },
    { at: beijing6('08:50'), text: '想我了没有', message_id: 'a2' },
  ]
  const merged = mergeHandoverItems(collectArchiveItems(archive, { sinceMs: SINCE }), collectDbItems(rows, { sinceMs: SINCE }))
  const text = formatHandover(merged)
  assert.ok(text.includes('08:48 [主人] 早上好大傻鱼'))
  assert.ok(text.includes('08:50 [主人] 想我了没有'))
  assert.equal(merged.length, 3)
})

test('两源合并：按时间排序（跨天也正确）', () => {
  const archive = [userEvt(beijing('17:00'), '昨天下午', 'channel-inbound')]
  const rows = [{ at: beijing6('08:48'), text: '今早', message_id: 'b1' }]
  const merged = mergeHandoverItems(collectArchiveItems(archive, { sinceMs: SINCE }), collectDbItems(rows, { sinceMs: SINCE }))
  assert.deepEqual(merged.map((m) => m.text), ['昨天下午', '今早'])
})

test('两源合并：16:50 边界（事件表 16:49 排除）', () => {
  const rows = [
    { at: beijing('16:49'), text: '早一秒', message_id: 'c1' },
    { at: beijing('16:50'), text: '正好', message_id: 'c2' },
  ]
  const merged = mergeHandoverItems([], collectDbItems(rows, { sinceMs: SINCE }))
  assert.deepEqual(merged.map((m) => m.text), ['正好'])
})

test('去重：没有 message_id 时按 (at,text)', () => {
  const archive = [userEvt(beijing('17:00'), '无 id 的话', 'channel-inbound')]
  const rows = [{ at: beijing('17:00'), text: '无 id 的话', message_id: '' }]
  const merged = mergeHandoverItems(collectArchiveItems(archive, { sinceMs: SINCE }), collectDbItems(rows, { sinceMs: SINCE }))
  assert.equal(merged.length, 1)
})

test('她的回复只从档案来：事件表 out 行不会进交接', () => {
  const store = openBridgeDb(':memory:')
  store.insertEvent({ at: beijing('17:00'), channel: 'qq', kind: 'private', contact: '2971030080', direction: 'in', text: '主人说的', messageId: 'm1' })
  store.insertEvent({ at: beijing('17:01'), channel: 'qq', kind: 'private', contact: '2971030080', direction: 'out', text: null, textLen: 4 })
  const h = createHandover({
    cfg: { handover: { sessionId: 'S', since: '2026-11-05T16:50:00+08:00' } },
    store,
    readEvents: () => [asstEvt(beijing('17:02'), '她回的')],
  })
  const text = h.take()
  assert.ok(text.includes('17:00 [主人] 主人说的'))
  assert.ok(text.includes('17:02 [汐] 她回的'))
  assert.ok(!text.includes('17:01'))
})

test('createHandover：默认从 bridge.db 读入站（两源）', () => {
  const store = openBridgeDb(':memory:')
  store.insertEvent({ at: beijing6('08:48'), channel: 'qq', kind: 'private', contact: '2971030080', direction: 'in', text: '早上好大傻鱼', messageId: 'x1' })
  const h = createHandover({
    cfg: { handover: { sessionId: 'S', since: '2026-11-05T16:50:00+08:00' } },
    store,
    readEvents: () => [userEvt(beijing('17:00'), '档案一句', 'channel-inbound')],
  })
  const text = h.take()
  assert.ok(text.includes('早上好大傻鱼'))
  assert.ok(text.includes('档案一句'))
  assert.equal(h.stats.sources.db, 1)
})

const dySay = (time, text) => ({ type: 'tool/call', time, data: { callId: 'c', name: 'dy_say', arguments: JSON.stringify({ channel: 'qq', contactId: '2971030080', kind: 'private', text }) } })

test('她的发言优先取 dy_say 原文；紧随其后的 assistant 总结被跳过', () => {
  const events = [
    userEvt(beijing('17:00'), '在吗', 'channel-inbound'),
    dySay(beijing('17:01'), '在呢，刚在看东西'),
    asstEvt(beijing('17:01'), '已回复对方：对方问在不在，我答在呢，并说明刚才在看东西。'),
  ]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  assert.ok(text.includes('17:01 [汐] 在呢，刚在看东西'))
  assert.ok(!text.includes('已回复对方'))
})

test('没有 dy_say 时回退 assistant 正文，但跳过总结/SILENT/规则块/空', () => {
  const events = [
    userEvt(beijing('17:00'), '说点啥', 'channel-inbound'),
    asstEvt(beijing('17:01'), '这是正常的一句回复'),
    asstEvt(beijing('17:02'), '已回复对方：这是包装'),
    asstEvt(beijing('17:03'), '[SILENT]'),
    asstEvt(beijing('17:04'), '【这个房间的规矩】\n- 要说的全部通过 dy_say 发'),
    asstEvt(beijing('17:05'), '   '),
  ]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  assert.ok(text.includes('这是正常的一句回复'))
  assert.ok(!text.includes('这是包装'))
  assert.ok(!text.includes('[SILENT]'))
  assert.ok(!text.includes('【这个房间的规矩】'))
  assert.equal(text.split('\n').filter(Boolean).length, 2) // 主人 + 一条回复
})

test('dy_say 多行按序拆条', () => {
  const events = [dySay(beijing('17:00'), '第一段\n第二段\n\n第三段')]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  const lines = text.split('\n')
  assert.equal(lines.length, 3)
  assert.ok(lines[0].endsWith('[汐] 第一段'))
  assert.ok(lines[1].endsWith('[汐] 第二段'))
  assert.ok(lines[2].endsWith('[汐] 第三段'))
})

test('相邻重复去重（同文本连续只留一条）', () => {
  const events = [
    userEvt(beijing('17:00'), '重复的话', 'channel-inbound'),
    asstEvt(beijing('17:01'), '重复的话'),
  ]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  assert.equal(text.split('\n').filter(Boolean).length, 1)
})

test('dy_say 的 [SILENT] 不发也不进交接', () => {
  const events = [userEvt(beijing('17:00'), '嗯', 'channel-inbound'), dySay(beijing('17:01'), '[SILENT]')]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  assert.equal(text.split('\n').filter(Boolean).length, 1)
  assert.ok(!text.includes('SILENT'))
})

import { cleanHandoverText } from '../lib/handover.js'

test('清洗：去掉 [QQ·…] 人物头、[补收·hh:mm] 前缀、尾部规则块', () => {
  assert.equal(cleanHandoverText('[QQ·私聊·饲养员(2971030080)] 你好'), '你好')
  assert.equal(cleanHandoverText('[QQ·私聊·饲养员(2971030080)] [补收·09:22] 这句'), '这句')
  assert.equal(
    cleanHandoverText('[QQ·私聊·饲养员(1)] 正文\n\n【这个房间的规矩】\n- 只有 dy_say 能送到对方；'),
    '正文',
  )
})

test('清洗后为空/只有 [SILENT] 的 user 消息不进交接', () => {
  const events = [
    userEvt(beijing('17:00'), '[QQ·私聊·饲养员(1)] 【这个房间的规矩】\n- 只有 dy_say', 'channel-inbound'),
    userEvt(beijing('17:01'), '[SILENT]', 'channel-inbound'),
    userEvt(beijing('17:02'), '[QQ·私聊·饲养员(1)] 真消息', 'channel-inbound'),
  ]
  const text = buildHandoverText(events, { sinceMs: SINCE })
  assert.equal(text.split('\n').filter(Boolean).length, 1)
  assert.equal(text, '17:02 [主人] 真消息')
})
