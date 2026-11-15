/**
 * home→群 的公开近况：只读 `dyMemory.publicBrief({limit:3})`。
 * 纯公开层；不读 owner/contact 记忆，失败/空返回空串（不阻断投递）。
 */
export function formatPublicBrief(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    const lines = value
      .map((x) => (typeof x === 'string' ? x : String(x?.text ?? x?.content ?? '')))
      .map((x) => x.trim())
      .filter(Boolean)
    return lines.length ? lines.join('\n') : ''
  }
  if (typeof value === 'object') {
    const text = value.text ?? value.brief ?? value.content
    if (text !== undefined) return formatPublicBrief(text)
  }
  return ''
}

export async function fetchPublicBrief({ getMemory = () => null, limit = 3, log = null } = {}) {
  const memory = getMemory?.()
  if (!memory || typeof memory.publicBrief !== 'function') return ''
  try {
    const value = await memory.publicBrief({ limit })
    const text = formatPublicBrief(value)
    if (!text) return ''
    return `[汐的近况]\n${text}`
  } catch (error) {
    log?.warn?.(`[channel-bridge] publicBrief 失败（群内不加近况）：${error?.message ?? error}`)
    return ''
  }
}
