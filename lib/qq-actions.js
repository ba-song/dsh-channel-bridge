/** QQ 图片/表情/资料/在线状态 的参数校验（纯函数，便于测试）。 */
import { existsSync, statSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
export const VOICE_EXTS = ['wav', 'mp3', 'silk']
export const VOICE_MAX_BYTES = 5 * 1024 * 1024
export const AVATAR_EXTS = ['png', 'jpg', 'jpeg']
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const IMAGE_DIRS = ['/sdcard/DSHA', '/tmp']
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024 // 原图上限；base64 后约 13MB（模型侧跨容器，只能传 base64）
export const FACE_MIN = 1
export const FACE_MAX = 300
// 2026-11-16：发文件 / 发视频（跨容器只能 base64，体积上限比图片更保守）
export const FILE_EXTS = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv','json','log','zip','rar','7z','tar','gz','apk','png','jpg','jpeg','gif','webp','mp3','wav','mp4']
export const FILE_MAX_BYTES = 8 * 1024 * 1024
export const VIDEO_EXTS = ['mp4','mov','mkv','webm','avi']
export const VIDEO_MAX_BYTES = 20 * 1024 * 1024
export const ONLINE_STATUS = { 在线: 10, 离开: 30, 隐身: 40, 忙碌: 50, 勿扰: 60, 学习: 70 }

/** 通用文件校验（图片/语音共用）；校验目录、扩展名、存在性、大小。 */
export function validateFilePath(path, { allowDirs = IMAGE_DIRS, maxBytes = IMAGE_MAX_BYTES, exts = IMAGE_EXTS, fs = null } = {}) {
  const f = fs ?? { existsSync, statSync }
  const p = String(path ?? '')
  if (!p) return { ok: false, code: 'E_PATH', detail: 'path 必填' }
  if (!p.startsWith('/')) return { ok: false, code: 'E_PATH', detail: '必须是绝对路径' }
  const dirOk = allowDirs.some((d) => p === d || p.startsWith(`${d}/`))
  if (!dirOk) return { ok: false, code: 'E_PATH', detail: `只允许 ${allowDirs.join(' / ')} 下的文件` }
  const ext = extname(p).replace(/^\./, '').toLowerCase()
  if (!exts.includes(ext)) return { ok: false, code: 'E_FORMAT', detail: `只支持 ${exts.join('/')}` }
  let st = null
  try {
    st = f.statSync(p)
  } catch {
    return { ok: false, code: 'E_PATH', detail: '文件不存在' }
  }
  if (!st.isFile()) return { ok: false, code: 'E_PATH', detail: '不是普通文件' }
  if (st.size > maxBytes) return { ok: false, code: 'E_TOO_LARGE', detail: `超过 ${Math.round(maxBytes / 1024 / 1024)}MB` }
  return { ok: true, abs: p, size: st.size, ext, name: basename(p) }
}

export function validateImagePath(path, opts = {}) {
  return validateFilePath(path, { ...opts, exts: IMAGE_EXTS, maxBytes: opts.maxBytes ?? IMAGE_MAX_BYTES })
}

export function validateVoicePath(path, opts = {}) {
  return validateFilePath(path, { ...opts, exts: VOICE_EXTS, maxBytes: opts.maxBytes ?? VOICE_MAX_BYTES })
}

/** 发文件：扩展名白名单 + 8MB（base64 过 WS，太大容易超时）。 */
export function validateFileToSend(path, opts = {}) {
  return validateFilePath(path, { ...opts, exts: opts.exts ?? FILE_EXTS, maxBytes: opts.maxBytes ?? FILE_MAX_BYTES })
}

/** 发视频：mp4/mov/mkv/webm/avi + 20MB。 */
export function validateVideoPath(path, opts = {}) {
  return validateFilePath(path, { ...opts, exts: opts.exts ?? VIDEO_EXTS, maxBytes: opts.maxBytes ?? VIDEO_MAX_BYTES })
}

/**
 * 合并转发节点校验：items [{senderName?, senderId?, text}]。
 * 返回规整后的 items（去空、截断），或错误。
 */
export function validateForwardItems(items, { maxItems = 20, maxChars = 500 } = {}) {
  if (!Array.isArray(items) || !items.length) return { ok: false, code: 'E_FORMAT', detail: 'items 必须是非空数组' }
  const out = []
  for (const it of items) {
    const text = String(it?.text ?? '').trim()
    if (!text) continue
    if ([...text].length > maxChars) return { ok: false, code: 'E_TOO_LONG', detail: `单条节点超过 ${maxChars} 字` }
    out.push({
      senderName: String(it?.senderName ?? '').trim().slice(0, 36),
      senderId: String(it?.senderId ?? '').replace(/\D/g, ''),
      text,
    })
    if (out.length >= maxItems) break
  }
  if (!out.length) return { ok: false, code: 'E_FORMAT', detail: 'items 里没有可发送的文本' }
  return { ok: true, items: out }
}

/** 表情回应：QQ 表情 id（数字串）或 emoji 名称，长度 1–16。 */
export function validateEmojiId(id) {
  const s = String(id ?? '').trim()
  if (!s) return { ok: false, code: 'E_FORMAT', detail: 'emojiId 必填' }
  if ([...s].length > 16) return { ok: false, code: 'E_FORMAT', detail: 'emojiId 太长' }
  return { ok: true, emojiId: s }
}

/**
 * 图片段：读本地文件 → `base64://`。
 * SnowLuma 跑在另一个容器/挂载里，看不到 proot 的 /tmp、/sdcard，`file://` 一律 ENOENT。
 */
export function buildImageSegments({ abs, caption = '', readFile = readFileSync } = {}) {
  const segs = []
  const text = String(caption ?? '').trim()
  if (text) segs.push({ type: 'text', data: { text } })
  const buf = readFile(abs)
  segs.push({ type: 'image', data: { file: `base64://${buf.toString('base64')}` } })
  return segs
}

export function validateAvatarPath(path, opts = {}) {
  return validateFilePath(path, { ...opts, exts: AVATAR_EXTS, maxBytes: opts.maxBytes ?? AVATAR_MAX_BYTES })
}

/** 头像：读本地文件 → base64（SnowLuma 的 file:// 是它的宿主路径，跨容器不可用）。 */
export function buildAvatarFile({ abs, readFile = readFileSync } = {}) {
  const buf = readFile(abs)
  return { file: `base64://${buf.toString('base64')}`, bytes: buf.length }
}

/** 脱敏：递归去掉 base64/超长字符串字段，只留状态类信息。 */
export function sanitizeResult(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 12)}…(${value.length} chars)` : value
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeResult(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (/base64|file/i.test(k) && typeof v === 'string' && v.length > 80) {
        out[k] = `[omitted ${v.length} chars]`
        continue
      }
      out[k] = sanitizeResult(v, depth + 1)
    }
    return out
  }
  return value
}

/** 语音段：读本地文件 → base64（SnowLuma 跨容器看不到本地文件）。 */
export function buildVoiceSegments({ abs, caption = '', readFile = readFileSync } = {}) {
  const segs = []
  const text = String(caption ?? '').trim()
  if (text) segs.push({ type: 'text', data: { text } })
  const buf = readFile(abs)
  segs.push({ type: 'record', data: { file: `base64://${buf.toString('base64')}` } })
  return segs
}

