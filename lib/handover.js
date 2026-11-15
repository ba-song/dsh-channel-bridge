/**
 * 一次性交接：从旧 QQ 会话档案里取「since 之后」的 user/assistant 消息，
 * 按时间拼成 `HH:MM [主人/汐] 文本`，≤maxChars，作为第一次 dyHome.deliver 的 handoverText。
 * 只传一次：成功后写 `bridge_meta.handover.done`。
 */
import { readSessionEvents } from './session-archive.js'

const pad = (n) => String(n).padStart(2, '0')

export function hhmm(ms, tzOffsetMinutes = 480) {
  const d = new Date(Number(ms) + Number(tzOffsetMinutes) * 60000)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function textOf(ev) {
  const msg = ev.type === 'user/message' ? ev.data : ev.data?.message
  const content = Array.isArray(msg?.content) ? msg.content : []
  return content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('').trim()
}

/** 去掉投递时加的外壳：`[QQ·…]` 人物头、`[补收·HH:MM]` 前缀、尾部 `【这个房间的规矩】` 规则块。 */
export function cleanHandoverText(text) {
  let t = String(text ?? '').replace(/\r/g, '')
  t = t.replace(/^\[QQ·[^\]]*\]\s*/, '')
  t = t.replace(/^\[补收·\d{2}:\d{2}\]\s*/, '')
  const idx = t.indexOf('【这个房间的规矩】')
  if (idx >= 0) t = t.slice(0, idx)
  return t.trim()
}

/** 她的 assistant 正文里常见的包装/总结，交接时不要。 */
export function isAssistantWrapper(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (t === '[SILENT]') return true
  if (t.startsWith('已回复对方')) return true
  if (t.includes('【这个房间的规矩】')) return true
  return false
}

/** tool/call 的 dy_say 参数 → 实际发出去的文本（按行拆条）。 */
export function dySayTexts(ev) {
  const name = String(ev?.data?.name ?? '')
  if (name !== 'dy_say' && name !== 'dy_voice') return []
  let args = ev?.data?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return []
    }
  }
  const text = args?.text
  if (typeof text !== 'string' || !text.trim()) return []
  if (text.trim() === '[SILENT]') return [] // 没发出去
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/\r?\n/g, ' '))
}

/** 档案事件 → 归一化条目（只收真实对话；她的发言优先取 dy_say 原文）。 */
export function collectArchiveItems(events = [], { sinceMs = 0 } = {}) {
  const items = []
  let hadDySaySinceAssistant = false // 本轮已有 dy_say → 跳过紧随其后的 assistant 总结
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const at = Number(ev.time ?? 0)
    if (!Number.isFinite(at) || at < sinceMs) continue

    if (ev.type === 'user/message') {
      const sourceKind = String(ev.data?.source?.kind ?? '')
      if (sourceKind !== 'user' && sourceKind !== 'channel-inbound') continue
      const text = cleanHandoverText(textOf(ev))
      if (!text || text === '[SILENT]') continue
      items.push({ at, role: 'user', text: text.replace(/\r?\n/g, ' '), messageId: String(ev.data?.id ?? '') })
      hadDySaySinceAssistant = false
      continue
    }

    if (ev.type === 'tool/call') {
      const texts = dySayTexts(ev)
      if (!texts.length) continue
      for (const t of texts) items.push({ at, role: 'assistant', text: t, messageId: '' })
      hadDySaySinceAssistant = true
      continue
    }

    if (ev.type === 'assistant/message') {
      const raw = textOf(ev)
      // 有 dy_say 就以 dy_say 原文为准，正文多半是「已回复对方：…」这类总结
      if (hadDySaySinceAssistant) {
        hadDySaySinceAssistant = false
        continue
      }
      if (isAssistantWrapper(raw)) continue
      const text = cleanHandoverText(raw)
      if (!text || text === '[SILENT]' || isAssistantWrapper(text)) continue
      items.push({ at, role: 'assistant', text: text.replace(/\r?\n/g, ' '), messageId: String(ev.data?.message?.id ?? '') })
    }
  }
  // 相邻重复去重（同文本连续出现只留一条）
  const out = []
  for (const item of items) {
    const prev = out[out.length - 1]
    if (prev && prev.text === item.text) continue // 同文本连续出现只留一条（不分角色）
    out.push(item)
  }
  return out
}

