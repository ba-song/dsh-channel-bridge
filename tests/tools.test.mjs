import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.js'
import { openBridgeDb } from '../lib/store.js'

const cfg = { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 3600 * 1000 } }

function harness({ mode = 'send', sendResult = { ok: true, messageId: 'mid-1' }, contact = null, outbox = null, mirror = null, log = null } = {}) {
  const tools = { defs: [], register(d) { this.defs.push(d) } }
  const store = openBridgeDb(':memory:')
  if (contact) store.upsertContact(contact)
  const sends = []
  const sender = { sendText: async (x) => { sends.push(x); return sendResult } }
  registerTools({
    tools,
    cfg,
    mode: { current: () => mode },
    sender,
    store,
    log,
    status: () => ({ mode, opened: true, events: 3, messages: 1 }),
    outbox,
    mirror,
  })
  const say = tools.defs.find((d) => d.name === 'dy_say')
  return { tools, store, sends, say, call: (args, exec) => say.execute(args, exec) }
}

test('注册了 dy_say，参数四件套必填', () => {
  const h = harness()
  assert.equal(h.tools.defs.length, 24)
  assert.deepEqual(
    h.tools.defs.map((d) => d.name).sort(),
    [
      'dy_bridge_rotate',
      'dy_bridge_status',
      'dy_qq_avatar',
      'dy_qq_custom_face',
      'dy_qq_file',
      'dy_qq_forward',
      'dy_qq_forward_msg',
      'dy_qq_friend',
      'dy_qq_friend_request',
      'dy_qq_friends',
      'dy_qq_get_forward',
      'dy_qq_group_info',
      'dy_qq_members',
      'dy_qq_poke',
      'dy_qq_profile',
      'dy_qq_reaction',
      'dy_qq_recall',
      'dy_qq_status',
      'dy_qq_video',
      'dy_say',
      'dy_send_face',
      'dy_send_image',
      'dy_send_voice',
      'dy_sticker_search',
    ],
  )
  assert.deepEqual(h.say.parameters.required, ['channel', 'contactId', 'text']) // email 不要 kind
  assert.deepEqual(h.say.parameters.properties.channel.enum, ['qq', 'email'])
})

test('observe：E_OBSERVE_ONLY，不发', async () => {
  const h = harness({ mode: 'observe' })
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: 'hi' })
  assert.match(r.detail, /E_OBSERVE_ONLY/)
  assert.equal(h.sends.length, 0)
  assert.equal(h.store.counts().out, 0)
})

test('deliver：E_DELIVER_ONLY，不发', async () => {
  const h = harness({ mode: 'deliver' })
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: 'hi' })
  assert.match(r.detail, /E_DELIVER_ONLY/)
  assert.equal(h.sends.length, 0)
})

test('send + 主人：SENT，审计只记长度/via/messageId', async () => {
  const h = harness()
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '晚安' })
  assert.equal(r.ok, true)
  assert.match(r.detail, /SENT/)
  assert.equal(h.sends.length, 1)
  const row = h.store.raw.prepare(`SELECT * FROM channel_events WHERE direction='out'`).get()
  assert.equal(row.text, null)
  assert.equal(row.text_len, 2)
  const meta = JSON.parse(row.meta)
  assert.equal(meta.via, 'owner-proactive')
  assert.equal(meta.messageId, 'mid-1')
})

test('send + 被动回复：via=reply', async () => {
  const h = harness({ contact: { contact: '11111111', kind: 'private', name: '某人', at: Date.now() } })
  const r = await h.call({ channel: 'qq', contactId: '11111111', kind: 'private', text: '在' })
  assert.equal(r.ok, true)
  const meta = JSON.parse(h.store.raw.prepare(`SELECT meta FROM channel_events WHERE direction='out'`).get().meta)
  assert.equal(meta.via, 'reply')
})

test('陌生人：拒，且不写 out 审计', async () => {
  const h = harness()
  const r = await h.call({ channel: 'qq', contactId: '11111111', kind: 'private', text: '在' })
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_UNKNOWN_CONTACT/)
  assert.equal(h.store.counts().out, 0)
  assert.equal(h.sends.length, 0)
})

test('[SILENT]：不发，写一条 silent', async () => {
  const h = harness()
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '[SILENT]' })
  assert.equal(r.ok, true)
  assert.match(r.detail, /SILENT/)
  assert.equal(h.sends.length, 0)
  assert.equal(h.store.counts().silent, 1)
})

test('发送失败：不写 out 审计', async () => {
  const h = harness({ sendResult: { ok: false, code: 'E_SEND_FAILED', detail: 'boom' } })
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: 'hi' })
  assert.equal(r.ok, false)
  assert.equal(h.store.counts().out, 0)
})

