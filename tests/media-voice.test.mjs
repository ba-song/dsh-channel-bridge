import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMedia } from '../lib/media.js'
import { parseMessageEvent } from '../lib/parse.js'
import { buildUnifiedText } from '../lib/unified.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bridge-voice-'))
const at = Date.parse('2026-11-06T08:00:00Z')
const parsed = (media, over = {}) => ({ channel: 'qq', kind: 'private', contactId: '2971030080', contactName: '饲养员', at, messageId: 'MSG1', text: '', media, ...over })

test('parse：record 段进 media（kind=voice），正文不再留占位', () => {
  const p = parseMessageEvent(
    {
      post_type: 'message', message_type: 'private', self_id: 1, user_id: 2971030080, message_id: 5, time: 1793900000,
      sender: { nickname: '主人' },
      message: [{ type: 'text', data: { text: '听一下' } }, { type: 'record', data: { file: 'abc.amr' } }],
    },
    { selfId: '1', owner: { qqIds: ['2971030080'] } },
  )
  assert.equal(p.text, '听一下')
  assert.equal(p.media.length, 1)
  assert.equal(p.media[0].kind, 'voice')
  assert.equal(p.media[0].file, 'abc.amr')
})

test('语音：get_record 返回 base64 wav → 落盘 + 正文带绝对路径', async () => {
  const d = dir()
  const wav = Buffer.from('RIFFxxxxWAVE')
  const client = { call: async (action, params) => {
    assert.equal(action, 'get_record')
    assert.equal(params.out_format, 'wav')
    return { status: 'ok', data: { base64: wav.toString('base64') } }
  } }
  const m = createMedia({ cfg: { media: { dir: d } }, getClient: () => client })
  const out = await m.enrich(parsed([{ kind: 'voice', file: 'x.amr', url: '' }]))
  assert.equal(out.attachments.length, 1)
  assert.match(out.attachments[0], /^\[语音\] \/.*MSG1-1\.wav$/)
  const path = out.attachments[0].replace('[语音] ', '')
  assert.ok(existsSync(path))
  assert.equal(readFileSync(path, 'utf8'), 'RIFFxxxxWAVE')
  rmSync(d, { recursive: true, force: true })
})

test('语音：get_record 不可用 → 退回按 url 存原文件（.amr）', async () => {
  const d = dir()
  const m = createMedia({
    cfg: { media: { dir: d } },
    getClient: () => ({ call: async () => { throw new Error('unsupported') } }),
    fetchImpl: async () => ({ ok: true, headers: { get: () => 'audio/amr' }, arrayBuffer: async () => Buffer.from('AMRDATA') }),
  })
  const out = await m.enrich(parsed([{ kind: 'voice', file: 'x.amr', url: 'https://x/a.amr' }]))
  assert.match(out.attachments[0], /^\[语音\] \/.*\.amr$/)
  rmSync(d, { recursive: true, force: true })
})

test('语音：既没 get_record 也没 url → [语音](未落地)，不阻断', async () => {
  const m = createMedia({ cfg: { media: { dir: dir() } } })
  const out = await m.enrich(parsed([{ kind: 'voice', file: 'x.amr', url: '' }]))
  assert.deepEqual(out.attachments, ['[语音](未落地)'])
})

test('图片：落盘后正文为「[图片] /abs/path」（单行绝对路径）', async () => {
  const d = dir()
  const m = createMedia({
    cfg: { media: { dir: d } },
    fetchImpl: async () => ({ ok: true, headers: { get: (k) => (k === 'content-type' ? 'image/jpeg' : null) }, arrayBuffer: async () => Buffer.from('JPG') }),
  })
  const p = parsed([{ kind: 'image', url: 'https://x/a.jpg' }])
  const out = await m.enrich(p)
  p.attachments = out.attachments
  assert.match(out.attachments[0], /^\[图片\] \/.*MSG1-1\.jpg$/)
  const text = buildUnifiedText({ ...p, text: '' })
  assert.ok(text.includes('[图片] /'), text)
  rmSync(d, { recursive: true, force: true })
})

test('纯文本消息不受影响（没有附件行）', () => {
  const text = buildUnifiedText({ ...parsed([]), text: '就一句话' })
  assert.ok(text.startsWith('[QQ·私聊·饲养员(2971030080)] 就一句话'))
  assert.ok(!text.includes('[图片]'))
})
