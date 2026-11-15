/**
 * 群消息门禁：默认只有 @ 了机器人才回。
 * - 只认真正的 at 段（parse 收集到 parsed.mentions）；
 * - mentionNames 只是兜底（文字里出现 @昵称），默认不配；
 * - selfId 缺失时保守不投，并让调用方 warn。
 */
export function shouldDeliverGroup(parsed, { requireMention = true, selfId = '', mentionNames = [] } = {}) {
  if (parsed?.kind !== 'group') return { ok: true, reason: 'not-group' }
  if (requireMention === false) return { ok: true, reason: 'disabled' }
  const self = String(selfId ?? '')
  const mentions = (parsed?.mentions ?? []).map(String)
  if (!self) return { ok: false, reason: 'no-self', warn: true }
  if (mentions.includes(self)) return { ok: true, reason: 'at-bot' }
  if (mentions.length) return { ok: false, reason: 'at-other' }
  const names = (mentionNames ?? []).map(String).filter(Boolean)
  const text = String(parsed?.text ?? '')
  if (names.some((n) => text.includes(`@${n}`))) return { ok: true, reason: 'name-fallback' }
  return { ok: false, reason: 'no-mention' }
}
