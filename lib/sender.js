/** 发送：走同一条 WS 的 OneBot action；不重试、不重放。 */

import { cleanOutgoing } from './style-clean.js'
import { DELIVERY_NOTE, requestKeyOf } from './delivery.js'

export function createSender({ getClient, log = null, styleClean = 'on', styleBanned = [], deliveries = null } = {}) {
  // 交付账本（2026-11-16，A14）：只有注入了 deliveries 时才有行为，否则完全照旧。
  const ledger = deliveries && deliveries.supported ? deliveries : null

  async function callAction(action, params, opts) {
    const client = getClient?.()
    if (!client) return { ok: false, code: 'E_NOT_CONNECTED', detail: '客户端未启动' }
    try {
      const res = await client.call(action, params, opts)
      return { ok: true, data: res?.data ?? null, raw: res }
    } catch (error) {
      return { ok: false, code: error?.code ?? 'E_SEND_FAILED', detail: error?.message ?? String(error) }
    }
  }

  /** 发送前占位 + 发送后改态；返回 null 表示这条不做账（例如调用方没给 key）。 */
  function hold({ kind, contactId, message }) {
    if (!ledger) return null
    try {
      const msgKey = requestKeyOf({ kind, contactId, message })
      const r = ledger.begin({ peerId: String(contactId ?? ''), msgKey, channel: kind })
      if (!r || !r.ok) return { blocked: r, id: r?.id ?? null }
      return { blocked: null, id: r.id, msgKey }
    } catch {
      return null
    }
  }

  const settle = (h, state, detail = null) => {
    if (h?.id) ledger.mark(h.id, state, { error: detail })
  }

  return {
    callAction,
    async sendText({ kind = 'private', contactId, text, replyTo = '' }) {
      let out = String(text ?? '')
      if (Array.isArray(styleBanned) && styleBanned.length) {
        const hit = styleBanned.find((w) => w && out.includes(w))
        if (hit) { log?.warn?.(`[style-banned] 拦下含禁词「${hit}」的消息`); return { ok: false, code: 'E_BANNED', detail: `含禁词：${hit}` } }
      }
      try {
        const r = cleanOutgoing(out, { enabled: styleClean !== 'off' })
        if (r.changed) {
          if (styleClean === 'dryRun') log?.info?.(`[style-clean] 将清洗（未应用）：${out.slice(0, 40)} -> ${r.text.slice(0, 40)}`)
          else if (r.text) { out = r.text; if (r.notes.length) log?.info?.(`[style-clean] 已清洗 ${r.notes.join(',')}：${out.slice(0, 40)}`) }
          // 清洗后为空（整句都是客服腔）→ 保留原文，绝不发空消息
        }
      } catch {}
      const message = []
      // 引用回复（2026-11-16）：reply 段放最前，后面跟正文；id 用 OneBot message_id
      const quoteId = String(replyTo ?? '').trim()
      if (quoteId) message.push({ type: 'reply', data: { id: quoteId } })
      message.push({ type: 'text', data: { text: out } })
      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const params =
        kind === 'group'
          ? { group_id: contactId, message, auto_escape: true }
          : { user_id: contactId, message, auto_escape: true }
      const h = hold({ kind, contactId, message })
      if (h?.blocked?.already) {
        // 同内容正在发送中：绝不重发（并发双发就是靠这里挡住的）
        return {
          ok: false,
          code: 'E_ALREADY_DELIVERING',
          already: true,
          state: h.blocked.state ?? 'queued',
          deliveryId: h.blocked.id ?? null,
          deliveryNote: DELIVERY_NOTE,
        }
      }
      const res = await callAction(action, params)
      if (!res.ok) {
        settle(h, 'failed', `${res.code}: ${res.detail ?? ''}`)
        log?.warn?.(`[channel-bridge] 发送失败（${res.code}）：${res.detail}`)
        return { ...res, state: 'failed', deliveryId: h?.id ?? null, deliveryNote: DELIVERY_NOTE }
      }
      settle(h, 'sent')
      const messageId = res.data?.message_id === undefined || res.data?.message_id === null ? '' : String(res.data.message_id)
      return { ok: true, messageId, state: 'sent', deliveryId: h?.id ?? null, deliveryNote: DELIVERY_NOTE }
    },

    /** 发任意 OneBot 消息段（图片/表情等）；不重试。 */
    async sendSegments({ kind = 'private', contactId, message, autoEscape = false } = {}) {
      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const params =
        kind === 'group'
          ? { group_id: String(contactId), message, auto_escape: autoEscape }
          : { user_id: String(contactId), message, auto_escape: autoEscape }
      const h = hold({ kind, contactId: String(contactId), message })
      if (h?.blocked?.already) {
        return {
          ok: false,
          code: 'E_ALREADY_DELIVERING',
          already: true,
          state: h.blocked.state ?? 'queued',
          deliveryId: h.blocked.id ?? null,
          deliveryNote: DELIVERY_NOTE,
        }
      }
      const res = await callAction(action, params)
      if (!res.ok) {
        settle(h, 'failed', `${res.code}: ${res.detail ?? ''}`)
        log?.warn?.(`[channel-bridge] 发段失败（${res.code}）：${res.detail}`)
        return { ...res, state: 'failed', deliveryId: h?.id ?? null, deliveryNote: DELIVERY_NOTE }
      }
      settle(h, 'sent')
      const messageId = res.data?.message_id === undefined || res.data?.message_id === null ? '' : String(res.data.message_id)
      return { ok: true, messageId, state: 'sent', deliveryId: h?.id ?? null, deliveryNote: DELIVERY_NOTE }
    },
  }
}
