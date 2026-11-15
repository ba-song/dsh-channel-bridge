/**
 * OneBot notice 事件解析（2026-11-16）。
 *
 * 桥以前只处理 `post_type === 'message'`，SL 推来的 notice（撤回/进群/退群/禁言/
 * 管理员/群文件/加好友/拍一拍）全被丢掉；这里统一成固定结构，供 index.js 记录/投递。
 *
 * 字段映射按 OneBot v11（已对照 SnowLuma event-converter/to-notice.ts 的实现）：
 * - friend_recall  → user_id, message_id
 * - group_recall   → group_id, user_id(发送者), operator_id, message_id
 * - group_increase/group_decrease → group_id, user_id, operator_id, sub_type
 * - group_ban      → group_id, user_id, operator_id, duration(秒), sub_type
 * - group_admin    → group_id, user_id, sub_type(set/unset)
 * - group_upload   → group_id, user_id, file{id,name,size}
 * - friend_add     → user_id
 * - notify/poke    → group_id(可空), user_id(发起者), target_id
 *
 * 纯函数：不改入参、不写文件、任何异常都吞掉（解析失败返回 null / 描述返回 ''）。
 */

/** 认识的 notice_type；不认识的返回 null。 */
const KNOWN_TYPES = new Set([
  'friend_recall',
  'group_recall',
  'group_increase',
  'group_decrease',
  'group_ban',
  'group_admin',
  'group_upload',
  'friend_add',
])

/** id 统一成字符串：null/undefined → ''，数字→字符串。 */
function idOf(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** 非负数字；非法/负数回落到 fallback。 */
function toNumber(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/** 秒/毫秒统一成毫秒；缺失/非法回落 0（保持纯函数，不取 Date.now）。 */
function toMillis(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n)
}

/** 按码点截断，中文不劈半。 */
function clip(text, max) {
  const chars = [...String(text ?? '')]
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, max).join('') + '…'
}

/** 取文件对象（SL 群文件事件只在 file 字段里给 id/name/size/busid）。 */
function fileOf(evt) {
  if (evt && typeof evt.file === 'object' && evt.file !== null) return evt.file
  return {}
}

/**
 * OneBot notice 事件 → 统一结构；非 notice/不认识返回 null。
 *
 * @param {object} evt OneBot 事件
 * @returns {null | {
 *   kind:'friend_recall'|'group_recall'|'group_increase'|'group_decrease'|'group_ban'|
 *        'group_admin'|'group_upload'|'friend_add'|'poke'|'unknown',
 *   subType:string, groupId:string, userId:string, operatorId:string,
 *   targetId:string, messageId:string, duration:number,
 *   fileName:string, fileSize:number, fileId:string, at:number,
 *   selfId:string,
 * }}
 */
export function parseNoticeEvent(evt) {
  try {
    if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return null
    if (String(evt.post_type ?? '') !== 'notice') return null

    const noticeType = String(evt.notice_type ?? '')
    if (!KNOWN_TYPES.has(noticeType) && noticeType !== 'notify') return null

    const base = {
      kind: 'unknown',
      subType: String(evt.sub_type ?? ''),
      groupId: idOf(evt.group_id),
      userId: idOf(evt.user_id),
      operatorId: idOf(evt.operator_id),
      targetId: idOf(evt.target_id),
      messageId: idOf(evt.message_id),
      duration: 0,
      fileName: '',
      fileSize: 0,
      fileId: '',
      at: toMillis(evt.time),
      selfId: idOf(evt.self_id),
    }

    if (noticeType === 'notify') {
      // notify 下只认 poke；其它 sub_type（输入状态/资料点赞等）归 unknown。
      if (base.subType !== 'poke') return { ...base, kind: 'unknown' }
      // 私聊 poke 的 user_id 是对方，sender_id 才是发起者；群聊 poke 没有 sender_id。
      return {
        ...base,
        kind: 'poke',
        userId: idOf(evt.sender_id) || base.userId,
        targetId: idOf(evt.target_id),
      }
    }

    if (noticeType === 'group_ban') {
      const duration = toNumber(evt.duration, 0)
      const subType = base.subType || (duration > 0 ? 'ban' : 'lift_ban')
      return { ...base, kind: 'group_ban', subType, duration }
    }

    if (noticeType === 'group_upload') {
      const file = fileOf(evt)
      return {
        ...base,
        kind: 'group_upload',
        fileName: clip(String(file.name ?? file.file_name ?? file.filename ?? ''), 200).trim(),
        fileSize: toNumber(file.size, 0),
        fileId: idOf(file.id),
      }
    }

    return { ...base, kind: noticeType }
  } catch {
    return null
  }
}

/** 秒数 → 中文时长：45 秒 / 10 分钟 / 1 分 30 秒。 */
function formatDuration(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return ''
  if (s < 60) return `${Math.round(s)} 秒`
  if (s % 60 === 0) return `${s / 60} 分钟`
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`
}

/**
 * 中文一行描述（不含昵称时用 QQ 号）。
 *
 * @param {ReturnType<typeof parseNoticeEvent>} notice
 * @param {{selfId?:string}} [opts] 调用方可显式传自己的 QQ（覆盖 notice.selfId）
 * @returns {string} 例：'撤回了消息' / '拍了拍你' / '拍了拍 12345' / '被管理员禁言 10 分钟'
 */
export function describeNotice(notice, { selfId = '' } = {}) {
  try {
    if (!notice || typeof notice !== 'object') return ''

    const kind = String(notice.kind ?? '')
    const subType = String(notice.subType ?? '')
    const targetId = idOf(notice.targetId)
    const self = idOf(notice.selfId) || idOf(selfId)

    switch (kind) {
      case 'friend_recall':
      case 'group_recall':
        return '撤回了消息'

      case 'group_increase':
        return '加入了群'

      case 'group_decrease':
        if (subType === 'kick' || subType === 'kick_me') return '被踢出了群'
        if (subType === 'disband') return '随群解散'
        return '退出了群'

      case 'group_ban': {
        if (subType === 'lift_ban') return '被解除禁言'
        const duration = formatDuration(notice.duration)
        return duration ? `被管理员禁言 ${duration}` : '被管理员禁言'
      }

      case 'group_admin':
        if (subType === 'unset') return '被取消管理员'
        return '被设为管理员'

      case 'group_upload': {
        const fileName = String(notice.fileName ?? '').trim()
        return fileName ? `上传了文件 ${fileName}` : '上传了文件'
      }

      case 'friend_add':
        return '加你为好友'

      case 'poke':
        // 目标是自己（或事件没带 target_id）→ 「你」；否则给 QQ 号。
        if (!targetId || (self && targetId === self)) return '拍了拍你'
        return `拍了拍 ${targetId}`

      default:
        return '未知通知'
    }
  } catch {
    return ''
  }
}
