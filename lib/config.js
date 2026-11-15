/**
 * 配置：默认值 + 合并/清洗。
 *
 * 口径（规格书 §5）：默认 enabled=false、mode=observe；profile 里不注册，由统筹者安装。
 * token 来源优先级：config.token > 环境变量 > 独立 token 文件（0600）。
 */
import { readFileSync, existsSync } from 'node:fs'

// cosmokit 的 volatile 引用标记（dsh-settings 的 .volatile() 字段解析后就是这种只读引用）
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 把 schemastery `.volatile()` 解析出来的引用还原成普通 JSON 值。
 * cordis 在调用 apply 前会用插件导出的 Config schema 解析 profile 配置，
 * volatile 字段会变成 `{ get() }` 只读引用；loadConfig 是唯一配置读入口，
 * 所以先还原再清洗。对原本就是普通对象的配置零影响。
 */
export function unwrapVolatile(value, seen = new Set()) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value && typeof value.get === 'function') {
    return unwrapVolatile(value.get(), seen)
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    const out = value.map((item) => unwrapVolatile(item, seen))
    seen.delete(value)
    return out
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    if (seen.has(value)) return value
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = unwrapVolatile(item, seen)
    seen.delete(value)
    return out
  }
  return value
}

export const DEFAULTS = {
  enabled: false,
  mode: 'observe',
  // 运行中热切换（读 /root/.dsh/dsh-channel-bridge.json）：2026-11-10 起默认关。
  // 原因：设置页读的是 profile 的 mode，而热切换文件会覆盖它，导致“页面显示只观察、实际在真发”。
  modeHotSwitch: false,
  host: '127.0.0.1',
  port: 3001,
  token: '',
  tokenFile: '/root/.dsh/dsh-channel-bridge.token',
  selfId: '',
  channel: 'qq',
  cwd: '/sdcard/DSHA/渠道/qq',
  groupCwd: '/sdcard/DSHA/渠道/qq-群',
  agentPreset: 'standard',
  outbound: 'tool',
  // 2026-11-12 P0：发送前清洗（off|dryRun|on）；默认 on 只做保守规则
  styleClean: 'on',
  // 2026-11-13：可选禁词包（默认空；命中直接拦下这条，不静默改词）
  styleBanned: [],
  // 2026-11-12：表情包知识库（只读索引，发送仍走 dy_send_image）
  // 2026-11-13：关系四维/沉默（默认关；开了才可能主动不回）
  relationship: {
    enabled: false,
    silence: { enabled: false, privateTrustMin: 0.35, groupClosenessMin: 0.45 },
  },
  stickers: {
    dirs: ['/sdcard/DSHA/表情包', '/sdcard/DSHA/生活/数据/stickers'],
    indexFile: '/sdcard/DSHA/生活/数据/stickers/index.json',
  },
  outboxFile: '/root/.dsh/dsh-channel-bridge-outbox.log',
  mirror: { enabled: false, table: 'channel_mirror' }, // 默认关：纯提示词方案已够用，开了会双份
  rotation: { enabled: true, threshold: 650000, ratio: 0.62, seedMessages: 50, handoffMaxChars: 12000 },
  unified: false,
  echoWindowMs: 3000,
  // 2026-11-16：引用（reply）反查 —— reply 段只有 message_id，用 get_msg 取原文
  quote: { timeoutMs: 3000 },
  reconcile: { enabled: true, everyMs: 60000, count: 20, backoffMs: 3600000, activeDays: 7, groups: true, groupCount: 20 },
  handover: {
    enabled: true,
    sessionId: 'bfd29a79-e435-4c7c-895a-8ba646c78187',
    since: '2026-11-05T16:50:00+08:00',
    maxChars: 20000,
    sessionsRoot: '/root/.dsh/sessions',
    tzOffsetMinutes: 480,
  },
  dbPath: '/root/.dsh/dsh-channel-bridge/bridge.db',
  modeFile: '/root/.dsh/dsh-channel-bridge.json',
  owner: { qqIds: [] },
  say: { maxTextChars: 2000, contactWindowMs: 7 * 24 * 60 * 60 * 1000, maxLen: 60, maxSegments: 4 },
  textStoreMax: 500,
  dedupeMax: 2000,
  maxQueue: 50,
  log: { textMax: 60, throttleMs: 30000, statsMs: 60000, file: '/root/.dsh/dsh-channel-bridge.log', maxBytes: 5 * 1024 * 1024 },
  reconnect: { baseMs: 1000, maxMs: 60000, jitter: 0.2 },
  health: {
    heartbeatMs: 30000,
    heartbeatAction: 'get_status',
    heartbeatTimeoutMs: 10000,
    staleMs: 180000,
    tickMs: 15000,
    silentMs: 1800000,
    checkMs: 60000,
    warnEveryMs: 1800000,
  },
  group: {
    requireMention: true,
    mentionNames: [],
    contextCount: 8,
    followUpMessages: 8,
    followUpIdleMs: 300000, // 2026-11-09 主人拍板：5 分钟没新消息就关窗，等下次被 @ 再开
    publicBriefLimit: 3,
    // 2026-11-13：群聊社交策略（默认关）
    social: { enabled: false, maxCount: 2, silentAfterMessages: 20, closeAfterMessages: 12 },
  },
  // 群聊轮次记忆（lib/group-turn-memory.js）：她的群回复 → dyMemory.saveGroupTurn。
  // enabled !== true 时整条路径关掉；flushIdleMs 内的多条 dy_say 合并成一轮。
  groupMemory: {
    enabled: true,
    flushIdleMs: 15000,
  },
  filters: { ignoreCards: true, ignoreContacts: [] },
  // 工具面裁剪：群聊 deny 一批「主人专属 / 管理类」工具；私聊默认不裁（空数组）。
  // 只给名字，建会话时按已注册名单过滤后再 restrict（名单里未注册的名字会让 restrict 整体抛错）。
  tools: {
    groupDeny: [
      'dy_life_pause',
      'dy_life_status',
      'dy_life_goal_add',
      'dy_life_goal_list',
      'dy_life_goal_done',
      'dy_life_goal_drop',
      'dy_life_home_awake',
      'dy_life_home_rotate',
      'dy_life_home_status',
      'dy_life_interest',
      'dy_life_practice',
      'dy_life_reflect',
      'dy_life_room_list',
      'dy_life_room_read',
      'dy_logs',
      'dy_mail_poll',
      'dy_mail_reply',
      'dy_mail_send',
      'dy_memory_forget',
      'dy_memory_forget_by_source',
      'dy_memory_conflict_resolve',
      'dy_memory_conflicts',
      'dy_memory_contact_merge',
      'dy_memory_contacts',
      'dy_memory_auto_list',
      'dy_memory_raw_verify',
      'dy_memory_stats',
      'dy_memory_decision_add',
      'dy_memory_decision_list',
      'dy_memory_project_upsert',
      // 设备控制（2026-11-09 主人拍板）：群聊一律不给，避免群友诱导她操作手机。
      // MCP 工具也在全局工具面里，可以按全名 deny。
      'mcp__dsha-android__android_click',
      'mcp__dsha-android__android_double_click',
      'mcp__dsha-android__android_get_state',
      'mcp__dsha-android__android_key',
      'mcp__dsha-android__android_long_press',
      'mcp__dsha-android__android_screenshot',
      'mcp__dsha-android__android_swipe',
      'mcp__dsha-android__android_type',
      'mcp__dsha-vscreen__android_vscreen_anchor',
      'mcp__dsha-vscreen__android_vscreen_anchored_click',
      'mcp__dsha-vscreen__android_vscreen_close',
      'mcp__dsha-vscreen__android_vscreen_create',
      'mcp__dsha-vscreen__android_vscreen_editor',
      'mcp__dsha-vscreen__android_vscreen_key',
      'mcp__dsha-vscreen__android_vscreen_launch',
      'mcp__dsha-vscreen__android_vscreen_node',
      'mcp__dsha-vscreen__android_vscreen_see',
      'mcp__dsha-vscreen__android_vscreen_status',
      'mcp__dsha-vscreen__android_vscreen_swipe',
      'mcp__dsha-vscreen__android_vscreen_tap',
      'mcp__dsha-vscreen__android_vscreen_touch',
      'mcp__dsha-vscreen__android_vscreen_tree',
      'mcp__dsha-vscreen__android_vscreen_type',
    ],
    privateDeny: [],
  },
  voice: { autoTranscribe: true, maxChars: 300, timeoutMs: 20000 },
  callTimeoutMs: 15000,
  deliverTimeoutMs: 60000,
  media: {
    enabled: true,
    dir: '/sdcard/DSHA/渠道/qq/附件',
    maxBytes: 20 * 1024 * 1024,
    timeoutMs: 15000,
    maxImages: 4,
    maxFiles: 3,
    offsetMinutes: 0,
  },
  replay: {
    enabled: true,
    count: 20,
    windowMs: 2 * 60 * 60 * 1000,
    onFirstSeen: false,
    groups: false,
    maxContacts: 20,
    timeoutMs: 20000,
    timeZoneOffsetMinutes: 480,
  },
  context: { enabled: true, limit: 10, maxChars: 300 },
  auto: { maxLen: 60, maxSegments: 4, timeoutMs: 180000, pollMs: 1000 },
}

