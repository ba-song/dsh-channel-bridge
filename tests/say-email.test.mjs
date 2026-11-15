import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.js'
import { openBridgeDb } from '../lib/store.js'

const cfg = { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 3600 * 1000 }, mail: { maxTextChars: 5000 } }

function harness({ mode = 'send', mail = undefined, sendResult = { delivered: true } } = {}) {
  const defs = []
  const sent = []
  const store = openBridgeDb(':memory:')
  const fakeMail = mail === null ? null : {
    ownerAddresses: async () => ['owner@example.com'],
    send: async (x) => { sent.push(x); return sendResult },
    ...(mail ?? {}),
  }
  registerTools({
    tools: { register: (d) => defs.push(d) },
    cfg,
    mode: { current: () => mode },
    sender: { sendText: async () => ({ ok: true, messageId: 'm' }) },
    store,
    getMail: () => fakeMail,
    log: null,
  })
  return { defs, say: defs.find((d) => d.name === 'dy_say'), sent, store, fakeMail }
}

const exec = { agent: { session: { header: { cwd: '/sdcard/DSHA/渠道/qq' } } } }

test('email：主人地址 → 调 dyMail.send（默认主题）+ 返回 channel email', async () => {
  const h = harness()
  const r = await h.say.execute({ channel: 'email', contactId: 'owner@example.com', text: '邮件正文' }, exec)
  assert.equal(r.ok, true)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.sent[0], { to: 'owner@example.com', subject: '汐的邮件', body: '邮件正文' })
  const body = JSON.parse(r.detail)
  assert.equal(body.channel, 'email')
  assert.equal(body.delivered, true)
  assert.equal(body.to, 'owner@example.com')
  assert.equal(body.subject, '汐的邮件')
})

test('email：自定义 subject 原样传', async () => {
  const h = harness()
  const r = await h.say.execute({ channel: 'email', contactId: 'owner@example.com', text: 'x', subject: '标题' }, exec)
  assert.equal(r.ok, true)
  assert.equal(h.sent[0].subject, '标题')
})

test('email：非主人地址 → E_NOT_OWNER，且不调用 send', async () => {
  const h = harness()
  const r = await h.say.execute({ channel: 'email', contactId: 'stranger@example.com', text: 'x' }, exec)
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_NOT_OWNER/)
  assert.equal(h.sent.length, 0)
})

test('email：dyMail 缺失 → E_CHANNEL_UNAVAILABLE', async () => {
  const h = harness({ mail: null })
  const r = await h.say.execute({ channel: 'email', contactId: 'owner@example.com', text: 'x' }, exec)
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_CHANNEL_UNAVAILABLE/)
})

test('email：正文超 5000 → E_TEXT_TOO_LONG；地址不合法 → E_FORMAT；observe 不发', async () => {
  const h = harness()
  assert.match((await h.say.execute({ channel: 'email', contactId: 'owner@example.com', text: '长'.repeat(5001) }, exec)).detail, /E_TEXT_TOO_LONG/)
  assert.match((await h.say.execute({ channel: 'email', contactId: 'not-an-email', text: 'x' }, exec)).detail, /E_FORMAT/)
  const obs = harness({ mode: 'observe' })
  assert.match((await obs.say.execute({ channel: 'email', contactId: 'owner@example.com', text: 'x' }, exec)).detail, /E_OBSERVE_ONLY/)
  assert.equal(obs.sent.length, 0)
})

test('email：dyMail.send 返回失败 → E_SEND_FAILED（不重试）', async () => {
  const h = harness({ sendResult: { ok: false, code: 'E_SMTP' } })
  const r = await h.say.execute({ channel: 'email', contactId: 'owner@example.com', text: 'x' }, exec)
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_SMTP/)
  assert.equal(h.sent.length, 1)
})

test('QQ 回归：channel=qq 仍要求 kind 与号码', async () => {
  const h = harness()
  assert.match((await h.say.execute({ channel: 'qq', contactId: '2971030080', text: 'x' }, exec)).detail, /E_MISSING_PARAM/)
  const r = await h.say.execute({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '在吗' }, exec)
  assert.equal(r.ok, true)
})
