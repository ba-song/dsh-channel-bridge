import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, resolveToken, wsUrl, DEFAULTS } from '../lib/config.js'

test('默认：enabled=false / observe / 3001 / cwd', () => {
  const c = loadConfig({})
  assert.equal(c.enabled, false)
  assert.equal(c.mode, 'observe')
  assert.equal(c.port, 3001)
  assert.equal(c.cwd, '/sdcard/DSHA/渠道/qq')
})

test('非法 mode 回 observe；数字端口字符串化', () => {
  assert.equal(loadConfig({ mode: 'whatever' }).mode, 'observe')
  assert.equal(loadConfig({ port: '3001' }).port, 3001)
})

test('嵌套段合并 + qqIds 变字符串数组', () => {
  const c = loadConfig({ owner: { qqIds: [2971030080] }, say: { maxTextChars: 500 }, log: { textMax: 20 } })
  assert.deepEqual(c.owner.qqIds, ['2971030080'])
  assert.equal(c.say.maxTextChars, 500)
  assert.equal(c.log.textMax, 20)
  assert.equal(c.say.contactWindowMs, DEFAULTS.say.contactWindowMs)
})

test('token 优先级：config > env > 文件', () => {
  const cfg = loadConfig({ token: 'cfg', tokenFile: '/t' })
  assert.equal(resolveToken(cfg, { DSH_CHANNEL_BRIDGE_TOKEN: 'env' }, () => 'file', () => true), 'cfg')
  assert.equal(resolveToken(loadConfig({ tokenFile: '/t' }), { DSH_CHANNEL_BRIDGE_TOKEN: 'env' }, () => 'file', () => true), 'env')
  assert.equal(resolveToken(loadConfig({ tokenFile: '/t' }), {}, () => 'file', () => true), 'file')
  assert.equal(resolveToken(loadConfig({ tokenFile: '/none' }), {}, () => '', () => false), '')
})

test('wsUrl 带尾斜杠', () => {
  assert.equal(wsUrl(loadConfig({})), 'ws://127.0.0.1:3001/')
})

test('replay.groups 默认 false（群聊不再补收），显式 true 才开', () => {
  assert.equal(loadConfig({}).replay.groups, false)
  assert.equal(loadConfig({ replay: { groups: true } }).replay.groups, true)
  assert.equal(loadConfig({ replay: { groups: 'true' } }).replay.groups, false) // 只认布尔 true
})

test('mirror 默认关闭（防止重启后双份消息）', () => {
  assert.equal(loadConfig({}).mirror.enabled, false)
  assert.equal(loadConfig({ mirror: { enabled: true } }).mirror.enabled, true)
})

test('unified 默认关；handover 默认参数齐全', () => {
  const c = loadConfig({})
  assert.equal(c.unified, false)
  assert.equal(c.handover.sessionId, 'bfd29a79-e435-4c7c-895a-8ba646c78187')
  assert.equal(c.handover.since, '2026-11-05T16:50:00+08:00')
  assert.equal(c.handover.maxChars, 20000)
  assert.equal(loadConfig({ unified: true }).unified, true)
  assert.equal(loadConfig({ unified: 'true' }).unified, false) // 只认布尔 true
})

test('group 段：默认值齐全且 profile 覆盖生效', () => {
  const d = loadConfig({})
  assert.deepEqual(d.group, {
    requireMention: true,
    mentionNames: [],
    contextCount: 8,
    followUpMessages: 8,
    followUpIdleMs: 300000,
    publicBriefLimit: 3,
    social: { enabled: false, maxCount: 2, silentAfterMessages: 20, closeAfterMessages: 12 },
  })
  const c = loadConfig({
    group: { requireMention: false, mentionNames: ['汐'], contextCount: 6, followUpMessages: 3, followUpIdleMs: 120000, publicBriefLimit: 2 },
  })
  assert.equal(c.group.requireMention, false)
  assert.deepEqual(c.group.mentionNames, ['汐'])
  assert.equal(c.group.contextCount, 6)
  assert.equal(c.group.followUpMessages, 3)
  assert.equal(c.group.followUpIdleMs, 120000)
  assert.equal(c.group.publicBriefLimit, 2)
  // 边界钳制
  const b = loadConfig({ group: { contextCount: 99, publicBriefLimit: 0, followUpIdleMs: 1 } })
  assert.equal(b.group.contextCount, 10)
  assert.equal(b.group.publicBriefLimit, 1)
  assert.equal(b.group.followUpIdleMs, 60000)
})

test('filters 段：默认 true/[]，profile 可关可加名单', () => {
  const d = loadConfig({})
  assert.equal(d.filters.ignoreCards, true)
  assert.deepEqual(d.filters.ignoreContacts, [])
  const c = loadConfig({ filters: { ignoreCards: false, ignoreContacts: ['2010741172', 123] } })
  assert.equal(c.filters.ignoreCards, false)
  assert.deepEqual(c.filters.ignoreContacts, ['2010741172', '123'])
})

test('health 段：silentMs/checkMs/warnEveryMs 有默认且永不 NaN', () => {
  const d = loadConfig({})
  assert.equal(d.health.silentMs, 1800000)
  assert.equal(d.health.checkMs, 60000)
  assert.equal(d.health.warnEveryMs, 1800000)
  for (const v of [d.health.silentMs, d.health.checkMs, d.health.warnEveryMs]) assert.ok(Number.isFinite(v))

  // 非法/缺失值回落到默认，不产生 NaN
  const bad = loadConfig({ health: { silentMs: 'abc', checkMs: null, warnEveryMs: undefined } })
  assert.equal(bad.health.silentMs, 1800000)
  assert.equal(bad.health.checkMs, 60000)
  assert.equal(bad.health.warnEveryMs, 1800000)
  assert.ok(!Number.isNaN(bad.health.silentMs) && !Number.isNaN(bad.health.checkMs))

  // 显式覆盖生效且钳制下限
  const ok = loadConfig({ health: { silentMs: 900000, checkMs: 30000, warnEveryMs: 600000 } })
  assert.equal(ok.health.silentMs, 900000)
  assert.equal(ok.health.checkMs, 30000)
  assert.equal(ok.health.warnEveryMs, 600000)
  const low = loadConfig({ health: { silentMs: 1, checkMs: 1, warnEveryMs: 1 } })
  assert.equal(low.health.silentMs, 60000)
  assert.equal(low.health.checkMs, 10000) // 下限 10s
  assert.equal(low.health.warnEveryMs, 60000)
})