/** bridge.db 入站行 → 归一化条目（她的回复不在事件表里，只有主人侧）。 */
export function collectDbItems(rows = [], { sinceMs = 0 } = {}) {
  const items = []
  for (const row of rows) {
    const at = Number(row?.at ?? 0)
    if (!Number.isFinite(at) || at < sinceMs) continue
    const text = String(row?.text ?? '').trim()
    if (!text) continue
    items.push({ at, role: 'user', text: text.replace(/\r?\n/g, ' '), messageId: String(row?.message_id ?? '') })
  }
  return items
}

/** 两源合并：按时间排序 + message_id/(at,text) 去重。 */
export function mergeHandoverItems(archiveItems = [], dbItems = []) {
  // 两道键：message_id（同源重复）与 (at,text)（跨源重复——档案的消息 id 与 QQ message_id 不是一套）
  const seenIds = new Set()
  const seenText = new Set()
  const out = []
  for (const item of [...archiveItems, ...dbItems].sort((a, b) => a.at - b.at)) {
    const textKey = `t:${item.at}|${item.text}`
    const idKey = item.messageId ? `m:${item.messageId}` : ''
    if (seenText.has(textKey) || (idKey && seenIds.has(idKey))) continue
    seenText.add(textKey)
    if (idKey) seenIds.add(idKey)
    out.push(item)
  }
  return out
}

/** 纯函数：条目 → 交接文本（HH:MM [主人/汐] 文本，≤maxChars，从最旧丢）。 */
export function formatHandover(items = [], { maxChars = 20000, tzOffsetMinutes = 480 } = {}) {
  let lines = items.map((i) => `${hhmm(i.at, tzOffsetMinutes)} [${i.role === 'user' ? '主人' : '汐'}] ${i.text}`)
  let body = lines.join('\n')
  while ([...body].length > maxChars && lines.length > 1) {
    lines = lines.slice(1)
    body = lines.join('\n')
  }
  return [...body].length > maxChars ? [...body].slice(0, maxChars).join('') : body
}

/** 兼容旧签名：只用档案事件生成交接文本。 */
export function buildHandoverText(events = [], opts = {}) {
  const items = collectArchiveItems(events, opts)
  return formatHandover(items, opts)
}

export function createHandover({ cfg = {}, store = null, log = null, readEvents = readSessionEvents, readInbound = null, now = () => Date.now() } = {}) {
  const h = { enabled: true, channel: 'qq', sessionId: '', since: '2026-11-05T16:50:00+08:00', maxChars: 20000, sessionsRoot: '/root/.dsh/sessions', tzOffsetMinutes: 480, ...(cfg.handover ?? {}) }
  const stats = { built: 0, chars: 0, done: false, error: null }
  let cached = null

  function alreadyDone() {
    try {
      return Boolean(store?.getMeta?.('handover.done'))
    } catch {
      return false
    }
  }

  return {
    stats,
    alreadyDone,
    /** 取一次交接文本（未完成时才有内容；不标记完成）。 */
    take() {
      if (!h.enabled || alreadyDone()) return ''
      if (cached !== null) return cached
      const sinceMs = Date.parse(h.since)
      if (!Number.isFinite(sinceMs)) {
        stats.error = `since 解析失败：${h.since}`
        cached = ''
        return ''
      }
      try {
        const events = readEvents({ sessionsRoot: h.sessionsRoot, sessionId: h.sessionId, log })
        const archiveItems = collectArchiveItems(events, { sinceMs })
        let rows = []
        try {
          const reader = readInbound ?? ((args) => store?.listInboundSince?.(args) ?? [])
          rows = reader({ channel: h.channel, sinceMs }) ?? []
        } catch {}
        const dbItems = collectDbItems(rows, { sinceMs })
        const merged = mergeHandoverItems(archiveItems, dbItems)
        cached = formatHandover(merged, { maxChars: h.maxChars, tzOffsetMinutes: h.tzOffsetMinutes })
        stats.built += 1
        stats.chars = [...cached].length
        stats.sources = { archive: archiveItems.length, db: dbItems.length, merged: merged.length }
        log?.info?.(
          `[channel-bridge] 交接文本：${stats.chars} 字（档案 ${archiveItems.length} + 事件表 ${dbItems.length} → 去重后 ${merged.length}；since ${h.since}）`,
        )
      } catch (error) {
        stats.error = error?.message ?? String(error)
        log?.warn?.(`[channel-bridge] 交接文本生成失败：${stats.error}`)
        cached = ''
      }
      return cached
    },
    /** 确认已在第一次 deliver 里送出去。 */
    markDone() {
      stats.done = true
      try {
        store?.setMeta?.('handover.done', new Date(now()).toISOString())
      } catch {}
    },
  }
}