export function validateFaceId(id) {
  const n = Number(id)
  if (!Number.isInteger(n)) return { ok: false, code: 'E_FORMAT', detail: 'id 必须是整数' }
  if (n < FACE_MIN || n > FACE_MAX) return { ok: false, code: 'E_FORMAT', detail: `id 范围 ${FACE_MIN}–${FACE_MAX}` }
  return { ok: true, id: n }
}

/** 目标校验：私聊走 owner 白名单/最近联系人窗口；群聊必须是目录里的群。 */
export function validateTarget({ kind, contactId, ownerIds = [], contactOf = () => null, now = () => Date.now(), windowMs = 7 * 24 * 3600 * 1000 } = {}) {
  const k = kind === 'group' ? 'group' : 'private'
  const id = String(contactId ?? '')
  if (!/^\d+$/.test(id)) return { ok: false, code: 'E_NO_CONTACT', detail: 'contactId 必须是数字' }
  if (k === 'private') {
    if (ownerIds.map(String).includes(id)) return { ok: true, kind: k, contactId: id }
    const row = contactOf('qq', id, 'private')
    if (row && now() - Number(row.last_seen_at ?? 0) <= windowMs) return { ok: true, kind: k, contactId: id }
    return { ok: false, code: 'E_NO_CONTACT', detail: '不是主人，也不在最近联系人窗口内' }
  }
  const row = contactOf('qq', id, 'group')
  if (!row) return { ok: false, code: 'E_NO_CONTACT', detail: '群里没见过这个群' }
  return { ok: true, kind: k, contactId: id }
}

/** 简单限流：同一目标每 windowMs 只允许 1 次。 */
export function createRateLimiter({ windowMs = 5000, now = () => Date.now() } = {}) {
  const last = new Map()
  return {
    hit(key) {
      const t = now()
      const prev = last.get(key)
      if (prev !== undefined && t - prev < windowMs) return false
      last.set(key, t)
      return true
    },
  }
}

/** 资料改动计划：字段 → action/参数。 */
export function planProfile({ nickname, signature, sex } = {}) {
  const fields = []
  const calls = []
  const base = {}
  if (nickname !== undefined) {
    const nn = String(nickname).trim()
    if (!nn) return { ok: false, code: 'E_FORMAT', detail: 'nickname 不能为空' }
    if ([...nn].length > 36) return { ok: false, code: 'E_FORMAT', detail: 'nickname 太长（≤36 字）' }
    base.nickname = nn
    fields.push('nickname')
  }
  if (sex !== undefined) {
    const sx = Number(sex)
    if (![0, 1, 2].includes(sx)) return { ok: false, code: 'E_FORMAT', detail: 'sex 只能是 0/1/2' }
    base.sex = sx
    fields.push('sex')
  }
  if (Object.keys(base).length) calls.push({ action: 'set_qq_profile', params: base })
  if (signature !== undefined) {
    const sig = String(signature).trim()
    if ([...sig].length > 100) return { ok: false, code: 'E_FORMAT', detail: 'signature 太长（≤100 字）' }
    fields.push('signature')
    calls.push({ action: 'set_self_longnick', params: { long_nick: sig } })
  }
  return { ok: true, fields, calls }
}

/** 在线状态校验（SnowLuma 枚举 10/30/40/50/60/70）。 */
export function validateOnlineStatus(status) {
  const n = Number(status)
  if (![10, 30, 40, 50, 60, 70].includes(n)) return { ok: false, code: 'E_FORMAT', detail: 'status 只支持 10/30/40/50/60/70' }
  return { ok: true, status: n }
}
