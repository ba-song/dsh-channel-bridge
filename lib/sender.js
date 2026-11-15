/** 发送：走同一条 WS 的 OneBot action；不重试、不重放。 */

import { cleanOutgoing } from './style-clean.js'

export function createSender({ getClient, log = null, styleClean = 'on', styleBanned = [] } = {}) {
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

  return {
    callAction,
    async sendText({ kind = 'private', contactId, text }) {
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
      const message = [{ type: 'text', data: { text: out } }]
      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const params =
        kind === 'group'
          ? { group_id: contactId, message, auto_escape: true }
          : { user_id: contactId, message, auto_escape: true }
      const res = await callAction(action, params)
      if (!res.ok) {
        log?.warn?.(`[channel-bridge] 发送失败（${res.code}）：${res.detail}`)
        return res
      }
      const messageId = res.data?.message_id === undefined || res.data?.message_id === null ? '' : String(res.data.message_id)
      return { ok: true, messageId }
    },

    /** 发任意 OneBot 消息段（图片/表情等）；不重试。 */
    async sendSegments({ kind = 'private', contactId, message, autoEscape = false } = {}) {
      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const params =
        kind === 'group'
          ? { group_id: String(contactId), message, auto_escape: autoEscape }
          : { user_id: String(contactId), message, auto_escape: autoEscape }
      const res = await callAction(action, params)
      if (!res.ok) {
        log?.warn?.(`[channel-bridge] 发段失败（${res.code}）：${res.detail}`)
        return res
      }
      const messageId = res.data?.message_id === undefined || res.data?.message_id === null ? '' : String(res.data.message_id)
      return { ok: true, messageId }
    },
  }
}
