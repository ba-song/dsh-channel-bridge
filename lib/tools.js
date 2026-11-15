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
  IMAGE_DIRS,
  IMAGE_MAX_BYTES,
} from './qq-actions.js'
import { splitForSend } from './split.js'
import { loadStickerIndex, rankStickers, searchStickers } from './stickers.js'

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

export function registerTools({ tools, cfg, mode, sender, store, router = null, log = null, status = null, outbound = 'tool', onSent = null, outbox = null, mirror = null, sessions = null, getMail = () => null, socialGate = null, now = () => Date.now() }) {
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

  return { ok: true, count: 2 }
}
