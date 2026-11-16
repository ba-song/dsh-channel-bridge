/**
 * dsh-channel-bridge · 最小可用版（P1+P2+P3）
 *
 * 做两件事：
 *   1) 连 NapCat OneBot WS，收消息 → 去重 → 落 bridge.db → 按模式投递到渠道会话
 *   2) 提供 dy_say 工具：校验通过后走同一条 WS 真发（observe/deliver 不发）
 *
 * 不做：调模型、写记忆、建人设、ASR/图片富化、补收、轮换（P4/P5 再说）。
 * 默认 enabled=false：不注册进 profile 时它什么都不做。
 */
import { loadConfig, resolveToken, wsUrl } from './config.js'
import { createLog, createFileSink, truncate } from './log.js'
import { createMode } from './mode.js'
import { createDedupe, createInboundGate, dedupeKey } from './dedupe.js'
import { parseMessageEvent } from './parse.js'
import { openBridgeDb } from './store.js'
import { createBridgeClient } from './ws.js'
import { createSender } from './sender.js'
import { createOutbox } from './outbox.js'
import { createMirror } from './mirror.js'
import { createUnified } from './unified.js'
import { createHandover } from './handover.js'
import { createReplayDeliverer } from './replay-deliver.js'
import { createHealth } from './health.js'
import { createEchoGuard } from './echo.js'
import { shouldDeliverGroup } from './mention.js'
import { decideGroupSocial } from './group-social.js'
import { createSocialGate } from './social-gate.js'
import { shouldSkipPrivate } from './filters.js'
import { buildGroupContext } from './group-followup.js'
import { createGroupBuckets } from './group-buckets.js'
import { createGroupDigest } from './group-digest.js'
import { createGroupTurnMemory } from './group-turn-memory.js'
import { fetchPublicBrief } from './public-brief.js'
import { shouldRouteToHome } from './unified.js'
import { createReconciler } from './reconcile.js'
import { buildBridgeStatus } from './status.js'
import { createHash } from 'node:crypto'
import { createSessions } from './sessions.js'
import { createRouter } from './router.js'
import { registerTools } from './tools.js'
import { createMedia } from './media.js'
import { createQuoteResolver } from './quote.js'
import { createForwardReader, formatForward } from './forward.js'
import { parseNoticeEvent, describeNotice } from './notice.js'
import { createAuto } from './auto.js'
import { createReplay } from './replay.js'
import { buildSessionContext } from './context.js'
import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from './config.js'
import { collectStatus } from './console-status.js'
import { consoleHtml } from './console-page.js'

export const name = 'dsh-channel-bridge'
export const inject = ['tools', 'webServer']

