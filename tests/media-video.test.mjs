import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMedia } from '../lib/media.js'
import { parseMessageEvent } from '../lib/parse.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bridge-video-'))
const DAY = '2026-11-05'
const parsed = (media, over = {}) => ({
  channel: 'qq',
  kind: 'private',
  contactId: '1',
  contactName: 'A',
  text: '',
  at: Date.parse('2026-11-05T01:02:03Z'),
  messageId: '9001',
  media,
  ...over,
})

function fakeFetch(map, { fail = [] } = {}) {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    if (fail.includes(url)) throw new Error(`network: ${url}`)
    const hit = map[url]
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    const buf = Buffer.from(hit.body ?? 'x')
    return {
      ok: hit.ok !== false,
      status: hit.status ?? 200,
      headers: {
        get: (k) => {
          const key = String(k).toLowerCase()
          if (key === 'content-type') return hit.ct ?? null
          if (key === 'content-length') return hit.len === null ? null : String(hit.len ?? buf.length)
          return null
        },
      },
      arrayBuffer: async () => buf,
    }
  }
  fn.calls = calls
  return fn
}

const fileOf = (line) => line.replace(/^\[[^\]]+\] /, '')

test('视频 http url → 落盘 <messageId>-1.mp4 + [视频] 绝对路径', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({ 'https://x/cat.mp4': { ct: 'video/mp4', body: 'MP4DATA' } })
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  // thumb 不是 http url：不该发请求
  const out = await m.enrich(parsed([{ kind: 'video', url: 'https://x/cat.mp4', file: '', name: '猫.mp4', thumb: 'base64://AAAA' }]))
  assert.equal(out.saved, 1)
  assert.equal(out.failed, 0)
  assert.equal(out.attachments.length, 1)
  assert.match(out.attachments[0], /^\[视频\] \/.*9001-1\.mp4$/)
  const path = fileOf(out.attachments[0])
  assert.ok(path.startsWith(join(d, DAY)), path)
  assert.equal(readFileSync(path, 'utf8'), 'MP4DATA')
  assert.deepEqual(fetchImpl.calls, ['https://x/cat.mp4'])
  rmSync(d, { recursive: true, force: true })
})

test('视频本机绝对 file 路径 → 复制为 .mp4（NapCat 本机路径）', async () => {
  const d = dir()
  const srcDir = dir()
  const src = join(srcDir, 'x.mp4')
  writeFileSync(src, 'LOCALMP4')
  const m = createMedia({ cfg: { media: { dir: d } } })
  const out = await m.enrich(parsed([{ kind: 'video', url: '', file: src, thumb: '' }]))
  assert.match(out.attachments[0], /^\[视频\] \/.*9001-1\.mp4$/)
  assert.equal(readFileSync(fileOf(out.attachments[0]), 'utf8'), 'LOCALMP4')
  rmSync(d, { recursive: true, force: true })
  rmSync(srcDir, { recursive: true, force: true })
})

test('无 http url → [视频](未落地)，不抛、不请求', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({})
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  const out = await m.enrich(parsed([{ kind: 'video', url: '', file: 'abc.mp4', thumb: '' }]))
  assert.deepEqual(out.attachments, ['[视频](未落地)'])
  assert.equal(out.saved, 0)
  assert.equal(out.failed, 1)
  assert.equal(fetchImpl.calls.length, 0)
  rmSync(d, { recursive: true, force: true })
})

test('超限（content-length / 实际字节）→ [视频](未落地)，不落盘', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({
    'https://x/big1.mp4': { ct: 'video/mp4', body: 'x'.repeat(100), len: 100 },
    'https://x/big2.mp4': { ct: 'video/mp4', body: 'x'.repeat(40), len: null }, // 无 content-length，按实际字节判
  })
  const m = createMedia({ cfg: { media: { dir: d, maxBytes: 10 } }, fetchImpl })
  const out = await m.enrich(parsed([
    { kind: 'video', url: 'https://x/big1.mp4', thumb: '' },
    { kind: 'video', url: 'https://x/big2.mp4', thumb: '' },
  ]))
  assert.deepEqual(out.attachments, ['[视频](未落地)', '[视频](未落地)'])
  assert.equal(out.saved, 0)
  assert.equal(out.failed, 2)
  assert.equal(existsSync(join(d, DAY)), false)
  rmSync(d, { recursive: true, force: true })
})

