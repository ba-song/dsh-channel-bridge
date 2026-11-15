import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { Config } from '../lib/index.js'
import { DEFAULTS, loadConfig, unwrapVolatile } from '../lib/config.js'

const PROFILE_PATCH = process.env.DSH_PROFILE_PATCH ?? '/root/.dsh/profiles/web/cordis.patch.yml'

/** 读 profile 里 channel-bridge 的 config 片段；拿不到就返回 undefined（测试可跳过）。 */
async function readProfileChannelConfig() {
  if (!existsSync(PROFILE_PATCH)) return undefined
  const { parse } = await import('yaml')
  const entries = parse(readFileSync(PROFILE_PATCH, 'utf8'))
  const entry = Array.isArray(entries) ? entries.find((row) => row?.id === 'channel-bridge') : undefined
  return entry?.config
}

/** 把 schema 的 dict 树里标了 volatile 的路径全找出来（排序后返回）。 */
function volatilePaths(schema, path = []) {
  const out = []
  for (const [key, child] of Object.entries(schema.dict ?? {})) {
    const target = [...path, key]
    if (child.meta?.volatile) out.push(target.join('.'))
    out.push(...volatilePaths(child, target))
  }
  return out.sort()
}

test('Config：导出的 schemastery schema 能解析 DEFAULTS', () => {
  assert.equal(typeof Config?.['~standard']?.validate, 'function')
  const result = Config['~standard'].validate(structuredClone(DEFAULTS))
  assert.equal(result.issues, undefined)
  // 未声明的键原样保留，声明过的键带默认值
  assert.equal(result.value.enabled, DEFAULTS.enabled)
  assert.equal(result.value.mode.get(), DEFAULTS.mode)
  assert.equal(result.value.say.maxLen.get(), DEFAULTS.say.maxLen)
  assert.equal(result.value.group.followUpIdleMs.get(), DEFAULTS.group.followUpIdleMs)
})

test('Config：解析后 loadConfig 与解析前完全一致（运行时行为不变）', () => {
  const resolved = Config['~standard'].validate(structuredClone(DEFAULTS)).value
  assert.deepEqual(loadConfig(resolved), loadConfig(structuredClone(DEFAULTS)))
})

test('Config：volatile 标在设置卡片的 5 个字段上', () => {
  assert.deepEqual(volatilePaths(Config), ['group.followUpIdleMs', 'group.followUpMessages', 'group.requireMention', 'group.social.enabled', 'mode', 'say.maxLen'])
})

test('Config：能解析 profile 里现有的 channel-bridge 配置片段', async (t) => {
  const profileConfig = await readProfileChannelConfig()
  if (profileConfig === undefined) {
    t.skip(`profile patch 不存在或没有 channel-bridge 条目：${PROFILE_PATCH}`)
    return
  }
  const result = Config['~standard'].validate(structuredClone(profileConfig))
  assert.equal(result.issues, undefined)
  const value = result.value
  assert.equal(value.enabled, profileConfig.enabled)
  assert.equal(value.unified, profileConfig.unified)
  assert.equal(value.mode.get(), profileConfig.mode)
  assert.equal(value.host, profileConfig.host)
  assert.equal(value.port, profileConfig.port)
  assert.equal(value.cwd, profileConfig.cwd)
  assert.deepEqual(value.owner.qqIds, profileConfig.owner.qqIds)
  // 解析后的配置跑 loadConfig 必须和原来的 profile 片段一致（含未声明键的默认值）
  assert.deepEqual(loadConfig(value), loadConfig(structuredClone(profileConfig)))
})

test('loadConfig：解开 schemastery volatile 引用，数字不会被当成对象', () => {
  const resolved = Config['~standard'].validate({ ...structuredClone(DEFAULTS), say: { maxLen: 90 } }).value
  assert.equal(loadConfig(resolved).say.maxLen, 90)
  assert.equal(loadConfig(resolved).mode, DEFAULTS.mode)
  assert.equal(typeof unwrapVolatile(resolved.say.maxLen), 'number')
  // 普通配置不受影响（引用解开对纯 JSON 是 no-op）
  assert.deepEqual(unwrapVolatile({ say: { maxLen: 90 } }), { say: { maxLen: 90 } })
})

