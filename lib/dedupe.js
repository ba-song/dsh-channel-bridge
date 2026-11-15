/** 去重：`message_type|group_id|message_id`，有上限（默认 2000，超了淘汰最旧）。
 *  没有 message_id 时**不吞消息**（返回 null，调用方不参与去重）。
 */

export function dedupeKey(evt) {
  const mid = evt?.message_id
  if (mid === undefined || mid === null || String(mid) === '') return null
  const type = String(evt?.message_type ?? '')
  const group = evt?.group_id === undefined || evt?.group_id === null ? '0' : String(evt.group_id)
  return `${type}|${group}|${String(mid)}`
}

export function createDedupe({ max = 2000 } = {}) {
  const limit = Math.max(1, Number(max) || 2000)
  const seenSet = new Set()
  const order = []
  return {
    /** true = 已经见过（本次不入）；false = 第一次见（已记录）。 */
    seen(key) {
      if (!key) return false
      if (seenSet.has(key)) return true
      seenSet.add(key)
      order.push(key)
      if (order.length > limit) {
        const oldest = order.shift()
        seenSet.delete(oldest)
      }
      return false
    },
    get size() {
      return seenSet.size
    },
    has(key) {
      return seenSet.has(key)
    },
    clear() {
      seenSet.clear()
      order.length = 0
    },
  }
}

/**
 * 入站闸：内存去重（同进程快速路径）+ 库去重（跨重启/补收后重放）。
 * 返回 {ok:true} 才允许落库与投递。
 */
export function createInboundGate({ store = null, dedupe = null } = {}) {
  return {
    accept(evt, parsed) {
      const key = dedupeKey(evt)
      if (dedupe && dedupe.seen(key)) return { ok: false, reason: 'dup-mem' }
      const mid = parsed?.messageId
      if (mid && store && typeof store.hasMessageId === 'function' && store.hasMessageId(mid)) {
        return { ok: false, reason: 'dup-db' }
      }
      return { ok: true }
    },
  }
}
