import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMedia } from '../lib/media.js'

const dir = () => mkdtempSync(join(tmpdir(), 'media-inline-'))
const parsed = (media, over = {}) => ({ at: Date.now(), messageId: '77', media, ...over })

function fakeFetch(map = {}, opts = {}) {
  const calls = []
  let inflight = 0
  let peak = 0
  const fn = async (url) => {
    calls.push(url)
    if (opts.delayMs) {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, opts.delayMs))
      inflight -= 1
    }
    const entry = map[url]
    if (entry === false) return { ok: false, status: 404, headers: { get: () => null } }
    const body = entry?.body ?? 'IMG'
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-type' ? entry?.ct ?? 'image/jpeg' : null) },
      arrayBuffer: async () => Buffer.from(body),
    }
  }
  fn.calls = calls
  Object.defineProperty(fn, 'peak', { get: () => peak })
  return fn
}

test('md5 去重：同一张图第二次直接复用，不再发请求', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({ 'https://x/a.jpg?rkey=1': { ct: 'image/jpeg', body: 'A' } })
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  const url = 'https://x/a.jpg?rkey=1'
  const file = 'ABCDEF0123456789ABCDEF0123456789.jpg'
  const out1 = await m.enrich(parsed([{ kind: 'image', url, file }]))
  const out2 = await m.enrich(parsed([{ kind: 'image', url, file }]))
  assert.equal(out1.attachments.length, 1)
  assert.equal(out2.attachments.length, 1)
  assert.equal(fetchImpl.calls.length, 1) // 第二次没请求
  assert.equal(m.stats.deduped, 1)
  assert.ok(existsSync(out2.attachments[0].replace('[图片] ', '')))
  rmSync(d, { recursive: true, force: true })
})

test('get_image 兜底：url 失效（404）→ 用 file 换新 url 重下成功', async () => {
  const d = dir()
  const calls = []
  const fetchImpl = fakeFetch({
    'https://x/stale.jpg?rkey=1': false,
    'https://x/fresh.jpg?rkey=2': { ct: 'image/jpeg', body: 'NEW' },
  })
  const client = {
    call: async (action, params) => {
      calls.push({ action, params })
      return { status: 'ok', retcode: 0, data: { url: 'https://x/fresh.jpg?rkey=2' } }
    },
  }
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl, getClient: () => client })
  const out = await m.enrich(parsed([{ kind: 'image', url: 'https://x/stale.jpg?rkey=1', file: '-123.jpg' }]))
  assert.equal(out.failed, 0)
  assert.equal(out.attachments.length, 1)
  assert.match(out.attachments[0], /^\[图片\] /)
  assert.deepEqual(calls[0], { action: 'get_image', params: { file: '-123.jpg' } })
  assert.equal(m.stats.refreshed, 1)
  rmSync(d, { recursive: true, force: true })
})

test('get_image 也失败：按原样占位，不影响投递', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({ 'https://x/bad.jpg': false })
  const client = { call: async () => ({ status: 'failed', retcode: 100, wording: 'image not found in cache' }) }
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl, getClient: () => client })
  const out = await m.enrich(parsed([{ kind: 'image', url: 'https://x/bad.jpg', file: '-1.jpg' }]))
  assert.equal(out.failed, 1)
  assert.deepEqual(out.attachments, ['[图片](未落地)'])
  rmSync(d, { recursive: true, force: true })
})

test('多图并发：保持数组顺序，并发峰值 > 1', async () => {
  const d = dir()
  const fetchImpl = fakeFetch(
    { 'https://x/1.jpg': { body: '1' }, 'https://x/2.jpg': { body: '2' }, 'https://x/3.jpg': { body: '3' } },
    { delayMs: 20 },
  )
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl })
  const out = await m.enrich(parsed([
    { kind: 'image', url: 'https://x/1.jpg' },
    { kind: 'image', url: 'https://x/2.jpg' },
    { kind: 'image', url: 'https://x/3.jpg' },
  ]))
  assert.equal(out.saved, 3)
  assert.deepEqual(out.attachments.map((x) => x.split(' ')[0]), ['[图片]', '[图片]', '[图片]'])
  assert.match(out.attachments[0], /-1\.jpg$/)
  assert.match(out.attachments[1], /-2\.jpg$/)
  assert.match(out.attachments[2], /-3\.jpg$/)
  assert.ok(fetchImpl.peak > 1, `并发峰值 ${fetchImpl.peak}`)
  rmSync(d, { recursive: true, force: true })
})

test('inline：第一张图存进 attachment 服务；inline=false 不存', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({ 'https://x/a.jpg': { body: 'A' } })
  const saved = []
  const attachments = {
    saveImage: async ({ data, mediaType, name }) => {
      saved.push({ bytes: data.length, mediaType, name })
      return { attachmentId: 'att-9', mediaType, bytes: data.length, width: 10, height: 20, name }
    },
  }
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl, getAttachments: () => attachments })
  const off = await m.enrich(parsed([{ kind: 'image', url: 'https://x/a.jpg' }]))
  assert.equal(off.inlineImage, null)
  assert.equal(saved.length, 0)
  const on = await m.enrich(parsed([{ kind: 'image', url: 'https://x/a.jpg' }]), { inline: true })
  assert.equal(on.inlineImage.type, 'image')
  assert.equal(on.inlineImage.attachment.attachmentId, 'att-9')
  assert.equal(on.inlineImage.attachment.width, 10)
  assert.equal(saved.length, 1)
  assert.equal(m.stats.inlined, 1)
  rmSync(d, { recursive: true, force: true })
})

test('inline：saveImage 失败降级为 null，不影响附件行', async () => {
  const d = dir()
  const fetchImpl = fakeFetch({ 'https://x/a.jpg': { body: 'A' } })
  const attachments = { saveImage: async () => { throw new Error('boom') } }
  const m = createMedia({ cfg: { media: { dir: d } }, fetchImpl, getAttachments: () => attachments })
  const out = await m.enrich(parsed([{ kind: 'image', url: 'https://x/a.jpg' }]), { inline: true })
  assert.equal(out.inlineImage, null)
  assert.equal(out.failed, 0)
  assert.match(out.attachments[0], /^\[图片\] /)
  rmSync(d, { recursive: true, force: true })
})
