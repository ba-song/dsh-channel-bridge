/**
 * 发送前清洗（2026-11-12 P0，参考 AstrBot 五层规格 §4）
 * 只做保守、可解释的清洗：客服腔开头、短句句号、多余空行、markdown 粗体。
 * 不改语气词、不改用词、不重写句子。
 */
const CUSTOMER_OPEN = /^(好的|好呀|好嘞|我明白了|明白了|收到|以下是|希望(这些|这个|对你)|有什么(可以|能)帮|感谢(您|你)的)/

export function cleanOutgoing(raw, { enabled = true } = {}) {
  const before = String(raw ?? '')
  if (!enabled) return { text: before, changed: false, notes: [] }
  const notes = []
  let s = before.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (s !== before.trim()) notes.push('空白')

  // 客服腔开头：只在第一行且很短时去掉（“好的，我明白了”这种）
  const m = s.match(CUSTOMER_OPEN)
  if (m) {
    const lineEnd = s.indexOf('\n')
    const first = lineEnd >= 0 ? s.slice(0, lineEnd) : s
    if (first.length <= 18) {
      s = (lineEnd >= 0 ? s.slice(lineEnd + 1) : '').trim()
      notes.push('客服腔开头')
      if (!s) s = '' // 整句都是客服腔：交给上层决定是否发
    }
  }
  // 短句句尾句号：整段 ≤15 字、只有一个句尾“。”时去掉
  if (s.length <= 15 && /[^。！？!?…]$/.test(s) === false && s.endsWith('。') && (s.match(/。/g) || []).length === 1) {
    s = s.slice(0, -1)
    notes.push('短句句号')
  }
  // markdown 粗体/行内代码：聊天里不显示
  if (/\*\*|`/.test(s)) { s = s.replace(/\*\*/g, '').replace(/`/g, ''); notes.push('markdown') }
  s = s.trim()
  return { text: s, changed: s !== before, notes }
}
