import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.js'
import { openBridgeDb } from '../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'qq-tools-'))
const png = join(dir, 'a.png')
writeFileSync(png, Buffer.from('PNGDATA'))
const big = join(dir, 'big.jpg')
writeFileSync(big, 'x')
truncateSync(big, 11 * 1024 * 1024) // 超过 10MB 原图上限

function setup({ modeValue = 'send', defs = [], calls = [], sendOk = true } = {}) {
  const store = openBridgeDb(':memory:')
  store.upsertContact({ channel: 'qq', contact: '2971030080', kind: 'private', name: '主人', at: Date.now() })
  const sent = []
  const sender = {
    callAction: async (action, params) => {
      calls.push({ action, params })
      const nickname = calls.some((c) => c.action === 'set_qq_profile' || c.action === 'set_self_longnick') ? '新名字' : '旧名字'
      if (action === 'get_login_info') return { ok: true, data: { user_id: 2190097528, nickname } }
      if (action === 'get_stranger_info') return { ok: true, data: { nickname, sex: 1, long_nick: '旧签名' } }
      return { ok: sendOk, data: {}, code: sendOk ? undefined : 'E_SEND_FAILED' }
    },
    sendSegments: async ({ kind, contactId, message }) => {
      sent.push({ kind, contactId, message })
      return sendOk ? { ok: true, messageId: 'mid-1' } : { ok: false, code: 'E_SEND_FAILED', detail: 'boom' }
    },
  }
  const tools = { register: (d) => defs.push(d) }
  registerTools({
    tools,
    cfg: { owner: { qqIds: ['2971030080'] }, say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 3600 * 1000 }, qq: { rateMs: 5000 }, selfId: '2190097528' },
    mode: { current: () => modeValue },
    sender,
    store,
    log: null,
  })
  const tool = (name) => defs.find((d) => d.name === name)
  return { store, sent, sender, tool, calls }
}

const ownerExec = { agent: { session: { header: { cwd: '/sdcard/DSHA/渠道/qq' } } } }

test('dy_send_image：合法 png → 图片段 file://绝对路径 + 审计脱敏', async () => {
  const h = setup()
  const r = await h.tool('dy_send_image').execute({ path: png, contactId: '2971030080', caption: '给你看' }, ownerExec)
  assert.equal(r.ok, true)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].message.length, 2)
  assert.deepEqual(h.sent[0].message[0], { type: 'text', data: { text: '给你看' } })
  assert.equal(h.sent[0].message[1].type, 'image')
  const file = h.sent[0].message[1].data.file
  assert.ok(file.startsWith('base64://'), file.slice(0, 32))
  assert.equal(Buffer.from(file.slice('base64://'.length), 'base64').toString(), 'PNGDATA')
  const ops = h.store.listQqOps(5)
  assert.equal(ops[0].action, 'send_image')
  assert.match(ops[0].fields, /a\.png/)
  assert.match(ops[0].fields, /size=7/)
  assert.ok(!JSON.stringify(ops).includes('PNGDATA'))
})

test('dy_send_image：越界目录/扩展名/超大/相对路径都拒绝', async () => {
  const h = setup()
  const t = h.tool('dy_send_image')
  const r1 = await t.execute({ path: '/etc/passwd', contactId: '2971030080' }, ownerExec)
  assert.equal(r1.ok, false)
  assert.match(r1.detail, /E_PATH/)
  const r2 = await t.execute({ path: '/root/nope.png', contactId: '2971030080' }, ownerExec) // 不在白名单目录
  assert.match(r2.detail, /E_PATH/)
  const txt = join(dir, 'x.txt'); writeFileSync(txt, 'hi')
  const r3 = await t.execute({ path: txt, contactId: '2971030080' }, ownerExec)
  assert.match(r3.detail, /E_FORMAT/)
  const r4 = await t.execute({ path: big, contactId: '2971030080' }, ownerExec)
  assert.match(r4.detail, /E_TOO_LARGE/)
  const r5 = await t.execute({ path: 'a.png', contactId: '2971030080' }, ownerExec)
  assert.match(r5.detail, /E_PATH/)
})

test('dy_send_image：连发两张不再限流（2026-11-14 解除 5 秒/张）', async () => {
  const h = setup()
  const t = h.tool('dy_send_image')
  assert.equal((await t.execute({ path: png, contactId: '2971030080' }, ownerExec)).ok, true)
  const r2 = await t.execute({ path: png, contactId: '2971030080' }, ownerExec)
  assert.equal(r2.ok, true)
  assert.equal(h.sent.length, 2)
})

