/**
 * 短窗回声去重：同 contact + 相同文本 + ≤3 秒 → 判为 SL 回声，不投。
 * SL 偶尔会把同一条消息推两遍（message_id 不同），超过窗口则认为是主人真的重复发。
 */
export function createEchoGuard({ windowMs = 3000, now = () => Date.now(), max = 500 } = {}) {
  const seen = new Map() // key -> lastAt
  const stats = { skipped: 0, seen: 0 }

  const keyOf = (p) => `${p?.channel ?? 'qq'}|${p?.kind ?? 'private'}|${p?.contactId ?? ''}|${p?.text ?? ''}`

  /** true = 命中回声，应跳过（并已刷新时间）；false = 正常，记录后放行。 */
  function isEcho(parsed) {
    const key = keyOf(parsed)
    const t = now()
    const last = seen.get(key)
    if (last !== undefined && t - last >= 0 && t - last <= windowMs) {
      stats.skipped += 1
      seen.set(key, t) // 连发也按最近一次算，避免回声拖长窗口
      return true
    }
    stats.seen += 1
    seen.set(key, t)
    if (seen.size > max) {
      const oldest = seen.keys().next().value
      seen.delete(oldest)
    }
    return false
  }

  return { isEcho, stats, windowMs, _seen: seen }
}
