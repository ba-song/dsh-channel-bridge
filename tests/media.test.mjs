import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMedia, extFromContentType, extFromUrl, pickExt, targetPath, dayOf } from '../lib/media.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bridge-media-'))
const parsed = (over = {}) => ({ channel: 'qq', kind: 'private', contactId: '1', contactName: 'A', text: '看图', at: Date.parse('2026-11-05T01:02:03Z'), messageId: '9001', ...over })

function fakeFetch(map) {
  return async (url) => {
    const hit = map[url]
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    const buf = Buffer.from(hit.body ?? 'x')
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? hit.ct : k.toLowerCase() === 'content-length' ? String(hit.len ?? buf.length) : null) },
      arrayBuffer: async () => buf,
    }
  }
}

test('content-type → 扩展名', () => {
  assert.equal(extFromContentType('image/png'), 'png')
  assert.equal(extFromContentType('image/jpeg; charset=binary'), 'jpg')
  assert.equal(extFromContentType('application/pdf'), 'pdf')
  assert.equal(extFromContentType('text/markdown'), 'md')
  assert.equal(extFromContentType('text/html'), '')
})

test('URL 后缀 → 扩展名（大小写/非白名单）', () => {
  assert.equal(extFromUrl('https://x/a.JPG?x=1'), 'jpg')
  assert.equal(extFromUrl('https://x/a.exe'), '')
  assert.equal(extFromUrl('not a url'), '')
})

test('pickExt：ct 优先、URL 兜底、白名单外拒', () => {
  assert.equal(pickExt({ contentType: 'image/webp', url: 'https://x/a.png' }), 'webp')
  assert.equal(pickExt({ contentType: 'text/html', url: 'https://x/a.pdf' }), 'pdf')
  assert.equal(pickExt({ contentType: 'text/html', url: 'https://x/a.bin' }), '')
})

test('路径格式：<dir>/<YYYY-MM-DD>/<message_id>-<n>.<ext>', () => {
  assert.equal(dayOf(Date.parse('2026-11-05T23:59:00Z')), '2026-11-05')
  assert.equal(targetPath({ dir: '/d', day: '2026-11-05', messageId: '9001', index: 0, ext: 'jpg' }), '/d/2026-11-05/9001-1.jpg')
  assert.equal(targetPath({ dir: '/d', day: '2026-11-05', messageId: '', index: 1, ext: 'png' }), '/d/2026-11-05/noid-2.png')
})

test('图片下载成功：落盘 + [图片] 绝对路径', async () => {
  const d = dir()
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl: fakeFetch({ 'https://x/a.png': { ct: 'image/png', body: 'PNGDATA' } }) })
  const out = await m.enrich(parsed({ media: [{ kind: 'image', url: 'https://x/a.png' }] }))
  assert.equal(out.attachments.length, 1)
  const path = out.attachments[0].replace('[图片] ', '')
  assert.ok(path.startsWith(join(d, '2026-11-05')))
  assert.ok(existsSync(path))
  assert.equal(readFileSync(path, 'utf8'), 'PNGDATA')
  rmSync(d, { recursive: true, force: true })
})

test('文件下载成功：[文件] 名字 + 路径（ext 由 ct 推）', async () => {
  const d = dir()
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl: fakeFetch({ 'https://x/dl': { ct: 'application/pdf', body: 'PDF' } }) })
  const out = await m.enrich(parsed({ media: [{ kind: 'file', url: 'https://x/dl', name: '报告.pdf' }] }))
  assert.match(out.attachments[0], /^\[文件\] 报告\.pdf \/.*\.pdf$/)
  rmSync(d, { recursive: true, force: true })
})

test('超限（content-length）→ 不落盘 + (未落地)', async () => {
  const d = dir()
  const m = createMedia({ cfg: { media: { dir: d, maxBytes: 10 } }, fetchImpl: fakeFetch({ 'https://x/big.png': { ct: 'image/png', body: 'x'.repeat(100), len: 100 } }) })
  const out = await m.enrich(parsed({ media: [{ kind: 'image', url: 'https://x/big.png' }] }))
  assert.deepEqual(out.attachments, ['[图片](未落地)'])
  assert.equal(out.failed, 1)
  rmSync(d, { recursive: true, force: true })
})

test('类型不认识 → (未落地)，不抛', async () => {
  const d = dir()
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl: fakeFetch({ 'https://x/a.bin': { ct: 'application/octet-stream', body: 'zz' } }) })
  const out = await m.enrich(parsed({ media: [{ kind: 'image', url: 'https://x/a.bin' }] }))
  assert.deepEqual(out.attachments, ['[图片](未落地)'])
  rmSync(d, { recursive: true, force: true })
})

test('下载抛错（fetch reject）→ (未落地)，不阻断', async () => {
  const m = createMedia({ cfg: { media: { dir: dir() } }, fetchImpl: async () => { throw new Error('boom') } })
  const out = await m.enrich(parsed({ media: [{ kind: 'image', url: 'https://x/a.png' }] }))
  assert.deepEqual(out.attachments, ['[图片](未落地)'])
})

test('media.enabled=false → 退回内联占位，不下载', async () => {
  let called = 0
  const m = createMedia({ cfg: { media: { enabled: false, dir: dir() } }, fetchImpl: async () => { called += 1; throw new Error('no') } })
  const out = await m.enrich(parsed({ media: [{ kind: 'image', url: 'https://x/a.png' }, { kind: 'file', url: 'https://x/b.pdf', name: 'b.pdf' }] }))
  assert.deepEqual(out.attachments, ['[图片]', '[文件] b.pdf'])
  assert.equal(called, 0)
})

test('图片最多 4 张：第 5 张只留占位', async () => {
  const d = dir()
  const media = Array.from({ length: 5 }, (_, i) => ({ kind: 'image', url: `https://x/${i}.png` }))
  const map = Object.fromEntries(media.map((m) => [m.url, { ct: 'image/png', body: 'p' }]))
  const m = createMedia({ cfg: { media: { dir: d, maxImages: 4 } }, fetchImpl: fakeFetch(map) })
  const out = await m.enrich(parsed({ media }))
  assert.equal(out.attachments.filter((x) => x.startsWith('[图片] /')).length, 4)
  assert.equal(out.attachments.filter((x) => x === '[图片](未落地)').length, 1)
  rmSync(d, { recursive: true, force: true })
})

test('补收消息不下载', async () => {
  let called = 0
  const m = createMedia({ cfg: { media: { dir: dir() } }, fetchImpl: async () => { called += 1; throw new Error('no') } })
  const out = await m.enrich(parsed({ replay: true, media: [{ kind: 'image', url: 'https://x/a.png' }] }))
  assert.deepEqual(out.attachments, ['[图片](未落地)'])
  assert.equal(called, 0)
})

test('本地绝对路径：复制进缓存目录', async () => {
  const d = dir()
  const srcDir = dir()
  const src = join(srcDir, 'x.png')
  const fs = await import('node:fs')
  fs.writeFileSync(src, 'LOCAL')
  const m = createMedia({ cfg: { media: { dir: d } } })
  const out = await m.enrich(parsed({ media: [{ kind: 'image', url: '', file: src }] }))
  const path = out.attachments[0].replace('[图片] ', '')
  assert.ok(existsSync(path))
  assert.equal(readFileSync(path, 'utf8'), 'LOCAL')
  rmSync(d, { recursive: true, force: true })
  rmSync(srcDir, { recursive: true, force: true })
})
