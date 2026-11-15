/**
 * 镜像消息：把 dy_say **实际发出去的每段原文**写回该会话，显示成 assistant 消息。
 * 目的：GUI「对话」页里出现的那段 == 真正发到 QQ 的那段（一字不差）。
 *
 * 优先宿主 API：`agent.session.append('assistant/message', { turn, step, message })`。
 * 宿主不可用/append 抛错 → 退化写 `bridge.db` 的 `channel_mirror` 表（报告里会写清），不硬造。
 */
import { randomUUID } from 'node:crypto'

export function createMirror({ store = null, log = null, now = () => Date.now(), cfg = {} } = {}) {
  const enabled = cfg?.mirror?.enabled === true
  const stats = { host: 0, db: 0, failed: 0, hostOk: true, lastReason: null }

  function sessionOf(agent) {
    return agent?.session ?? agent?.agent?.session ?? null
  }

  /** 当前 turn/step（宿主对 assistant/message 有 schema 校验，尽量给合法值）。 */
  function turnStep(session) {
    const events = Array.isArray(session?.log) ? session.log : []
    let turn = 1
    let step = 1
    for (const ev of events) {
      if (ev?.type === 'turn/start') turn = Number(ev.data?.turn ?? turn) || turn
      if (ev?.type === 'assistant/message' && Number(ev.data?.turn ?? 0) === turn) {
        step = Math.max(step, (Number(ev.data?.step ?? 0) || 0) + 1)
      }
    }
    return { turn, step }
  }

  function appendOne(session, text, meta) {
    const { turn, step } = turnStep(session)
    session.append('assistant/message', {
      turn,
      step,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'text', text: String(text) }],
        source: { kind: 'model', provider: meta.provider || 'qq', model: meta.model || 'dy_say' },
      },
    })
  }

  /**
   * @param {{agent?:object, parts?:Array<{text:string}>, channel?:string, kind?:string, contactId?:string, sessionId?:string}} input
   */
  function mirror({ agent = null, parts = [], channel = 'qq', kind = 'private', contactId = '', sessionId = null, provider = 'qq', model = 'dy_say' } = {}) {
    if (!enabled) return { ok: true, count: 0, host: false, skipped: true }
    // 同一段只镜像一次：按段序号去重（不是按文本——重复的文字是真内容，不能吞）
    const seen = new Set()
    const texts = []
    for (let i = 0; i < (Array.isArray(parts) ? parts.length : 0); i += 1) {
      const part = parts[i]
      const t = String(part?.text ?? '')
      if (!t) continue
      const key = part?.index === undefined || part?.index === null ? `i:${i}` : `x:${part.index}`
      if (seen.has(key)) continue
      seen.add(key)
      texts.push(t)
    }
    if (!texts.length) return { ok: true, count: 0, host: stats.hostOk }

    const session = sessionOf(agent)
    const canHost = typeof session?.append === 'function'
    let hostCount = 0
    let dbCount = 0

    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i]
      if (canHost) {
        try {
          appendOne(session, text, { provider, model })
          hostCount += 1
          stats.host += 1
          continue
        } catch (error) {
          stats.failed += 1
          stats.lastReason = error?.message ?? String(error)
          stats.hostOk = false
          log?.warn?.(`[channel-bridge] 镜像写回失败（改存 bridge.db）：${stats.lastReason}`)
        }
      } else if (stats.hostOk) {
        stats.hostOk = false
        stats.lastReason = 'session.append 不可用'
        log?.warn?.('[channel-bridge] 宿主没有 session.append，镜像改存 bridge.db')
      }
      try {
        store?.insertMirror?.({ at: now(), channel, kind, contact: contactId, sessionId, seg: i, text })
        dbCount += 1
        stats.db += 1
      } catch (error) {
        stats.failed += 1
        stats.lastReason = error?.message ?? String(error)
      }
    }
    return { ok: true, count: texts.length, host: hostCount, db: dbCount, hostOk: stats.hostOk }
  }

  return { mirror, stats, enabled }
}
