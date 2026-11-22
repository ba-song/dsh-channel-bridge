import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionContext } from '../lib/context.js'
import { openBridgeDb } from '../lib/store.js'

const T0 = Date.parse('2026-11-05T01:00:00Z')
const cfg = { context: { enabled: true, limit: 10, maxChars: 300 } }
const conversation = { channel: 'qq', kind: 'private', contact: '11111111' }

test('没有事件 → 空串', () => {
  const store = openBridgeDb(':memory:')
  assert.equal(buildSessionContext({ store, cfg, conversation }), '')
})

test('有入站 → 「上次在 QQ 房间里聊到：」+ 每行时间/来人/摘要', () => {
  const store = openBridgeDb(':memory:')
  store.insertEvent({ at: T0, channel: 'qq', kind: 'private', contact: '11111111', direction: 'in', text: '你昨天说的那个插件' })
  store.insertEvent({ at: T0 + 60000, channel: 'qq', kind: 'private', contact: '11111111', direction: 'in', text: '今天继续吗' })
  const s = buildSessionContext({ store, cfg })
  assert.match(s, /^（上次在 QQ 房间里聊到：/)
  assert.match(s, /你昨天说的那个插件/)
  assert.match(s, /今天继续吗/)
  assert.match(s, /接上就行/)
})

test('只取最近 limit 条（且按时间正序）', () => {
  const store = openBridgeDb(':memory:')
  for (let i = 0; i < 6; i += 1) store.insertEvent({ at: T0 + i * 60000, channel: 'qq', kind: 'private', contact: '1', direction: 'in', text: `第${i}条` })
  const s = buildSessionContext({ store, cfg: { context: { limit: 3, maxChars: 300 } }, conversation: { channel: 'qq', kind: 'private', contact: '1' } })
  assert.ok(!s.includes('第0条'))
  assert.ok(s.includes('第5条'))
})

test('关闭 → 空串；maxChars 截断', () => {
  const store = openBridgeDb(':memory:')
  store.insertEvent({ at: T0, channel: 'qq', kind: 'private', contact: '1', direction: 'in', text: 'x'.repeat(200) })
  assert.equal(buildSessionContext({ store, cfg: { context: { enabled: false } }, conversation }), '')
  const s = buildSessionContext({ store, cfg: { context: { maxChars: 60 } }, conversation })
  assert.ok([...s].length < 140)
})

test('跨联系人/会话类型隔离；缺少会话范围时 fail closed', () => {
  const store = openBridgeDb(':memory:')
  store.insertEvent({ at: T0, channel: 'qq', kind: 'private', contact: '11111111', direction: 'in', text: '当前私聊消息' })
  store.insertEvent({ at: T0 + 1000, channel: 'qq', kind: 'private', contact: '22222222', direction: 'in', text: '其他私聊秘密' })
  store.insertEvent({ at: T0 + 2000, channel: 'qq', kind: 'group', contact: '11111111', direction: 'in', text: '同号群聊消息' })
  store.insertEvent({ at: T0 + 3000, channel: 'other', kind: 'private', contact: '11111111', direction: 'in', text: '其他渠道消息' })

  const scoped = buildSessionContext({ store, cfg, conversation })
  assert.match(scoped, /当前私聊消息/)
  assert.doesNotMatch(scoped, /其他私聊秘密|同号群聊消息|其他渠道消息/)
  assert.equal(buildSessionContext({ store, cfg }), '')
  assert.equal(buildSessionContext({ store, cfg, conversation: { channel: 'qq', kind: 'private' } }), '')
})
