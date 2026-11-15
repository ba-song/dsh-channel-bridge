/**
 * 合并转发（forward）读取 / 节点构造 / 渲染 —— 2026-11-16
 *
 * 背景：OneBot 的 forward 段只带 res_id（或 message_id），正文要另调
 * `get_forward_msg`。桥以前在 parse.js 里只渲染 `[转发]`，汐看不到转发内容。
 *
 * 这里补三件事：
 *   1. createForwardReader({getClient,...}).resolve({id, messageId})：反查节点；
 *   2. buildForwardNodes(items)：把 [{senderName,senderId,text}] 拼成发送用 node 段；
 *   3. formatForward(forward)：拼成一行可读文本，由 prompt 放进投递正文。
 *
 * 失败一律返回 null —— 只丢转发正文，不影响这条消息本身投递。
 * 段渲染自己实现（text/at/image/record/face/json/xml/forward…），
 * 不 import parse.js，避免 parse → forward → parse 的循环依赖。
 */
import { truncate } from './log.js'

/** 一条合并转发最多渲染多少字（防止长转发把上下文挤爆）。 */
export const FORWARD_TEXT_MAX = 600
/** 一条合并转发最多展示多少个节点（其余只报条数）。 */
export const FORWARD_NODES_MAX = 8

/** 非文本段 → 占位文本（与 parse.js/quote.js 的展示口径一致）。 */
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

/** 单个消息段 → 纯文本（不递归展开嵌套 forward/reply）。 */
export function renderForwardSegment(seg) {
  if (!seg || typeof seg !== 'object') return ''
  const type = String(seg.type ?? '')
  const data = seg.data ?? {}
  if (type === 'text') return String(data.text ?? '')
  if (type === 'at') return `@${data.qq ?? ''}`
  if (type === 'reply') return ''
  return placeholders[type] ?? `[${type || '未知'}]`
}

/** 段数组/字符串 → 纯文本。 */
export function renderForwardText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) parts.push(renderForwardSegment(seg))
  return parts.join('')
}

/** 秒/毫秒时间统一成毫秒；无有效时间返回 0（不编造当前时间）。 */
function toMillis(t) {
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? n * 1000 : n
}

/**
 * get_forward_msg 的一个节点 → 统一结构。
 * 兼容两种形态：
 *   - 消息事件：{ user_id, time, sender:{user_id,nickname,card}, message:[…] }
 *   - node 段：{ type:'node', data:{ uin/user_id, name/nickname, content:[…] } }
 */
function nodeFromItem(item) {
  if (!item || typeof item !== 'object') return { senderId: '', senderName: '', text: '', at: 0 }
  const data = item.type === 'node' && item.data && typeof item.data === 'object' ? item.data : item
  const sender = data.sender && typeof data.sender === 'object' ? data.sender : {}
  const senderId = String(sender.user_id ?? data.user_id ?? data.uin ?? '')
  const senderName = String(sender.card || sender.nickname || data.nickname || data.name || senderId || '')
  const content = data.message ?? data.content ?? data.raw_message ?? []
  return {
    senderId,
    senderName,
    text: renderForwardText(content).trim(),
    at: toMillis(data.time),
  }
}

/**
 * @param {{getClient?:()=>any, log?:any, timeoutMs?:number}} deps
 * @returns {{resolve:(opts?:{id?:string, messageId?:string|number})=>Promise<object|null>, stats:object}}
 */
export function createForwardReader({ getClient = () => null, log = null, timeoutMs = 3000 } = {}) {
  const stats = { ok: 0, fail: 0, noClient: 0, empty: 0 }

  async function resolve({ id = '', messageId = '' } = {}) {
    const rid = String(id ?? '').trim()
    const mid = String(messageId ?? '').trim()
    if (!rid && !mid) {
      stats.empty += 1
      return null
    }
    // 二选一：res_id 优先（它才是合并转发资源标识；message_id 是带转发的消息 id）
    const params = rid ? { id: rid } : { message_id: mid }
    const tag = rid ? `id=${rid}` : `message_id=${mid}`
    const client = getClient?.()
    if (!client || typeof client.call !== 'function') {
      stats.noClient += 1
      log?.warn?.(`[channel-bridge] 合并转发读取跳过（${tag}）：客户端未连接`)
      return null
    }
    try {
      const res = await client.call('get_forward_msg', params, { timeoutMs })
      if (res?.status !== 'ok' || res?.retcode !== 0) {
        stats.fail += 1
        // 只带 id / status / retcode，不打印转发正文
        log?.warn?.(`[channel-bridge] 合并转发读取失败（${tag}）：status=${res?.status ?? '?'} retcode=${res?.retcode ?? '?'}`)
        return null
      }
      const messages = res?.data?.messages ?? res?.data?.message ?? res?.data?.nodes
      if (!Array.isArray(messages) || messages.length === 0) {
        stats.empty += 1
        log?.warn?.(`[channel-bridge] 合并转发读取为空（${tag}）`)
        return null
      }
      const nodes = messages.map(nodeFromItem)
      const forward = {
        id: rid || mid,
        nodes,
        text: formatForward({ nodes }),
      }
      stats.ok += 1
      return forward
    } catch (error) {
      stats.fail += 1
      log?.warn?.(`[channel-bridge] 合并转发读取失败（${tag}）：${error?.code ?? error?.message ?? error}`)
      return null
    }
  }

  return { resolve, stats }
}

/**
 * 转发节点构造（发送用，OneBot v11 node 段）。
 * items: [{ senderName='', senderId='', text='' }]
 * → [{ type:'node', data:{ name, uin, content:[{type:'text',data:{text}}] } }]
 * 空/纯空白文本的节点直接丢弃。
 */
export function buildForwardNodes(items) {
  if (!Array.isArray(items)) return []
  const nodes = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const text = String(item.text ?? '').trim()
    if (!text) continue
    const uin = String(item.senderId ?? '').trim()
    const name = String(item.senderName ?? '').trim() || uin
    nodes.push({
      type: 'node',
      data: { name, uin, content: [{ type: 'text', data: { text } }] },
    })
  }
  return nodes
}

/**
 * 渲染成可读文本，供 prompt 使用。
 * '[合并转发 3 条] 1. 甲：… 2. 乙：…'；无节点 → '[合并转发]'。
 * 超过 maxNodes 只展示前 maxNodes 条并注明剩余条数；整行按 maxChars 截断。
 */
export function formatForward(forward, { maxNodes = FORWARD_NODES_MAX, maxChars = FORWARD_TEXT_MAX } = {}) {
  const nodes = Array.isArray(forward?.nodes) ? forward.nodes : []
  if (!nodes.length) return '[合并转发]'
  const total = nodes.length
  const keep = Math.max(0, Math.floor(Number(maxNodes)))
  const shown = Number.isFinite(keep) && keep > 0 ? nodes.slice(0, keep) : []
  const lines = shown.map((node, index) => {
    const who = String(node?.senderName || node?.senderId || '未知')
    const text = String(node?.text ?? '').trim() || '[空消息]'
    return `${index + 1}. ${who}：${text}`
  })
  if (total > shown.length) lines.push(`…（还有 ${total - shown.length} 条）`)
  const header = `[合并转发 ${total} 条]`
  return truncate(lines.length ? `${header} ${lines.join(' ')}` : header, maxChars)
}
