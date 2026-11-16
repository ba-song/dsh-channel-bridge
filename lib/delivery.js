/**
 * 交付账本（2026-11-16，方案 P2-2 / A14）。
 *
 * 语义借自 Anima `calls.py:343-352` 的 call_turns：
 *   thinking → generated → queued → sent | failed | interrupted
 * 三件不同的事必须分开记：「生成了」≠「发出去了」≠「对方看到了」。
 * OneBot 的 `message_id` 只代表 QQ 服务端受理，因此 sent 也只能这么解释（见 deliveryNote）。
 *
 * 唯一硬约束在 store 的 `one_inflight` 部分唯一索引上：同一 (peer_id, msg_key)
 * 只允许一条「未发出」态，已 sent/failed 之后再发同内容不拦（重发/补发语义）。
 *
 * 全部记账都是 best-effort：任何异常都吞掉并返回 null，绝不阻断真实发送。
 */
import { createHash } from 'node:crypto'
import { INFLIGHT, KNOWN_STATES } from './store.js'

export { INFLIGHT, KNOWN_STATES }

/** 返回体里给调用方看的一句话：不要把「发出去」说成「对方看到了」。 */
export const DELIVERY_NOTE =
  '已发出 ≠ 对方已看到：message_id 只代表 QQ 服务端受理，不代表对方已读或已送达'

/** 稳定 msg_key：同一 (kind, contactId, 正文/消息段) → 同一 key。 */
export function requestKeyOf({ kind = 'private', contactId = '', message = null, text = '' } = {}) {
  const body = message === null || message === undefined ? String(text ?? '') : JSON.stringify(message)
  return createHash('sha256').update(`${String(kind)}|${String(contactId)}|${body}`).digest('hex')
}

export function createDeliveries({ store = null, now = () => Date.now(), log = null } = {}) {
  const usable = Boolean(store && typeof store.beginDelivery === 'function')
  const stats = { begun: 0, already: 0, sent: 0, failed: 0, interrupted: 0, errors: 0 }

  const guard = (fn, fallback = null) => {
    try {
      return fn()
    } catch (error) {
      stats.errors += 1
      log?.warn?.(`[channel-bridge] 交付账本异常（不影响发送）：${error?.message ?? error}`)
      return fallback
    }
  }

  return {
    supported: usable,
    note: DELIVERY_NOTE,
    stats,
    key: requestKeyOf,

    /** 发送前占位。already:true = 同内容正在发送中，调用方不要重发。 */
    begin({ peerId = '', msgKey = '', channel = 'qq', state = 'queued' } = {}) {
      if (!usable) return null
      return guard(() => {
        const r = store.beginDelivery({ peerId, msgKey, channel, state, at: now() })
        if (!r) return null
        if (r.already) {
          stats.already += 1
          log?.info?.(`[channel-bridge] 交付去重：peer=${peerId} 同内容在途（id=${r.id} state=${r.state}），不重发`)
        } else if (r.ok) {
          stats.begun += 1
        }
        return r
      })
    },

    /** 推进状态（同一行原地改）：sent / failed / interrupted / generated / thinking / queued。 */
    mark(id, state, { error = null } = {}) {
      if (!usable || !id) return null
      if (!KNOWN_STATES.has(String(state))) return null
      return guard(() => {
        const r = store.updateDelivery(id, state, { error, at: now() })
        if (r?.ok) {
          if (state === 'sent') stats.sent += 1
          else if (state === 'failed') stats.failed += 1
          else if (state === 'interrupted') stats.interrupted += 1
        }
        return r
      })
    },

    get({ peerId = '', msgKey = '' } = {}) {
      if (!usable) return null
      return guard(() => store.getDelivery({ peerId, msgKey }))
    },

    list({ peerId = null, limit = 20 } = {}) {
      if (!usable) return null
      return guard(() => store.listDeliveries({ peerId, limit }), [])
    },

    counts() {
      if (!usable) return null
      return guard(() => store.deliveryCounts())
    },
  }
}