/**
 * 设置页只认识 Config schema 里标了 `.volatile()` 的字段（dsh-settings 的
 * `volatileForm`/`isVolatilePath`），所以这里只声明：
 *   - profile 里现有的键（enabled/unified/mode/host/port/cwd/owner.qqIds），
 *   - 设置卡片暴露的 3 个字段（mode、say.maxLen、group.followUpIdleMs）。
 * 未声明的键走 schemastery 的非 strict 合并原样保留，loadConfig 继续按 DEFAULTS 清洗，
 * 运行时行为不变（apply 仍然只是 loadConfig(raw)）。
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  unified: z.boolean().default(DEFAULTS.unified),
  mode: z
    .union([z.const('observe'), z.const('deliver'), z.const('send')])
    .default(DEFAULTS.mode)
    .volatile(),
  host: z.string().default(DEFAULTS.host),
  port: z.number().default(DEFAULTS.port),
  cwd: z.string().default(DEFAULTS.cwd),
  owner: z.object({
    qqIds: z.array(z.string()).default([]),
  }),
  say: z.object({
    maxLen: z.number().default(DEFAULTS.say.maxLen).volatile(),
  }),
  group: z.object({
    requireMention: z.boolean().default(DEFAULTS.group.requireMention).volatile(),
    followUpMessages: z.number().default(DEFAULTS.group.followUpMessages).volatile(),
    followUpIdleMs: z.number().default(DEFAULTS.group.followUpIdleMs).volatile(),
    social: z.object({
      enabled: z.boolean().default(false).volatile(),
      maxCount: z.number().default(DEFAULTS.group.social.maxCount),
      silentAfterMessages: z.number().default(DEFAULTS.group.social.silentAfterMessages),
      closeAfterMessages: z.number().default(DEFAULTS.group.social.closeAfterMessages),
    }).default({}),
  }),
})

const maskId = (id) => {
  const s = String(id ?? '')
  return s.length <= 2 ? '**' : `${'*'.repeat(Math.max(0, s.length - 2))}${s.slice(-2)}`
}

export function apply(ctx, raw = {}) {
  const cfg = loadConfig(raw)
  const fileSink = cfg.log?.file ? createFileSink(cfg.log.file, { maxBytes: cfg.log.maxBytes }) : null
  const log = createLog({
    logger: ctx?.logger ?? console,
    sink: fileSink,
    textMax: cfg.log.textMax,
    throttleMs: cfg.log.throttleMs,
  })

  for (const w of cfg.tools?.warnings ?? []) log.warn(`[channel-bridge] 配置 ${w}`)

  if (!cfg.enabled) {
    log.info('[channel-bridge] 未启用（enabled:false）：不连 WS、不注册工具、不建库。')
    return
  }

  let store
  try {
    store = openBridgeDb(cfg.dbPath, { log })
  } catch (error) {
    log.error(`[channel-bridge] bridge.db 打不开（fail-closed，不启动）：${error?.message ?? error}`)
    return
  }

  const mode = createMode({ file: cfg.modeFile, initial: cfg.mode, hotSwitch: cfg.modeHotSwitch, log })
  const dedupe = createDedupe({ max: cfg.dedupeMax })
  const gate = createInboundGate({ store, dedupe })
  const echoGuard = createEchoGuard({ windowMs: cfg.echoWindowMs ?? 3000 })
  const groupDigest = createGroupDigest({
    getMemory: () => {
      try {
        return ctx.get?.('dyMemory') ?? null
      } catch {
        return null
      }
    },
    log,
  })
  const groupBuckets = createGroupBuckets({
    digest: groupDigest,
    log,
    messages: cfg.group?.followUpMessages ?? 8,
    idleMs: cfg.group?.followUpIdleMs ?? 300000,
  })
  function bucketForGroup(groupId, groupName = '') {
    return groupBuckets.get(groupId, groupName)
  }
  const noteGroupMessage = (bucket, msg) => groupBuckets.noteMessage(bucket, msg)
  // 群聊轮次记忆：每轮群友消息 + 她的回复 → dyMemory.saveGroupTurn（多段 15s 内合并一次）
  const groupTurnMemory = createGroupTurnMemory({
    getMemory: () => {
      try {
        return ctx.get?.('dyMemory') ?? null
      } catch {
        return null
      }
    },
    getBucket: (id) => bucketForGroup(id),
    log,
    idleMs: cfg.groupMemory?.flushIdleMs ?? 15000,
    enabled: cfg.groupMemory?.enabled === true,
  })
  const textHash = (text) => createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 8)
  const lastSessionByContact = new Map()
  const token = resolveToken(cfg)

  const getAgents = () => {
    try {
      return ctx?.get?.('agents') ?? null
    } catch {
      return null
    }
  }
  const getModel = () => {
    try {
      return ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null
    } catch {
      return null
    }
  }

  const getMemory = () => {
    try {
      return ctx?.get?.('dyMemory') ?? null
    } catch {
      return null
    }
  }

  const sessions = createSessions({ getAgents, getModel, store, cfg, log, getMemory })
  const media = createMedia({
    cfg,
    log,
    getClient: () => client,
    getMedia: () => {
      try {
        return ctx.get?.('dyMedia') ?? null
      } catch {
        return null
      }
    },
    // 2026-11-16：群聊图片直投用（把第一张图存进 DSH attachment 服务）
    getAttachments: () => {
      try {
        return ctx.get?.('attachments') ?? null
      } catch {
        return null
      }
    },
  })
  const sender = createSender({ getClient: () => client, log, styleClean: cfg.styleClean, styleBanned: cfg.styleBanned })

  // 引用富化（2026-11-16）：reply 段只有 message_id，用 get_msg 反查被引用原文。
  // 失败只丢引用、不影响正文；补收（replay）不查，省一次调用。
  const quoteResolver = createQuoteResolver({ getClient: () => client, log, timeoutMs: cfg.quote?.timeoutMs ?? 3000 })
  // 合并转发读取（2026-11-16）：forward 段只有 res_id，正文要调 get_forward_msg
  const forwardReader = createForwardReader({ getClient: () => client, log, timeoutMs: cfg.forward?.timeoutMs ?? 3000 })
  const enrichInbound = async (parsed) => {
    // 群聊才直投图片（私聊走 dyHome，只收文本）；可在配置 images.inline=false 关掉
    const inline = cfg.images?.inline !== false && parsed?.kind === 'group'
    const extra = await media.enrich(parsed, { inline })
    if (parsed?.replyId && !parsed?.quote && !parsed?.replay) {
      const quote = await quoteResolver.resolve(parsed.replyId, { selfId: cfg.selfId || '' })
      if (quote) {
        extra.quote = quote
        log?.info?.(`[channel-bridge] 引用已解析（reply=${parsed.replyId} → quote=${quote.messageId}）`)
      }
    }
    if (parsed?.forwardId && !parsed?.forward && !parsed?.replay) {
      const fwd = await forwardReader.resolve({ id: parsed.forwardId })
      if (fwd) {
        extra.forward = fwd
        log?.info?.(`[channel-bridge] 合并转发已解析（forward=${parsed.forwardId} → ${fwd.nodes.length} 条）`)
      }
    }
    return extra
  }

  // 2026-11-14：给 autonomy 的真实 send_qq 执行器提供受控外发口；mode!==send 一律拒绝
  try {
    ctx.provide?.('dyChannel', {
      version: 1,
      mode: () => mode.current(),
      canSend: () => mode.current() === 'send',
      sendText: async ({ kind = 'private', contactId, text } = {}) => {
        if (mode.current() !== 'send') return { ok: false, code: 'MODE_NOT_SEND' }
        return sender.sendText({ kind, contactId, text })
      },
    })
  } catch (e) { log.warn?.(`[channel-bridge] dyChannel 提供失败：${e?.message ?? e}`) }
  const socialGate = createSocialGate()
  const auto = createAuto({ cfg, store, sender, log })
  const router = createRouter({
    store,
    sessions,
    mode,
    log,
    maxQueue: cfg.maxQueue,
    timeZoneOffsetMinutes: cfg.replay?.timeZoneOffsetMinutes ?? 480,
    enrich: (parsed) => enrichInbound(parsed),
    contextBuilder: () => buildSessionContext({ store, cfg }),
    outbound: cfg.outbound,
    mirrorEnabled: cfg.mirror?.enabled === true,
    relationship: cfg.relationship,
    getPublicBrief: () =>
      fetchPublicBrief({
        getMemory: () => {
          try {
            return ctx.get?.('dyMemory') ?? null
          } catch {
            return null
          }
        },
        limit: cfg.group?.publicBriefLimit ?? 3,
        log,
      }),
    getGroupContext: (p) =>
      buildGroupContext({
        getClient: () => client,
        groupId: p.contactId,
        count: cfg.group?.contextCount ?? 8,
        excludeMessageId: p.messageId,
        selfId: cfg.selfId || '',
        ownerIds: cfg.owner?.qqIds ?? [],
        fallback: ({ n }) =>
          (store.recentInboundAsc?.({ channel: 'qq', limit: n + 1 }) ?? [])
            .filter((r) => String(r.kind) === 'group')
            .map((r) => ({ id: null, sender: '', text: String(r.text ?? '') })),
        log,
      }),
    onDelivered: (payload) => auto.noteDelivery(payload),
  })
  const outbox = createOutbox({ file: cfg.outboxFile })
  const mirror = createMirror({ store, log, cfg })
  const handover = createHandover({ cfg, store, log })
  const unified = createUnified({
    cfg,
    store,
    handover,
    log,
    getHome: () => {
      try {
        return ctx.get?.('dyHome') ?? null
      } catch {
        return null
      }
    },
  })

  let client = null
  const health = createHealth({
    silentMs: cfg.health?.silentMs ?? 1800000,
    warnEveryMs: cfg.health?.warnEveryMs ?? 300000,
    retryMs: cfg.health?.retryMs ?? 300000,
    log,
    hasHistory: () => {
      try {
        return (store.counts?.().inbound ?? 0) > 0
      } catch {
        return false
      }
    },
    forceReconnect: () => client?.forceReconnect?.('假在线：长时间没有 message 事件') === true,
  })

  /** 对账投递：和实时同一条路（unified → home；否则自己的会话）。 */
  async function deliverReconciled(parsed) {
    if (shouldRouteToHome(parsed, { unified: unified.enabled, ownerIds: cfg.owner?.qqIds ?? [] })) {
      const r = await unified.deliver(parsed)
      if (r?.ok) {
        health.noteMessage() // 对账拉到新消息 = 对端其实有消息，复位 SILENT
        return { ok: true, delivered: Boolean(r.delivered) }
      }
      return { ok: false, code: r?.code ?? 'E_HOME_UNAVAILABLE' }
    }
    const v = router.deliver(parsed)
    if (v === 'QUEUED') {
      health.noteMessage()
      return { ok: true }
    }
    return { ok: false, code: v }
  }

  const reconciler = createReconciler({
    cfg,
    store,
    getClient: () => client,
    deliverOne: deliverReconciled,
    onMessage: () => health.noteMessage(),
    log,
  })

  /** 补收计数：unified 走 home，其余走旧会话（legacy 应为 0 才算切干净）。 */
  const replayCounters = { homeDelivered: 0, legacyDelivered: 0, dupSkipped: 0 }
  const deliverReplayBase = createReplayDeliverer({ unified, ownerIds: cfg.owner?.qqIds ?? [], store, router, log, counters: replayCounters })

  /** 补收专用投递：先二次查重，再按 unified/legacy 路由。 */
  function deliverReplay(parsed) {
    if (parsed?.messageId && store.hasMessageId?.(parsed.messageId)) {
      log.warn(`[channel-bridge] 补收跳过已存在的消息 ${parsed.messageId}`)
      return 'QUEUE_FULL'
    }
    return deliverReplayBase(parsed)
  }

  const replay = createReplay({ cfg, store, getClient: () => client, deliver: deliverReplay, mode, log })

  async function onOpen() {
    try {
      const res = await client.call('get_login_info', {}, { timeoutMs: 8000 })
      const id = res?.data?.user_id
      const nick = res?.data?.nickname
      if (id && !cfg.selfId) cfg.selfId = String(id)
      log.info(`[channel-bridge] 自检 get_login_info：user_id=${maskId(id)} nickname=${nick ?? '-'}`)
    } catch (error) {
      log.warn(`[channel-bridge] 自检失败（${error?.code ?? error?.message ?? error}）：先只收不发`)
    }
    log.info(`[channel-bridge] 当前模式：${mode.current()}`)
    try {
      await replay.replayOnConnect()
    } catch (error) {
      log.warn(`[channel-bridge] 补收异常（不影响收消息）：${error?.message ?? error}`)
    }
  }

  // ---------- notice 事件（2026-11-16）：撤回/拍一拍/进群退群/禁言/管理员/群文件/好友添加 ----------
  const NOTICE_DELIVER_DEFAULT = ['friend_recall', 'poke', 'friend_add', 'group_recall']
  function handleNotice(evt) {
    if (cfg.notices?.enabled === false) return
    const n = parseNoticeEvent(evt)
    if (!n) {
      log.counters.noticeUnknown = (log.counters.noticeUnknown ?? 0) + 1
      return
    }
    log.counters.notices = (log.counters.notices ?? 0) + 1
    const isGroup = Boolean(n.groupId)
    const kind = isGroup ? 'group' : 'private'
    const contactId = String(isGroup ? n.groupId : n.userId || n.targetId || '')
    const text = describeNotice(n)
    try {
      store.insertEvent({
        at: n.at,
        channel: 'qq',
        kind,
        contact: contactId,
        senderId: String(n.userId || ''),
        direction: 'notice',
        text,
        meta: { noticeKind: n.kind, subType: n.subType, messageId: n.messageId },
      })
    } catch (error) {
      log.warn(`[channel-bridge] notice 落库失败：${error?.message ?? error}`)
    }
    const deliverKinds = new Set(Array.isArray(cfg.notices?.deliver) ? cfg.notices.deliver : NOTICE_DELIVER_DEFAULT)
    if (!deliverKinds.has(n.kind)) {
      log.throttled(`notice:${n.kind}`, `[channel-bridge] notice 仅记录：${n.kind} ${kind}:${contactId}「${text}」`)
      return
    }
    // 群里的撤回/拍一拍：只有跟话窗口开着才投（避免噪音烧回合）
    if (isGroup && ['group_recall', 'poke'].includes(n.kind)) {
      const bucket = bucketForGroup(contactId)
      if (!bucket?.window?.isOpen?.()) return
    }
    // 私聊 notice：只投主人相关（friend_add 例外——提醒有人加她）
    if (!isGroup && n.kind !== 'friend_add') {
      const owners = (cfg.owner?.qqIds ?? []).map(String)
      if (owners.length && !owners.includes(String(n.userId ?? ''))) return
    }
    let contactName = ''
    try {
      contactName = String(store.contactOf?.('qq', contactId, kind)?.name ?? '')
    } catch {}
    const parsed = {
      channel: 'qq',
      kind,
      contactId,
      contactName: contactName || (isGroup ? `群_${contactId}` : ''),
      senderId: String(n.userId || ''),
      senderName: String(n.userId || ''),
      text: `[系统] ${text}`,
      at: n.at,
      isOwner: false,
      messageId: '',
      notice: true,
    }
    log.info(`[channel-bridge] notice 投递：${n.kind} ${kind}:${contactId}「${text}」`)
    if (!isGroup && unified.enabled) {
      void unified
        .deliver(parsed)
        .catch((error) => log.warn(`[channel-bridge] notice 投递 home 失败：${error?.message ?? error}`))
    } else {
      router.deliver(parsed)
    }
  }

  function onEvent(evt) {
    log.counters.events += 1
    if (String(evt?.post_type ?? '') === 'notice') {
      handleNotice(evt)
      return
    }
    if (String(evt?.post_type ?? '') !== 'message') {
      log.counters.notMessage += 1
      return
    }
    const parsed = parseMessageEvent(evt, {
      selfId: cfg.selfId || String(evt?.self_id ?? ''),
      owner: cfg.owner,
      channel: cfg.channel,
    })
    if (!parsed) {
      log.counters.parseFail += 1
      return
    }
    // 只有真正的 message 事件才算「对端在推消息」；meta/heartbeat 不算
    health.noteMessage()
    const accepted = gate.accept(evt, parsed)
    if (!accepted.ok) {
      log.counters.dup += 1
      if (accepted.reason === 'dup-db') log.throttled('dup-db', `[channel-bridge] 重复消息（库里已有 message_id=${parsed.messageId}），跳过投递`)
      return
    }
    // 短窗回声：同 contact + 同文本 + ≤3 秒 → 判为 SL 回声，不投不落库
    if (echoGuard.isEcho(parsed)) {
      log.counters.echoSkipped += 1
      log.warn(
        `[channel-bridge] 回声跳过：${parsed.channel}/${parsed.kind}/${parsed.contactId} messageId=${parsed.messageId || '-'} textHash=${textHash(parsed.text)} at=${new Date(parsed.at).toISOString()}`,
      )
      return
    }
    // 非主人私聊的纯占位卡片（如 QQ 邮箱提醒）不投：真实邮件由 IMAP 单独进
    const skip = shouldSkipPrivate(parsed, cfg.filters ?? {})
    if (skip.skip) {
      log.counters.cardSkipped += 1
      log.info(`[channel-bridge] 卡片/占位跳过：${parsed.channel}/${parsed.kind}/${parsed.contactId}（${skip.reason}）"${truncate(parsed.text, 40)}"`)
      return
    }

    log.counters.inbound += 1
    log.throttled(
      `in:${parsed.channel}:${parsed.contactId}`,
      `[channel-bridge] ${parsed.channel} · ${parsed.kind === 'group' ? '群' : '私聊'} · ${parsed.contactName}(${parsed.contactId}) · "${truncate(parsed.text, cfg.log.textMax)}"` +
        ` [messageId=${parsed.messageId || '-'} textHash=${textHash(parsed.text)} at=${new Date(parsed.at).toISOString()}]`,
    )

    try {
      store.insertEvent({
        at: parsed.at,
        channel: parsed.channel,
        kind: parsed.kind,
        contact: parsed.contactId,
        senderId: parsed.senderId,
        direction: 'in',
        text: truncate(parsed.text, cfg.textStoreMax),
        messageId: parsed.messageId,
      })
      store.upsertContact({
        channel: parsed.channel,
        contact: parsed.contactId,
        kind: parsed.kind,
        name: parsed.contactName,
        at: parsed.at,
        isOwner: parsed.isOwner === true,
      })
    } catch (error) {
      log.warn(`[channel-bridge] 入站落库失败：${error?.message ?? error}`)
    }

    // 群消息门禁：@ 或被「跟话窗口」覆盖才回（私聊不受影响）
    if (parsed.kind === 'group') {
      const bucket = bucketForGroup(parsed.contactId, parsed.contactName)
      const followUp = bucket.window
      const gateRes = shouldDeliverGroup(parsed, {
        requireMention: cfg.group?.requireMention !== false,
        selfId: cfg.selfId || String(evt?.self_id ?? ''),
        mentionNames: cfg.group?.mentionNames ?? [],
      })
      const mentionMode = cfg.group?.requireMention !== false
      let viaWindow = false
      if (!gateRes.ok) {
        // 被 @ 过、窗口还开着 → 不用 @ 也投，并消耗一条
        if (mentionMode && followUp.isOpen()) {
          // 先记进摘要 buffer，再消耗（消耗可能关窗并触发摘要）
          noteGroupMessage(bucket, {
            speaker: parsed.senderName || parsed.contactName || String(parsed.senderId ?? ''),
            text: parsed.text,
            at: parsed.at,
          })
          viaWindow = followUp.consume()
        }
        if (!viaWindow) {
          log.counters.groupMentionSkipped += 1
          if (mentionMode) log.counters.groupFollowUpSkipped += 1
          const why = gateRes.reason === 'at-other' ? '这条 @ 的是别人' : gateRes.reason === 'no-self' ? 'selfId 未知（保守不回）' : '没 @ 她'
          log.info(`[channel-bridge] 群消息不投：${why}（group=${parsed.contactId} from=${parsed.senderId}）`)
          if (gateRes.warn) log.warn('[channel-bridge] selfId 缺失：群消息一律不投（等 get_login_info/配置补上）')
          return
        }
      } else if (mentionMode && gateRes.reason === 'at-bot') {
        followUp.open() // @ 命中：开/续窗口
        parsed.wantGroupContext = true
        // 窗口内消息（含 @ 那条）留档给关窗摘要；只进 home 记忆，不回群
        noteGroupMessage(bucket, {
          speaker: parsed.senderName || parsed.contactName || String(parsed.senderId ?? ''),
          text: parsed.text,
          at: parsed.at,
        })
      }
      if (viaWindow) parsed.viaFollowUp = true
    }

    // 2026-11-13：群聊社交策略（默认关；只做“说不说”这一层）
    if (parsed.kind === 'group' && cfg.group?.social?.enabled === true) {
      const d = decideGroupSocial({ parsed, cfg: { enabled: true, social: cfg.group.social }, recent: 0 })
      if (!d.speak) {
        log.info(`[channel-bridge] 群社交沉默（${d.reason}）：group=${parsed.contactId}`)
        return
      }
      parsed.socialCount = d.count
      parsed.socialQuote = d.quote
      parsed.socialClose = d.close
      socialGate.arm({ kind: 'group', contactId: parsed.contactId, max: d.count, quote: d.quote, close: d.close })
    }

    // unified：只有「主人私聊」进 home；陌生私聊走各自房间（private:<QQ>）
    if (shouldRouteToHome(parsed, { unified: unified.enabled, ownerIds: cfg.owner?.qqIds ?? [] })) {
      void (async () => {
        // 附件先落盘：她拿到绝对路径才能 read_image / 听语音
        try {
          const m = await enrichInbound(parsed)
          if (Array.isArray(m?.attachments) && m.attachments.length) parsed.attachments = m.attachments
          if (m?.quote) parsed.quote = m.quote
          if (m?.forward) parsed.forward = m.forward
          if (m?.inlineImage) parsed.inlineImage = m.inlineImage
        } catch (error) {
          log.warn(`[channel-bridge] unified 附件落盘失败（按原样投）：${error?.message ?? error}`)
        }
        return unified.deliver(parsed)
      })()
        .then((r) => {
          const sid = r?.result?.sessionId ?? r?.sessionId ?? null
          const key = `${parsed.channel}/${parsed.kind}/${parsed.contactId}`
          const firstInSession = sid ? lastSessionByContact.get(key) !== sid : false
          if (sid) lastSessionByContact.set(key, sid)
          const tag = `messageId=${parsed.messageId || '-'} sessionId=${sid ?? '-'} firstInSession=${firstInSession}`
          if (!r.ok) log.warn(`[channel-bridge] unified 投递未成功：${r.code}（不重放，交 home 侧重试） ${tag}`)
          else if (r.queued) log.info(`[channel-bridge] unified：home 已排队（queued），交接未标记，下一条会再带 ${tag}`)
          else log.info(`[channel-bridge] unified：已投递 home${r.handover ? '（带一次性交接文本）' : ''} ${tag}`)
        })
        .catch((error) => log.warn(`[channel-bridge] unified 异常：${error?.message ?? error}`))
      return
    }

    const verdict = router.deliver(parsed)
    if (verdict === 'QUEUED') log.counters.delivered += 0 // 真正计数在 router
  }

  client = createBridgeClient({
    url: wsUrl(cfg),
    token,
    reconnect: cfg.reconnect,
    health: cfg.health,
    log,
    onEvent,
    onOpen,
  })

  const sessionKeysMasked = () => {
    try {
      const rows = store.listSessions?.('qq') ?? []
      return rows.map((r) => {
        const k = String(r.kind ?? '')
        const i = k.indexOf(':')
        if (i < 0) return k
        return `${k.slice(0, i)}:***${k.slice(i + 1).slice(-4)}`
      })
    } catch {
      return []
    }
  }

  const statusProvider = () =>
    buildBridgeStatus({
      clientStatus: client.status(),
      mode,
      cfg,
      log,
      router,
      store,
      media,
      replay,
      replayCounters,
      handover,
      unified,
      mirror,
      auto,
      sessions,
      health,
      reconcile: reconciler.stats,
      followUp: { open: groupBuckets.anyOpen() },
      sessionKeys: sessionKeysMasked(),
    })

  registerTools({
    tools: ctx.get?.('tools'),
    cfg,
    mode,
    sender,
    store,
    router,
    log,
    status: statusProvider,
    outbound: cfg.outbound,
    mirrorEnabled: cfg.mirror?.enabled === true,
    onSent: (payload) => {
      if (payload?.kind === 'group') {
        const bucket = bucketForGroup(payload.contactId)
        bucket.window.renew()
        noteGroupMessage(bucket, { speaker: '汐', text: payload.text, at: Date.now() })
        groupTurnMemory.noteReply({
          groupId: payload.contactId,
          groupName: bucket?.meta?.groupName ?? '',
          text: payload.text,
        })
      }
      auto.noteToolSend(payload)
    },
    outbox,
    mirror,
    sessions,
    getMail: () => {
      try {
        return ctx.get?.('dyMail') ?? null
      } catch {
        return null
      }
    },
  })
  client.start()
  reconciler.start()

  const healthTimer = setInterval(() => {
    try {
      health.check({ opened: Boolean(client?.opened) })
    } catch (error) {
      log.warn(`[channel-bridge] 健康检查异常：${error?.message ?? error}`)
    }
  }, cfg.health?.checkMs ?? 60000)
  healthTimer?.unref?.()

  const statsTimer = setInterval(() => {
    const c = log.counters
    const s = store.counts?.() ?? {}
    log.info(
      `[channel-bridge] 统计：事件 ${c.events}（消息 ${c.inbound}、非消息 ${c.notMessage}、重复 ${c.dup}、解析失败 ${c.parseFail}）` +
        ` 投递 ${router.stats.delivered}/${router.stats.queued} 失败 ${router.stats.deliverFail} 静默 ${router.stats.silent}` +
        ` | 富化：附件 ${media.stats.saved} 落地/${media.stats.failed} 失败，上下文 ${router.stats.contextAdded} 次` +
        ` | 补收：投递 ${replay.stats.delivered}（拉 ${replay.stats.fetched}，跳 ${replay.stats.skipped}，失败 ${replay.stats.failed}）` +
        ` | 库：事件 ${s.events ?? 0}（入 ${s.inbound ?? 0} 出 ${s.out ?? 0} 静默 ${s.silent ?? 0}）联系人 ${s.contacts ?? 0} 会话 ${s.sessions ?? 0}`,
    )
  }, cfg.log.statsMs)
  statsTimer?.unref?.()

  // 2026-11-13：汐控制台（只读状态；设置仍走 DSH 设置页）
  try {
    const ws = ctx.get?.('webServer') ?? ctx.webServer
    if (ws && typeof ws.register === 'function') {
      ws.register({
        kind: 'get', path: '/xi-console',
        handler: async (req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(consoleHtml()) },
      })
      ws.register({
        kind: 'get', path: '/api/xi-console/status',
        handler: async (req, res) => {
          const data = collectStatus()
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(data))
        },
      })
      // 2026-11-14：webserver 的路由表只按 path 去重、不区分 method，
      // GET/POST 分两条注册必然报 duplicate（之前控制台设置页保存因此失效）。
      // 合并成一条 exact 路由，按 req.method 分发。
      ws.register({
        kind: 'exact', path: '/api/xi/settings',
        handler: async (req, res) => {
          if (req.method === 'POST') {
            const settings = ctx.get?.('settings')
            if (!settings || typeof settings.mutate !== 'function') { res.statusCode = 503; res.end('{"ok":false,"error":"settings-unavailable"}'); return }
            const body = await new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 200_000) req.destroy() }); req.on('end', () => resolve(b)); req.on('error', () => resolve('')) })
            let payload = null
            try { payload = JSON.parse(body) } catch {}
            if (!payload?.ns || !Array.isArray(payload.operations)) { res.statusCode = 400; res.end('{"ok":false,"error":"bad-body"}'); return }
            try {
              await settings.mutate(String(payload.ns), payload.operations, payload.revision)
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.end('{"ok":true}')
            } catch (e) {
              res.statusCode = 409
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 300) }))
            }
            return
          }
          const settings = ctx.get?.('settings')
          if (!settings || typeof settings.describe !== 'function') { res.statusCode = 503; res.end('{"ok":false,"error":"settings-unavailable"}'); return }
          const rows = settings.describe().filter((r) => ['persona-core', 'memory-core', 'autonomy'].includes(r.ns))
            .map((r) => ({ ns: r.ns, value: r.value, revision: r.revision }))
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, rows }))
        },
      })
    }
  } catch (e) { log.warn?.(`[channel-bridge] 控制台注册失败：${e?.message ?? e}`) }

  const dispose = () => {
    try {
      groupTurnMemory.dispose()
    } catch {}
    try {
      reconciler.stop()
    } catch {}
    try {
      clearInterval(healthTimer)
    } catch {}
    try {
      clearInterval(statsTimer)
    } catch {}
    try {
      client.stop()
    } catch {}
    try {
      router.dispose()
    } catch {}
    try {
      store.close()
    } catch {}
  }
  try {
    ctx.on?.('dispose', dispose)
  } catch {}

  return dispose
}
