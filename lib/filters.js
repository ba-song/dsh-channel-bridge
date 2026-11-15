/**
 * 入站过滤：非主人私聊里的「纯占位卡片」不投。
 * 例：QQ 邮箱提醒机器人发来的 `[卡片]`——真实邮件走 IMAP，这条只会打扰她。
 *
 * 只按内容判定（优先），`ignoreContacts` 只是可选的号码名单兜底。
 */
const PLACEHOLDERS = new Set(['[卡片]', '[转发]', '[视频]', '[表情]', '[文件]', '[图片]', '[语音]', '[未知]'])

export function isPlaceholderOnly(parsed) {
  if (Array.isArray(parsed?.media) && parsed.media.length) return false
  const text = String(parsed?.text ?? '').trim()
  if (!text) return false
  const tokens = text.match(/\[[^\]]+\]/g) ?? []
  if (!tokens.length) return false
  // 去掉所有占位后没有正文 → 纯占位
  const rest = text.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, '')
  if (rest) return false
  return tokens.every((t) => PLACEHOLDERS.has(t))
}

export function shouldSkipPrivate(parsed, { ignoreCards = true, ignoreContacts = [] } = {}) {
  if (parsed?.kind !== 'private') return { skip: false, reason: 'not-private' }
  if (parsed?.isOwner === true) return { skip: false, reason: 'owner' }
  const list = (ignoreContacts ?? []).map(String)
  if (list.includes(String(parsed?.contactId ?? ''))) return { skip: true, reason: 'contact' }
  if (ignoreCards && isPlaceholderOnly(parsed)) return { skip: true, reason: 'placeholder' }
  return { skip: false, reason: 'ok' }
}
