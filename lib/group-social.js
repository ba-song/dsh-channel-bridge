/**
 * 群聊社交策略（2026-11-13，参考 SurfCore group-policy）：
 * 看不看 / 说不说 / 说几条 / 引用 / 收尾。默认关；打开后只在群里生效。
 */
const clampInt = (x, d, a, b) => Math.max(a, Math.min(b, Number.isFinite(Number(x)) ? Math.round(Number(x)) : d))

export function decideGroupSocial({ parsed = {}, cfg = {}, recent = 0 } = {}) {
  const c = cfg.social ?? cfg ?? {}
  if (cfg.enabled !== true || c.enabled !== true) return { speak: true, count: 1, quote: false, close: false, reason: 'off' }
  const text = String(parsed.text ?? '').trim()
  if (!text) return { speak: false, count: 0, quote: false, close: false, reason: 'empty' }
  if (/^(#|\/|！|!)/.test(text)) return { speak: false, count: 0, quote: false, close: false, reason: 'command' }
  const addressed = parsed.wantGroupContext === true || parsed.viaFollowUp === true
  const isOwner = parsed.isOwner === true
  const question = /[?？]|吗|呢|怎么|为什么|要不要|能不能/.test(text)
  if (!addressed && !isOwner && text.length < 4) return { speak: false, count: 0, quote: false, close: false, reason: 'too-short' }
  if (!addressed && !isOwner && !question && Number(recent) >= Number(c.silentAfterMessages ?? 20)) return { speak: false, count: 0, quote: false, close: false, reason: 'quiet' }
  const count = isOwner && question ? clampInt(c.maxCount, 2, 1, 4) : 1
  const quote = addressed || isOwner
  const close = Number(recent) >= Number(c.closeAfterMessages ?? 12)
  return { speak: true, count, quote, close, reason: addressed ? 'addressed' : isOwner ? 'owner' : 'relevant' }
}
