/**
 * 出站切分（dy_say / auto 共用）：
 * - 优先在句末标点（。！？!?；;）后切，其次逗号/顿号/冒号；
 * - 超长再硬切，但**绝不在标点前切**（切点紧邻标点时把标点并入前一段）；
 * - 纯标点段不单独成条（并回前一段；首段则并入后一段）；
 * - 相邻段能并到 maxLen 就并；段数超限时最后一段吸收剩余（不丢字）。
 */

const SENT_END = '。！？!?；;'
const CLAUSE = '，,、；;：:'
const PUNCT = /[。！？!?；;，,、…：:]/

const len = (s) => [...s].length

/** 硬切：按 maxLen 等分，再把「开头是标点」的段并回前一段。 */
function hardCut(s, maxLen) {
  const chars = [...s]
  const chunks = []
  for (let i = 0; i < chars.length; i += maxLen) chunks.push(chars.slice(i, i + maxLen).join(''))
  const out = []
  for (const c of chunks) {
    if (!out.length) {
      out.push(c)
      continue
    }
    const m = c.match(PUNCT) && c.match(new RegExp(`^[${SENT_END}${CLAUSE}…]+`))
    if (m) {
      out[out.length - 1] += m[0]
      const rest = c.slice(m[0].length)
      if (rest) out.push(rest)
    } else out.push(c)
  }
  return out
}

/** 单句拆成 <=maxLen 的块（句末标点 → 逗号 → 硬切）。 */
function splitSentence(sentence, maxLen) {
  const parts = []
  for (const sentencePart of sentence.split(new RegExp(`(?<=[${SENT_END}])`))) {
    if (!sentencePart) continue
    if (len(sentencePart) <= maxLen) {
      parts.push(sentencePart)
      continue
    }
    for (const clause of sentencePart.split(new RegExp(`(?<=[${CLAUSE}])`))) {
      if (!clause) continue
      if (len(clause) <= maxLen) parts.push(clause)
      else parts.push(...hardCut(clause, maxLen))
    }
  }
  return parts
}

const isPurePunct = (s) => {
  const t = s.trim()
  return t.length > 0 && [...t].every((c) => PUNCT.test(c) || /\s/.test(c))
}

export function splitForSend(text, { maxLen = 60, maxSegments = 4 } = {}) {
  const raw = String(text ?? '').replace(/\r/g, '').trim()
  if (!raw) return []

  // 换行也算断句边界
  const pieces = []
  for (const line of raw.split(/\n+/)) {
    const t = line.trim()
    if (t) pieces.push(t)
  }

  // 1) 句/逗号/硬切
  const chunks = []
  for (const piece of pieces) chunks.push(...splitSentence(piece, maxLen))

  // 2) 纯标点段并回前一段（首段并入后一段）
  const cleaned = []
  let carry = ''
  for (const c of chunks) {
    if (isPurePunct(c)) {
      if (cleaned.length) cleaned[cleaned.length - 1] += c
      else carry += c
      continue
    }
    cleaned.push(carry + c)
    carry = ''
  }
  if (carry) {
    if (cleaned.length) cleaned[cleaned.length - 1] += carry
    else cleaned.push(carry)
  }

  // 3) 相邻段能并就并（<=maxLen）
  const segs = []
  for (const c of cleaned) {
    const last = segs[segs.length - 1]
    if (last !== undefined && len(last) + len(c) <= maxLen) segs[segs.length - 1] = last + c
    else segs.push(c)
  }

  // 4) 段数超限：末段吸收剩余（不丢字）
  if (segs.length <= maxSegments) return segs
  return [...segs.slice(0, maxSegments - 1), segs.slice(maxSegments - 1).join('')]
}

export function joinParts(parts) {
  return parts.join('')
}
