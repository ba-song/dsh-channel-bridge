/**
 * 工具面裁剪（群聊 deny / 私聊不裁）：
 * - 默认名单精确、keep∩deny=∅
 * - 配置清洗（非字符串/空串/重复 → 丢 + warn，不抛）
 * - setup 提交前过滤未注册名（restrict 遇到未知名会整体抛错）
 * - fail-open：没有 tools / restrict 抛错都不影响建会话
 * - 5 个调用点（create×4 + resume×1）都带 setup
 * 全程 fake ctx，不连真服务。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, DEFAULTS, cleanToolNames } from '../lib/config.js'
import { createSessions } from '../lib/sessions.js'

const ROOT = mkdtempSync(join(tmpdir(), 'tool-scope-'))
const cfgFor = (raw = {}) => ({
  ...loadConfig(raw),
  cwdRoot: ROOT,
  privateCwd: join(ROOT, 'qq-私聊'),
  groupCwd: join(ROOT, 'qq-群'),
})
const model = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
const GROUP = { channel: 'qq', kind: 'group', contactId: '707380948' }
const PRIVATE = { channel: 'qq', kind: 'private', contactId: '2971030080' }

/** 期望的群聊 deny（30 个，只这些）。 */
const EXPECTED_GROUP_DENY = [
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
  // 设备控制：群聊一律不给（2026-11-09 主人拍板）
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
]

/** 绝对不能出现在 deny 里的能力（她的读/写/行动）。 */
const KEEP = [
  'dy_memory_add',
  'dy_memory_recall',
  'dy_memory_quote_search',
  'dy_memory_facts_list',
  'dy_memory_fact_add',
  'dy_memory_publish',
  'dy_memory_group_archive',
  'dy_memory_person_archive',
  'dy_archive_read',
  'dy_archive_research',
  'dy_archive_tools_overview',
  'dy_life_action_run',
  'dy_life_diary_append',
  'dy_say',
  'dy_send_image',
  'dy_send_voice',
  'dy_send_face',
]

/** fake 工具面：schemas 随 restrict 变少，restrict 记录每次调用。 */
function fakeTools(registered = [], { throwOnRestrict = false } = {}) {
  const calls = []
  const restricted = []
  return {
    calls,
    get: (name) => (registered.includes(name) ? { name } : undefined),
    restrict: (filter) => {
      if (throwOnRestrict) throw new Error('boom-restrict')
      calls.push(filter)
      restricted.push(...(filter.deny ?? []))
      return () => {}
    },
    schemas: () => registered.filter((n) => !restricted.includes(n)).map((n) => ({ name: n })),
  }
}

function captureLog() {
  const warns = []
  const infos = []
  return { warns, infos, warn: (m) => warns.push(String(m)), info: (m) => infos.push(String(m)), error: () => {} }
}

function memStore(row = null) {
  const saves = []
  const st = { row }
  return {
    saves,
    getSession: () => st.row,
    saveSession: (x) => {
      saves.push(x)
      st.row = { channel: x.channel, kind: x.kind, session_id: x.sessionId, cwd: x.cwd }
    },
    updateUsage: () => {},
  }
}

function fakeAgents({ tools = null, failSeedCreate = false, failResume = false } = {}) {
  const calls = []
  const mkAgent = (id) => ({ id, followup: async () => {}, session: { log: [] }, status: 'idle', ctx: { tools } })
  const agents = {
    calls,
    async create(opts) {
      calls.push({ op: 'create', opts })
      if (failSeedCreate && Array.isArray(opts.seed) && opts.seed.length) throw new Error('seed 不被支持')
      const agent = mkAgent(opts.sessionId)
      if (typeof opts.setup === 'function') await opts.setup({ tools }, agent)
      return agent
    },
    async resume(opts) {
      calls.push({ op: 'resume', opts })
      if (failResume) throw new Error('resume failed')
      const agent = mkAgent(opts.resumeSessionId)
      if (typeof opts.setup === 'function') await opts.setup({ tools }, agent)
      return agent
    },
    get: () => undefined,
  }
  return agents
}

const newSessions = ({ agents = null, store = memStore(), cfg = cfgFor(), log = captureLog(), readArchive } = {}) =>
  createSessions({ getAgents: () => agents, getModel: model, store, cfg, log, ...(readArchive ? { readArchive } : {}) })

// ---------- 名单本体 ----------

test('groupDeny 默认值精确等于清单（53 个：生活 19 + 记忆 11 + 设备 23）', () => {
  assert.deepEqual(loadConfig({}).tools.groupDeny, EXPECTED_GROUP_DENY)
  assert.deepEqual([...DEFAULTS.tools.groupDeny], EXPECTED_GROUP_DENY)
  assert.equal(new Set(EXPECTED_GROUP_DENY).size, 53)
})

