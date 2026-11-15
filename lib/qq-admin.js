/** QQ 消息撤回/转发、好友请求 的参数校验（按 SnowLuma 源码 actions/*.ts 核对）。 */

/** message_id：数字（负值合法）。 */
export function validateMessageId(id) {
  const v = typeof id === 'number' ? id : String(id ?? '').trim()
  if (v === '' || !/^-?\d+$/.test(String(v))) return { ok: false, code: 'E_PARAM', detail: 'messageId 必须是整数（负值合法）' }
  const n = Number(v)
  if (!Number.isSafeInteger(n)) return { ok: false, code: 'E_PARAM', detail: 'messageId 超出安全整数范围' }
  return { ok: true, messageId: n }
}

export function validateForwardTarget({ toKind, toId } = {}) {
  const kind = String(toKind ?? '')
  if (kind !== 'private' && kind !== 'group') return { ok: false, code: 'E_PARAM', detail: 'toKind 必须是 private / group' }
  const id = String(toId ?? '').trim()
  if (!/^\d{5,12}$/.test(id)) return { ok: false, code: 'E_PARAM', detail: 'toId 必须是 5–12 位数字' }
  return { ok: true, toKind: kind, toId: id }
}

/** list / approve / reject；approve 必须 confirm:true。 */
export function validateFriendAction({ action, flag, confirm } = {}) {
  const a = String(action ?? '')
  if (a === 'list') return { ok: true, action: 'list' }
  if (a !== 'approve' && a !== 'reject') return { ok: false, code: 'E_PARAM', detail: 'action 只能是 list / approve / reject' }
  const f = String(flag ?? '').trim()
  if (!f) return { ok: false, code: 'E_PARAM', detail: 'approve/reject 需要 flag（列表项的 uid，不能按 QQ 号构造）' }
  if (a === 'approve' && confirm !== true) {
    return { ok: false, code: 'E_CONFIRM_REQUIRED', detail: '通过好友申请会加好友，确认请传 confirm:true', wouldChange: ['friend-request'] }
  }
  return { ok: true, action: a, flag: f }
}

/** 好友申请列表条目的脱敏视图（只回必要字段）。 */
export function presentFriendRequests(list) {
  const arr = Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : []
  return arr.map((x) => ({
    flag: x?.uid ?? x?.flag ?? '',
    userId: x?.user_id ?? null,
    nick: x?.nick ?? '',
    source: x?.source ?? '',
    msg: x?.msg ?? '',
    groupCode: x?.group_code ?? '',
    reqTime: x?.reqTime ?? null,
  }))
}