test('封面 http url → 额外落盘 <messageId>-1.jpg，附件行仍只有 [视频] 一行', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({
    'https://x/v.mp4': { ct: 'video/mp4', body: 'MP4' },
    'https://x/t.jpg': { ct: 'image/jpeg', body: 'JPG' },
  })
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  const out = await m.enrich(parsed([{ kind: 'video', url: 'https://x/v.mp4', thumb: 'https://x/t.jpg' }]))
  assert.equal(out.saved, 1)
  assert.equal(out.failed, 0)
  assert.equal(out.attachments.length, 1)
  assert.match(out.attachments[0], /^\[视频\] \/.*9001-1\.mp4$/)
  assert.equal(readFileSync(join(d, DAY, '9001-1.jpg'), 'utf8'), 'JPG')
  rmSync(d, { recursive: true, force: true })
})

test('封面下载失败（404）→ 主视频照常落盘，failed 不增加', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({ 'https://x/v.mp4': { ct: 'video/mp4', body: 'MP4' } })
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  const out = await m.enrich(parsed([{ kind: 'video', url: 'https://x/v.mp4', thumb: 'https://x/missing.jpg' }]))
  assert.equal(out.saved, 1)
  assert.equal(out.failed, 0)
  assert.match(out.attachments[0], /^\[视频\] \/.*9001-1\.mp4$/)
  assert.equal(existsSync(join(d, DAY, '9001-1.jpg')), false)
  rmSync(d, { recursive: true, force: true })
})

test('视频 fetch 抛错 → 占位且不阻断后续附件', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({ 'https://x/ok.png': { ct: 'image/png', body: 'P' } }, { fail: ['https://x/bad.mp4'] })
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  const out = await m.enrich(parsed([
    { kind: 'video', url: 'https://x/bad.mp4', thumb: '' },
    { kind: 'image', url: 'https://x/ok.png' },
  ]))
  assert.deepEqual(out.attachments.map((x) => x.split(' ')[0]), ['[视频](未落地)', '[图片]'])
  assert.equal(out.saved, 1)
  assert.equal(out.failed, 1)
  assert.match(out.attachments[1], /9001-2\.png$/)
  rmSync(d, { recursive: true, force: true })
})

test('maxVideos 默认 2：第 3 个视频只留占位', async () => {
  const d = dir()
  const map = {}
  const media = Array.from({ length: 3 }, (_, i) => {
    const url = `https://x/${i}.mp4`
    map[url] = { ct: 'video/mp4', body: 'v' }
    return { kind: 'video', url, thumb: '' }
  })
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl: fakeFetch(map) })
  const out = await m.enrich(parsed(media))
  assert.equal(out.saved, 2)
  assert.equal(out.failed, 1)
  assert.equal(out.attachments.filter((x) => x.startsWith('[视频] /')).length, 2)
  assert.deepEqual(out.attachments.filter((x) => x === '[视频](未落地)'), ['[视频](未落地)'])
  assert.deepEqual(readdirSync(join(d, DAY)).sort(), ['9001-1.mp4', '9001-2.mp4'])
  rmSync(d, { recursive: true, force: true })
})

test('cfg.media.maxVideos=1 → 只有第 1 个视频落盘', async () => {
  const d = dir()
  const map = {}
  const media = Array.from({ length: 2 }, (_, i) => {
    const url = `https://x/${i}.mp4`
    map[url] = { ct: 'video/mp4', body: 'v' }
    return { kind: 'video', url, thumb: '' }
  })
  const m = createMedia({ cfg: { media: { dir: d, maxVideos: 1 } }, fetchImpl: fakeFetch(map) })
  const out = await m.enrich(parsed(media))
  assert.equal(out.saved, 1)
  assert.equal(out.failed, 1)
  assert.deepEqual(out.attachments.map((x) => x.split(' ')[0]), ['[视频]', '[视频](未落地)'])
  rmSync(d, { recursive: true, force: true })
})

