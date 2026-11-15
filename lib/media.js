/**
 * 入站媒体落盘（P4-lite 第 1 项）。
 *
 * 规则：
 *  - 图片/文件/视频段有 http(s) url 或本地绝对路径时，落到 `<dir>/<YYYY-MM-DD>/<message_id>-<n>.<ext>`
 *  - 视频固定存 `.mp4`；有 `thumb`（http url）时额外存 `<message_id>-<n>.jpg` 封面，封面失败不阻断
 *  - 扩展名白名单 png/jpg/jpeg/gif/webp/pdf/zip/txt/md；从 content-type 先推，再退回 URL 后缀
 *  - 默认 20MB 上限；超限/失败/类型不认识 → 保留 `[图片](未落地)` 占位，**不阻断投递**
 *  - `media.enabled=false` → 退回内联占位（`[图片]` / `[文件] 名字` / `[视频]`），不下载
 */
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

export const EXT_WHITELIST = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'txt', 'md', 'amr', 'silk', 'mp3', 'wav']

const CT_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'text/plain': 'txt',
  'text/markdown': 'md',
}

export function extFromContentType(ct) {
  const key = String(ct ?? '').split(';')[0].trim().toLowerCase()
  return CT_MAP[key] ?? ''
}

export function extFromUrl(url) {
  const raw = String(url ?? '')
  let pathname = raw
  try {
    pathname = new URL(raw).pathname
  } catch {
    pathname = raw.split('?')[0].split('#')[0]
  }
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(pathname)
  const ext = m ? m[1].toLowerCase() : ''
  return EXT_WHITELIST.includes(ext) ? ext : ''
}

/** content-type 优先，其次 URL；都不在白名单 → ''（调用方按失败处理）。 */
export function pickExt({ contentType, url, kind = 'image', whitelist = EXT_WHITELIST } = {}) {
  const fromCt = extFromContentType(contentType)
  if (fromCt && whitelist.includes(fromCt)) return fromCt
  const fromUrl = extFromUrl(url)
  if (fromUrl && whitelist.includes(fromUrl)) return fromUrl
  return ''
}

export function dayOf(ts, offsetMinutes = 0) {
  const d = new Date(Number(ts || Date.now()) + Number(offsetMinutes) * 60000)
  return d.toISOString().slice(0, 10)
}

export function targetPath({ dir, day, messageId, index, ext }) {
  const id = String(messageId ?? '').replace(/[^\w.-]/g, '') || 'noid'
  return join(String(dir), String(day), `${id}-${Number(index) + 1}.${ext}`)
}