test('privateDeny 默认空数组（私聊不裁）', () => {
  assert.deepEqual(loadConfig({}).tools.privateDeny, [])
  assert.deepEqual(DEFAULTS.tools.privateDeny, [])
})

test('keep ∩ deny = ∅（读/写/行动能力一个都不能被裁）', () => {
  const deny = new Set(loadConfig({}).tools.groupDeny)
  assert.deepEqual(KEEP.filter((n) => deny.has(n)), [])
})

// ---------- 配置清洗 ----------

test('非法值：非字符串/空串/重复都丢掉并 warn，不抛', () => {
  const c = loadConfig({ tools: { groupDeny: ['dy_logs', 'dy_logs', '', 42, null, '   ', 'dy_memory_stats'] } })
  assert.deepEqual(c.tools.groupDeny, ['dy_logs', 'dy_memory_stats'])
  assert.ok(c.tools.warnings.length >= 4, `warnings=${JSON.stringify(c.tools.warnings)}`)
  assert.ok(c.tools.warnings.some((w) => w.includes('重复')))
  assert.ok(c.tools.warnings.some((w) => w.includes('非字符串')))
  assert.ok(c.tools.warnings.some((w) => w.includes('空串')))
})

test('不是数组 → 回落默认并 warn（group 仍受保护，private 仍是空）', () => {
  const c = loadConfig({ tools: { groupDeny: 'dy_logs', privateDeny: { a: 1 } } })
  assert.deepEqual(c.tools.groupDeny, EXPECTED_GROUP_DENY)
  assert.deepEqual(c.tools.privateDeny, [])
  assert.equal(c.tools.warnings.length, 2)
  assert.ok(c.tools.warnings.every((w) => w.includes('不是数组')))
})

test('显式空数组是合法配置（不回落默认），cleanToolNames 去重', () => {
  assert.deepEqual(loadConfig({ tools: { groupDeny: [] } }).tools.groupDeny, [])
  const w = []
  assert.deepEqual(cleanToolNames(['a', 'a', ' b '], [], 'x', w), ['a', 'b'])
  assert.equal(w.length, 1)
})

// ---------- setup 本体 ----------

test('setup：只把已注册的名字传给 restrict，未注册的不抛', () => {
  const log = captureLog()
  const s = newSessions({ log, cfg: cfgFor({ tools: { groupDeny: ['dy_logs', 'dy_memory_stats', 'dy_not_registered'] } }) })
  const tools = fakeTools(['dy_logs', 'dy_memory_stats', 'dy_send_image'])
  assert.doesNotThrow(() => s.scopeSetup('group:707380948')({ tools }, { id: 'abcdef12-3456' }))
  assert.equal(tools.calls.length, 1)
  assert.deepEqual(tools.calls[0].deny, ['dy_logs', 'dy_memory_stats'])
  assert.deepEqual(s.stats.lastToolScope, { kind: 'group', configured: 3, applied: 2, sessionId: 'abcdef12' })
  const line = log.infos.find((m) => m.includes('工具裁剪'))
  assert.match(line, /deny=2\/3/)
  assert.match(line, /工具面 3→1/) // before 3 个 → after 1 个
})

test('setup：deny 全部未注册 → 不调用 restrict，只 warn', () => {
  const log = captureLog()
  const s = newSessions({ log, cfg: cfgFor({ tools: { groupDeny: ['dy_logs', 'dy_nope'] } }) })
  const tools = fakeTools(['dy_send_image'])
  assert.doesNotThrow(() => s.scopeSetup('group:1')({ tools }))
  assert.equal(tools.calls.length, 0)
  assert.ok(log.warns.some((m) => m.includes('全部未注册')))
})

test('setup：没有 tools / tools 没 restrict 时不炸', () => {
  const log = captureLog()
  const s = newSessions({ log })
  const setup = s.scopeSetup('group:1')
  assert.doesNotThrow(() => setup({}))
  assert.doesNotThrow(() => setup(undefined))
  assert.doesNotThrow(() => setup({ tools: {} }))
  assert.doesNotThrow(() => setup())
})

test('setup：restrict 抛错 → 只 warn，不往外抛', () => {
  const log = captureLog()
  const s = newSessions({ log })
  const tools = fakeTools(['dy_logs'], { throwOnRestrict: true })
  assert.doesNotThrow(() => s.scopeSetup('group:1')({ tools }))
  assert.ok(log.warns.some((m) => m.includes('工具裁剪失败（group）')))
})

test('私聊 deny 为空 → 不生成 setup（restrict 一次都不调）', () => {
  const s = newSessions()
  assert.equal(s.scopeSetup('private:2971030080'), undefined)
  const tools = fakeTools(['dy_logs'])
  const agents = fakeAgents({ tools })
  const sessions = newSessions({ agents })
  return sessions.ensure(PRIVATE).then((r) => {
    assert.equal(r.ok, true)
    assert.equal(agents.calls.length, 1)
    assert.equal(agents.calls[0].opts.setup, undefined)
    assert.equal(tools.calls.length, 0)
  })
})