test('dy_send_face：1–300 校验 + face 段', async () => {
  const h = setup()
  const t = h.tool('dy_send_face')
  assert.equal((await t.execute({ id: 14, contactId: '2971030080' }, ownerExec)).ok, true)
  assert.deepEqual(h.sent[0].message, [{ type: 'face', data: { id: '14' } }])
  const bad = await t.execute({ id: 999, contactId: '2971030080' }, ownerExec)
  assert.match(bad.detail, /E_FORMAT/)
  // 表情仍保留 5 秒/次（只解除图片限流）
  assert.match((await t.execute({ id: 15, contactId: '2971030080' }, ownerExec)).detail, /E_RATE_LIMIT/)
})

test('dy_send_image：非主人私聊不在窗口 → E_NO_CONTACT；observe 模式拒绝', async () => {
  const h = setup()
  const r = await h.tool('dy_send_image').execute({ path: png, contactId: '999999' }, ownerExec)
  assert.match(r.detail, /E_NO_CONTACT/)
  const h2 = setup({ modeValue: 'observe' })
  const r2 = await h2.tool('dy_send_image').execute({ path: png, contactId: '2971030080' }, ownerExec)
  assert.match(r2.detail, /E_MODE_OBSERVE/)
})

test('dy_qq_profile：没 confirm → E_CONFIRM_REQUIRED，且一次写都没调', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_profile').execute({ nickname: '新名字' }, ownerExec)
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_CONFIRM_REQUIRED/)
  assert.match(r.detail, /nickname/)
  assert.equal(h.calls.filter((c) => c.action === 'set_qq_profile').length, 0)
})

test('dy_qq_profile：confirm 后写入 + 回读 before/after + 审计', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_profile').execute({ nickname: '新名字', signature: '新签名', confirm: true }, ownerExec)
  assert.equal(r.ok, true)
  const body = JSON.parse(r.detail)
  assert.deepEqual(body.fields, ['nickname', 'signature'])
  assert.ok(h.calls.some((c) => c.action === 'set_qq_profile' && c.params.nickname === '新名字'))
  assert.ok(h.calls.some((c) => c.action === 'set_self_longnick' && c.params.long_nick === '新签名'))
  assert.ok(body.before && body.after && body.after.nickname === '新名字')
  const ops = h.store.listQqOps(5)
  assert.equal(ops[0].action, 'profile')
  assert.equal(ops[0].ok, 1)
})

test('dy_qq_profile：写失败不重试 + 审计失败', async () => {
  const calls = []
  const h = setup({ calls, sendOk: false })
  const r = await h.tool('dy_qq_profile').execute({ nickname: '新名字', confirm: true }, ownerExec)
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_SEND_FAILED/)
  assert.equal(h.calls.filter((c) => c.action === 'set_qq_profile').length, 1) // 只一次
  assert.equal(h.store.listQqOps(1)[0].ok, 0)
})

test('dy_qq_status：confirm 必需 + 枚举校验 + set_online_status', async () => {
  const h = setup()
  const t = h.tool('dy_qq_status')
  assert.match((await t.execute({ status: 40 }, ownerExec)).detail, /E_CONFIRM_REQUIRED/)
  assert.match((await t.execute({ status: 20, confirm: true }, ownerExec)).detail, /E_FORMAT/)
  const ok = await t.execute({ status: 40, confirm: true }, ownerExec)
  assert.equal(ok.ok, true)
  assert.ok(h.calls.some((c) => c.action === 'set_online_status' && c.params.status === 40))
})

const wav = join(dir, 'v.wav'); writeFileSync(wav, Buffer.from('RIFFDATA'))
const bigVoice = join(dir, 'v-big.wav'); writeFileSync(bigVoice, 'x'); truncateSync(bigVoice, 6 * 1024 * 1024)
const ogg = join(dir, 'v.ogg'); writeFileSync(ogg, 'OggS')

test('dy_send_voice：record 段 base64 + 解码回原字节 + 审计脱敏', async () => {
  const h = setup()
  const r = await h.tool('dy_send_voice').execute({ path: wav, contactId: '2971030080', caption: '听这里' }, ownerExec)
  assert.equal(r.ok, true)
  assert.equal(h.sent.length, 1)
  const msg = h.sent[0].message
  assert.equal(msg.length, 2)
  assert.deepEqual(msg[0], { type: 'text', data: { text: '听这里' } })
  assert.equal(msg[1].type, 'record')
  const file = msg[1].data.file
  assert.ok(file.startsWith('base64://'))
  assert.equal(Buffer.from(file.slice('base64://'.length), 'base64').toString(), 'RIFFDATA')
  const ops = h.store.listQqOps(5)
  assert.equal(ops[0].action, 'send_voice')
  assert.match(ops[0].fields, /voice:v\.wav size=8/)
  assert.ok(!JSON.stringify(ops).includes('base64'))
  assert.ok(!JSON.stringify(ops).includes('RIFFDATA'))
})