export const MODES = ['observe', 'deliver', 'send']

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const num = (v, d) => {
  // null / '' / undefined 都当「没给」，回落到默认；缺省也不得产生 NaN
  if (v === undefined || v === null || v === '') {
    const fallback = Number(d)
    return Number.isFinite(fallback) ? fallback : 0
  }
  const n = Number(v)
  if (Number.isFinite(n)) return n
  const fallback = Number(d)
  return Number.isFinite(fallback) ? fallback : 0
}
const str = (v, d) => (typeof v === 'string' ? v : d)
const bool = (v, d) => (typeof v === 'boolean' ? v : d)

/**
 * 工具名列表清洗（tools.groupDeny / tools.privateDeny）：
 * 非字符串、空串、重复都丢掉并记一条 warning，绝不抛；整个值不是数组时回落默认值。
 */
export function cleanToolNames(value, fallback, label, warnings = []) {
  const list = Array.isArray(fallback) ? fallback : []
  if (value === undefined) return [...list]
  if (!Array.isArray(value)) {
    warnings.push(`${label} 不是数组（${typeof value}），已回落默认 ${list.length} 个`)
    return [...list]
  }
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') {
      warnings.push(`${label} 丢掉非字符串项 ${JSON.stringify(item)}`)
      continue
    }
    const name = item.trim()
    if (!name) {
      warnings.push(`${label} 丢掉空串项`)
      continue
    }
    if (seen.has(name)) {
      warnings.push(`${label} 丢掉重复项 ${name}`)
      continue
    }
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 合并一层（owner/say/log/reconnect 是对象段）。 */
export function loadConfig(raw = {}) {
  const input = unwrapVolatile(raw)
  const r = isObj(input) ? input : {}
  const cfg = { ...DEFAULTS }
  for (const key of ['enabled', 'host', 'port', 'token', 'tokenFile', 'selfId', 'channel', 'cwd', 'groupCwd', 'agentPreset', 'outboxFile', 'dbPath', 'modeFile', 'textStoreMax', 'dedupeMax', 'maxQueue', 'callTimeoutMs', 'deliverTimeoutMs']) {
    if (r[key] === undefined) continue
    if (key === 'enabled') cfg[key] = bool(r[key], DEFAULTS.enabled)
    else if (key === 'modeHotSwitch') cfg[key] = bool(r[key], DEFAULTS.modeHotSwitch)
    else if (key === 'port') cfg[key] = num(r[key], DEFAULTS.port)
    else if (['textStoreMax', 'dedupeMax', 'maxQueue', 'callTimeoutMs', 'deliverTimeoutMs'].includes(key)) cfg[key] = Math.max(1, num(r[key], DEFAULTS[key]))
    else cfg[key] = str(r[key], DEFAULTS[key])
  }
  cfg.owner = { ...DEFAULTS.owner, ...(isObj(r.owner) ? r.owner : {}) }
  cfg.owner.qqIds = (Array.isArray(cfg.owner.qqIds) ? cfg.owner.qqIds : []).map((x) => String(x)).filter(Boolean)
  cfg.say = { ...DEFAULTS.say, ...(isObj(r.say) ? r.say : {}) }
  cfg.say.maxTextChars = Math.max(1, num(cfg.say.maxTextChars, DEFAULTS.say.maxTextChars))
  cfg.say.contactWindowMs = Math.max(0, num(cfg.say.contactWindowMs, DEFAULTS.say.contactWindowMs))
  cfg.say.maxLen = Math.max(10, num(cfg.say.maxLen, DEFAULTS.say.maxLen))
  cfg.say.maxSegments = Math.max(1, Math.min(9, num(cfg.say.maxSegments, DEFAULTS.say.maxSegments)))
  cfg.mirror = { ...DEFAULTS.mirror, ...(isObj(r.mirror) ? r.mirror : {}) }
  cfg.rotation = { ...DEFAULTS.rotation, ...(isObj(r.rotation) ? r.rotation : {}) }
  cfg.rotation.threshold = Math.max(1000, num(cfg.rotation.threshold, DEFAULTS.rotation.threshold))
  cfg.rotation.ratio = Math.min(1, Math.max(0.1, num(cfg.rotation.ratio, DEFAULTS.rotation.ratio)))
  cfg.rotation.seedMessages = Math.max(1, Math.min(200, num(cfg.rotation.seedMessages, DEFAULTS.rotation.seedMessages)))
  cfg.unified = r.unified === true
  cfg.echoWindowMs = Math.max(0, num(r.echoWindowMs, DEFAULTS.echoWindowMs))
  cfg.quote = { ...DEFAULTS.quote, ...(isObj(r.quote) ? r.quote : {}) }
  cfg.quote.timeoutMs = Math.max(500, Math.min(15000, num(cfg.quote.timeoutMs, DEFAULTS.quote.timeoutMs)))
  cfg.reconcile = { ...DEFAULTS.reconcile, ...(isObj(r.reconcile) ? r.reconcile : {}) }
  cfg.reconcile.everyMs = Math.max(5000, num(cfg.reconcile.everyMs, DEFAULTS.reconcile.everyMs))
  cfg.reconcile.count = Math.max(1, Math.min(100, num(cfg.reconcile.count, DEFAULTS.reconcile.count)))
  cfg.reconcile.backoffMs = Math.max(60000, num(cfg.reconcile.backoffMs, DEFAULTS.reconcile.backoffMs))
  cfg.reconcile.activeDays = Math.max(1, num(cfg.reconcile.activeDays, DEFAULTS.reconcile.activeDays))
  // 群对账：默认开（groups:false 可整块关）；groupCount 单独可配
  cfg.reconcile.groups = bool(cfg.reconcile.groups, DEFAULTS.reconcile.groups)
  cfg.reconcile.groupCount = Math.max(1, Math.min(100, num(cfg.reconcile.groupCount, DEFAULTS.reconcile.groupCount)))
  cfg.handover = { ...DEFAULTS.handover, ...(isObj(r.handover) ? r.handover : {}) }
  cfg.handover.maxChars = Math.max(100, num(cfg.handover.maxChars, DEFAULTS.handover.maxChars))
  cfg.log = { ...DEFAULTS.log, ...(isObj(r.log) ? r.log : {}) }
  cfg.log.textMax = Math.max(8, num(cfg.log.textMax, DEFAULTS.log.textMax))
  cfg.log.throttleMs = Math.max(0, num(cfg.log.throttleMs, DEFAULTS.log.throttleMs))
  cfg.log.statsMs = Math.max(1000, num(cfg.log.statsMs, DEFAULTS.log.statsMs))
  cfg.log.file = str(cfg.log.file, DEFAULTS.log.file)
  cfg.log.maxBytes = Math.max(64 * 1024, num(cfg.log.maxBytes, DEFAULTS.log.maxBytes))
  cfg.health = { ...DEFAULTS.health, ...(isObj(r.health) ? r.health : {}) }
  cfg.health.heartbeatMs = Math.max(1000, num(cfg.health.heartbeatMs, DEFAULTS.health.heartbeatMs))
  cfg.health.staleMs = Math.max(cfg.health.heartbeatMs, num(cfg.health.staleMs, DEFAULTS.health.staleMs))
  cfg.health.tickMs = Math.max(500, num(cfg.health.tickMs, DEFAULTS.health.tickMs))
  cfg.health.heartbeatTimeoutMs = Math.max(500, num(cfg.health.heartbeatTimeoutMs, DEFAULTS.health.heartbeatTimeoutMs))
  cfg.health.heartbeatAction = str(cfg.health.heartbeatAction, DEFAULTS.health.heartbeatAction)
  cfg.health.silentMs = Math.max(60000, num(cfg.health.silentMs, DEFAULTS.health.silentMs))
  cfg.health.checkMs = Math.max(10000, num(cfg.health.checkMs, DEFAULTS.health.checkMs))
  cfg.health.warnEveryMs = Math.max(60000, num(cfg.health.warnEveryMs, DEFAULTS.health.warnEveryMs))

  cfg.group = { ...DEFAULTS.group, ...(isObj(r.group) ? r.group : {}) }
  cfg.group.requireMention = cfg.group.requireMention !== false // 显式 false 才关
  cfg.group.mentionNames = Array.isArray(cfg.group.mentionNames) ? cfg.group.mentionNames.map(String) : []
  cfg.group.contextCount = Math.max(5, Math.min(10, num(cfg.group.contextCount, DEFAULTS.group.contextCount)))
  cfg.group.followUpMessages = Math.max(0, num(cfg.group.followUpMessages, DEFAULTS.group.followUpMessages))
  cfg.group.followUpIdleMs = Math.max(60000, num(cfg.group.followUpIdleMs, DEFAULTS.group.followUpIdleMs))
  cfg.group.publicBriefLimit = Math.max(1, Math.min(10, num(cfg.group.publicBriefLimit, DEFAULTS.group.publicBriefLimit)))
  cfg.group.social = { ...DEFAULTS.group.social, ...(isObj(cfg.group.social) ? cfg.group.social : {}) }
  cfg.group.social.enabled = cfg.group.social.enabled === true
  cfg.group.social.maxCount = Math.max(1, Math.min(4, num(cfg.group.social.maxCount, DEFAULTS.group.social.maxCount)))
  cfg.group.social.silentAfterMessages = Math.max(1, num(cfg.group.social.silentAfterMessages, DEFAULTS.group.social.silentAfterMessages))
  cfg.group.social.closeAfterMessages = Math.max(1, num(cfg.group.social.closeAfterMessages, DEFAULTS.group.social.closeAfterMessages))

  cfg.groupMemory = { ...DEFAULTS.groupMemory, ...(isObj(r.groupMemory) ? r.groupMemory : {}) }
  cfg.groupMemory.enabled = cfg.groupMemory.enabled === true // 只认布尔 true（'true' 之类视为关闭）
  cfg.groupMemory.flushIdleMs = Math.max(1000, num(cfg.groupMemory.flushIdleMs, DEFAULTS.groupMemory.flushIdleMs))

  cfg.filters = { ...DEFAULTS.filters, ...(isObj(r.filters) ? r.filters : {}) }
  cfg.filters.ignoreCards = cfg.filters.ignoreCards !== false
  cfg.filters.ignoreContacts = Array.isArray(cfg.filters.ignoreContacts) ? cfg.filters.ignoreContacts.map(String) : []

  // 工具面裁剪：非法项过滤 + warn（写进 cfg.tools.warnings，由 index.js 落到日志）
  const toolWarnings = []
  const rawTools = isObj(r.tools) ? r.tools : {}
  cfg.tools = {
    groupDeny: cleanToolNames(rawTools.groupDeny, DEFAULTS.tools.groupDeny, 'tools.groupDeny', toolWarnings),
    privateDeny: cleanToolNames(rawTools.privateDeny, DEFAULTS.tools.privateDeny, 'tools.privateDeny', toolWarnings),
    warnings: toolWarnings,
  }

  cfg.voice = { ...DEFAULTS.voice, ...(isObj(r.voice) ? r.voice : {}) }
  cfg.voice.autoTranscribe = cfg.voice.autoTranscribe !== false
  cfg.voice.maxChars = Math.max(1, Math.min(2000, num(cfg.voice.maxChars, DEFAULTS.voice.maxChars)))
  cfg.voice.timeoutMs = Math.max(1000, num(cfg.voice.timeoutMs, DEFAULTS.voice.timeoutMs))
  cfg.reconnect = { ...DEFAULTS.reconnect, ...(isObj(r.reconnect) ? r.reconnect : {}) }
  cfg.media = { ...DEFAULTS.media, ...(isObj(r.media) ? r.media : {}) }
  cfg.media.maxBytes = Math.max(1024, num(cfg.media.maxBytes, DEFAULTS.media.maxBytes))
  cfg.media.maxImages = Math.max(0, num(cfg.media.maxImages, DEFAULTS.media.maxImages))
  cfg.media.maxFiles = Math.max(0, num(cfg.media.maxFiles, DEFAULTS.media.maxFiles))
  cfg.replay = { ...DEFAULTS.replay, ...(isObj(r.replay) ? r.replay : {}) }
  cfg.replay.count = Math.max(1, Math.min(200, num(cfg.replay.count, DEFAULTS.replay.count)))
  cfg.replay.groups = bool(cfg.replay.groups, DEFAULTS.replay.groups)
  cfg.context = { ...DEFAULTS.context, ...(isObj(r.context) ? r.context : {}) }
  cfg.reconnect.baseMs = Math.max(50, num(cfg.reconnect.baseMs, DEFAULTS.reconnect.baseMs))
  cfg.reconnect.maxMs = Math.max(cfg.reconnect.baseMs, num(cfg.reconnect.maxMs, DEFAULTS.reconnect.maxMs))
  cfg.reconnect.jitter = Math.min(1, Math.max(0, num(cfg.reconnect.jitter, DEFAULTS.reconnect.jitter)))
  cfg.mode = MODES.includes(String(r.mode)) ? String(r.mode) : 'observe'
  cfg.outbound = String(r.outbound) === 'auto' ? 'auto' : 'tool'
  cfg.styleClean = ['off','dryRun','on'].includes(String(r.styleClean)) ? String(r.styleClean) : DEFAULTS.styleClean
  cfg.styleBanned = Array.isArray(r.styleBanned) ? r.styleBanned.map(String).filter(Boolean).slice(0, 100) : [...DEFAULTS.styleBanned]
  cfg.relationship = { ...DEFAULTS.relationship, ...(r?.relationship && typeof r.relationship === 'object' ? r.relationship : {}) }
  cfg.relationship.silence = { ...DEFAULTS.relationship.silence, ...(cfg.relationship.silence && typeof cfg.relationship.silence === 'object' ? cfg.relationship.silence : {}) }
  cfg.stickers = { ...DEFAULTS.stickers, ...(r?.stickers && typeof r.stickers === 'object' ? r.stickers : {}) }
  cfg.stickers.dirs = Array.isArray(cfg.stickers.dirs) ? cfg.stickers.dirs.map(String).filter(Boolean) : [...DEFAULTS.stickers.dirs]
  cfg.auto = { ...DEFAULTS.auto, ...(isObj(r.auto) ? r.auto : {}) }
  cfg.auto.maxLen = Math.max(10, num(cfg.auto.maxLen, DEFAULTS.auto.maxLen))
  cfg.auto.maxSegments = Math.max(1, Math.min(9, num(cfg.auto.maxSegments, DEFAULTS.auto.maxSegments)))
  cfg.auto.timeoutMs = Math.max(1000, num(cfg.auto.timeoutMs, DEFAULTS.auto.timeoutMs))
  cfg.auto.pollMs = Math.max(200, num(cfg.auto.pollMs, DEFAULTS.auto.pollMs))
  cfg.selfId = String(cfg.selfId || '')
  return cfg
}

/** token：config > env > 文件（去空白；文件不存在/为空返回 ''）。 */
export function resolveToken(cfg, env = process.env, readFile = readFileSync, exists = existsSync) {
  if (cfg?.token) return String(cfg.token).trim()
  const fromEnv = env?.DSH_CHANNEL_BRIDGE_TOKEN
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()
  const file = cfg?.tokenFile
  try {
    if (file && exists(file)) {
      const t = String(readFile(file, 'utf8')).trim()
      if (t) return t
    }
  } catch {}
  return ''
}

export function wsUrl(cfg) {
  const host = cfg.host || '127.0.0.1'
  const port = Number(cfg.port) || 3001
  return `ws://${host}:${port}/`
}