test('dy_bridge_status：只读状态字段齐全', async () => {
  const h = harness()
  const t = h.tools.defs.find((d) => d.name === 'dy_bridge_status')
  const r = await t.execute({})
  assert.equal(r.ok, true)
  const body = JSON.parse(r.detail)
  assert.equal(body.opened, true)
  assert.equal(body.mode, 'send')
  assert.equal(body.events, 3)
  assert.equal(body.messages, 1)
})

test('outbound=auto：dy_say 返回 E_AUTO_MODE，不发', async () => {
  const defs = []
  const sends = []
  registerTools({
    tools: { register: (d) => defs.push(d) },
    cfg: { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 3600 * 1000 } },
    mode: { current: () => 'send' },
    sender: { sendText: async (x) => { sends.push(x); return { ok: true, messageId: 'm' } } },
    store: openBridgeDb(':memory:'),
    log: null,
    outbound: 'auto',
  })
  const say = defs.find((d) => d.name === 'dy_say')
  const r = await say.execute({ channel: 'qq', contactId: '2971030080', kind: 'private', text: 'hi' })
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_AUTO_MODE/)
  assert.equal(sends.length, 0)
})

test('outbound=tool：onSent 回调收到发出文本', async () => {
  const seen = []
  const defs = []
  registerTools({
    tools: { register: (d) => defs.push(d) },
    cfg: { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 3600 * 1000 } },
    mode: { current: () => 'send' },
    sender: { sendText: async () => ({ ok: true, messageId: 'm' }) },
    store: openBridgeDb(':memory:'),
    log: null,
    outbound: 'tool',
    onSent: (x) => seen.push(x.text),
  })
  await defs.find((d) => d.name === 'dy_say').execute({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '晚安' })
  assert.deepEqual(seen, ['晚安'])
})

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutbox } from '../lib/outbox.js'

const outboxTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bridge-outbox-'))
  return { d, file: join(d, 'outbox.log') }
}
const detailOf = (r) => JSON.parse(r.detail)

test('dy_say 成功：parts 拼接 == 入参原文，delivered=true', async () => {
  const h = harness()
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '晚安，早点睡' })
  const d = detailOf(r)
  assert.equal(r.ok, true)
  assert.equal(d.delivered, true)
  assert.equal(d.parts.length, 1)
  assert.equal(d.parts[0].text, '晚安，早点睡')
  assert.equal(d.parts[0].ok, true)
  assert.equal(d.parts.map((p) => p.text).join(''), '晚安，早点睡')
})

test('dy_say 长文 200 字：2–4 段、每段 ≤60、拼回不丢字', async () => {
  const h = harness()
  const text = '啊'.repeat(200)
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text })
  const d = detailOf(r)
  assert.equal(d.delivered, true)
  assert.ok(d.parts.length >= 2 && d.parts.length <= 4, `段数 ${d.parts.length}`)
  for (const p of d.parts) assert.ok([...p.text].length <= 60)
  assert.equal(d.parts.map((p) => p.text).join(''), text)
  assert.equal(h.sends.length, d.parts.length)
  assert.equal(h.store.counts().out, d.parts.length)
})

test('dy_say 掉线：E_OFFLINE、parts 带原文、outbox 留原文、queued=true', async () => {
  const { d, file } = outboxTmp()
  const h = harness({ sendResult: { ok: false, code: 'E_NOT_CONNECTED', detail: '未连上 NapCat' }, outbox: createOutbox({ file }) })
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: 'QQ 掉线时我本来想说这句' })
  const body = detailOf(r)
  assert.equal(r.ok, false)
  assert.equal(body.code, 'E_OFFLINE')
  assert.equal(body.delivered, false)
  assert.equal(body.queued, true)
  assert.equal(body.parts.length, 1)
  assert.equal(body.parts[0].text, 'QQ 掉线时我本来想说这句')
  assert.equal(body.parts[0].ok, false)
  assert.ok(existsSync(file))
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[?20\d\d-\d\d-\d\dT/)
  assert.ok(lines[0].includes('2971030080'))
  assert.ok(lines[0].includes('QQ 掉线时我本来想说这句'))
  rmSync(d, { recursive: true, force: true })
})

test('dy_say 群聊掉线：outbox 只留长度，不留原文（隐私）', async () => {
  const { d, file } = outboxTmp()
  const h = harness({
    sendResult: { ok: false, code: 'E_NOT_CONNECTED', detail: 'offline' },
    contact: { contact: '707380948', kind: 'group', name: '测试群', at: Date.now() },
    outbox: createOutbox({ file }),
  })
  const r = await h.call({ channel: 'qq', contactId: '707380948', kind: 'group', text: '群里说的秘密' })
  const body = detailOf(r)
  assert.equal(body.code, 'E_OFFLINE')
  const line = readFileSync(file, 'utf8').trim()
  assert.ok(line.includes('(len=6)'))
  assert.ok(!line.includes('群里说的秘密'))
  rmSync(d, { recursive: true, force: true })
})

