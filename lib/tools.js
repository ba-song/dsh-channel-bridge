/**
 * 工具：`dy_say(channel, contactId, kind, text)`。
 * 审计只记长度/渠道/联系人/模式，不记正文（silent 只记 reason）。
 */
import { validateSay } from './say.js'
import {
  validateMessageId,
  validateForwardTarget,
  validateFriendAction,
  presentFriendRequests,
} from './qq-admin.js'
import {
  validateImagePath,
  buildImageSegments,
  validateVoicePath,
  buildVoiceSegments,
  validateAvatarPath,
  buildAvatarFile,
  sanitizeResult,
  validateFaceId,
  validateTarget,
  createRateLimiter,
  planProfile,
  validateOnlineStatus,
  validateFileToSend,
  validateVideoPath,
  validateForwardItems,
  validateEmojiId,
  IMAGE_DIRS,
  IMAGE_MAX_BYTES,
} from './qq-actions.js'
import { buildForwardNodes } from './forward.js'
import { splitForSend } from './split.js'
import { loadStickerIndex, rankStickers, searchStickers } from './stickers.js'
import { readFileSync } from 'node:fs'

const OUT = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['ok', 'detail'],
  additionalProperties: false,
}

const pack = (obj) => ({ ok: obj?.ok !== false, detail: JSON.stringify(obj) })
const render = (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }]

export const SAY_PARAMETERS = {
  type: 'object',
  properties: {
    channel: { type: 'string', enum: ['qq', 'email'], description: '渠道：qq（默认）/ email（抖音暂未开放）' },
    contactId: { type: 'string', description: 'QQ 号/群号（qq）或邮箱地址（email）' },
    kind: { type: 'string', enum: ['private', 'group'], description: 'qq 必填：private=私聊，group=群' },
    subject: { type: 'string', description: '仅 email：主题（默认「汐的邮件」）' },
    replyTo: { type: 'string', description: '可选：要引用的 QQ 消息 id（message_id，可负），只给第一段带引用' },
    text: { type: 'string', description: '要说的话；写 [SILENT] 表示这一轮不接话' },
  },
  required: ['channel', 'contactId', 'text'],
  additionalProperties: false,
}