test('设置服务：describe 只暴露 6 个 volatile 字段，mutate 写入嵌套路径', async (t) => {
  let SettingsForms
  try {
    ({ SettingsForms } = await import('@deepseek-ai/dsh-settings'))
  } catch {
    t.skip('@deepseek-ai/dsh-settings 不可解析，跳过 Host 设置管线集成测试')
    return
  }
  const profileConfig = (await readProfileChannelConfig()) ?? {
    enabled: true,
    unified: true,
    mode: 'observe',
    host: '127.0.0.1',
    port: 3001,
    cwd: '/sdcard/DSHA/渠道/qq',
    owner: { qqIds: ['2971030080'] },
  }
  const inherited = { enabled: false, mode: 'observe', host: '127.0.0.1', port: 3001, cwd: '/sdcard/DSHA/渠道/qq' }
  const merged = { ...inherited, ...profileConfig, owner: { ...profileConfig.owner } }
  const resolved = Config['~standard'].validate(structuredClone(merged)).value
  let captured
  let entry
  entry = {
    id: 'channel-bridge',
    options: { id: 'channel-bridge', name: 'dsh-channel-bridge', config: merged },
    fiber: { uid: 7, runtime: { Config }, state: 2, config: resolved },
  }
  const ctx = {
    reflect: { provide() {} },
    effect(fn) {
      fn()
      return () => {}
    },
    on() {},
    emit() {},
    logger: { error() {} },
    // 挂起：跳过 legacy settings.yaml 迁移（它需要真实 profileContext）
    root: { loader: { await: () => new Promise(() => {}) } },
    configEditor: {
      documentPath: '/root/.dsh/profiles/web/cordis.patch.yml',
      configuration: () => [{ entry, inherited, override: profileConfig }],
      entries: () => [entry],
      edit: async (subject, change) => {
        captured = change(structuredClone(subject.options.config), inherited)
      },
    },
  }
  const forms = new SettingsForms(ctx)
  const descriptors = forms.describe()
  const descriptor = descriptors.find((row) => row.ns === 'channel-bridge')
  assert.ok(descriptor, 'channel-bridge 必须出现在 describe 里')
  assert.deepEqual(descriptor.value, {
    mode: profileConfig.mode,
    say: { maxLen: DEFAULTS.say.maxLen },
    group: {
      followUpIdleMs: DEFAULTS.group.followUpIdleMs,
      followUpMessages: DEFAULTS.group.followUpMessages,
      requireMention: DEFAULTS.group.requireMention,
      social: { enabled: profileConfig.group?.social?.enabled ?? false },
    },
  })
  // describe 给的是 toJSON() 信封 { uid, refs }，客户端用它 rehydrate
  const root = descriptor.schema.refs[descriptor.schema.uid]
  assert.deepEqual(Object.keys(root.dict).sort(), ['group', 'mode', 'say'])

  // 客户端 decode 用的就是这份 form schema + value
  const z = (await import('@deepseek-ai/schemastery')).default
  const FormSchema = new z(descriptor.schema)
  assert.equal(FormSchema['~standard'].validate(descriptor.value).issues, undefined)

  await forms.mutate('channel-bridge', [{ op: 'set', path: ['say', 'maxLen'], value: 90 }], descriptor.revision)
  assert.equal(captured.say.maxLen, 90)
  assert.equal(typeof captured.say.maxLen, 'number')
  // 非表单字段必须原样保留
  assert.equal(captured.enabled, true)
  assert.equal(captured.host, '127.0.0.1')
  assert.equal(captured.cwd, '/sdcard/DSHA/渠道/qq')
  assert.deepEqual(captured.owner.qqIds, ['2971030080'])
  assert.equal(loadConfig(captured).say.maxLen, 90)
})