// ---------- 5 个调用点 ----------

test('建会话（群）：create 带 setup，restrict 真被调用', async () => {
  const tools = fakeTools([...EXPECTED_GROUP_DENY, 'dy_say'])
  const agents = fakeAgents({ tools })
  const s = newSessions({ agents })
  const r = await s.ensure(GROUP)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(typeof agents.calls[0].opts.setup, 'function')
  assert.deepEqual(tools.calls[0].deny, EXPECTED_GROUP_DENY)
  assert.equal(tools.schemas().length, 1)
})

test('resume（重启后存活房间）：同样带 setup，restrict 生效', async () => {
  const tools = fakeTools([...EXPECTED_GROUP_DENY])
  const agents = fakeAgents({ tools })
  const store = memStore({ channel: 'qq', kind: 'group:707380948', session_id: 'live-1', cwd: ROOT })
  const s = newSessions({ agents, store })
  const r = await s.ensure(GROUP)
  assert.equal(r.ok, true)
  assert.equal(r.created, false)
  assert.equal(agents.calls[0].op, 'resume')
  assert.equal(typeof agents.calls[0].opts.setup, 'function')
  assert.equal(tools.calls.length, 1)
  assert.equal(tools.schemas().length, 0)
})

test('resume 失败 → 带 seed 建会话（4a）也带 setup', async () => {
  const tools = fakeTools(EXPECTED_GROUP_DENY)
  const agents = fakeAgents({ tools, failResume: true })
  const store = memStore({ channel: 'qq', kind: 'group:707380948', session_id: 'dead-1', cwd: ROOT })
  const events = [
    { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
  ]
  const s = newSessions({ agents, store, readArchive: async () => events })
  const r = await s.ensure(GROUP)
  assert.equal(r.ok, true)
  assert.equal(r.via, 'create-seeded')
  const createCall = agents.calls.find((c) => c.op === 'create')
  assert.ok(createCall, '应走到 create')
  assert.equal(typeof createCall.opts.setup, 'function')
  assert.ok(Array.isArray(createCall.opts.seed))
  assert.equal(tools.calls.length, 1)
})

test('轮换：B（带 seed）与 A（退化空建）两条路径都带 setup', async () => {
  const tools = fakeTools(EXPECTED_GROUP_DENY)
  const agents = fakeAgents({ tools, failSeedCreate: true })
  const store = memStore({ channel: 'qq', kind: 'group:707380948', session_id: 'old-1', cwd: ROOT })
  const s = newSessions({ agents, store })
  const r = await s.forceRotate({ channel: 'qq', kind: 'group', sessionKey: 'group:707380948' })
  assert.equal(r.ok, true)
  assert.equal(agents.calls.length, 2, 'B 失败后应再走 A')
  for (const call of agents.calls) assert.equal(typeof call.opts.setup, 'function')
  assert.equal(tools.calls.length, 1) // B 在建会话前失败，只有 A 真正提交了 restrict
})

test('fail-open：restrict 抛错时建会话仍然成功，且打 warn', async () => {
  const log = captureLog()
  const tools = fakeTools(EXPECTED_GROUP_DENY, { throwOnRestrict: true })
  const agents = fakeAgents({ tools })
  const s = newSessions({ agents, log })
  const r = await s.ensure(GROUP)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.ok(log.warns.some((m) => m.includes('工具裁剪失败')))
})

test('群房间：先挂 qq-room 预设（read_image），再按 deny 裁剪', async () => {
  const log = captureLog()
  const s = newSessions({ log })
  const tools = fakeTools([...EXPECTED_GROUP_DENY])
  const mounts = []
  const ctx = { tools, get: (n) => (n === 'agentPresets' ? { mount: async (_c, id) => { mounts.push(id) } } : undefined) }
  await s.scopeSetup('group:707380948')(ctx, { id: 'agent-x' })
  assert.deepEqual(mounts, ['qq-room'])
  assert.equal(tools.calls.length, 1) // 挂完预设再 restrict
  assert.ok(log.infos.some((m) => m.includes('qq-room')))
})

test('群房间：预设挂载失败 → fail-open，restrict 仍执行', async () => {
  const log = captureLog()
  const s = newSessions({ log })
  const tools = fakeTools([...EXPECTED_GROUP_DENY])
  const ctx = { tools, get: () => ({ mount: async () => { throw new Error('preset missing') } }) }
  await s.scopeSetup('group:1')(ctx, { id: 'agent-y' })
  assert.equal(tools.calls.length, 1)
  assert.ok(log.warns.some((m) => m.includes('预设挂载失败')))
})