export function registerTools({ tools, cfg, mode, sender, store, router = null, log = null, status = null, outbound = 'tool', onSent = null, outbox = null, mirror = null, sessions = null, getMail = () => null, socialGate = null, forwardReader = null, now = () => Date.now() }) {
  const reg = (def) => {
    try {
      tools.register(def)
      return true
    } catch (error) {
      log?.warn?.(`[channel-bridge] 注册 ${def.name} 失败：${error?.message ?? error}`)
      return false
    }
  }

  reg({
    name: 'dy_say',
    description:
      '把一句话真的发出去。channel=qq 时发 QQ（contactId 是号码，kind 是 private/group）；channel=email 时发邮件给主人（contactId 是主人邮箱，subject 可选）。' +
      '不想接话就把 text 写成 [SILENT]（不发任何东西）。' +
      '返回值里 parts 是你实际要说/已发出的原文（每段一条）；delivered:false 表示没发出去，原文已经留底，主人能在本地看到。',
    parameters: SAY_PARAMETERS,
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      if (outbound === 'auto') {
        return pack({ ok: false, code: 'E_AUTO_MODE', message: '当前是自动发送模式：直接写正文即可，dy_say 已停用（防双发）' })
      }
      const m = mode.current()
      const channelArg = String(args.channel ?? 'qq')
      if (channelArg === 'email') {
        const v = validateSay(
          { ...args, channel: 'email' },
          { mode: m, maxEmailChars: cfg.mail?.maxTextChars ?? 5000 },
        )
        if (!v.ok) {
          log?.info?.(`[channel-bridge] dy_say(email) 拒绝（${v.code}）：${String(v.detail ?? '').slice(0, 80)}`)
          return pack({ ok: false, code: v.code, message: v.detail, channel: 'email' })
        }
        if (v.silent) return pack({ ok: true, channel: 'email', delivered: false, silent: true })
        const mail = getMail?.()
        if (!mail || typeof mail.send !== 'function') {
          return pack({ ok: false, code: 'E_CHANNEL_UNAVAILABLE', message: 'dyMail 服务不可用（生活侧没提供）', channel: 'email' })
        }
        const to = String(args.contactId)
        let owners = []
        try {
          owners = (await mail.ownerAddresses?.()) ?? []
        } catch {
          owners = []
        }
        const lower = owners.map((x) => String(x).toLowerCase())
        if (!lower.includes(to.toLowerCase())) {
          return pack({ ok: false, code: 'E_NOT_OWNER', message: `只能发给主人的邮箱（白名单 ${owners.length} 个）`, channel: 'email' })
        }
        const subject = String(args.subject ?? '汐的邮件')
        let res = null
        try {
          res = await mail.send({ to, subject, body: String(args.text) }) // 失败不重试
        } catch (error) {
          return pack({ ok: false, code: 'E_SEND_FAILED', message: error?.message ?? String(error), channel: 'email' })
        }
        const delivered = res?.delivered === true || res?.ok === true
        if (!delivered) {
          return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: '邮件未送达（未重试）', channel: 'email' })
        }
        try {
          store?.insertEvent?.({ at: now(), channel: 'email', kind: 'private', contact: to, direction: 'out', text: `[邮件] ${subject}` })
        } catch {}
        return pack({ ok: true, channel: 'email', delivered: true, to, subject })
      }

      const deps = {
        mode: m,
        ownerIds: cfg.owner?.qqIds ?? [],
        maxTextChars: cfg.say?.maxTextChars ?? 2000,
        windowMs: cfg.say?.contactWindowMs ?? 7 * 24 * 60 * 60 * 1000,
        now,
        contactOf: (channel, contactId, kind) => store?.contactOf?.(channel, contactId, kind) ?? null,
      }
      const v = validateSay(args, deps)
      if (!v.ok) {
        log?.info?.(`[channel-bridge] dy_say 拒绝（${v.code}）：${String(v.detail ?? '').slice(0, 80)}`)
        return pack({ ok: false, code: v.code, message: v.detail, mode: m })
      }

      const parsed = {
        channel: String(args.channel),
        kind: String(args.kind),
        contactId: String(args.contactId),
        contactName: '',
        at: now(),
      }

      if (v.silent) {
        if (router) router.noteSilent(parsed, 'explicit')
        else {
          try {
            store?.insertEvent?.({
              at: now(),
              channel: parsed.channel,
              kind: parsed.kind,
              contact: parsed.contactId,
              direction: 'silent',
              meta: { reason: 'explicit' },
            })
          } catch {}
        }
        return pack({ ok: true, code: 'SILENT', mode: m, delivered: false, silent: true, parts: [] })
      }

      // 2026-11-13：群社交发送闸（默认关；由 index 在群里 arm）
      if (parsed.kind === 'group' && socialGate) {
        const g = socialGate.take({ kind: 'group', contactId: parsed.contactId })
        if (!g.ok) {
          log?.info?.(`[channel-bridge] 群社交限流：group=${parsed.contactId} 本轮已达上限`)
          return pack({ ok: false, code: 'E_SOCIAL_LIMIT', message: '这轮群消息已达社交策略上限，不再发', mode: m })
        }
      }

      const fullText = String(args.text)
      const segments = splitForSend(fullText, {
        maxLen: cfg.say?.maxLen ?? 60,
        maxSegments: cfg.say?.maxSegments ?? 4,
      })
      const parts = (segments.length ? segments : [fullText]).map((t, i) => ({ index: i, text: t, ok: false }))
      const messageIds = []
      let failCode = null
      let failDetail = null

      for (const part of parts) {
        const res = await sender.sendText({
          kind: parsed.kind,
          contactId: parsed.contactId,
          text: part.text,
          replyTo: part.index === 0 ? String(args.replyTo ?? '') : '',
        })
        if (!res?.ok) {
          failCode = res?.code === 'E_NOT_CONNECTED' ? 'E_OFFLINE' : (res?.code ?? 'E_SEND_FAILED')
          failDetail = res?.detail ?? null
          log?.warn?.(`[channel-bridge] dy_say 发送失败（${failCode}，第 ${part.index + 1}/${parts.length} 段），原文已留底`)
          break
        }
        part.ok = true
        messageIds.push(res.messageId || '')
        try {
          store?.insertEvent?.({
            at: now(),
            channel: parsed.channel,
            kind: parsed.kind,
            contact: parsed.contactId,
            direction: 'out',
            text: null,
            textLen: [...part.text].length,
            meta: { messageId: res.messageId || null, via: v.via, ...(parts.length > 1 ? { seg: part.index + 1, of: parts.length } : {}) },
          })
        } catch {}
      }

      const delivered = parts.length > 0 && parts.every((p) => p.ok)
      if (!delivered) {
        let queued = false
        try {
          queued = Boolean(outbox?.write?.({
            contact: parsed.contactId,
            kind: parsed.kind,
            text: fullText,
            ownerIds: cfg.owner?.qqIds ?? [],
            code: failCode ?? '',
          }))
        } catch {}
        return pack({
          ok: false,
          code: failCode ?? 'E_SEND_FAILED',
          error: failDetail,
          mode: m,
          delivered: false,
          queued,
          parts,
        })
      }

      try {
        onSent?.({ channel: parsed.channel, kind: parsed.kind, contactId: parsed.contactId, text: fullText })
      } catch {}
      // 镜像：把真发出去的每段原文写回会话（GUI 对话页一字不差）；失败不影响发送
      let mirrored = 0
      try {
        const r = mirror?.mirror?.({
          agent: exec?.agent ?? null,
          parts,
          channel: parsed.channel,
          kind: parsed.kind,
          contactId: parsed.contactId,
          sessionId: exec?.agent?.session?.id ?? null,
        })
        if (r && typeof r.count === 'number') mirrored = r.host ?? 0
      } catch (error) {
        log?.warn?.(`[channel-bridge] 镜像异常（不影响发送）：${error?.message ?? error}`)
      }
      return pack({ ok: true, code: 'SENT', mode: m, delivered: true, via: v.via, parts, mirrored, message_ids: messageIds })
    },
  })

  // owner 门禁：子智能体/群聊房间不能换会话
  const ownerDenied = (exec) => {
    const agent = exec?.agent ?? exec
    const header = agent?.session?.header ?? {}
    if (header.parentSession !== undefined || header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0) return 'E_PERMISSION'
    const cwd = String(header.cwd ?? '')
    const groupCwd = String(cfg?.groupCwd ?? '')
    if (groupCwd && (cwd === groupCwd || cwd.startsWith(`${groupCwd}/`))) return 'E_PERMISSION'
    return null
  }

  // ---------- 发表情/图片（传输层） ----------
  const sendLimiter = createRateLimiter({ windowMs: cfg.qq?.rateMs ?? 5000 })
  // 2026-11-14：主人要求解除「发图额度」。图片单独一个限流器，默认 0 = 不限
  // （createRateLimiter 在 windowMs<=0 时 `t - prev < windowMs` 恒假 = 恒放行）；
  // face/voice 仍走上面的 5 秒 sendLimiter，行为不变。
  const imageLimiter = createRateLimiter({ windowMs: cfg.qq?.imageRateMs ?? 0 })
  const modeGate = () => {
    const m = mode.current()
    if (m === 'observe') return { ok: false, code: 'E_MODE_OBSERVE', detail: '当前是只读（observe）模式，不发送' }
    return { ok: true }
  }
  const targetGate = (args) =>
    validateTarget({
      kind: args.kind,
      contactId: args.contactId,
      ownerIds: cfg.owner?.qqIds ?? [],
      contactOf: (channel, id, k) => store?.contactOf?.(channel, id, k) ?? null,
      now,
      windowMs: cfg.say?.contactWindowMs ?? 7 * 24 * 3600 * 1000,
    })

  reg({
    name: 'dy_send_image',
    description: '发一张本地图片到 QQ（绝对路径，白名单目录 /sdcard/DSHA、/tmp；png/jpg/jpeg/gif/webp；原图 ≤10MB，桥会读成 base64 发）。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片绝对路径' },
        kind: { type: 'string', enum: ['private', 'group'], description: '默认 private' },
        contactId: { type: 'string', description: 'QQ 号/群号' },
        caption: { type: 'string', description: '可选：图片前的文字' },
      },
      required: ['path', 'contactId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能发文件' })
      const mg = modeGate()
      if (!mg.ok) return pack({ ok: false, code: mg.code, message: mg.detail })
      const t = targetGate(args)
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      const v = validateImagePath(args.path, { allowDirs: cfg.qq?.allowDirs ?? IMAGE_DIRS, maxBytes: cfg.qq?.maxBytes ?? IMAGE_MAX_BYTES })
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      if (!imageLimiter.hit(`image:${t.kind}:${t.contactId}`)) return pack({ ok: false, code: 'E_RATE_LIMIT', message: `同一目标 ${Math.round((cfg.qq?.imageRateMs ?? 0) / 1000)} 秒内只能发 1 张` })
      let segments = null
      try {
        segments = buildImageSegments({ abs: v.abs, caption: args.caption ?? '' })
      } catch (error) {
        return pack({ ok: false, code: 'E_PATH', message: `读图失败：${error?.message ?? error}` })
      }
      const res = await sender?.sendSegments?.({ kind: t.kind, contactId: t.contactId, message: segments })
      try {
        store?.insertQqOp?.({ at: now(), action: 'send_image', fields: `image:${v.name} size=${v.size}`, ok: Boolean(res?.ok), error: res?.ok ? null : res?.code ?? null })
        store?.insertEvent?.({ at: now(), channel: 'qq', kind: t.kind, contact: t.contactId, direction: 'out', text: `[图片] ${v.name}` })
      } catch {}
      if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: res?.detail ?? '发送失败' })
      return pack({ ok: true, kind: t.kind, contactId: t.contactId, name: v.name, bytes: v.size, messageId: res.messageId ?? null })
    },
  })

  reg({
    name: 'dy_sticker_search',
    description: '按情绪/场景/关键词在本地表情包库找图，返回文件路径；找到后再用 dy_send_image 发。owner 用。',
    parameters: {
      type: 'object',
      properties: { emotion: { type: 'string' }, scene: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能查表情包' })
      const items = loadStickerIndex({ dirs: cfg.stickers?.dirs ?? [], indexFile: cfg.stickers?.indexFile ?? '' })
      const found = (args.query || args.scene || args.emotion)
        ? rankStickers(items, { text: [args.query ?? '', args.scene ?? ''].join(' ').trim(), moods: args.emotion ? [args.emotion] : [], limit: args.limit })
        : searchStickers(items, { emotion: args.emotion ?? '', scene: args.scene ?? '', query: args.query ?? '', limit: args.limit })
      return pack({ ok: true, count: found.length, total: items.length, items: found.map((x) => ({ file: x.file, name: x.name, emotion: x.emotion, scene: x.scene, tags: x.tags, desc: x.desc })) })
    },
  })

  reg({
    name: 'dy_send_face',
    description: '发一个 QQ 原生表情（face id 1–300）。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'QQ 表情 id（1–300）' },
        kind: { type: 'string', enum: ['private', 'group'] },
        contactId: { type: 'string', description: 'QQ 号/群号' },
      },
      required: ['id', 'contactId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能发表情' })
      const mg = modeGate()
      if (!mg.ok) return pack({ ok: false, code: mg.code, message: mg.detail })
      const t = targetGate(args)
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      const v = validateFaceId(args.id)
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      if (!sendLimiter.hit(`face:${t.kind}:${t.contactId}`)) return pack({ ok: false, code: 'E_RATE_LIMIT', message: '同一目标 5 秒内只能发 1 次' })
      const res = await sender?.sendSegments?.({ kind: t.kind, contactId: t.contactId, message: [{ type: 'face', data: { id: String(v.id) } }] })
      try {
        store?.insertQqOp?.({ at: now(), action: 'send_face', fields: `face:${v.id}`, ok: Boolean(res?.ok), error: res?.ok ? null : res?.code ?? null })
      } catch {}
      if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: res?.detail ?? '发送失败' })
      return pack({ ok: true, kind: t.kind, contactId: t.contactId, id: v.id, messageId: res.messageId ?? null })
    },
  })

  reg({
    name: 'dy_send_voice',
    description: '发一条本地语音到 QQ（绝对路径，白名单 /sdcard/DSHA、/tmp；wav/mp3/silk；原文件 ≤5MB，桥读成 base64 发）。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '语音绝对路径' },
        kind: { type: 'string', enum: ['private', 'group'], description: '默认 private' },
        contactId: { type: 'string', description: 'QQ 号/群号' },
        caption: { type: 'string', description: '可选：语音前的文字' },
      },
      required: ['path', 'contactId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能发语音' })
      const mg = modeGate()
      if (!mg.ok) return pack({ ok: false, code: mg.code, message: mg.detail })
      const t = targetGate(args)
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      const v = validateVoicePath(args.path, { allowDirs: cfg.qq?.allowDirs ?? IMAGE_DIRS })
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      if (!sendLimiter.hit(`voice:${t.kind}:${t.contactId}`)) return pack({ ok: false, code: 'E_RATE_LIMIT', message: '同一目标 5 秒内只能发 1 条语音' })
      let segments = null
      try {
        segments = buildVoiceSegments({ abs: v.abs, caption: args.caption ?? '' })
      } catch (error) {
        return pack({ ok: false, code: 'E_PATH', message: `读语音失败：${error?.message ?? error}` })
      }
      const res = await sender?.sendSegments?.({ kind: t.kind, contactId: t.contactId, message: segments })
      try {
        store?.insertQqOp?.({ at: now(), action: 'send_voice', fields: `voice:${v.name} size=${v.size}`, ok: Boolean(res?.ok), error: res?.ok ? null : res?.code ?? null })
        store?.insertEvent?.({ at: now(), channel: 'qq', kind: t.kind, contact: t.contactId, direction: 'out', text: `[语音] ${v.name}` })
      } catch {}
      if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: res?.detail ?? '发送失败' })
      return pack({ ok: true, kind: t.kind, contactId: t.contactId, name: v.name, bytes: v.size, messageId: res.messageId ?? null })
    },
  })

  // ---------- 撤回 / 转发 / 好友请求（owner 专用写操作） ----------
  const ownerOnly = (exec) => {
    const deny = ownerDenied(exec)
    if (deny) return pack({ ok: false, code: deny, message: '只有主人能用这个操作' })
    const mg = modeGate()
    if (!mg.ok) return pack({ ok: false, code: mg.code, message: mg.detail })
    return null
  }

  reg({
    name: 'dy_qq_recall',
    description: '撤回一条 QQ 消息（写操作）。messageId 用消息里的真实 id（负值合法）。owner 用。',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'number', description: '要撤回的 message_id' } },
      required: ['messageId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const gate = ownerOnly(exec)
      if (gate) return gate
      const v = validateMessageId(args.messageId)
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      const res = await sender?.callAction?.('delete_msg', { message_id: v.messageId }) // 失败不重试
      try {
        store?.insertQqOp?.({ at: now(), action: 'recall', fields: `message_id:${v.messageId}`, ok: Boolean(res?.ok), error: res?.ok ? null : res?.code ?? null })
      } catch {}
      if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: '撤回失败（未重试）' })
      return pack({ ok: true, messageId: v.messageId })
    },
  })

  reg({
    name: 'dy_qq_forward',
    description: '把一条 QQ 消息转发给好友或群（写操作）。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'number', description: '要转发的 message_id' },
        toKind: { type: 'string', enum: ['private', 'group'], description: '转发目标类型' },
        toId: { type: 'string', description: '目标 QQ 号 / 群号' },
      },
      required: ['messageId', 'toKind', 'toId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const gate = ownerOnly(exec)
      if (gate) return gate
      const m = validateMessageId(args.messageId)
      if (!m.ok) return pack({ ok: false, code: m.code, message: m.detail })
      const t = validateForwardTarget(args)
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      const action = t.toKind === 'group' ? 'forward_group_single_msg' : 'forward_friend_single_msg'
      const params = t.toKind === 'group' ? { message_id: m.messageId, group_id: Number(t.toId) } : { message_id: m.messageId, user_id: Number(t.toId) }
      const res = await sender?.callAction?.(action, params) // 失败不重试
      try {
        store?.insertQqOp?.({ at: now(), action: 'forward', fields: `to:${t.toKind}:${t.toId} message_id:${m.messageId}`, ok: Boolean(res?.ok), error: res?.ok ? null : res?.code ?? null })
      } catch {}
      if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: '转发失败（未重试）' })
      return pack({ ok: true, toKind: t.toKind, toId: t.toId, messageId: res.data?.message_id ?? null })
    },
  })

  reg({
    name: 'dy_qq_friend_request',
    description: '查看/处理「可疑好友申请」（写操作）。list 只读；approve 必须 confirm:true；flag 用列表项的 uid，不能按 QQ 号构造。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'approve', 'reject'] },
        flag: { type: 'string', description: '列表项 uid（approve/reject 必填）' },
        remark: { type: 'string', description: '备注（SnowLuma 该接口暂无备注参数，保留兼容）' },
        confirm: { type: 'boolean', description: 'approve 必须 true' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能处理好友申请' })
      const v = validateFriendAction(args)
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail, wouldChange: v.wouldChange })
      if (v.action === 'list') {
        const res = await sender?.callAction?.('get_doubt_friends_add_request', { count: 20 })
        if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: '拉取好友申请失败（未重试）' })
        return pack({ ok: true, action: 'list', requests: presentFriendRequests(res.data) })
      }
      const mg = modeGate()
      if (!mg.ok) return pack({ ok: false, code: mg.code, message: mg.detail })
      const res = await sender?.callAction?.('set_doubt_friends_add_request', { flag: v.flag, approve: v.action === 'approve' }) // 失败不重试
      try {
        store?.insertQqOp?.({ at: now(), action: `friend_request:${v.action}`, fields: 'friend-request', ok: Boolean(res?.ok), error: res?.ok ? null : res?.code ?? null })
      } catch {}
      if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: '处理好友申请失败（未重试）' })
      return pack({ ok: true, action: v.action })
    },
  })

  // ---------- 改资料 / 在线状态（写操作，二次确认） ----------
  async function readProfile() {
    const info = {}
    const login = await sender?.callAction?.('get_login_info', {})
    if (login?.ok) {
      info.userId = login.data?.user_id ?? cfg.selfId ?? null
      if (login.data?.nickname !== undefined) info.nickname = login.data.nickname
    }
    const uid = info.userId ?? cfg.selfId
    if (uid) {
      const st = await sender?.callAction?.('get_stranger_info', { user_id: String(uid) })
      if (st?.ok) {
        if (info.nickname === undefined && st.data?.nickname !== undefined) info.nickname = st.data.nickname
        if (st.data?.sex !== undefined) info.sex = st.data.sex
        if (st.data?.long_nick !== undefined) info.signature = st.data.long_nick
      }
    }
    return info
  }

  reg({
    name: 'dy_qq_profile',
    description: '改 QQ 昵称/签名/性别（写操作，必须 confirm:true）。返回 before/after 校验；失败不重试。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        nickname: { type: 'string' },
        signature: { type: 'string' },
        sex: { type: 'number', description: '0 未知 / 1 男 / 2 女' },
        confirm: { type: 'boolean', description: '必须 true 才会真的改' },
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能改资料' })
      const plan = planProfile(args)
      if (!plan.ok) return pack({ ok: false, code: plan.code, message: plan.detail })
      if (!plan.fields.length) return pack({ ok: false, code: 'E_FORMAT', message: '至少给一个字段：nickname / signature / sex' })
      if (args.confirm !== true) {
        return pack({ ok: false, code: 'E_CONFIRM_REQUIRED', message: `会改：${plan.fields.join('、')}。确认请传 confirm:true`, wouldChange: plan.fields })
      }
      const before = await readProfile()
      for (const call of plan.calls) {
        const res = await sender?.callAction?.(call.action, call.params) // 不重试
        if (!res?.ok) {
          try {
            store?.insertQqOp?.({ at: now(), action: 'profile', fields: plan.fields.join(','), ok: false, error: res?.code ?? 'E_SEND_FAILED' })
          } catch {}
          return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: '改资料失败（未重试）', fields: plan.fields })
        }
      }
      const after = await readProfile()
      try {
        store?.insertQqOp?.({ at: now(), action: 'profile', fields: plan.fields.join(','), ok: true })
      } catch {}
      const pick = (o) => ({ nickname: o.nickname, sex: o.sex, signature: o.signature })
      return pack({ ok: true, fields: plan.fields, before: pick(before), after: pick(after) })
    },
  })

  reg({
    name: 'dy_qq_status',
    description: '改 QQ 在线状态（写操作，必须 confirm:true）。10 在线 / 30 离开 / 40 隐身 / 50 忙碌 / 60 勿扰 / 70 学习。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'number', description: '10/30/40/50/60/70' },
        confirm: { type: 'boolean' },
      },
      required: ['status'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能改状态' })
      const v = validateOnlineStatus(args.status)
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      if (args.confirm !== true) return pack({ ok: false, code: 'E_CONFIRM_REQUIRED', message: `会把在线状态改成 ${v.status}。确认请传 confirm:true`, wouldChange: ['status'] })
      const res = await sender?.callAction?.('set_online_status', { status: v.status })
      try {
        store?.insertQqOp?.({ at: now(), action: 'status', fields: `status:${v.status}`, ok: Boolean(res?.ok), error: res?.ok ? null : res?.code ?? null })
      } catch {}
      if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: '改状态失败（未重试）' })
      return pack({ ok: true, status: v.status })
    },
  })

  reg({
    name: 'dy_qq_avatar',
    description: '改 QQ 头像（写操作，必须 confirm:true；png/jpg/jpeg，原图 ≤2MB）。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '头像图片绝对路径（/sdcard/DSHA 或 /tmp）' },
        confirm: { type: 'boolean', description: '必须 true 才会真的改' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能改头像' })
      const v = validateAvatarPath(args.path, { allowDirs: cfg.qq?.allowDirs ?? IMAGE_DIRS })
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      if (args.confirm !== true) {
        return pack({ ok: false, code: 'E_CONFIRM_REQUIRED', message: `会把 QQ 头像换成 ${v.name}（${v.size} 字节）。确认请传 confirm:true`, wouldChange: ['avatar'] })
      }
      let payload = null
      try {
        payload = buildAvatarFile({ abs: v.abs })
      } catch (error) {
        return pack({ ok: false, code: 'E_PATH', message: `读头像失败：${error?.message ?? error}` })
      }
      const res = await sender?.callAction?.('set_qq_avatar', { file: payload.file }) // 不重试
      try {
        store?.insertQqOp?.({ at: now(), action: 'avatar', fields: `avatar:${v.name} size=${v.size}`, ok: Boolean(res?.ok), error: res?.ok ? null : res?.code ?? null })
      } catch {}
      if (!res?.ok) return pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message: '改头像失败（未重试）' })
      return pack({ ok: true, bytes: payload.bytes, result: sanitizeResult(res.raw ?? res.data ?? res) })
    },
  })

  // 手动轮换（owner 用）：把当前会话换成带 preset 的新房，旧会话保留
  reg({
    name: 'dy_bridge_rotate',
    description:
      '把这个渠道的会话立刻换成新会话：保留旧会话，新会话带上最近 50 条原话与房间规矩。只有主人能用；回合处理中会拒绝（E_BUSY）。',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '渠道，目前只支持 qq' },
        kind: { type: 'string', enum: ['private', 'group'], description: '默认 private' },
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能换会话（群聊/子智能体不允许）' })
      const channel = String(args.channel ?? 'qq')
      if (channel !== 'qq') return pack({ ok: false, code: 'E_UNKNOWN_CHANNEL', message: '目前只支持 qq' })
      const kind = args.kind === 'group' ? 'group' : 'private'
      try {
        const r = await sessions?.forceRotate?.({ channel, kind })
        if (!r) return pack({ ok: false, code: 'E_UNAVAILABLE', message: '会话服务不可用' })
        return pack(r)
      } catch (error) {
        return pack({ ok: false, code: 'E_ROTATE_FAILED', message: error?.message ?? String(error) })
      }
    },
  })

  // 只读状态工具（给 owner 排查用；不发送、不改库、不建会话）
  reg({
    name: 'dy_bridge_status',
    description: '只读：通道桥当前状态（连接/重连/心跳/事件/投递/发送/模式/会话 id）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async () => {
      try {
        const s = typeof status === 'function' ? status() : {}
        return pack({ ok: true, ...s })
      } catch (error) {
        return pack({ ok: false, code: 'E_STATUS_FAILED', message: error?.message ?? String(error) })
      }
    },
  })


  // ==================== 2026-11-16 · QQ 常用能力补齐 ====================

  const qqOp = (action, fields, ok, error = null) => {
    try {
      store?.insertQqOp?.({ at: now(), action, fields, ok: Boolean(ok), error: ok ? null : error ?? null })
    } catch {}
  }
  const failOf = (res, message) => pack({ ok: false, code: res?.code ?? 'E_SEND_FAILED', message })

  // ---------- 拍一拍（写，轻互动，不需要 confirm） ----------
  reg({
    name: 'dy_qq_poke',
    description: '拍一拍：私聊拍对方 / 群聊拍指定成员（写操作）。私聊省略 userId；群聊必须给 userId。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['private', 'group'], description: 'private=拍好友，group=拍群成员' },
        contactId: { type: 'string', description: '私聊 QQ 号 / 群号' },
        userId: { type: 'string', description: '群聊时拍谁（QQ 号）；私聊省略' },
      },
      required: ['kind', 'contactId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const gate = ownerOnly(exec)
      if (gate) return gate
      const kind = args.kind === 'group' ? 'group' : 'private'
      const t = targetGate({ kind, contactId: args.contactId })
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      let action, params
      if (kind === 'group') {
        const uid = String(args.userId ?? '').trim()
        if (!/^\d+$/.test(uid)) return pack({ ok: false, code: 'E_FORMAT', message: '群拍必须给 userId（QQ 号）' })
        action = 'group_poke'
        params = { group_id: Number(t.contactId), user_id: Number(uid) }
      } else {
        action = 'friend_poke'
        params = { user_id: Number(t.contactId) }
      }
      const res = await sender?.callAction?.(action, params) // 失败不重试
      qqOp('poke', `${kind}:${t.contactId}${params.user_id ? ':' + params.user_id : ''}`, res?.ok, res?.code)
      if (!res?.ok) return failOf(res, '拍一拍失败（未重试）')
      return pack({ ok: true, kind, contactId: t.contactId, userId: params.user_id ? String(params.user_id) : null })
    },
  })

  // ---------- 消息表情回应（写，轻互动） ----------
  reg({
    name: 'dy_qq_reaction',
    description: '给一条 QQ 消息加/取消表情回应（写操作）。emojiId 用 QQ 表情 id（如 "76"=赞）或 emoji 名称；set:false 取消。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'number', description: '目标 message_id（负值合法）' },
        emojiId: { type: 'string', description: '表情 id/名称，例如 "76"（赞）、"4"（得意）' },
        set: { type: 'boolean', description: '默认 true=加回应；false=取消' },
      },
      required: ['messageId', 'emojiId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const gate = ownerOnly(exec)
      if (gate) return gate
      const m = validateMessageId(args.messageId)
      if (!m.ok) return pack({ ok: false, code: m.code, message: m.detail })
      const e = validateEmojiId(args.emojiId)
      if (!e.ok) return pack({ ok: false, code: e.code, message: e.detail })
      const set = args.set !== false
      const res = await sender?.callAction?.('set_msg_emoji_like', { message_id: m.messageId, emoji_id: e.emojiId, set }) // 失败不重试
      qqOp('reaction', `message_id:${m.messageId} emoji:${e.emojiId} set:${set}`, res?.ok, res?.code)
      if (!res?.ok) return failOf(res, '表情回应失败（未重试）')
      return pack({ ok: true, messageId: m.messageId, emojiId: e.emojiId, set })
    },
  })

  // ---------- 合并转发：发（写） ----------
  reg({
    name: 'dy_qq_forward_msg',
    description: '把一组文本合并转发给好友/群（写操作）。items=[{senderName?, text}]，最多 20 条。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['private', 'group'] },
        contactId: { type: 'string', description: '目标 QQ 号 / 群号' },
        items: {
          type: 'array',
          description: '转发节点：senderName 显示名（可空）、text 正文',
          items: {
            type: 'object',
            properties: { senderName: { type: 'string' }, text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
      required: ['kind', 'contactId', 'items'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const gate = ownerOnly(exec)
      if (gate) return gate
      const kind = args.kind === 'group' ? 'group' : 'private'
      const t = targetGate({ kind, contactId: args.contactId })
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      const v = validateForwardItems(args.items)
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      const nodes = buildForwardNodes(v.items)
      const action = kind === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg'
      const params = kind === 'group' ? { group_id: Number(t.contactId), messages: nodes } : { user_id: Number(t.contactId), messages: nodes }
      const res = await sender?.callAction?.(action, params) // 失败不重试
      qqOp('forward_msg', `to:${kind}:${t.contactId} nodes:${nodes.length}`, res?.ok, res?.code)
      if (!res?.ok) return failOf(res, '合并转发失败（未重试）')
      return pack({ ok: true, kind, contactId: t.contactId, nodes: nodes.length, messageId: res.data?.message_id ?? null })
    },
  })

  // ---------- 合并转发：读（只读） ----------
  reg({
    name: 'dy_qq_get_forward',
    description: '只读：读一条合并转发的内容（id=转发 res_id，或 messageId=带转发的消息 id，二选一）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '合并转发 res_id' },
        messageId: { type: 'number', description: '带合并转发的消息 message_id' },
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) => {
      if (!args.id && !args.messageId) return pack({ ok: false, code: 'E_MISSING_PARAM', message: 'id / messageId 至少给一个' })
      if (!forwardReader || typeof forwardReader.resolve !== 'function') return pack({ ok: false, code: 'E_UNAVAILABLE', message: 'forward 读取器未接入' })
      const r = await forwardReader.resolve({ id: args.id ? String(args.id) : '', messageId: args.messageId })
      if (!r) return pack({ ok: false, code: 'E_NOT_FOUND', message: '读不到这条合并转发' })
      return pack({ ok: true, id: r.id, count: r.nodes.length, text: r.text })
    },
  })

  // ---------- 群成员 / 群资料 / 群公告（只读） ----------
  reg({
    name: 'dy_qq_members',
    description: '只读：群成员列表（昵称/群名片/角色/最后发言时间），默认最多 100 个。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        limit: { type: 'number', description: '最多返回几个（默认 100，上限 300）' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) => {
      const gid = String(args.groupId ?? '').trim()
      if (!/^\d+$/.test(gid)) return pack({ ok: false, code: 'E_FORMAT', message: 'groupId 必须是数字' })
      const res = await sender?.callAction?.('get_group_member_list', { group_id: Number(gid) })
      if (!res?.ok) return failOf(res, '拉群成员失败（未重试）')
      const limit = Math.max(1, Math.min(300, Number(args.limit) || 100))
      const list = (Array.isArray(res.data) ? res.data : res.data?.members ?? []).slice(0, limit).map((m) => ({
        userId: String(m.user_id ?? ''),
        nickname: String(m.nickname ?? ''),
        card: String(m.card ?? ''),
        role: String(m.role ?? 'member'),
        lastSentTime: Number(m.last_sent_time ?? 0) || null,
      }))
      return pack({ ok: true, groupId: gid, count: list.length, members: list })
    },
  })

  reg({
    name: 'dy_qq_group_info',
    description: '只读：群资料 + 最新群公告（群名/人数/公告标题与发布者）。',
    parameters: {
      type: 'object',
      properties: { groupId: { type: 'string', description: '群号' } },
      required: ['groupId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) => {
      const gid = String(args.groupId ?? '').trim()
      if (!/^\d+$/.test(gid)) return pack({ ok: false, code: 'E_FORMAT', message: 'groupId 必须是数字' })
      const info = await sender?.callAction?.('get_group_info', { group_id: Number(gid) })
      const notice = await sender?.callAction?.('_get_group_notice', { group_id: Number(gid) }).catch(() => null)
      const i = info?.ok ? info.data ?? {} : {}
      const notices = notice?.ok ? (Array.isArray(notice.data) ? notice.data : notice.data?.notices ?? []) : []
      const latest = notices.slice(0, 3).map((n) => ({
        noticeId: String(n.notice_id ?? n.id ?? ''),
        title: String(n.notice?.title ?? n.title ?? '').slice(0, 120),
        text: String(n.notice?.text ?? n.text ?? '').slice(0, 300),
        sender: String(n.notice?.sender_name ?? n.sender_name ?? ''),
        time: Number(n.notice?.publish_time ?? n.publish_time ?? 0) || null,
      }))
      return pack({
        ok: true,
        groupId: gid,
        groupName: String(i.group_name ?? ''),
        memberCount: Number(i.member_count ?? 0) || null,
        maxMemberCount: Number(i.max_member_count ?? 0) || null,
        notices: latest,
        noticeCount: notices.length,
        error: info?.ok === false ? info?.code ?? 'E_SEND_FAILED' : null,
      })
    },
  })

  // ---------- 好友列表（只读） ----------
  reg({
    name: 'dy_qq_friends',
    description: '只读：好友列表（QQ 号/昵称/备注），默认最多 200 个。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几个（默认 200，上限 500）' } },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) => {
      const res = await sender?.callAction?.('get_friend_list', {})
      if (!res?.ok) return failOf(res, '拉好友列表失败（未重试）')
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 200))
      const list = (Array.isArray(res.data) ? res.data : []).slice(0, limit).map((f) => ({
        userId: String(f.user_id ?? ''),
        nickname: String(f.nickname ?? ''),
        remark: String(f.remark ?? ''),
      }))
      return pack({ ok: true, count: list.length, friends: list })
    },
  })

  // ---------- 收藏表情（list 只读 / send 写） ----------
  reg({
    name: 'dy_qq_custom_face',
    description: 'QQ 收藏表情：action=list 只读列表；action=send 发送一个（需 kind/contactId/emojiId）。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'send'] },
        emojiId: { type: 'string', description: 'send 必填：收藏表情的完整 id 或 MD5（来自 list）' },
        kind: { type: 'string', enum: ['private', 'group'] },
        contactId: { type: 'string', description: 'send 必填：QQ 号 / 群号' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能用收藏表情' })
      if (args.action === 'list') {
        const res = await sender?.callAction?.('fetch_custom_face', {})
        if (!res?.ok) return failOf(res, '拉收藏表情失败（未重试）')
        // 实测 2026-11-16：fetch_custom_face 返回的是 URL 字符串数组（不是对象）；
        // emoji_id 可取 URL 里的 32 位 MD5
        const raw = Array.isArray(res.data) ? res.data : res.data?.faces ?? []
        const list = raw.slice(0, 40).map((f) => {
          if (typeof f === 'string') {
            const md5 = (/[0-9a-fA-F]{32}/.exec(f) ?? [])[0] ?? ''
            return { emojiId: md5, md5, desc: '', url: f }
          }
          return {
            emojiId: String(f.emoji_id ?? f.id ?? f.emojiId ?? f.md5 ?? ''),
            md5: String(f.md5 ?? ''),
            desc: String(f.desc ?? f.name ?? '').slice(0, 40),
            url: String(f.url ?? ''),
          }
        })
        return pack({ ok: true, action: 'list', count: list.length, faces: list })
      }
      const mg = modeGate()
      if (!mg.ok) return pack({ ok: false, code: mg.code, message: mg.detail })
      const kind = args.kind === 'group' ? 'group' : 'private'
      const t = targetGate({ kind, contactId: args.contactId })
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      const e = validateEmojiId(args.emojiId)
      if (!e.ok) return pack({ ok: false, code: e.code, message: e.detail })
      const params = kind === 'group' ? { emoji_id: e.emojiId, group_id: Number(t.contactId) } : { emoji_id: e.emojiId, user_id: Number(t.contactId) }
      const res = await sender?.callAction?.('send_custom_face', params) // 失败不重试
      qqOp('custom_face', `${kind}:${t.contactId}`, res?.ok, res?.code)
      if (!res?.ok) return failOf(res, '发表情失败（未重试）')
      return pack({ ok: true, action: 'send', kind, contactId: t.contactId })
    },
  })

  // ---------- 好友关系（加/删/备注/同意申请；拉黑与举报 SL 无接口） ----------
  reg({
    name: 'dy_qq_friend',
    description:
      '好友关系写操作（必须 confirm:true）：action=add 加好友（给 userId + 可选 flag/message）、delete 删好友（userId）、' +
      'remark 改备注（userId+remark）、approve 同意申请（flag 来自申请事件）。blacklist/report SnowLuma 没有接口，返回 E_UNSUPPORTED。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'delete', 'remark', 'approve', 'blacklist', 'report'] },
        userId: { type: 'string', description: 'add/delete/remark 必填：QQ 号' },
        flag: { type: 'string', description: 'add/approve 必填：申请 flag（来自好友申请事件）' },
        message: { type: 'string', description: 'add 可选：验证消息（≤100 字）' },
        remark: { type: 'string', description: 'remark 必填：新备注（≤30 字）' },
        confirm: { type: 'boolean', description: '写操作必须 true' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const deny = ownerDenied(exec)
      if (deny) return pack({ ok: false, code: deny, message: '只有主人能改好友关系' })
      const action = String(args.action ?? '')
      if (action === 'report') {
        return pack({ ok: false, code: 'E_UNSUPPORTED', message: 'SnowLuma 没有举报接口（222 个 action 里不存在），做不到' })
      }
      if (!['add', 'delete', 'remark', 'approve', 'blacklist'].includes(action)) return pack({ ok: false, code: 'E_FORMAT', message: 'action 只支持 add/delete/remark/approve/blacklist/report' })
      const mg = modeGate()
      if (!mg.ok) return pack({ ok: false, code: mg.code, message: mg.detail })
      if (action === 'remark') {
        const uid = String(args.userId ?? '').trim()
        const rk = String(args.remark ?? '').trim()
        if (!/^\d+$/.test(uid)) return pack({ ok: false, code: 'E_FORMAT', message: 'userId 必须是数字' })
        if (!rk || [...rk].length > 30) return pack({ ok: false, code: 'E_FORMAT', message: 'remark 必填且 ≤30 字' })
        if (args.confirm !== true) return pack({ ok: false, code: 'E_CONFIRM_REQUIRED', message: `会把 ${uid} 的备注改成「${rk}」。确认请传 confirm:true` })
        const res = await sender?.callAction?.('set_friend_remark', { user_id: Number(uid), remark: rk }) // 失败不重试
        qqOp('friend_remark', `user:${uid}`, res?.ok, res?.code)
        if (!res?.ok) return failOf(res, '改备注失败（未重试）')
        return pack({ ok: true, action: 'remark', userId: uid, remark: rk })
      }
      if (args.confirm !== true) return pack({ ok: false, code: 'E_CONFIRM_REQUIRED', message: `好友操作 ${action} 会改关系，确认请传 confirm:true` })
      if (action === 'blacklist') {
        const uid = String(args.userId ?? '').trim()
        if (!/^\d+$/.test(uid)) return pack({ ok: false, code: 'E_FORMAT', message: 'userId 必须是数字' })
        // 2026-11-16 实测结论：SL 没有独立拉黑 action，唯一入口是 delete_friend{block:true}（删除并拉黑）
        const res = await sender?.callAction?.('delete_friend', { user_id: Number(uid), block: true }) // 失败不重试
        qqOp('friend_blacklist', `user:${uid}`, res?.ok, res?.code)
        if (!res?.ok) return failOf(res, '拉黑（删除并拉黑）失败（未重试）')
        return pack({ ok: true, action: 'blacklist', userId: uid, via: 'delete_friend+block' })
      }
      if (action === 'delete') {
        const uid = String(args.userId ?? '').trim()
        if (!/^\d+$/.test(uid)) return pack({ ok: false, code: 'E_FORMAT', message: 'userId 必须是数字' })
        const res = await sender?.callAction?.('delete_friend', { user_id: Number(uid) }) // 失败不重试
        qqOp('friend_delete', `user:${uid}`, res?.ok, res?.code)
        if (!res?.ok) return failOf(res, '删好友失败（未重试）')
        return pack({ ok: true, action: 'delete', userId: uid })
      }
      // add / approve 都走 set_friend_add_request
      const flag = String(args.flag ?? '').trim()
      const uid = String(args.userId ?? '').trim()
      if (!flag) return pack({ ok: false, code: 'E_MISSING_PARAM', message: `${action} 需要 flag（来自好友申请事件，不能按 QQ 号构造）` })
      if (action === 'add' && !/^\d+$/.test(uid)) return pack({ ok: false, code: 'E_FORMAT', message: 'add 需要 userId（QQ 号）' })
      const params = { flag, approve: true }
      if (action === 'add') {
        params.user_id = Number(uid)
        const msg = String(args.message ?? '').trim()
        if (msg) params.remark = msg.slice(0, 100)
      }
      const res = await sender?.callAction?.('set_friend_add_request', params) // 失败不重试
      qqOp(`friend_${action}`, `flag:${flag.slice(0, 8)}…`, res?.ok, res?.code)
      if (!res?.ok) return failOf(res, `${action === 'add' ? '加好友' : '同意申请'}失败（未重试）`)
      return pack({ ok: true, action })
    },
  })

  // ---------- 发文件（写，base64 跨容器） ----------
  reg({
    name: 'dy_qq_file',
    description: '给好友/群发文件（写操作）。path 必须 /sdcard/DSHA 或 /tmp 下，默认 ≤8MB；默认传 file:// 路径（同机可读），base64:true 才走 base64。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['private', 'group'] },
        contactId: { type: 'string', description: 'QQ 号 / 群号' },
        path: { type: 'string', description: '本地绝对路径' },
        name: { type: 'string', description: '对端显示的文件名（默认取 basename）' },
        base64: { type: 'boolean', description: '默认 false=传 file:// 路径；true=读成 base64 再传' },
      },
      required: ['kind', 'contactId', 'path'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const gate = ownerOnly(exec)
      if (gate) return gate
      const kind = args.kind === 'group' ? 'group' : 'private'
      const t = targetGate({ kind, contactId: args.contactId })
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      const v = validateFileToSend(args.path, { allowDirs: cfg.qq?.allowDirs ?? IMAGE_DIRS })
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      let b64 = ''
      try {
        b64 = `base64://${readFileSync(v.abs).toString('base64')}`
      } catch (error) {
        return pack({ ok: false, code: 'E_PATH', message: `读文件失败：${error?.message ?? error}` })
      }
      const name = String(args.name ?? v.name).slice(0, 120) || v.name
      // 实测（2026-11-16，spec §2）：SnowLuma 与桥同一 mount namespace，能直接读 file:///tmp、file:///sdcard；
      // 默认传 file://（省内存），传 base64:true 才走 base64
      const fileArg = args.base64 === true ? b64 : `file://${v.abs}`
      const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file'
      const params = kind === 'group' ? { group_id: Number(t.contactId), file: fileArg, name } : { user_id: Number(t.contactId), file: fileArg, name }
      const res = await sender?.callAction?.(action, params, { timeoutMs: 120000 }) // 失败不重试
      qqOp('send_file', `${kind}:${t.contactId} ${name} ${v.size}B`, res?.ok, res?.code)
      if (!res?.ok) return failOf(res, '发文件失败（未重试）')
      return pack({ ok: true, kind, contactId: t.contactId, name, bytes: v.size, fileId: res.data?.file_id ?? null })
    },
  })

  // ---------- 发视频（写，video 消息段） ----------
  reg({
    name: 'dy_qq_video',
    description: '给好友/群发视频（写操作）。path 必须 /sdcard/DSHA 或 /tmp 下，mp4/mov/mkv/webm/avi，≤20MB。owner 用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['private', 'group'] },
        contactId: { type: 'string', description: 'QQ 号 / 群号' },
        path: { type: 'string', description: '本地视频绝对路径' },
        caption: { type: 'string', description: '可选：随视频先发一句文字' },
      },
      required: ['kind', 'contactId', 'path'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      const gate = ownerOnly(exec)
      if (gate) return gate
      const kind = args.kind === 'group' ? 'group' : 'private'
      const t = targetGate({ kind, contactId: args.contactId })
      if (!t.ok) return pack({ ok: false, code: t.code, message: t.detail })
      const v = validateVideoPath(args.path, { allowDirs: cfg.qq?.allowDirs ?? IMAGE_DIRS })
      if (!v.ok) return pack({ ok: false, code: v.code, message: v.detail })
      let b64 = ''
      try {
        b64 = `base64://${readFileSync(v.abs).toString('base64')}`
      } catch (error) {
        return pack({ ok: false, code: 'E_PATH', message: `读视频失败：${error?.message ?? error}` })
      }
      // 实测（2026-11-16）：SL 要求 video 段必须是消息里唯一段；caption 只能单独先发一条
      const cap = String(args.caption ?? '').trim()
      if (cap) await sender?.sendText?.({ kind, contactId: t.contactId, text: cap })
      const res = await sender?.sendSegments?.({ kind, contactId: t.contactId, message: [{ type: 'video', data: { file: b64 } }] }) // 失败不重试
      qqOp('send_video', `${kind}:${t.contactId} ${v.size}B`, res?.ok, res?.code)
      if (!res?.ok) return failOf(res, '发视频失败（未重试）')
      return pack({ ok: true, kind, contactId: t.contactId, bytes: v.size, messageId: res.messageId ?? null })
    },
  })

  return { ok: true, count: 2 }
}
