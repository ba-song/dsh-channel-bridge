/**
 * 引用（reply）消息富化 —— 2026-11-16
 *
 * 背景：OneBot 的 reply 段只带被引用消息的 message_id，正文里没有原文
 * （OneBot 规范如此；SnowLuma 的 toSegment 也只输出 `{type:'reply',data:{id}}`）。
 * 桥以前在 parse.js 里直接 `continue` 丢掉这个段，所以汐永远读不到「在回哪一句」。
 *
 * 这里补两件事：
 *   1. resolve(replyId)：调 SnowLuma 的 `get_msg` 反查发送者与正文，返回结构化 quote；
 *   2. formatQuote(quote)：拼成一行 `[引用 某某：原文…]`，由 prompt.js 放进投递正文。
 *
 * 失败一律返回 null —— 只丢引用，不影响这条消息本身投递。
 */
import { truncate } from './log.js'
import { faceText, mfaceText } from './face.js'

/** 被引用消息渲染成纯文本时最多保留多少字（防止一条长文把上下文挤爆）。 */
export const QUOTE_TEXT_MAX = 300
/** 拼进正文时的展示上限。 */
export const QUOTE_DISPLAY_MAX = 60

/** 被引用消息 → 纯文本（不落盘、不递归展开嵌套 reply）。 */
export function renderQuoteText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const type = String(seg.type ?? '')
    const data = seg.data ?? {}
    if (type === 'text') parts.push(String(data.text ?? ''))
    else if (type === 'at') parts.push(`@${data.qq ?? ''}`)
    else if (type === 'face') parts.push(faceText(data.id))
    else if (type === 'mface') parts.push(mfaceText(data))
    else if (type === 'reply') continue
    else if (type === 'image') parts.push('[图片]')
    else if (type === 'record') parts.push('[语音]')
    else if (type === 'video') parts.push('[视频]')
    else if (type === 'file') parts.push('[文件]')
    else if (type === 'json' || type === 'xml') parts.push('[卡片]')
    else if (type === 'forward') parts.push('[转发]')
    else parts.push(`[${type || '未知'}]`)
  }
  return parts.join('')
}

/** 正文里的展示行：`[引用 霸宋：原来的话…]`。没有内容返回 ''。 */
export function formatQuote(quote, { maxChars = QUOTE_DISPLAY_MAX } = {}) {
  if (!quote || !quote.text) return ''
  const who = String(quote.senderName || quote.senderId || '对方')
  return `[引用 ${who}：${truncate(quote.text, maxChars)}]`
}

function toMessageId(id) {
  const s = String(id ?? '').trim()
  return /^-?\d+$/.test(s) ? Number(s) : s
}

/**
 * @param {{getClient?:()=>any, log?:any, timeoutMs?:number, maxChars?:number}} deps
 * @returns {{resolve:(replyId:string, opts?:{selfId?:string})=>Promise<object|null>, stats:object}}
 */
export function createQuoteResolver({ getClient = () => null, log = null, timeoutMs = 3000, maxChars = QUOTE_TEXT_MAX } = {}) {
  const stats = { ok: 0, fail: 0, noClient: 0, empty: 0 }

  async function resolve(replyId, { selfId = '' } = {}) {
    const id = String(replyId ?? '').trim()
    if (!id) {
      stats.empty += 1
      return null
    }
    const client = getClient?.()
    if (!client || typeof client.call !== 'function') {
      stats.noClient += 1
      return null
    }
    try {
      const res = await client.call('get_msg', { message_id: toMessageId(id) }, { timeoutMs })
      const d = res?.data
      if (!d) {
        stats.fail += 1
        return null
      }
      const sender = d.sender ?? {}
      const rawText = renderQuoteText(d.message ?? d.raw_message ?? '')
      const senderId = String(d.user_id ?? sender.user_id ?? '')
      let senderName = String(sender.card || sender.nickname || senderId || '')
      if (!senderName && selfId && senderId === String(selfId)) senderName = '你'
      const quote = {
        messageId: String(d.message_id ?? d.real_id ?? id),
        senderId,
        senderName,
        text: truncate(rawText.trim() || '[非文本消息]', maxChars),
        at: Number(d.time) > 0 ? (Number(d.time) < 1e12 ? Number(d.time) * 1000 : Number(d.time)) : 0,
      }
      stats.ok += 1
      return quote
    } catch (error) {
      stats.fail += 1
      log?.warn?.(`[channel-bridge] 引用消息反查失败（message_id=${id}）：${error?.code ?? error?.message ?? error}`)
      return null
    }
  }

  return { resolve, stats }
}
