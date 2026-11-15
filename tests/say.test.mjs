import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSay } from '../lib/say.js'

const now = 1_000_000_000_000
const base = {
  mode: 'send',
  ownerIds: ['2971030080'],
  maxTextChars: 2000,
  windowMs: 7 * 24 * 3600 * 1000,
  now: () => now,
  contactOf: () => null,
}
const say = (over = {}, deps = {}) => validateSay({ channel: 'qq', contactId: '2971030080', kind: 'private', text: 'hi', ...over }, { ...base, ...deps })
const withContact = (kind = 'private', lastSeen = now - 1000) => ({ ...base, contactOf: (channel, contactId) => (contactId === '11111111' ? { last_seen_at: lastSeen, kind } : null) })

test('1 缺参数', () => {
  const v = validateSay({ channel: 'qq' }, base)
  assert.equal(v.code, 'E_MISSING_PARAM')
  assert.match(v.detail, /contactId/)
})

test('2 未知渠道', () => assert.equal(say({ channel: 'wechat' }).code, 'E_UNKNOWN_CHANNEL'))

test('3 非法 kind', () => assert.equal(say({ kind: 'channel' }).code, 'E_BAD_KIND'))

test('4 号码格式（私聊 5–12 位数字）', () => {
  assert.equal(say({ contactId: 'abc' }).code, 'E_UNKNOWN_CONTACT')
  assert.equal(say({ contactId: '1234' }).code, 'E_UNKNOWN_CONTACT')
  assert.equal(say({ contactId: '1234567890123' }).code, 'E_UNKNOWN_CONTACT')
})

test('5 超长', () => assert.equal(say({ text: 'x'.repeat(2001) }).code, 'E_TEXT_TOO_LONG'))

test('6 陌生人拒绝', () => assert.equal(say({ contactId: '11111111' }, { ...base, contactOf: () => null }).code, 'E_UNKNOWN_CONTACT'))

test('7 主人放行（owner-proactive）', () => {
  const v = say({}, { contactOf: () => null })
  assert.equal(v.ok, true)
  assert.equal(v.via, 'owner-proactive')
})

test('8 主人不能当群发（E_OWNER_KIND）', () => assert.equal(say({ kind: 'group' }).code, 'E_OWNER_KIND'))

test('9 observe 只观察', () => assert.equal(say({}, { mode: 'observe' }).code, 'E_OBSERVE_ONLY'))

test('10 deliver 只投递', () => assert.equal(say({}, { mode: 'deliver' }).code, 'E_DELIVER_ONLY'))

test('11 send 通过', () => {
  const v = say({}, { mode: 'send' })
  assert.equal(v.ok, true)
  assert.equal(v.silent, false)
})

test('12 [SILENT] 不算发（不校验模式）', () => {
  for (const mode of ['observe', 'deliver', 'send']) {
    const v = say({ text: '[SILENT]' }, { mode })
    assert.equal(v.ok, true)
    assert.equal(v.silent, true)
  }
})

test('被动回复：目录里 7 天内、kind 一致 → via=reply', () => {
  const v = validateSay({ channel: 'qq', contactId: '11111111', kind: 'private', text: '在' }, withContact('private'))
  assert.equal(v.ok, true)
  assert.equal(v.via, 'reply')
})

test('被动回复：超过 7 天 → 拒', () => {
  const v = validateSay({ channel: 'qq', contactId: '11111111', kind: 'private', text: '在' }, withContact('private', now - 8 * 24 * 3600 * 1000))
  assert.equal(v.code, 'E_UNKNOWN_CONTACT')
})

test('owner.qqIds 为空：主动 fail-closed，被动照常', () => {
  assert.equal(say({}, { ownerIds: [] }).code, 'E_UNKNOWN_CONTACT')
  const v = validateSay({ channel: 'qq', contactId: '11111111', kind: 'private', text: '在' }, { ...withContact(), ownerIds: [] })
  assert.equal(v.ok, true)
})

test('私聊与群的 [SILENT] 语义一致（都不发送）', async () => {
  const { registerTools } = await import('../lib/tools.js')
  const { openBridgeDb } = await import('../lib/store.js')
  for (const kind of ['private', 'group']) {
    const defs = []
    const sends = []
    const store = openBridgeDb(':memory:')
    if (kind === 'group') store.upsertContact({ contact: '707380948', kind: 'group', name: '测试群', at: Date.now() })
    registerTools({
      tools: { register: (d) => defs.push(d) },
      cfg: { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 3600 * 1000 } },
      mode: { current: () => 'send' },
      sender: { sendText: async (x) => { sends.push(x); return { ok: true, messageId: 'm' } } },
      store,
      log: null,
    })
    const say = defs.find((d) => d.name === 'dy_say')
    const args = kind === 'private'
      ? { channel: 'qq', contactId: '2971030080', kind, text: '[SILENT]' }
      : { channel: 'qq', contactId: '707380948', kind, text: '[SILENT]' }
    const r = await say.execute(args)
    assert.equal(r.ok, true)
    assert.match(r.detail, /SILENT/)
    assert.equal(sends.length, 0)
  }
})
