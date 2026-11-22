/**
 * 投递队列：同渠道串行，一条一条 followup；observe 只记不投。
 * 不做富化（P4 才有 ASR/图片/补收）。
 */
import { buildChannelMessage } from './message.js'
import { AUTO_RULES, buildChannelPrompt, roomRulesFor } from './prompt.js'
import { mountRoomRules } from './rules-context.js'
import { silenceDecision } from './relationship.js'

export function createRouter({
  store,
  sessions,
  mode,
  log = null,
  buildPrompt = buildChannelPrompt,
  enrich = null,
  contextBuilder = null,
  timeZoneOffsetMinutes = 480,
  outbound = 'tool',
  mirrorEnabled = false,
  getGroupContext = null,
  getPublicBrief = null,
  onDelivered = null,
  relationship = null,
  maxQueue = 50,
  now = () => Date.now(),
} = {}) {
  const queues = new Map()
  /** 队列按会话 key 串行：每个群/每个陌生私聊各一条队列，互不阻塞。 */
  const queueKeyOf = (parsed) => {
    const kind = parsed?.kind === 'group' ? 'group' : 'private'
    const id = String(kind === 'group' ? parsed?.contactId : parsed?.senderId || parsed?.contactId || '')
    return `${String(parsed?.channel ?? 'qq')}|${kind}:${id}`
  }
  const running = new Set()
  const silentDedup = new Map()
  const stats = { queued: 0, delivered: 0, deliverFail: 0, agentErrors: 0, observeSkipped: 0, queueFull: 0, silent: 0, busy: 0, enrichFail: 0, contextAdded: 0, relationshipSilent: 0 }

  function queueOf(key) {
    let q = queues.get(key)
    if (!q) {
      q = []
      queues.set(key, q)
    }
    return q
  }

  async function enrichOne(parsed) {
    if (typeof enrich !== 'function') return parsed
    if (parsed?.replay) return parsed // 补收不下载附件
    try {
      const extra = await enrich(parsed)
      if (!extra) return parsed
      const next = { ...parsed }
      if (Array.isArray(extra.attachments)) next.attachments = extra.attachments
      // 引用富化（2026-11-16）：enrich 调 get_msg 反查被引用消息，失败不给 quote
      if (extra.quote) next.quote = extra.quote
      // 合并转发富化：enrich 调 get_forward_msg 解析节点，失败不给 forward
      if (extra.forward) next.forward = extra.forward
      // 群聊图片直投：enrich 把第一张图存进 attachment 服务
      if (extra.inlineImage) next.inlineImage = extra.inlineImage
      return next
    } catch (error) {
      stats.enrichFail += 1
      log?.warn?.(`[channel-bridge] 富化失败（按原样投递）：${error?.message ?? error}`)
      return parsed
    }
  }

  /** 会话最后一条 turn/end 是 error 吗（例如工作目录不存在）。 */
  function lastTurnError(agent) {
    const events = agent?.session?.log
    if (!Array.isArray(events)) return ''
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if (e?.type !== 'turn/end') continue
      if (e?.data?.reason !== 'error') return ''
      return String(e?.data?.message ?? e?.data?.error?.message ?? e?.data?.detail ?? 'turn/end reason=error')
    }
    return ''
  }

  async function deliverOne(parsed) {
    // 2026-11-13：关系沉默策略（默认关）；主人永不沉默
    try {
      if (relationship?.enabled === true && !parsed?.replay && !parsed?.reconcile) {
        const row = store?.contactOf?.(parsed?.channel ?? 'qq', parsed?.contactId, parsed?.kind ?? 'private') ?? null
        const d = silenceDecision({
          row, isOwner: parsed?.isOwner === true, kind: parsed?.kind ?? 'private',
          mentioned: parsed?.wantGroupContext === true || parsed?.viaFollowUp === true,
          cfg: relationship,
        })
        if (d.silent) {
          stats.relationshipSilent += 1
          log?.info?.(`[channel-bridge] 关系沉默（${d.reason}/${d.tier}）from=${parsed?.senderId ?? parsed?.contactId ?? ''}`)
          return { ok: true, code: 'SILENCED' }
        }
      }
    } catch {}
    // 先确保会话可用，再下载附件：会话不可用时不白下 20MB
    const res = await sessions.ensure(parsed)
    if (!res?.ok) {
      stats.deliverFail += 1
      log?.warn?.(`[channel-bridge] 投递失败（${res?.code ?? 'UNKNOWN'}）：${res?.detail ?? ''}${parsed?.messageId ? ` msg=${parsed.messageId}` : ''}`)
      return { ok: false, code: res?.code }
    }
    const p = await enrichOne(parsed)
    // 2026-11-12：优先把规矩挂成该 agent 的 systemPrompt 常驻上下文（只挂一次，不随消息累积）；
    // 挂不上（旧宿主/测试 fake agent）才回退到消息内规则：首条/轮换 full，其余 short。
    const rulesText = outbound === 'auto' ? AUTO_RULES : roomRulesFor(mirrorEnabled)
    const rulesMounted = p.replay || p.reconcile ? false : mountRoomRules(res.agent, rulesText)
    if (rulesMounted === 'new') log?.info?.(`房间规矩已挂 systemPrompt（${res.sessionId || p.contactId}）`)
    const rulesMode = p.replay || p.reconcile || rulesMounted ? 'none' : (res.created || res.rotated ? 'full' : 'short')
    let promptText = buildPrompt(p, { mode: mode.current(), timeZoneOffsetMinutes, outbound, mirrorEnabled, rulesMode })
    // 群里被 @ 时：先拼公开近况（home→群），再拼最近几条群上下文（群→家之外的上下文）
    if (p.kind === 'group' && p.wantGroupContext) {
      const parts = []
      if (typeof getPublicBrief === 'function') {
        try {
          const brief = await getPublicBrief(p)
          if (brief) parts.push(brief)
        } catch (error) {
          log?.warn?.(`[channel-bridge] 公开近况拼装失败（跳过）：${error?.message ?? error}`)
        }
      }
      if (typeof getGroupContext === 'function') {
        try {
          const ctx = await getGroupContext(p)
          if (ctx) parts.push(ctx)
        } catch (error) {
          log?.warn?.(`[channel-bridge] 群上下文拼装失败（按原样投）：${error?.message ?? error}`)
        }
      }
      if (parts.length) promptText = `${parts.join('\n\n')}\n\n${promptText}`
    }
    // B 轮换已把历史 seed 进会话 → 不再叠「上次聊到」；
    // seed 失败退化 A 时，把交接卡顶在最前面（一次性）。
    if (res.handoffText) {
      promptText = `${res.handoffText}\n\n${promptText}`
      try {
        store?.clearHandoff?.({ channel: p.channel, kind: p.kind })
      } catch {}
    } else if (!res.rotated && res.created && typeof contextBuilder === 'function') {
      try {
        const ctxText = contextBuilder(p)
        if (ctxText) {
          promptText = `${ctxText}\n\n${promptText}`
          stats.contextAdded += 1
        }
      } catch (error) {
        log?.warn?.(`[channel-bridge] 新会话上下文拼装失败：${error?.message ?? error}`)
      }
    }
    // 2026-11-13：群聊社交策略（默认关；由 index 的 gate 写入 p.social*）
    if (p.kind === 'group' && p.socialCount) {
      const bits = [`这轮最多回 ${Math.max(1, Number(p.socialCount) || 1)} 条`]
      if (p.socialQuote) bits.push('要接的人用引用/点名说清楚')
      if (p.socialClose) bits.push('这段聊得差不多了就自然收尾，别硬续')
      promptText += `\n\n【群聊策略】${bits.join('；')}。`
    }

    const message = buildChannelMessage(promptText, p, { blocks: p.inlineImage ? [p.inlineImage] : [] })
    try {
      await res.agent.followup(message)
      // agent 回合挂了（如 working-directory 不存在）不能当成已回复，否则就是静默失败
      const agentError = lastTurnError(res.agent)
      if (agentError && /working-directory|directory does not exist/i.test(agentError)) {
        stats.agentErrors += 1
        log?.warn?.(`[channel-bridge] agent 回合错误，不当作已回复：${agentError}`)
        return { ok: false, code: 'E_AGENT_ERROR', detail: agentError }
      }
      stats.delivered += 1
      try {
        onDelivered?.({ agent: res.agent, sessionId: res.sessionId, parsed: p })
      } catch (error) {
        log?.warn?.(`[channel-bridge] onDelivered 回调异常：${error?.message ?? error}`)
      }
      try {
        store?.updateEventSession?.(parsed.messageId, res.sessionId)
      } catch {}
      log?.info?.(`[channel-bridge] 已投递 ${parsed.channel}/${parsed.kind} → ${res.sessionId.slice(0, 8)}…（${res.created ? '新会话' : '旧会话'}，队列剩 ${queueOf(queueKeyOf(parsed)).length}）`)
      return { ok: true, sessionId: res.sessionId }
    } catch (error) {
      stats.deliverFail += 1
      log?.warn?.(`[channel-bridge] followup 失败：${error?.message ?? error}`)
      return { ok: false, code: 'E_FOLLOWUP_FAILED' }
    }
  }

  async function drain(channel) {
    if (running.has(channel)) {
      stats.busy += 1
      return
    }
    running.add(channel)
    try {
      const q = queueOf(channel)
      while (q.length) {
        const item = q.shift()
        await deliverOne(item)
      }
    } finally {
      running.delete(channel)
    }
  }

  return {
    stats,
    pending(channel = null) {
      if (channel === null || channel === undefined) {
        let n = 0
        for (const q of queues.values()) n += q.length
        return n
      }
      let n = 0
      for (const [k, q] of queues.entries()) if (k.startsWith(`${String(channel)}|`)) n += q.length
      return n
    },
    /** 'QUEUED' | 'MODE_OBSERVE' | 'QUEUE_FULL' */
    deliver(parsed) {
      if (mode.current() === 'observe') {
        stats.observeSkipped += 1
        return 'MODE_OBSERVE'
      }
      const q = queueOf(queueKeyOf(parsed))
      if (q.length >= maxQueue) {
        stats.queueFull += 1
        log?.warn?.(`[channel-bridge] 队列满（${maxQueue}），丢弃入站 ${parsed?.messageId ?? ''}`)
        return 'QUEUE_FULL'
      }
      q.push(parsed)
      stats.queued += 1
      void drain(queueKeyOf(parsed))
      return 'QUEUED'
    },
    /** 显式 SILENT（dy_say 里写了标记）：2 秒内同 (channel,kind,contact) 只记一条。 */
    noteSilent(parsed, reason = 'explicit') {
      const key = `${parsed?.channel}|${parsed?.kind}|${parsed?.contactId}`
      const t = now()
      const prev = silentDedup.get(key)
      if (prev && t - prev < 2000) return false
      silentDedup.set(key, t)
      stats.silent += 1
      try {
        store?.insertEvent?.({
          at: t,
          channel: parsed.channel,
          kind: parsed.kind,
          contact: parsed.contactId,
          direction: 'silent',
          meta: { reason },
        })
      } catch {}
      return true
    },
    /** 测试用：等当前队列排空。 */
    async idle() {
      for (let i = 0; i < 400; i += 1) {
        const busy = running.size > 0 || [...queues.values()].some((q) => q.length > 0)
        if (!busy) return
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    dispose() {
      for (const q of queues.values()) q.length = 0
      running.clear()
    },
  }
}
