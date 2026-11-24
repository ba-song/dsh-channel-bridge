import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupTurnMemory } from '../lib/group-turn-memory.js'
import { loadConfig } from '../lib/config.js'

const T0 = Date.parse('2026-11-09T00:00:00Z')
const GID = '707380948'

function setup({ memory = 'default', enabled = true, idleMs = 15000, messages = [], meta = {}, now = () => T0 } = {}) {
  const calls = []
  const infos = []
  const warns = []
  const mem = memory === null ? null : memory === 'default'
    ? {
        saveGroupTurn: async (x) => {
          calls.push(x)
          return { ok: true, id: calls.length, chars: 20 }
        },
      }
    : memory
  const bucket = { messages, meta: { groupId: GID, groupName: '测试群', ...meta } }
  const mod = createGroupTurnMemory({
    getMemory: () => mem,
    getBucket: () => bucket,
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
    idleMs,
    enabled,
    now,
  })
  return { mod, calls, infos, warns, bucket }
}

test('回复后 flush：incoming 只含群友（不含汐自己那条），reply 是本轮回复原文', async () => {
  const h = setup({
    messages: [
      { speaker: '群友A', text: '在吗', at: T0 - 2000 },
      { speaker: '汐', text: '在的', at: T0 - 1000 }, // 她自己的话：不算 incoming
      { speaker: '群友B', text: '帮看下', at: T0 - 500 },
    ],
  })
  h.mod.noteReply({ groupId: GID, groupName: '测试群', text: '在的，我看看' })
  const r = await h.mod.flush(GID)

  assert.equal(r.ok, true)
  assert.equal(h.calls.length, 1)
  const c = h.calls[0]
  assert.equal(c.groupId, GID)
  assert.equal(c.groupName, '测试群')
  assert.deepEqual(c.incoming, [
    { speaker: '群友A', text: '在吗', at: T0 - 2000 },
    { speaker: '群友B', text: '帮看下', at: T0 - 500 },
  ])
  assert.deepEqual(c.reply, [{ text: '在的，我看看', at: T0 }])
  assert.equal(c.at, T0)
  assert.equal(h.mod.stats.flushed, 1)
  assert.equal(h.mod.stats.ok, 1)
  assert.ok(
    h.infos.some((m) => m.includes(`群记忆：group=${GID} in=2 chars=20 → ok`)),
    `日志行不对：${JSON.stringify(h.infos)}`,
  )
  h.mod.dispose()
})

test('15s 内多条 dy_say 合并成一次 flush（按发送顺序 join）', async () => {
  const h = setup({ idleMs: 60000, messages: [{ speaker: '群友A', text: '在吗', at: T0 - 1000 }] })
  h.mod.noteReply({ groupId: GID, text: '第一段' })
  h.mod.noteReply({ groupId: GID, text: '第二段' })
  assert.equal(h.calls.length, 0) // idle 没到：不自动写
  await h.mod.flush(GID)

  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].reply.length, 1) // 多段合成一条 reply
  assert.equal(h.calls[0].reply[0].text, '第一段\n第二段')
  assert.equal(h.calls[0].groupName, '测试群') // noteReply 没给群名 → 用 buffer meta
  h.mod.dispose()
})

test('idle 到期自动 flush 一次（timer unref，不拖住进程）', async () => {
  const h = setup({ idleMs: 10, messages: [{ speaker: '群友A', text: '在吗', at: T0 }] })
  h.mod.noteReply({ groupId: GID, text: '嗯' })
  h.mod.noteReply({ groupId: GID, text: '在' }) // 重置定时器
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].reply[0].text, '嗯\n在')
  h.mod.dispose()
})

test('enabled:false → noteReply/flush 都不写（一键关掉）', async () => {
  const h = setup({ enabled: false, messages: [{ speaker: '群友A', text: '在吗', at: T0 }] })
  const noted = h.mod.noteReply({ groupId: GID, text: '嗯' })
  assert.equal(noted.code, 'E_DISABLED')
  const r = await h.mod.flush(GID)
  assert.equal(r.code, 'E_DISABLED')
  assert.equal(h.calls.length, 0)
  assert.equal(h.mod.stats.flushed, 0)
  h.mod.dispose()
})

