import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openBridgeDb } from '../lib/store.js'

test('内存库：建表 + 三种 direction 落库 + 计数', () => {
  const s = openBridgeDb(':memory:')
  s.insertEvent({ at: 1000, channel: 'qq', kind: 'private', contact: '1', direction: 'in', text: 'hi' })
  s.insertEvent({ at: 1001, channel: 'qq', kind: 'private', contact: '1', direction: 'out', text: null, textLen: 2, meta: { messageId: 'm1', via: 'reply' } })
  s.insertEvent({ at: 1002, channel: 'qq', kind: 'private', contact: '1', direction: 'silent', meta: { reason: 'explicit' } })
  const c = s.counts()
  assert.equal(c.events, 3)
  assert.equal(c.inbound, 1)
  assert.equal(c.out, 1)
  assert.equal(c.silent, 1)
  s.close()
})

test('联系人 upsert：last_seen_at 只增不减', () => {
  const s = openBridgeDb(':memory:')
  s.upsertContact({ contact: '1', kind: 'private', name: 'A', at: 500 })
  s.upsertContact({ contact: '1', kind: 'private', name: '', at: 900 })
  s.upsertContact({ contact: '1', kind: 'private', name: 'A2', at: 700 })
  const row = s.contactOf('qq', '1', 'private')
  assert.equal(row.last_seen_at, 900)
  assert.equal(row.name, 'A2')
  assert.equal(row.first_seen_at, 500)
  s.close()
})

test('kind 隔离：同号码 private/group 是两条', () => {
  const s = openBridgeDb(':memory:')
  s.upsertContact({ contact: '707380948', kind: 'group', at: 1 })
  s.upsertContact({ contact: '707380948', kind: 'private', at: 2 })
  assert.equal(s.listContacts('qq').length, 2)
  assert.equal(s.contactOf('qq', '707380948', 'group').kind, 'group')
  s.close()
})

test('窗口查询：只取 since 之后的入站，倒序', () => {
  const s = openBridgeDb(':memory:')
  s.insertEvent({ at: 100, channel: 'qq', direction: 'in', text: 'old', messageId: 'a' })
  s.insertEvent({ at: 300, channel: 'qq', direction: 'in', text: 'new', messageId: 'b' })
  const rows = s.recentInbound('qq', 200, 10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, 'new')
  s.close()
})

test('会话：save/get + 回填 session_id', () => {
  const s = openBridgeDb(':memory:')
  s.saveSession({ channel: 'qq', sessionId: 's1', cwd: '/tmp/x', at: 1 })
  assert.equal(s.getSession('qq').session_id, 's1')
  s.saveSession({ channel: 'qq', sessionId: 's2', cwd: '/tmp/x', at: 2 })
  assert.equal(s.getSession('qq').session_id, 's2')
  s.insertEvent({ at: 5, channel: 'qq', direction: 'in', messageId: 'm9' })
  assert.equal(s.updateEventSession('m9', 's2'), 1)
  s.close()
})

test('v1 老库迁移：缺的列自动补、重复开不报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  const file = join(dir, 'bridge.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE channel_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, channel TEXT, contact TEXT, direction TEXT, text TEXT, session_id TEXT)`)
  old.exec(`INSERT INTO channel_events(at,channel,contact,direction,text) VALUES (1,'qq','1','in','hello')`)
  old.close()

  const s = openBridgeDb(file)
  assert.equal(s.available(), true)
  const row = s.raw.prepare('SELECT * FROM channel_events').get()
  assert.equal(row.text, 'hello')
  assert.equal(row.kind, 'unknown')
  assert.equal(row.text_len, null)
  s.close()

  const s2 = openBridgeDb(file) // 再来一次，幂等
  assert.equal(s2.counts().events, 1)
  s2.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v2 老库迁移：channel_sessions 补 kind，旧行归 private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-v3-'))
  const file = join(dir, 'bridge.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE channel_sessions (channel TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, created_at INTEGER)`)
  old.exec(`INSERT INTO channel_sessions(channel,session_id,cwd,created_at) VALUES ('qq','OLD-SID','/sdcard/Documents/Me/渠道/qq',1)`)
  old.close()

  const s = openBridgeDb(file)
  const rows = s.listSessions('qq')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'private')
  assert.equal(rows[0].session_id, 'OLD-SID')
  assert.equal(s.getSession('qq', 'group'), null) // 群聊不能落到私聊房间

  s.saveSession({ channel: 'qq', kind: 'group', sessionId: 'G-SID', cwd: '/sdcard/DSHA/渠道/qq-群', at: 2 })
  assert.equal(s.listSessions('qq').length, 2)
  assert.equal(s.getSession('qq', 'group').session_id, 'G-SID')
  assert.equal(s.getSession('qq', 'private').session_id, 'OLD-SID')
  s.close()

  const again = openBridgeDb(file)
  assert.equal(again.listSessions('qq').length, 2) // 幂等
  again.close()
  rmSync(dir, { recursive: true, force: true })
})

test('新会话上下文查询必须同时限定 channel/kind/contact，缺范围返回空', () => {
  const s = openBridgeDb(':memory:')
  s.insertEvent({ at: 100, channel: 'qq', kind: 'private', contact: 'A', direction: 'in', text: 'private-A' })
  s.insertEvent({ at: 200, channel: 'qq', kind: 'private', contact: 'B', direction: 'in', text: 'private-B' })
  s.insertEvent({ at: 300, channel: 'qq', kind: 'group', contact: 'A', senderId: 'member-7', direction: 'in', text: 'group-A' })
  s.insertEvent({ at: 400, channel: 'other', kind: 'private', contact: 'A', direction: 'in', text: 'other-channel-A' })

  const rows = s.recentInboundAsc({ channel: 'qq', kind: 'private', contact: 'A', limit: 10 })
  assert.deepEqual(rows.map((r) => r.text), ['private-A'])
  const groupRows = s.recentInboundAsc({ channel: 'qq', kind: 'group', contact: 'A', limit: 10 })
  assert.equal(groupRows[0].sender_id, 'member-7', '群历史必须保留真实发言成员 ID')
  assert.deepEqual(s.recentInboundAsc({ channel: 'qq', limit: 10 }), [])
  assert.deepEqual(s.recentInboundAsc({ channel: 'qq', kind: 'private', limit: 10 }), [])
  s.close()
})