function safeBaseName(name) {
  const b = basename(String(name ?? '')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  return b || ''
}

function isHttp(url) {
  return /^https?:\/\//i.test(String(url ?? ''))
}

import { createVoiceTranscriber } from './voice-transcribe.js'

export function createMedia({ cfg = {}, log = null, fetchImpl = globalThis.fetch, now = () => Date.now(), fsFs = null, getClient = () => null, getMedia = () => null } = {}) {
  const c = { enabled: true, dir: '/sdcard/DSHA/渠道/qq/附件', maxBytes: 20 * 1024 * 1024, timeoutMs: 15000, maxImages: 4, maxFiles: 3, ...(cfg.media ?? {}) }
  // config.js 会加 maxVideos；这里自带兜底，未配置时默认 2（与 maxImages/maxFiles 同风格）。
  const maxVideos = Math.max(0, Number(cfg.media?.maxVideos ?? 2) || 0)
  const whitelist = Array.isArray(c.extWhitelist) && c.extWhitelist.length ? c.extWhitelist : EXT_WHITELIST
  const fsm = fsFs ?? { mkdirSync, writeFileSync, copyFileSync, existsSync }
  const stats = { saved: 0, failed: 0, skipped: 0, bytes: 0 }
  const transcriber = createVoiceTranscriber({
    getMedia,
    maxChars: cfg.voice?.maxChars ?? 300,
    timeoutMs: cfg.voice?.timeoutMs ?? 20000,
    log,
  })
  const autoTranscribe = cfg.voice?.autoTranscribe !== false

  const kindOf = (entry) => {
    const kind = entry?.kind
    return kind === 'file' || kind === 'voice' || kind === 'video' ? kind : 'image'
  }

  function placeholder(entry, ok) {
    const kind = kindOf(entry)
    const name = safeBaseName(entry?.name)
    if (kind === 'image') return ok ? '[图片]' : '[图片](未落地)'
    if (kind === 'voice') return ok ? '[语音]' : '[语音](未落地)'
    if (kind === 'video') return ok ? '[视频]' : '[视频](未落地)'
    if (ok) return name ? `[文件] ${name}` : '[文件]'
    return name ? `[文件] ${name}(未落地)` : '[文件](未落地)'
  }

  /** 下载到内存：统一超时 / HTTP 状态 / 体积上限（超限抛 E_TOO_LARGE）。 */
  async function fetchBytes(url, maxBytes) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), Math.max(1000, Number(c.timeoutMs) || 15000))
    timer?.unref?.()
    try {
      const res = await fetchImpl(url, { signal: ac.signal })
      if (!res || res.ok === false) throw new Error(`HTTP ${res?.status ?? '?'}`)
      const len = Number(res.headers?.get?.('content-length') ?? 0)
      if (len && len > maxBytes) throw Object.assign(new Error(`too large: ${len}`), { code: 'E_TOO_LARGE' })
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw Object.assign(new Error(`too large: ${buf.length}`), { code: 'E_TOO_LARGE' })
      return { buf, contentType: res.headers?.get?.('content-type') }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 视频落盘：固定 `.mp4`（契约命名；QQ 视频段基本就是 mp4）。
   * 有 http(s) url 就下载；没有 url 但有本机绝对 file 路径则复制。失败抛出，由 enrich 降级占位。
   */
  async function saveVideo(entry, parsed, index, day) {
    const url = entry?.url
    const localPath = entry?.file
    const abs = (ext) => targetPath({ dir: c.dir, day, messageId: parsed?.messageId, index, ext })

    if (!isHttp(url) && typeof localPath === 'string' && localPath.startsWith('/') && fsm.existsSync(localPath)) {
      const out = abs('mp4')
      fsm.mkdirSync(dirname(out), { recursive: true })
      fsm.copyFileSync(localPath, out)
      stats.saved += 1
      return out
    }
    if (!isHttp(url)) throw Object.assign(new Error('no http url'), { code: 'E_NO_URL' })

    const { buf } = await fetchBytes(url, c.maxBytes)
    const out = abs('mp4')
    fsm.mkdirSync(dirname(out), { recursive: true })
    fsm.writeFileSync(out, buf)
    stats.saved += 1
    stats.bytes += buf.length
    return out
  }

  /** 视频封面：失败只记日志并返回 ''，绝不打断主附件投递。 */
  async function saveVideoThumb(entry, parsed, index, day) {
    const thumb = entry?.thumb
    if (!isHttp(thumb)) return ''
    try {
      const { buf } = await fetchBytes(thumb, c.maxBytes)
      const out = targetPath({ dir: c.dir, day, messageId: parsed?.messageId, index, ext: 'jpg' })
      fsm.mkdirSync(dirname(out), { recursive: true })
      fsm.writeFileSync(out, buf)
      return out
    } catch (error) {
      log?.throttled?.('media-thumb-fail', `[channel-bridge] 视频封面没落地（${error?.code ?? error?.message ?? error}）：${String(thumb).slice(0, 80)}`)
      return ''
    }
  }

  async function saveOne(entry, parsed, index, day, offsetMinutes) {
    const url = entry?.url
    const localPath = entry?.file
    const kind = kindOf(entry)
    const abs0 = (ext) => targetPath({ dir: c.dir, day, messageId: parsed?.messageId, index, ext })

    if (kind === 'video') return saveVideo(entry, parsed, index, day)

    // 语音优先：SnowLuma 的 get_record → wav（base64 或落盘路径）
    if (kind === 'voice' && localPath) {
      const client = getClient?.()
      if (client && typeof client.call === 'function') {
        try {
          const res = await client.call('get_record', { file: localPath, out_format: 'wav' }, { timeoutMs: Math.max(5000, Number(c.timeoutMs) || 15000) })
          const b64raw = res?.data?.base64 ?? res?.data?.data ?? ''
          const b64 = typeof b64raw === 'string' ? b64raw.replace(/^data:[^;]+;base64,/, '') : ''
          if (b64) {
            const buf = Buffer.from(b64, 'base64')
            if (buf.length > 0 && buf.length <= c.maxBytes) {
              const abs = abs0('wav')
              fsm.mkdirSync(dirname(abs), { recursive: true })
              fsm.writeFileSync(abs, buf)
              stats.saved += 1
              stats.bytes += buf.length
              return abs
            }
          }
          const p = res?.data?.file
          if (typeof p === 'string' && p.startsWith('/') && fsm.existsSync(p)) {
            const abs = abs0('wav')
            fsm.mkdirSync(dirname(abs), { recursive: true })
            fsm.copyFileSync(p, abs)
            stats.saved += 1
            return abs
          }
        } catch (error) {
          log?.throttled?.('voice-convert', `[channel-bridge] get_record 失败，改存原文件：${error?.code ?? error?.message ?? error}`)
        }
      }
    }

    // 1) 本地绝对路径：直接复制（NapCat 偶尔给本机 file 路径）
    if (!isHttp(url) && typeof localPath === 'string' && localPath.startsWith('/') && fsm.existsSync(localPath)) {
      const ext = pickExt({ url: localPath, kind, whitelist })
      if (!ext) throw Object.assign(new Error('unsupported type'), { code: 'E_EXT' })
      const abs = targetPath({ dir: c.dir, day, messageId: parsed?.messageId, index, ext })
      fsm.mkdirSync(dirname(abs), { recursive: true })
      fsm.copyFileSync(localPath, abs)
      stats.saved += 1
      return abs
    }

    if (!isHttp(url)) throw Object.assign(new Error('no http url'), { code: 'E_NO_URL' })

    const { buf, contentType } = await fetchBytes(url, c.maxBytes)
    const ext = pickExt({ contentType, url, kind, whitelist })
    if (!ext) throw Object.assign(new Error('unsupported type'), { code: 'E_EXT' })
    const abs = targetPath({ dir: c.dir, day, messageId: parsed?.messageId, index, ext })
    fsm.mkdirSync(dirname(abs), { recursive: true })
    fsm.writeFileSync(abs, buf)
    stats.saved += 1
    stats.bytes += buf.length
    return abs
  }

  return {
    stats,
    transcriber,
    /**
     * 给一条 parsed 补 attachments（字符串数组，一行一个）。
     * 永不抛：任何异常都降级成占位。
     */
    async enrich(parsed) {
      const media = Array.isArray(parsed?.media) ? parsed.media : []
      if (!media.length) return { attachments: [], saved: 0, failed: 0 }

      if (c.enabled === false) {
        stats.skipped += media.length
        return { attachments: media.map((m) => placeholder(m, true)), saved: 0, failed: 0 }
      }

      // 补收消息不下载（避免重连时把旧图全拉一遍）
      if (parsed?.replay) {
        stats.skipped += media.length
        return { attachments: media.map((m) => placeholder(m, false)), saved: 0, failed: 0 }
      }

      const day = dayOf(parsed?.at ?? now(), c.offsetMinutes ?? 0)
      const attachments = []
      let saved = 0
      let failed = 0
      let img = 0
      let file = 0
      let video = 0
      for (let i = 0; i < media.length; i += 1) {
        const entry = media[i]
        const kind = kindOf(entry)
        if (kind === 'image' && img >= c.maxImages) {
          attachments.push(placeholder(entry, false))
          failed += 1
          continue
        }
        if (kind === 'file' && file >= c.maxFiles) {
          attachments.push(placeholder(entry, false))
          failed += 1
          continue
        }
        if (kind === 'video' && video >= maxVideos) {
          attachments.push(placeholder(entry, false))
          failed += 1
          continue
        }
        if (kind === 'image') img += 1
        else if (kind === 'video') video += 1
        else file += 1
        try {
          const abs = await saveOne(entry, parsed, i, day, c.offsetMinutes ?? 0)
          saved += 1
          if (kind === 'video') {
            attachments.push(`[视频] ${abs}`)
            // 封面是附加资产：失败已经内部吞掉，不影响主视频行
            await saveVideoThumb(entry, parsed, i, day)
          } else if (kind === 'image') attachments.push(`[图片] ${abs}`)
          else if (kind === 'voice') {
            let line = `[语音] ${abs}`
            if (autoTranscribe && abs.endsWith('.wav')) {
              const said = await transcriber.transcribe(abs)
              if (said) line += `\n[语音转写] ${said}`
            }
            attachments.push(line)
          } else attachments.push(`[文件] ${safeBaseName(entry?.name) || '文件'} ${abs}`)
        } catch (error) {
          failed += 1
          attachments.push(placeholder(entry, false))
          log?.throttled?.('media-fail', `[channel-bridge] 附件没落地（${error?.code ?? error?.message ?? error}）：${String(entry?.url ?? entry?.file ?? '').slice(0, 80)}`)
        }
      }
      stats.failed += failed
      return { attachments, saved, failed }
    },
  }
}