test('记忆服务缺失：noteReply 不抛不缓存；flush 跳过且不报错', async () => {
  const h = setup({ memory: null, messages: [{ speaker: '群友A', text: '在吗', at: T0 }] })
  assert.doesNotThrow(() => h.mod.noteReply({ groupId: GID, text: '嗯' }))
  const r = await h.mod.flush(GID)
  assert.equal(r.code, 'E_MEMORY_UNAVAILABLE')
  assert.equal(h.calls.length, 0)
  assert.equal(h.mod.stats.skipped, 1)
  h.mod.dispose()
})

test('saveGroupTurn 抛异常：只 warn、不抛，stats.error +1', async () => {
  const h = setup({
    memory: { saveGroupTurn: async () => { throw new Error('boom') } },
    messages: [{ speaker: '群友A', text: '在吗', at: T0 }],
  })
  h.mod.noteReply({ groupId: GID, text: '嗯' })
  const r = await h.mod.flush(GID)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'boom')
  assert.equal(h.mod.stats.error, 1)
  assert.ok(h.warns.some((m) => m.includes('群记忆写入异常')))
  h.mod.dispose()
})

test('入站早于 lastAt 不重复带：第二次 flush incoming 为空', async () => {
  const h = setup({ messages: [{ speaker: '群友A', text: '第一条', at: T0 - 1000 }] })
  h.mod.noteReply({ groupId: GID, text: '回一下' })
  await h.mod.flush(GID)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].incoming.length, 1)

  // buffer 里补一条更早的旧消息（关窗前可能还留着），再 flush：不重复带，也不写空记忆
  h.bucket.messages.push({ speaker: '群友B', text: '旧消息', at: T0 - 5000 })
  await h.mod.flush(GID)
  assert.equal(h.calls.length, 1) // 没有新入站 → 跳过，不落空记忆
  assert.equal(h.mod.stats.skipped, 1)
  // 新消息进来后才写：只带新的那条
  h.bucket.messages.push({ speaker: '群友C', text: '新消息', at: T0 + 1000 })
  await h.mod.flush(GID)
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].incoming.length, 1)
  assert.equal(h.calls[1].incoming[0].text, '新消息')
  h.mod.dispose()
})

test('限流/重复返回值映射到 stats 与日志标签', async () => {
  const seq = [
    { ok: false, reason: 'rate-limited' },
    { ok: true, duplicate: true, chars: 40 },
  ]
  const h = setup({ memory: { saveGroupTurn: async () => seq.shift() }, messages: [{ speaker: '群友A', text: '一', at: T0 - 1000 }] })
  h.mod.noteReply({ groupId: GID, text: 'a' })
  await h.mod.flush(GID)
  h.bucket.messages.push({ speaker: '群友B', text: '二', at: T0 + 1000 })
  h.mod.noteReply({ groupId: GID, text: 'b' })
  await h.mod.flush(GID)

  assert.equal(h.mod.stats.limited, 1)
  assert.equal(h.mod.stats.duplicate, 1)
  assert.equal(h.mod.stats.ok, 0)
  assert.ok(h.infos.some((m) => m.includes('→ rate-limited')))
  assert.ok(h.infos.some((m) => m.includes('chars=40 → duplicate')))
  h.mod.dispose()
})

test('config.groupMemory：默认开启/15s；enabled 只认布尔 true', () => {
  const d = loadConfig({})
  assert.deepEqual(d.groupMemory, { enabled: true, flushIdleMs: 15000 })
  assert.equal(loadConfig({ groupMemory: { enabled: false } }).groupMemory.enabled, false)
  assert.equal(loadConfig({ groupMemory: { enabled: 'true' } }).groupMemory.enabled, false)
  assert.equal(loadConfig({ groupMemory: { flushIdleMs: 5000 } }).groupMemory.flushIdleMs, 5000)
  assert.equal(loadConfig({ groupMemory: { flushIdleMs: 1 } }).groupMemory.flushIdleMs, 1000) // 下限 1s
})


