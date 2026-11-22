/**
 * 新会话上下文（P4-lite 第 3 项，可选）：
 * 首次投递到新会话时，用 `channel_events` 最近 N 条入站拼一句「上次在 QQ 房间里聊到：…」，≤300 字。
 * 只读、不写库；拿不到就返回空串（投递照常）。
 */
import { truncate } from './log.js'

export function buildSessionContext({ store, cfg, conversation } = {}) {
  const c = { enabled: true, limit: 10, maxChars: 300, timeZoneOffsetMinutes: 480, ...(cfg?.context ?? {}) }
  if (c.enabled === false) return ''

  // Fail closed: no context is assembled without an explicit current conversation scope.
  const channel = String(conversation?.channel ?? '').trim()
  const kind = String(conversation?.kind ?? '').trim()
  const contact = String(conversation?.contact ?? '').trim()
  if (!channel || !['private', 'group'].includes(kind) || !contact) return ''

  let rows = []
  try {
    rows = store?.recentInboundAsc?.({ channel, kind, contact, limit: c.limit }) ?? []
  } catch {
    return ''
  }
  if (!rows.length) return ''

  const lines = []
  for (const row of rows) {
    const text = String(row?.text ?? '').trim()
    if (!text) continue
    const hhmm = new Date(Number(row.at || 0) + Number(c.timeZoneOffsetMinutes) * 60000).toISOString().slice(11, 16)
    const who = String(row.contact ?? '')
    lines.push(`${hhmm} ${who}：${truncate(text.replace(/\n/g, ' '), 60)}`)
  }
  if (!lines.length) return ''

  let body = ''
  for (const line of lines) {
    if ([...body].length + [...line].length + 1 > c.maxChars) break
    body += (body ? '\n' : '') + line
  }
  if (!body) return ''
  return `（上次在 QQ 房间里聊到：\n${body}\n——接上就行，不用回这段。）`
}
