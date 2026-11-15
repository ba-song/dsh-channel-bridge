import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../lib/router.js'
import { openBridgeDb } from '../lib/store.js'

const parsed = (over = {}) => ({ channel: 'qq', kind: 'private', contactId: '2971030080', contactName: '饲养员', senderName: '饲养员', text: '看图', at: 1000, messageId: 'm1', ...over })
const modeOf = (m) => ({ current: () => m })

function harness({ created = false, enrich = null, contextBuilder = null } = {}) {
  const got = []
  const agent = { followup: async (m) => { got.push(m) } }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 'sess', created }) }
  const r = createRouter({ store: openBridgeDb(':memory:'), sessions, mode: modeOf('send'), enrich, contextBuilder })
  return { r, got }
}

test('enrich 的 attachments 进正文（图片路径行）', async () => {
  const h = harness({ enrich: async () => ({ attachments: ['[图片] /sdcard/x/1.jpg'] }) })
  h.r.deliver(parsed())
  await h.r.idle()
  assert.ok(h.got[0].content[0].text.includes('\n[图片] /sdcard/x/1.jpg'))
})

test('enrich 抛错：按原样投递，不影响队列', async () => {
  const h = harness({ enrich: async () => { throw new Error('boom') } })
  h.r.deliver(parsed())
  await h.r.idle()
  assert.equal(h.got.length, 1)
  assert.match(h.got[0].content[0].text, /^\[QQ·私聊·饲养员\(2971030080\)\] 看图/)
  assert.equal(h.r.stats.enrichFail, 1)
})

test('补收消息跳过 enrich', async () => {
  let called = 0
  const h = harness({ enrich: async () => { called += 1; return { attachments: [] } } })
  h.r.deliver(parsed({ replay: true, replayLabel: '08:41' }))
  await h.r.idle()
  assert.equal(called, 0)
  assert.match(h.got[0].content[0].text, /\[补收·08:41\]/)
})

test('新会话才加「上次在 QQ 房间里聊到」；旧会话不加', async () => {
  const ctx = () => '（上次在 QQ 房间里聊到：\n08:00 1：hi\n——接上就行，不用回这段。）'
  const a = harness({ created: true, contextBuilder: ctx })
  a.r.deliver(parsed())
  await a.r.idle()
  assert.match(a.got[0].content[0].text, /^（上次在 QQ 房间里聊到：/)
  assert.equal(a.r.stats.contextAdded, 1)

  const b = harness({ created: false, contextBuilder: ctx })
  b.r.deliver(parsed())
  await b.r.idle()
  assert.ok(!b.got[0].content[0].text.includes('上次在 QQ 房间里聊到'))
})

test('followup 成功后回调 onDelivered（给自动发送登记）', async () => {
  const got = []
  const agent = { followup: async () => {} }
  const sessions = { ensure: async () => ({ ok: true, agent, sessionId: 'S-AUTO', created: true }) }
  const r = createRouter({
    store: openBridgeDb(':memory:'),
    sessions,
    mode: modeOf('send'),
    onDelivered: (x) => got.push({ sessionId: x.sessionId, contact: x.parsed.contactId, agent: x.agent }),
  })
  r.deliver(parsed())
  await r.idle()
  assert.equal(got.length, 1)
  assert.equal(got[0].sessionId, 'S-AUTO')
  assert.equal(got[0].contact, '2971030080')
  assert.equal(got[0].agent, agent)
})