test('cfg.media.maxVideos=0 → 全部占位且不请求', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({})
  const m = createMedia({ cfg: { media: { dir: d, maxVideos: 0 } }, fetchImpl })
  const out = await m.enrich(parsed([{ kind: 'video', url: 'https://x/v.mp4', thumb: '' }]))
  assert.deepEqual(out.attachments, ['[视频](未落地)'])
  assert.equal(out.failed, 1)
  assert.equal(fetchImpl.calls.length, 0)
  rmSync(d, { recursive: true, force: true })
})

test('命名按 media 数组位置：图片之后的视频是 <messageId>-2.mp4，封面 -2.jpg', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({
    'https://x/a.png': { ct: 'image/png', body: 'P' },
    'https://x/v.mp4': { ct: 'video/mp4', body: 'V' },
    'https://x/t.jpg': { ct: 'image/jpeg', body: 'J' },
  })
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  const out = await m.enrich(parsed([
    { kind: 'image', url: 'https://x/a.png' },
    { kind: 'video', url: 'https://x/v.mp4', thumb: 'https://x/t.jpg' },
  ]))
  assert.equal(out.saved, 2)
  assert.match(out.attachments[0], /9001-1\.png$/)
  assert.match(out.attachments[1], /9001-2\.mp4$/)
  assert.equal(readFileSync(join(d, DAY, '9001-2.jpg'), 'utf8'), 'J')
  rmSync(d, { recursive: true, force: true })
})

test('端到端：parse 的 video 段 → enrich 落盘 mp4 + 封面', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({
    'https://x/qq.mp4': { ct: 'video/mp4', body: 'MP4' },
    'https://x/qq.jpg': { ct: 'image/jpeg', body: 'JPG' },
  })
  const p = parseMessageEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 1,
    user_id: 2,
    message_id: 77,
    time: Math.floor(Date.parse('2026-11-05T01:02:03Z') / 1000),
    sender: { nickname: '主人' },
    message: [
      { type: 'text', data: { text: '看视频' } },
      { type: 'video', data: { url: 'https://x/qq.mp4', file: 'qq.mp4', name: '猫.mp4', thumb: 'https://x/qq.jpg' } },
    ],
  }, { selfId: '1', owner: { qqIds: ['2'] } })
  assert.equal(p.media.length, 1)
  assert.equal(p.media[0].kind, 'video')
  assert.equal(p.text, '看视频')
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  const out = await m.enrich(p)
  assert.equal(out.attachments.length, 1)
  assert.match(out.attachments[0], /^\[视频\] \/.*77-1\.mp4$/)
  assert.equal(readFileSync(fileOf(out.attachments[0]), 'utf8'), 'MP4')
  assert.equal(readFileSync(join(d, '2026-11-05', '77-1.jpg'), 'utf8'), 'JPG')
  rmSync(d, { recursive: true, force: true })
})

test('media.enabled=false / replay → 视频退回占位，不下载', async () => {
  const fetchImpl = fakeFetch({})
  const d1 = dir()
  const d2 = dir()
  const disabled = createMedia({ cfg: { media: { dir: d1, enabled: false } }, fetchImpl })
  const a = await disabled.enrich(parsed([{ kind: 'video', url: 'https://x/v.mp4', thumb: 'https://x/t.jpg' }]))
  assert.deepEqual(a.attachments, ['[视频]'])

  const replaying = createMedia({ cfg: { media: { dir: d2 } }, fetchImpl })
  const b = await replaying.enrich(parsed([{ kind: 'video', url: 'https://x/v.mp4', thumb: 'https://x/t.jpg' }], { replay: true }))
  assert.deepEqual(b.attachments, ['[视频](未落地)'])
  assert.equal(fetchImpl.calls.length, 0)
  rmSync(d1, { recursive: true, force: true })
  rmSync(d2, { recursive: true, force: true })
})
