/**
 * OneBot 事件 → 统一入站结构。
 *
 * 只认 `post_type === 'message'`（private/group）；`message_sent`、meta_event、notice 一律 null。
 * 自己发的（user_id === self_id）也 null。
 */

import { faceText, mfaceText } from './face.js'

export const SILENT_MARKER = '[SILENT]'

/** 字符串消息里的 [CQ:at,qq=123] 兜底。 */
export function cqMentions(text) {
  const out = []
  const re = /\[CQ:at,qq=(\d+)\]/g
  let m
  while ((m = re.exec(String(text ?? '')))) {
    if (m[1] && m[1] !== 'all' && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * 取 reply（引用）段里的被引用 message_id（2026-11-16）。
 *
 * OneBot 的 reply 段只有 id，没有原文：OneBot 规范如此，SnowLuma 也如此
 * （bundle 里 toSegment 输出 `{type:'reply',data:{id}}`）。原文要另调 get_msg 反查，
 * 见 quote.js；这里只负责把 id 留下来，别再像以前那样直接 continue 扔掉。
 */
export function extractReplyId(message) {
  if (typeof message === 'string') {
    const m = /\[CQ:reply,[^\]]*\bid=([^,\]]+)/.exec(message)
    return m ? String(m[1]).trim() : ''
  }
  if (!Array.isArray(message)) return ''
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    if (String(seg.type ?? '') !== 'reply') continue
    const id = seg.data?.id
    if (id !== undefined && id !== null && String(id).trim()) return String(id).trim()
  }
  return ''
}

const placeholders = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  face: '[表情]',
  mface: '[表情]',
  json: '[卡片]',
  xml: '[卡片]',
  forward: '[转发]',
}

/** 段数组 → 纯文本（保留占位；@ 变成 @qq）。 */
export function renderSegments(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const type = String(seg.type ?? '')
    const data = seg.data ?? {}
    if (type === 'text') parts.push(String(data.text ?? ''))
    else if (type === 'at') parts.push(`@${data.qq ?? ''}`)
    else if (type === 'reply') continue
    else if (type === 'face') parts.push(faceText(data.id))
    else if (type === 'mface') parts.push(mfaceText(data))
    else parts.push(placeholders[type] ?? `[${type || '未知'}]`)
  }
  return parts.join('')
}

/**
 * 段数组 → { text, media }：image/file 收进 media，正文里不再留占位（由 media.js 决定落盘或占位）。
 * 其它段（文字/@/语音/表情…）行为与 renderSegments 一致。
 */
export function splitSegments(message) {
  const replyId = extractReplyId(message)
  if (typeof message === 'string') {
    return { text: message, media: [], mentions: cqMentions(message), replyId }
  }
  if (!Array.isArray(message)) return { text: '', media: [], mentions: [], replyId }
  const parts = []
  const media = []
  const mentions = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const type = String(seg.type ?? '')
    const data = seg.data ?? {}
    if (type === 'text') parts.push(String(data.text ?? ''))
    else if (type === 'at') {
      const qq = String(data.qq ?? '')
      if (qq && qq !== 'all' && !mentions.includes(qq)) mentions.push(qq)
      parts.push(`@${qq}`)
    }
    else if (type === 'reply') continue
    else if (type === 'image') media.push({ kind: 'image', url: String(data.url ?? ''), file: String(data.file ?? ''), name: String(data.filename ?? data.name ?? '') })
    else if (type === 'file') media.push({ kind: 'file', url: String(data.url ?? ''), file: String(data.file ?? ''), name: String(data.name ?? data.filename ?? '') })
    else if (type === 'record') media.push({ kind: 'voice', url: String(data.url ?? ''), file: String(data.file ?? ''), name: String(data.name ?? '') })
    else if (type === 'face') parts.push(faceText(data.id))
    else if (type === 'mface') {
      // 表情包：有图就落盘给她看（read_image），同时留个名字方便描述
      const url = String(data.url ?? data.icon ?? '')
      if (url) media.push({ kind: 'image', url, file: '', name: String(data.summary ?? '表情包') })
      parts.push(mfaceText(data))
    }
    else parts.push(placeholders[type] ?? `[${type || '未知'}]`)
  }
  if (!mentions.length) {
    for (const qq of cqMentions(parts.join(''))) if (!mentions.includes(qq)) mentions.push(qq)
  }
  return { text: parts.join(''), media, mentions, replyId }
}

/** 秒/毫秒时间统一成毫秒。 */
export function toMillis(t) {
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < 1e12 ? n * 1000 : n
}

/**
 * @param {object} evt OneBot 事件
 * @param {{selfId?:string, owner?:{qqIds?:string[]}, channel?:string, now?:()=>number}} cfg
 * @returns {null | {channel,kind,contactId,contactName,senderId,senderName,text,at,isOwner,messageId}}
 */
export function parseMessageEvent(evt, cfg = {}) {
  if (!evt || typeof evt !== 'object') return null
  if (String(evt.post_type ?? '') !== 'message') return null
  const type = String(evt.message_type ?? '')
  if (type !== 'private' && type !== 'group') return null

  const selfId = String(evt.self_id ?? cfg.selfId ?? '')
  const senderId = evt.user_id === undefined || evt.user_id === null ? '' : String(evt.user_id)
  if (selfId && senderId && senderId === selfId) return null

  const sender = evt.sender ?? {}
  const senderName = String(sender.card || sender.nickname || senderId || '')
  const ownerIds = (cfg.owner?.qqIds ?? []).map((x) => String(x))
  const at = toMillis(evt.time ?? (cfg.now ? cfg.now() : Date.now()))

  const body = splitSegments(evt.message ?? evt.raw_message ?? '')

  if (type === 'private') {
    if (!senderId) return null
    return {
      channel: String(cfg.channel ?? 'qq'),
      kind: 'private',
      contactId: senderId,
      contactName: senderName || senderId,
      senderId,
      senderName: senderName || senderId,
      text: body.text,
      media: body.media,
      mentions: body.mentions ?? [],
      replyId: body.replyId || '',
      at,
      isOwner: ownerIds.includes(senderId),
      messageId: evt.message_id === undefined || evt.message_id === null ? '' : String(evt.message_id),
    }
  }

  const groupId = evt.group_id === undefined || evt.group_id === null ? '' : String(evt.group_id)
  if (!groupId) return null
  const groupName = String(evt.group_name ?? '')
  return {
    channel: String(cfg.channel ?? 'qq'),
    kind: 'group',
    contactId: groupId,
    contactName: groupName || `群_${groupId}`,
    senderId,
    senderName: senderName || senderId,
    text: body.text,
    media: body.media,
    mentions: body.mentions ?? [],
    replyId: body.replyId || '',
    at,
    isOwner: ownerIds.includes(senderId),
    messageId: evt.message_id === undefined || evt.message_id === null ? '' : String(evt.message_id),
  }
}
