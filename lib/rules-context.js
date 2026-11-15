/**
 * 房间规矩 → systemPrompt 常驻上下文（2026-11-12）
 *
 * 目的：规则不必每条消息重复（省上下文），又不会因上下文变长被忘掉。
 * 每个 agent 只挂一次；挂不上（老宿主/测试 fake agent）时由调用方回退到消息内规则。
 */
const mounted = new WeakSet()

export function mountRoomRules(agent, text, { name = 'dy-room-rules', order = 965 } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return false
  try {
    if (mounted.has(agent)) return 'already'
    const sp = agent?.ctx?.systemPrompt
    if (!sp || typeof sp.context !== 'function') return false
    sp.context({ name, order, interpolate: false, text: () => body })
    mounted.add(agent)
    return 'new'
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (msg.includes('already registered')) { mounted.add(agent); return 'already' }
    return false
  }
}
