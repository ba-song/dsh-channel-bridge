import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionContext } from '../lib/context.js'
import { openBridgeDb } from '../lib/store.js'

const T0 = Date.parse('2026-11-05T01:00:00Z')
const cfg = { channel: 'qq', context: { enabled: true, limit: 10, maxChars: 300 } }

test('没有事件 → 空串', () => {
  const store = openBridgeDb(':memory:')
  assert.equal(buildSessionContext({ store, cfg }), '')
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
  const s = buildSessionContext({ store, cfg: { channel: 'qq', context: { limit: 3, maxChars: 300 } } })
  assert.ok(!s.includes('第0条'))
  assert.ok(s.includes('第5条'))
})

test('关闭 → 空串；maxChars 截断', () => {
  const store = openBridgeDb(':memory:')
  store.insertEvent({ at: T0, channel: 'qq', kind: 'private', contact: '1', direction: 'in', text: 'x'.repeat(200) })
  assert.equal(buildSessionContext({ store, cfg: { channel: 'qq', context: { enabled: false } } }), '')
  const s = buildSessionContext({ store, cfg: { channel: 'qq', context: { maxChars: 60 } } })
  assert.ok([...s].length < 140)
})
