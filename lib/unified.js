/**
 * unified 模式（架构 A：home 是唯一私聊会话，桥只当 QQ 适配器）。
 *
 * - 开启后 QQ **私聊**入站不再建自己的会话，改调 `ctx.get('dyHome').deliver(...)`；
 * - QQ **群聊**仍走桥自己的独立房间（调用方不进来）；
 * - dyHome 缺失 → `E_HOME_UNAVAILABLE`，**绝不回退到自己建会话**（避免又分裂）；
 * - 第一次 deliver 带一次性 `handoverText`（旧 QQ 会话 2026-11-05 16:50 之后的消息）。
 */
import { buildChannelPrompt } from './prompt.js'

/** 投给 home 的正文：和旧投递一致的完整 prompt（人物头 + 正文 + ROOM_RULES）。 */
/** 只有「主人私聊」进 home；陌生私聊走各自房间。 */
export function shouldRouteToHome(parsed, { unified = false, ownerIds = [] } = {}) {
  if (!unified) return false
  if (parsed?.kind !== 'private') return false
  const id = String(parsed?.senderId || parsed?.contactId || '')
  if (!id) return false
  return parsed?.isOwner === true || ownerIds.map(String).includes(id)
}

export function buildUnifiedText(parsed, { mirrorEnabled = false } = {}) {
  // mode='send' 不会加「通道当前只读」那行；规则按 mirror 开关选 tool/mirror 版
  // 2026-11-12：home 交给 autonomy 把它挂成 systemPrompt 常驻上下文（首条带完整版，之后消息内剥掉）
  return buildChannelPrompt(parsed, { mode: 'send', mirrorEnabled, rulesMode: 'full' })
}

export function createUnified({ cfg = {}, store = null, getHome = () => null, handover = null, log = null } = {}) {
  const enabled = cfg.unified === true
  const ownerIds = (cfg.owner?.qqIds ?? []).map((x) => String(x))
  const stats = { delivered: 0, queued: 0, handoverSent: 0, homeUnavailable: 0, failed: 0, lastError: null, lastResult: null }

  async function deliver(parsed) {
    if (!enabled) return { ok: false, code: 'E_UNIFIED_OFF' }
    if (parsed?.kind !== 'private') return { ok: false, code: 'E_NOT_PRIVATE' }
    const home = getHome?.()
    if (!home || typeof home.deliver !== 'function') {
      stats.homeUnavailable += 1
      stats.lastError = 'E_HOME_UNAVAILABLE'
      log?.warn?.('[channel-bridge] unified：dyHome 不可用（E_HOME_UNAVAILABLE），不回退到自建会话')
      return { ok: false, code: 'E_HOME_UNAVAILABLE' }
    }
    // 主人消息最高优先级：生活侧按 owner 队列优先处理
    const isOwner = parsed.kind === 'private' && ownerIds.includes(String(parsed.contactId))
    const payload = {
      channel: parsed.channel ?? 'qq',
      kind: 'private',
      contactId: parsed.contactId,
      contactName: parsed.contactName,
      text: buildUnifiedText(parsed, { mirrorEnabled: cfg?.mirror?.enabled === true }),
      at: parsed.at,
      messageId: parsed.messageId,
      priority: isOwner ? 'owner' : 'normal',
    }
    let handoverText = ''
    try {
      handoverText = handover?.take?.() ?? ''
    } catch {}
    if (handoverText) payload.handoverText = handoverText
    try {
      const r = await home.deliver(payload)
      // 只有明确 delivered===true 才算送达；queued/failed 都不算，也绝不提前写 handover.done
      const summary = {
        delivered: r?.delivered === true,
        queued: r?.queued === true,
        ok: r?.ok,
        code: r?.code ?? null,
      }
      stats.lastResult = summary

      if (summary.delivered) {
        stats.delivered += 1
        if (handoverText) {
          stats.handoverSent += 1
          try {
            handover?.markDone?.()
          } catch {}
        }
        return { ok: true, code: 'DELIVERED_HOME', delivered: true, handover: Boolean(handoverText), result: r }
      }

      if (summary.queued) {
        stats.queued += 1
        log?.info?.('[channel-bridge] unified：home 已排队（queued），不标记交接完成；下一条入站会重新带交接文本')
        return { ok: true, code: 'QUEUED_HOME', queued: true, handover: Boolean(handoverText), result: r }
      }

      // ok:false / code / 返回值不明：都按失败记，不写 done、不重放（消息仍在 home 侧处理）
      stats.failed += 1
      stats.lastError = summary.code ?? 'E_HOME_UNCONFIRMED'
      log?.warn?.(`[channel-bridge] unified：home 未确认送达（${stats.lastError}），不写 handover.done、不重放`)
      return { ok: false, code: summary.code ?? 'E_HOME_UNCONFIRMED', handover: Boolean(handoverText), result: r }
    } catch (error) {
      stats.failed += 1
      stats.lastError = error?.message ?? String(error)
      stats.lastResult = { delivered: false, queued: false, ok: false, code: 'E_HOME_DELIVER_FAILED' }
      log?.warn?.(`[channel-bridge] unified：dyHome.deliver 失败：${stats.lastError}`)
      return { ok: false, code: 'E_HOME_DELIVER_FAILED', detail: stats.lastError }
    }
  }

  return { enabled, deliver, stats }
}