test('写入限流后保留本轮内容；重试成功才推进游标', async () => {
  const seq = [
    { ok: false, reason: 'rate-limited' },
    { ok: true, id: 'saved-after-retry', chars: 20 },
  ]
  const h = setup({
    idleMs: 60000,
    memory: { saveGroupTurn: async (x) => { h.calls.push(x); return seq.shift() } },
    messages: [{ speaker: '群友A', text: '不要丢掉我', at: T0 - 1000 }],
  })
  h.mod.noteReply({ groupId: GID, text: '我听到了' })
  const first = await h.mod.flush(GID)
  assert.equal(first.reason, 'rate-limited')
  assert.equal(h.calls.length, 1)

  const second = await h.mod.flush(GID)
  assert.equal(second.ok, true)
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls[1].incoming.map((x) => x.text), ['不要丢掉我'])
  assert.deepEqual(h.calls[1].reply, [{ text: '我听到了', at: T0 }])

  // 成功提交后，同一条旧入站不能再次进入记忆
  await h.mod.flush(GID)
  assert.equal(h.calls.length, 2)
  h.mod.dispose()
})

test('saveGroupTurn 抛异常后保留回复；并发 flush 对同一群单飞', async () => {
  let release
  let attempts = 0
  const gate = new Promise((resolve) => { release = resolve })
  const h = setup({
    idleMs: 60000,
    memory: {
      saveGroupTurn: async (x) => {
        attempts += 1
        h.calls.push(x)
        if (attempts === 1) throw new Error('temporary failure')
        if (attempts === 2) await gate
        return { ok: true, id: 'ok', chars: 10 }
      },
    },
    messages: [{ speaker: '群友A', text: '这条要留下', at: T0 - 1000 }],
  })
  h.mod.noteReply({ groupId: GID, text: '我来处理' })
  const failed = await h.mod.flush(GID)
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'temporary failure')

  const first = h.mod.flush(GID)
  const concurrent = h.mod.flush(GID)
  await Promise.resolve()
  assert.equal(attempts, 2)
  release()
  const [a, b] = await Promise.all([first, concurrent])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(attempts, 2)
  assert.deepEqual(h.calls[1].incoming.map((x) => x.text), ['这条要留下'])
  assert.deepEqual(h.calls[1].reply, [{ text: '我来处理', at: T0 }])
  h.mod.dispose()
})


test('flush 进行中有新回复到达：单飞结束后重新安排 flush，不丢缓冲', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = setup({
    idleMs: 10,
    memory: {
      saveGroupTurn: async (x) => {
        h.calls.push(x)
        if (h.calls.length === 1) await gate
        return { ok: true, id: h.calls.length, chars: 10 }
      },
    },
    messages: [{ speaker: '群友A', text: '第一轮', at: T0 - 1000 }],
  })
  h.mod.noteReply({ groupId: GID, text: '第一轮回复' })
  const first = h.mod.flush(GID)

  h.bucket.messages.push({ speaker: '群友B', text: '第二轮', at: T0 + 1000 })
  h.mod.noteReply({ groupId: GID, text: '第二轮回复' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(h.calls.length, 1)

  release()
  await first
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls[1].incoming.map((x) => x.text), ['第二轮'])
  assert.deepEqual(h.calls[1].reply, [{ text: '第二轮回复', at: T0 }])
  h.mod.dispose()
})


test('写入已落库但响应异常：重试沿用同一轮次时间，服务端可判 duplicate', async () => {
  const persisted = new Map()
  let first = true
  const times = [T0, T0 + 5000]
  const h = setup({
    idleMs: 60000,
    now: () => times.shift() ?? T0 + 9000,
    memory: {
      saveGroupTurn: async (x) => {
        h.calls.push(x)
        const key = `group-turn:${x.groupId}:${x.at}`
        if (persisted.has(key)) return { ok: true, duplicate: true, id: persisted.get(key), chars: 20 }
        persisted.set(key, 77)
        if (first) {
          first = false
          throw new Error('response lost after commit')
        }
        return { ok: true, id: 77, chars: 20 }
      },
    },
    messages: [{ speaker: '群友A', text: '服务端已写入', at: T0 - 1000 }],
  })
  h.mod.noteReply({ groupId: GID, text: '不要重复记我' })
  const firstResult = await h.mod.flush(GID)
  assert.equal(firstResult.error, 'response lost after commit')
  const retry = await h.mod.flush(GID)
  assert.equal(retry.duplicate, true)
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[0].at, h.calls[1].at)
  assert.equal(persisted.size, 1)
  h.mod.dispose()
})
