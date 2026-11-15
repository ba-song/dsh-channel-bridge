/**
 * 650k 轮换 + B 方案注入（seed 旧会话最近 50 条真实消息）。
 *
 * 计量（从会话事件里读，不额外存）：
 *   prompt_tokens  = 最近一条 assistant/message 的 usage.inputTokens
 *   context_window = 最近一条 request/context 的 data.contextWindow（拿不到就 0）
 * 触发：prompt_tokens >= 650_000 或 context_window>0 且 ratio>=0.62。
 */
import { randomUUID } from 'node:crypto'

export const HANDOFF_NOTE =
  '以下是你上一个会话的记录，不是现在发生的事；不要把它们当成现在的对话。如果最后一条是主人发来、你还没回的，就接着回它。'

export function computeUsage(events = []) {
  let promptTokens = 0
  let contextWindow = 0
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'assistant/message') {
      const u = ev.data?.usage
      if (u && Number.isFinite(Number(u.inputTokens))) promptTokens = Math.max(promptTokens, Number(u.inputTokens) + Number(u.cacheReadTokens ?? 0) * 0)
      else if (u && Number.isFinite(Number(u.totalTokens))) promptTokens = Math.max(promptTokens, Number(u.totalTokens))
    } else if (ev.type === 'request/context') {
      const w = Number(ev.data?.contextWindow)
      if (Number.isFinite(w) && w > 0) contextWindow = w
    }
  }
  return { promptTokens: Math.max(0, Math.round(promptTokens)), contextWindow: Math.max(0, Math.round(contextWindow)) }
}

export function shouldRotate({ promptTokens = 0, contextWindow = 0 } = {}, { threshold = 650000, ratio = 0.62 } = {}) {
  if (promptTokens >= threshold) return true
  if (contextWindow > 0 && promptTokens / contextWindow >= ratio) return true
  return false
}

/** 只收真实对话：user/message（source.kind==='user'）+ assistant/message（有 text）。 */
export function collectRecentMessages(events = [], limit = 50) {
  const out = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'user/message') {
      const msg = ev.data
      if (!msg || String(msg.source?.kind ?? '') !== 'user') continue
      const text = (Array.isArray(msg.content) ? msg.content : []).filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('')
      if (!text.trim()) continue
      const clean = text.replace(/【这个房间的规矩】[\s\S]*$/, '').trim()
      if (!clean) continue
      const at = Number(ev.time)
      out.push({ role: 'user', content: [{ type: 'text', text: clean }], source: { kind: 'user' }, at: Number.isFinite(at) ? at : null })
    } else if (ev.type === 'assistant/message') {
      const msg = ev.data?.message
      if (!msg) continue
      const text = (Array.isArray(msg.content) ? msg.content : []).filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('')
      if (!text.trim()) continue
      const clean = text.replace(/【这个房间的规矩】[\s\S]*$/, '').trim()
      if (!clean) continue
      const at = Number(ev.time)
      out.push({
        role: 'assistant',
        content: [{ type: 'text', text: clean }],
        source: { kind: 'model', provider: 'qq', model: 'history' },
        at: Number.isFinite(at) ? at : null,
      })
    }
  }
  return out.slice(-Math.max(1, limit))
}

/**
 * B 方案 seed：首条提示（handoff-note）+ 可选结构化简报（handoff-brief）+ 最近 N 条消息。
 * seq 连续、surfaceOp=append；messages 仍只计真实消息条数（不含提示与简报）。
 */
export function buildSeed(events = [], { limit = 50, now = () => Date.now(), brief = '' } = {}) {
  const msgs = collectRecentMessages(events, limit)
  const seed = []
  const time = now()
  const briefText = String(brief ?? '').trim()
  const push = (type, data) => {
    seed.push({ type, seq: seed.length, time, surfaceOp: 'append', data })
  }
  push('user/message', {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: HANDOFF_NOTE }],
    source: { kind: 'handoff-note' },
  })
  if (briefText) {
    push('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: briefText }],
      source: { kind: 'handoff-brief' },
    })
  }
  let turn = 1
  for (const m of msgs) {
    if (m.role === 'user') {
      push('user/message', { id: randomUUID(), role: 'user', content: m.content, source: { kind: 'user' } })
    } else {
      push('assistant/message', {
        turn,
        step: 1,
        stream: [],
        message: { id: randomUUID(), role: 'assistant', content: m.content, source: m.source },
      })
      turn += 1
    }
  }
  return {
    seed,
    messages: msgs.length,
    lastIsUser: msgs.length ? msgs[msgs.length - 1].role === 'user' : false,
    hasBrief: Boolean(briefText),
  }
}

/**
 * seed 不可用时的退化：一张不超过 maxChars 的交接卡。
 * 结构化简报放最前，后接【上次聊到】；简报为空时与旧行为完全一致。
 */
export function buildHandoffText(events = [], { maxChars = 12000, limit = 50, brief = '' } = {}) {
  const cap = (text) => [...String(text ?? '')].slice(0, Math.max(0, maxChars)).join('')
  const msgs = collectRecentMessages(events, limit)
  const briefText = String(brief ?? '').trim()
  if (!msgs.length) return briefText ? cap(briefText) : ''
  const head = briefText ? `${briefText}\n\n【上次聊到】\n` : '【上次聊到】\n'
  let body = head
  for (const m of msgs) {
    const line = `${m.role === 'user' ? '主人' : '你'}：${m.content.map((c) => c.text).join('')}\n`
    if ([...body].length + [...line].length > maxChars) break
    body += line
  }
  if (body.length > head.length) return cap(body.trimEnd())
  return briefText ? cap(briefText) : ''
}