test('dy_say [SILENT]：parts 为空、delivered=false、不写 outbox', async () => {
  const { d, file } = outboxTmp()
  const h = harness({ outbox: createOutbox({ file }) })
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '[SILENT]' })
  const body = detailOf(r)
  assert.equal(r.ok, true)
  assert.equal(body.silent, true)
  assert.equal(body.delivered, false)
  assert.deepEqual(body.parts, [])
  assert.equal(existsSync(file), false)
  assert.equal(h.sends.length, 0)
  rmSync(d, { recursive: true, force: true })
})

test('工具描述写明 parts 是原文', () => {
  const h = harness()
  assert.ok(h.say.description.includes('parts'))
  assert.ok(h.say.description.includes('delivered'))
})

import { createMirror } from '../lib/mirror.js'

test('dy_say 成功 → 镜像 append 每段原文（经 exec.agent，顺序一致）', async () => {
  const appends = []
  const agent = { session: { id: 'S1', log: [{ type: 'turn/start', data: { turn: 1 } }], append: (t, d) => appends.push(d.message.content[0].text) } }
  const h = harness({ mirror: createMirror({ store: openBridgeDb(':memory:'), cfg: { mirror: { enabled: true } } }) })
  const text = '啊'.repeat(130)
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text }, { agent })
  const body = detailOf(r)
  assert.equal(body.delivered, true)
  assert.ok(body.parts.length >= 2)
  assert.deepEqual(appends, body.parts.map((p) => p.text))
  assert.equal(body.mirrored, body.parts.length)
})

test('dy_say [SILENT] → 0 次镜像 append', async () => {
  const appends = []
  const agent = { session: { append: () => appends.push(1) } }
  const h = harness({ mirror: createMirror({ store: openBridgeDb(':memory:'), cfg: { mirror: { enabled: true } } }) })
  await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '[SILENT]' }, { agent })
  assert.equal(appends.length, 0)
})

test('镜像 append 抛错 → 发送仍 ok，日志有 warn', async () => {
  const warns = []
  const agent = { session: { append: () => { throw new Error('surface rejected') } } }
  const h = harness({
    mirror: createMirror({ store: openBridgeDb(':memory:'), log: { warn: (x) => warns.push(x) }, cfg: { mirror: { enabled: true } } }),
    log: { info: () => {}, warn: (x) => warns.push(x) },
  })
  const r = await h.call({ channel: 'qq', contactId: '2971030080', kind: 'private', text: '还是发出去了' }, { agent })
  assert.equal(r.ok, true)
  assert.match(r.detail, /SENT/)
  assert.ok(warns.some((w) => w.includes('镜像')))
})

test('dy_bridge_rotate：默认 qq/private，返回新会话信息', async () => {
  const h = harness()
  h.rotate = { forceRotate: async (x) => ({ ok: true, oldSessionId: 'OLD', newSessionId: 'NEW', seeded: 50, count: 50, ...x }) }
  registerTools({
    tools: { register: (d) => h.tools.defs.push(d) },
    cfg: { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 1 }, groupCwd: '/sdcard/DSHA/渠道/qq-群' },
    mode: { current: () => 'observe' },
    sender: { sendText: async () => ({ ok: true }) },
    store: openBridgeDb(':memory:'),
    log: null,
    sessions: h.rotate,
  })
  const t = h.tools.defs.filter((d) => d.name === 'dy_bridge_rotate').at(-1)
  const r = await t.execute({}, { agent: { session: { header: { cwd: '/sdcard/DSHA/渠道/qq' } } } })
  assert.equal(r.ok, true)
  assert.match(r.detail, /NEW/)
  assert.match(r.detail, /"seeded":50/)
})

test('dy_bridge_rotate：子智能体/群聊房间被拒（E_PERMISSION）', async () => {
  const calls = []
  const defs = []
  registerTools({
    tools: { register: (d) => defs.push(d) },
    cfg: { owner: { qqIds: [] }, say: {}, groupCwd: '/sdcard/DSHA/渠道/qq-群' },
    mode: { current: () => 'send' },
    sender: { sendText: async () => ({ ok: true }) },
    store: openBridgeDb(':memory:'),
    log: null,
    sessions: { forceRotate: async (x) => { calls.push(x); return { ok: true } } },
  })
  const t = defs.find((d) => d.name === 'dy_bridge_rotate')
  const sub = await t.execute({}, { agent: { session: { header: { parentSession: 'p' } } } })
  assert.equal(sub.ok, false)
  assert.match(sub.detail, /E_PERMISSION/)
  const group = await t.execute({ kind: 'group' }, { agent: { session: { header: { cwd: '/sdcard/DSHA/渠道/qq-群' } } } })
  assert.equal(group.ok, false)
  assert.match(group.detail, /E_PERMISSION/)
  assert.equal(calls.length, 0)
})