test('dy_send_voice：扩展名/大小/路径/门禁/限流', async () => {
  const h = setup()
  const t = h.tool('dy_send_voice')
  assert.match((await t.execute({ path: ogg, contactId: '2971030080' }, ownerExec)).detail, /E_FORMAT/)
  assert.match((await t.execute({ path: bigVoice, contactId: '2971030080' }, ownerExec)).detail, /E_TOO_LARGE/)
  assert.match((await t.execute({ path: '/etc/passwd.wav', contactId: '2971030080' }, ownerExec)).detail, /E_PATH/)
  assert.match((await t.execute({ path: wav, contactId: '999999' }, ownerExec)).detail, /E_NO_CONTACT/)
  assert.equal((await t.execute({ path: wav, contactId: '2971030080' }, ownerExec)).ok, true)
  assert.match((await t.execute({ path: wav, contactId: '2971030080' }, ownerExec)).detail, /E_RATE_LIMIT/)
})

test('dy_send_voice：发送失败不重试，返回 E_SEND_FAILED', async () => {
  const h = setup({ sendOk: false })
  const r = await h.tool('dy_send_voice').execute({ path: wav, contactId: '2971030080' }, ownerExec)
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_SEND_FAILED/)
  assert.equal(h.store.listQqOps(1)[0].ok, 0)
})

const avatarPng = join(dir, 'avatar.png'); writeFileSync(avatarPng, Buffer.from('AVATARDATA'))
const avatarBig = join(dir, 'avatar-big.jpg'); writeFileSync(avatarBig, 'x'); truncateSync(avatarBig, 3 * 1024 * 1024)
const avatarGif = join(dir, 'avatar.gif'); writeFileSync(avatarGif, 'GIF89a')

test('dy_qq_avatar：confirm 后 base64 调用 set_qq_avatar + 结果脱敏 + 审计', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_avatar').execute({ path: avatarPng, confirm: true }, ownerExec)
  assert.equal(r.ok, true)
  const call = h.calls.find((c) => c.action === 'set_qq_avatar')
  assert.ok(call, '必须调用 set_qq_avatar')
  assert.ok(call.params.file.startsWith('base64://'))
  assert.equal(Buffer.from(call.params.file.slice('base64://'.length), 'base64').toString(), 'AVATARDATA')
  const body = JSON.parse(r.detail)
  assert.equal(body.bytes, 10)
  const ops = h.store.listQqOps(5)
  assert.equal(ops[0].action, 'avatar')
  assert.match(ops[0].fields, /avatar:avatar\.png size=10/)
  assert.ok(!JSON.stringify(ops).includes('base64'))
  assert.ok(!JSON.stringify(ops).includes('AVATARDATA'))
})

test('dy_qq_avatar：缺 confirm → 零调用；路径/扩展名/2MB 拒绝', async () => {
  const h = setup()
  const t = h.tool('dy_qq_avatar')
  const r0 = await t.execute({ path: avatarPng }, ownerExec)
  assert.match(r0.detail, /E_CONFIRM_REQUIRED/)
  assert.equal(h.calls.filter((c) => c.action === 'set_qq_avatar').length, 0)
  assert.match((await t.execute({ path: avatarGif, confirm: true }, ownerExec)).detail, /E_FORMAT/)
  assert.match((await t.execute({ path: avatarBig, confirm: true }, ownerExec)).detail, /E_TOO_LARGE/)
  assert.match((await t.execute({ path: '/etc/x.png', confirm: true }, ownerExec)).detail, /E_PATH/)
})

test('dy_qq_avatar：写失败只调一次（不重试）+ 审计 ok=0', async () => {
  const h = setup({ sendOk: false })
  const r = await h.tool('dy_qq_avatar').execute({ path: avatarPng, confirm: true }, ownerExec)
  assert.equal(r.ok, false)
  assert.match(r.detail, /E_SEND_FAILED/)
  assert.equal(h.calls.filter((c) => c.action === 'set_qq_avatar').length, 1)
  assert.equal(h.store.listQqOps(1)[0].ok, 0)
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
