/** 投递消息体：人物标记 + 话（+ 补收时间前缀 + 附件路径行）。 */

export function markerOf(parsed) {
  const id = String(parsed?.contactId ?? '')
  const name = String(parsed?.contactName ?? '')
  if (parsed?.kind === 'group') {
    const group = name.startsWith('群_') ? '' : name
    return `[QQ·群·${group}(${id})]`
  }
  return `[QQ·私聊·${name}(${id})]`
}

const IDENTITY_RULE = '- 你也是家里那个汐；这里和家里的记忆是同一套，别把自己当成两个人。'

/** tool 模式（mirror 关）的规则：dy_say 发 + 正文原样写同一句。 */
export const ROOM_RULES_TOOL = [
  '【这个房间的规矩】',
  '- 只有 dy_say 能送到对方；你在这里写的字对方看不到。',
  '- 发完 dy_say 后，在正文里把同一句原样写一遍（只写这一句）。',
  '- 回复超过 60 字就拆成 2–4 条，一条一条 dy_say 发，别一次发一大段。',
  '- 不想接就不接，不用解释。',
  IDENTITY_RULE,
].join('\n')

/** 镜像模式（mirror.enabled===true）的规则：对话页自动显示已发原文，正文可留空。 */
export const ROOM_RULES_MIRROR = [
  '【这个房间的规矩】',
  '- 要说的全部通过 dy_say 发；对话页里会自动显示你发出去的原文。',
  '- 不要写总结、不要写解释、不要复述你刚发了什么；正文留空，或只写 [SILENT]。',
  '- 一条太长（>60 字）桥会自动拆成多条，你不用自己拆。',
  IDENTITY_RULE,
].join('\n')

/** 短提醒（2026-11-12）：每条都带，但只保留最关键的一条规矩，约 45 字。 */
export const ROOM_RULES_SHORT = [
  '【这个房间的规矩】',
  '- dy_say 才送到对方；发完在正文里原样复述同一句；超过 60 字拆 2–4 条；不想接就不接。',
].join('\n')

/** 默认导出 = tool 版（mirror 默认关）。 */
export const ROOM_RULES = ROOM_RULES_TOOL

export const ROOM_RULES_SHORT_MIRROR = [
  '【这个房间的规矩】',
  '- 要说的全用 dy_say 发；对话页会自动显示你发出去的原文；正文留空或 [SILENT]；超过 60 字桥会自动拆。',
].join('\n')

export function roomRulesFor(mirrorEnabled = false, { short = false } = {}) {
  if (short) return mirrorEnabled === true ? ROOM_RULES_SHORT_MIRROR : ROOM_RULES_SHORT
  return mirrorEnabled === true ? ROOM_RULES_MIRROR : ROOM_RULES_TOOL
}

/** 自动发送模式下换一套规则（她写正文，桥负责发）。 */
export const AUTO_RULES = [
  '【这个房间的规矩】',
  '- 你在这里写的最后一条消息会被原样发到 QQ；超过 60 字自动拆成多条。',
  '- 只写要说的话，不要写解释、不要总结、不要列点。',
  '- 不想接话就只写 [SILENT]。',
].join('\n')

/** 本地 HH:MM（按 replay.timeZoneOffsetMinutes 偏移，默认 +480）。 */
export function hhmm(at, offsetMinutes = 480) {
  const d = new Date(Number(at || 0) + Number(offsetMinutes) * 60000)
  return d.toISOString().slice(11, 16)
}

export function buildChannelPrompt(
  parsed,
  { mode = 'observe', timeZoneOffsetMinutes = 480, outbound = 'tool', mirrorEnabled = false, includeRules = false, rulesMode } = {},
) {
  const marker = markerOf(parsed)
  const text = String(parsed?.text ?? '')
  const replay = parsed?.replay ? `[补收·${parsed?.replayLabel || hhmm(parsed?.at, timeZoneOffsetMinutes)}] ` : ''
  const senderName = String(parsed?.senderName ?? '')
  // 群里必须让她认得出主人：QQ 昵称和私聊里的称呼往往不一样（2026-11-09）
  const senderLabel = parsed?.kind === 'group' ? `${parsed?.isOwner ? '【主人】' : ''}${senderName}` : ''
  const body =
    parsed?.kind === 'group'
      ? `${marker} ${replay}${senderLabel}：${text}`
      : `${marker} ${replay}${text}`
  const attachments = Array.isArray(parsed?.attachments) && parsed.attachments.length ? `\n${parsed.attachments.join('\n')}` : ''
  const out = `${body}${attachments}`
  const withMode = mode === 'send' ? out : `${out}\n（通道当前只读，发送会被拦）`
  // 房间规矩：真实入站每条都带（2026-11-12 起；补收/重放不带），避免长上下文里忘掉 dy_say 复述规则
  const rm = rulesMode ?? (includeRules ? 'full' : 'none')
  if (rm === 'none') return withMode
  const rules = outbound === 'auto' ? AUTO_RULES : roomRulesFor(mirrorEnabled, { short: rm === 'short' })
  return `${withMode}\n\n${rules}`
}
