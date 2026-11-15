import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMedia } from '../lib/media.js'

const at = Date.parse('2026-11-07T06:00:00Z')
const msg = (kind, mid, over = {}) => ({
  channel: 'qq', kind, contactId: '2971030080', contactName: '主人', at, messageId: mid, text: '', media: [{ kind: 'voice', file: 'x.amr', url: '' }], ...over,
})

function setup({ transcribe = null, mediaEnabled = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-tr-'))
  const calls = []
  const warns = []
  const service = transcribe === null ? null : {
    transcribe: async (x) => { calls.push(x); return transcribe(x) },
  }
  const m = createMedia({
    cfg: { media: { dir }, voice: { autoTranscribe: mediaEnabled } },
    getClient: () => ({ call: async () => ({ data: { base64: Buffer.from('RIFFWAV').toString('base64') } }) }),
    getMedia: () => service,
    log: { info: () => {}, warn: (x) => warns.push(x), throttled: (k, x) => warns.push(x) },
  })
  return { m, dir, calls, warns }
}

test('转写成功：正文在 [语音] /path.wav 后追加 [语音转写] 文本', async () => {
  const h = setup({ transcribe: async () => ({ text: '早上好呀' }) })
  const out = await h.m.enrich(msg('private', 'M1'))
  assert.equal(out.attachments.length, 1)
  assert.match(out.attachments[0], /^\[语音\] \/.*M1-1\.wav\n\[语音转写\] 早上好呀$/)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0].path, /M1-1\.wav$/)
  rmSync(h.dir, { recursive: true, force: true })
})

test('转写失败/服务缺失：保留路径、warn、不阻断投递', async () => {
  const h = setup({ transcribe: async () => { throw new Error('asr down') } })
  const out = await h.m.enrich(msg('private', 'M2'))
  assert.match(out.attachments[0], /^\[语音\] \/.*M2-1\.wav$/)
  assert.ok(!out.attachments[0].includes('[语音转写]'))
  assert.equal(out.saved, 1)
  assert.ok(h.warns.some((w) => w.includes('语音转写失败')))

  const h2 = setup({ transcribe: null })
  const out2 = await h2.m.enrich(msg('private', 'M3'))
  assert.ok(out2.attachments[0].startsWith('[语音] /'))
  assert.ok(!out2.attachments[0].includes('[语音转写]'))
  rmSync(h.dir, { recursive: true, force: true })
  rmSync(h2.dir, { recursive: true, force: true })
})

test('非语音不转写；图片不调 transcribe', async () => {
  const h = setup({ transcribe: async () => ({ text: '不该出现' }) })
  const out = await h.m.enrich(msg('private', 'M4', { media: [{ kind: 'image', url: 'https://x/a.jpg' }] }))
  assert.equal(h.calls.length, 0)
  assert.ok(!out.attachments.join('\n').includes('[语音转写]'))
  rmSync(h.dir, { recursive: true, force: true })
})

test('同一路径不重复转写', async () => {
  const h = setup({ transcribe: async () => ({ text: '一次就好' }) })
  const p = msg('private', 'M5')
  const a = await h.m.enrich(p)
  const b = await h.m.enrich(p)
  assert.equal(h.calls.length, 1)
  assert.ok(a.attachments[0].includes('[语音转写] 一次就好'))
  assert.ok(!b.attachments[0].includes('[语音转写]'))
  rmSync(h.dir, { recursive: true, force: true })
})

test('群/私聊一致：两条不同语音各自转写', async () => {
  const h = setup({ transcribe: async () => ({ text: '收到' }) })
  const p1 = await h.m.enrich(msg('private', 'M6'))
  const p2 = await h.m.enrich(msg('group', 'G1', { contactId: '707380948', contactName: '群' }))
  assert.equal(h.calls.length, 2)
  assert.ok(p1.attachments[0].includes('[语音转写] 收到'))
  assert.ok(p2.attachments[0].includes('[语音转写] 收到'))
  rmSync(h.dir, { recursive: true, force: true })
})

test('autoTranscribe:false → 只保留路径', async () => {
  const h = setup({ transcribe: async () => ({ text: '不该转' }), mediaEnabled: false })
  const out = await h.m.enrich(msg('private', 'M7'))
  assert.equal(h.calls.length, 0)
  assert.match(out.attachments[0], /^\[语音\] \/.*\.wav$/)
  rmSync(h.dir, { recursive: true, force: true })
})
