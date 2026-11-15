/**
 * 群聊「跟话窗口」 + 被 @ 时的上下文。
 *
 * - 被 @ → 开/续窗口（剩余消息数回到 followUpMessages，idle 从此刻起算）；
 * - 窗口内非 @ 消息 → 投递并消耗 1 条；
 * - 她的群回复 → 刷新 idle + 重置剩余条数；
 * - 条数用完或 idle 超时 → 关窗，恢复「必须 @」。
 */
export function createFollowUpWindow({ messages = 8, idleMs = 600000, now = () => Date.now(), log = null, onClose = null } = {}) {
  const stats = { opened: 0, renews: 0, consumed: 0, closed: 0, lastCloseReason: null }
  let open = false
  let remaining = 0
  let lastAt = 0
  let timer = null
  // 真实定时器：安静到点就主动关窗（不等下一条消息）；unref 不拖住进程
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; close('idle') }, idleMs)
    timer?.unref?.()
  }
  const disarm = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }
  const humanIdle = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`)

  function close(reason) {
    if (!open) return false
    open = false
    remaining = 0
    disarm()
    stats.closed += 1
    stats.lastCloseReason = reason
    const at = now()
    log?.info?.(`[channel-bridge] 群跟话窗口关闭（${reason === 'idle' ? `${humanIdle(idleMs)}没人说话` : '消息数用完'}），恢复必须 @`)
    try {
      onClose?.({ reason, at })
    } catch (error) {
      log?.warn?.(`[channel-bridge] 关窗回调异常：${error?.message ?? error}`)
    }
    return true
  }

  function isOpen() {
    if (!open) return false
    if (now() - lastAt >= idleMs) {
      close('idle')
      return false
    }
    if (remaining <= 0) {
      close('exhausted')
      return false
    }
    return true
  }

  return {
    stats,
    isOpen,
    /** 被 @：开或续，剩余条数重置。 */
    open() {
      if (open) {
        stats.renews += 1
      } else {
        stats.opened += 1
      }
      open = true
      remaining = messages
      lastAt = now()
      arm()
    },
    /** 窗口内投递一条：消耗 1 条（最后一条仍投）。 */
    consume() {
      if (!isOpen()) return false
      remaining -= 1
      lastAt = now()
      stats.consumed += 1
      arm()
      if (remaining <= 0) close('exhausted') // 最后一条仍然投出去，但窗口立即关
      return true
    },
    /** 她自己在群里说话了：续窗。 */
    renew() {
      if (!open) return false
      remaining = messages
      lastAt = now()
      stats.renews += 1
      arm()
      return true
    },
    close,
    status() {
      const alive = isOpen()
      return { open: alive, remaining: alive ? remaining : 0, idleMs, lastCloseReason: stats.lastCloseReason }
    },
  }
}

const placeholders = { image: '[图片]', record: '[语音]', video: '[视频]', file: '[文件]', face: '[表情]', mface: '[表情]', json: '[卡片]', xml: '[卡片]', forward: '[转发]' }

function renderContent(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    const t = String(seg?.type ?? '')
    const d = seg?.data ?? {}
    if (t === 'text') parts.push(String(d.text ?? ''))
    else if (t === 'at') parts.push(`@${d.qq ?? ''}`)
    else if (t === 'reply') continue
    else parts.push(placeholders[t] ?? '')
  }
  return parts.join('').trim()
}

/**
 * 被 @ 时拼上下文：`[群聊上下文·最近 N 条]` + `昵称: 内容`。
 * 优先 get_group_msg_history；失败降级用桥自己的最近入站事件（fallback 函数），不阻断投递。
 */
export async function buildGroupContext({
  getClient = () => null,
  groupId,
  count = 8,
  excludeMessageId = '',
  selfId = '',
  ownerIds = [],
  fallback = () => [],
  log = null,
} = {}) {
  const n = Math.max(5, Math.min(10, Number(count) || 8))
  let rows = null
  try {
    const client = getClient?.()
    if (!client || typeof client.call !== 'function') throw Object.assign(new Error('no client'), { code: 'E_NOT_CONNECTED' })
    const res = await client.call('get_group_msg_history', { group_id: String(groupId), count: n + 1 }, { timeoutMs: 10000 })
    const msgs = res?.data?.messages
    if (!Array.isArray(msgs)) throw new Error('bad history response')
    rows = msgs.map((evt) => {
      const sender = String(evt?.sender?.card || evt?.sender?.nickname || evt?.user_id || '')
      const text = renderContent(evt?.message)
      const mid = evt?.message_id === undefined || evt?.message_id === null ? '' : String(evt.message_id)
      const senderId = String(evt?.user_id ?? '')
      return mid ? { id: mid, sender, senderId, text } : { sender, senderId, text }
    })
  } catch (error) {
    log?.warn?.(`[channel-bridge] 群上下文拉取失败，降级用本地事件：${error?.code ?? error?.message ?? error}`)
    rows = fallback({ n })
  }
  const lines = (rows ?? [])
    .filter((r) => r && String(r.text ?? '').trim())
    .filter((r) => !excludeMessageId || String(r.id ?? '') !== String(excludeMessageId))
    .slice(-n)
    .map((r) => {
      const who = r.sender ? `${ownerIds.map(String).includes(String(r.senderId ?? '')) ? '【主人】' : ''}${r.sender}: ` : ''
      return `${who}${String(r.text).trim()}`
    })
  if (!lines.length) return ''
  return `[群聊上下文·最近 ${lines.length} 条]\n${lines.join('\n')}`
}
