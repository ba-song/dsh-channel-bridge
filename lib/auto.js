/**
 * 出站自动模式（`outbound='auto'`）：
 * 她不再调 dy_say —— 桥在她这一轮结束后，把她**最后一条 assistant 文本**原样发到对应 QQ 联系人。
 *
 * 取回合结束的方式：轮询宿主内存事件日志 `agent.session.log`（1s 一次，最多 180s），
 * 找 `assistant/message` 的最后一段文本 + 之后的 `turn/end`。
 * （不读磁盘档案、不依赖 session/event 的订阅链，宿主重启/子上下文都不影响。）
 */
import { SILENT } from './say.js'
import { splitForSend } from './split.js'

export { splitForSend }

/** assistant/message 的 data → 纯文本。 */
export function textOfAssistant(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('')
    .trim()
}

export function createAuto({
  cfg = {},
  store = null,
  sender,
  log = null,
  now = () => Date.now(),
  setInterval: setI = setInterval,
  clearInterval: clearI = clearInterval,
} = {}) {
  const enabled = cfg.outbound === 'auto'
  const a = { maxLen: 60, maxSegments: 4, timeoutMs: 180000, pollMs: 1000, ...(cfg.auto ?? {}) }
  const watches = new Map()
  const toolSends = []
  let timer = null
  const stats = { started: 0, sent: 0, segments: 0, skipped: 0, silent: 0, timeouts: 0, failed: 0, overflow: 0, lastReason: null }

  function readEvents(agent) {
    try {
      const s = agent?.session
      if (Array.isArray(s?.log)) return s.log
      if (typeof s?.snapshotEvents === 'function') return s.snapshotEvents(0)
    } catch {}
    return []
  }

  function scan(watch) {
    const events = readEvents(watch.agent).slice(watch.startSeq)
    let lastText = ''
    let ended = false
    for (const ev of events) {
      if (ev?.type === 'assistant/message') {
        const t = textOfAssistant(ev.data)
        if (t) lastText = t
      } else if (ev?.type === 'turn/end') {
        ended = true
      }
    }
    return { lastText, ended }
  }

  function ensureTimer() {
    if (timer || !enabled) return
    timer = setI(() => tick(), Math.max(200, a.pollMs))
    timer?.unref?.()
  }

  function stopTimerIfIdle() {
    if (watches.size === 0 && timer) {
      try {
        clearI(timer)
      } catch {}
      timer = null
    }
  }

  /** dy_say 发过什么（用于防双发）：只记最近 50 条。 */
  function noteToolSend({ channel = 'qq', contactId, text, at = now() } = {}) {
    toolSends.push({ channel: String(channel), contactId: String(contactId ?? ''), text: String(text ?? '').trim(), at })
    while (toolSends.length > 50) toolSends.shift()
  }

  function alreadySentByTool(watch, text) {
    const t = String(text ?? '').trim()
    return toolSends.some(
      (x) => x.contactId === String(watch.parsed.contactId) && x.at >= watch.notifiedAt && x.text && (x.text === t || t.startsWith(x.text)),
    )
  }

  /** 投递成功后登记：从当前事件长度开始看这一轮。 */
  function noteDelivery({ agent, sessionId, parsed } = {}) {
    if (!enabled || !agent || !sessionId || !parsed) return false
    const events = readEvents(agent)
    watches.set(String(sessionId), {
      agent,
      parsed,
      startSeq: events.length,
      notifiedAt: now(),
      deadline: now() + a.timeoutMs,
    })
    stats.started += 1
    ensureTimer()
    return true
  }

  async function flush(sessionId, watch, { timeout = false } = {}) {
    watches.delete(sessionId)
    stopTimerIfIdle()
    const { lastText, ended } = scan(watch)
    const parsed = watch.parsed

    if (timeout) {
      stats.timeouts += 1
      stats.lastReason = 'AUTO_SEND_TIMEOUT'
      log?.warn?.(`[channel-bridge] 自动发送超时（${Math.round(a.timeoutMs / 1000)}s 没有 assistant 文本）：${sessionId.slice(0, 8)}…，不发送、不重试`)
      return { ok: false, code: 'AUTO_SEND_TIMEOUT' }
    }
    if (!ended) return { ok: false, code: 'TURN_NOT_ENDED' }

    const text = String(lastText ?? '').trim()
    if (!text || text.includes(SILENT) === true && text.replace(SILENT, '').trim() === '') {
      stats.silent += 1
      stats.lastReason = 'SILENT'
      log?.info?.('[channel-bridge] 自动发送：这一轮只有 [SILENT] 或空，不发')
      return { ok: true, code: 'SILENT', segments: 0 }
    }
    if (alreadySentByTool(watch, text)) {
      stats.skipped += 1
      stats.lastReason = 'TOOL_ALREADY_SENT'
      log?.info?.('[channel-bridge] 自动发送：本回合 dy_say 已发过同样内容，跳过（防双发）')
      return { ok: true, code: 'SKIPPED_TOOL_SENT', segments: 0 }
    }

    const segments = splitForSend(text, { maxLen: a.maxLen, maxSegments: a.maxSegments })
    if (!segments.length) {
      stats.silent += 1
      return { ok: true, code: 'EMPTY', segments: 0 }
    }
    const overflow = segments.some((s) => [...s].length > a.maxLen)
    if (overflow) stats.overflow += 1

    const ids = []
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]
      const res = await sender.sendText({ kind: parsed.kind, contactId: parsed.contactId, text: seg })
      if (!res?.ok) {
        stats.failed += 1
        stats.lastReason = res?.code ?? 'E_SEND_FAILED'
        log?.warn?.(`[channel-bridge] 自动发送失败（第 ${i + 1}/${segments.length} 段，${res?.code ?? '?'}），不再重试`)
        return { ok: false, code: res?.code ?? 'E_SEND_FAILED', segments: i }
      }
      ids.push(res.messageId || '')
      stats.segments += 1
      try {
        store?.insertEvent?.({
          at: now(),
          channel: parsed.channel ?? 'qq',
          kind: parsed.kind,
          contact: parsed.contactId,
          direction: 'out',
          text: null,
          textLen: [...seg].length,
          meta: { auto: true, seg: i + 1, of: segments.length, messageId: res.messageId || null },
        })
      } catch {}
    }
    stats.sent += 1
    stats.lastReason = 'AUTO_SENT'
    log?.info?.(`[channel-bridge] 自动发送：${segments.length} 段 / 共 ${[...text].length} 字 → ${parsed.kind}/${parsed.contactId}`)
    return { ok: true, code: 'AUTO_SENT', segments: segments.length, messageIds: ids }
  }

  /** 每 pollMs 跑一次：有 turn/end 就发，超时就判 AUTO_SEND_TIMEOUT。 */
  function tick() {
    if (!enabled) return
    for (const [sessionId, watch] of [...watches.entries()]) {
      const { ended } = scan(watch)
      if (ended) {
        void flush(sessionId, watch).catch((e) => log?.warn?.(`[channel-bridge] 自动发送异常：${e?.message ?? e}`))
        continue
      }
      if (now() >= watch.deadline) {
        void flush(sessionId, watch, { timeout: true }).catch(() => {})
      }
    }
  }

  return { enabled, stats, noteDelivery, noteToolSend, tick, flush, splitForSend, watches, dispose() {
    for (const id of [...watches.keys()]) watches.delete(id)
    stopTimerIfIdle()
  } }
}
