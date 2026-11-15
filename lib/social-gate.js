/** 群社交发送闸（2026-11-13）：把“这轮最多几条”落到 dy_say 层，默认不启用。 */
export function createSocialGate({ now = () => Date.now(), ttlMs = 5 * 60 * 1000 } = {}) {
  const map = new Map()
  const keyOf = (kind, contactId) => `${kind}:${contactId}`
  return {
    arm({ kind = 'group', contactId = '', max = 1, quote = false, close = false } = {}) {
      map.set(keyOf(kind, contactId), { max: Math.max(1, Number(max) || 1), used: 0, quote, close, at: now() })
    },
    take({ kind = 'group', contactId = '' } = {}) {
      const key = keyOf(kind, contactId)
      const p = map.get(key)
      if (!p || now() - p.at > ttlMs) return { ok: true, remaining: null, gated: false }
      if (p.used >= p.max) return { ok: false, remaining: 0, gated: true, quote: p.quote, close: p.close }
      p.used += 1
      return { ok: true, remaining: Math.max(0, p.max - p.used), gated: true, quote: p.quote, close: p.close }
    },
    snapshot() { return [...map.entries()].map(([k, v]) => ({ key: k, ...v, left: Math.max(0, v.max - v.used) })) },
  }
}
