import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupDigest } from '../lib/group-digest.js'
import { createFollowUpWindow } from '../lib/group-followup.js'

const T0 = Date.parse('2026-11-07T05:00:00Z')
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? '汐' : '主人', text: `第${i}条`, at: T0 + i }))

function setup({ memory = undefined, digestFail = false, transcriptFail = false, withTranscript = true } = {}) {
  const digestCalls = []
  const transcriptCalls = []
  const warns = []
  const infos = []
  const mem = memory === null ? null : {
    saveGroupDigest: async (x) => { digestCalls.push(x); if (digestFail) throw new Error('digest down'); return { ok: true } },
    ...(withTranscript ? {
      saveGroupTranscript: async (x) => { transcriptCalls.push(x); if (transcriptFail) throw new Error('transcript down'); return { ok: true, archived: x.messages.length } },
    } : {}),
    ...(memory ?? {}),
  }
  const digest = createGroupDigest({
    getMemory: () => mem,
    now: () => T0,
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
  })
  return { digest, digestCalls, transcriptCalls, warns, infos }
}

test('群摘要退役：不再调 saveGroupDigest，仍调 saveGroupTranscript（参数不变）', async () => {
  const h = setup()
  const messages = msgs(2)
  const r = await h.digest.save({ groupId: '707380948', groupName: '测试群', messages, at: T0 })
  assert.equal(r.ok, true)
  assert.equal(h.digestCalls.length, 0) // 旧摘要路径已停
  assert.equal(r.digest, null)
  assert.equal(h.transcriptCalls.length, 1)
  assert.equal(r.transcript.ok, true)
  const c = h.transcriptCalls[0]
  assert.equal(c.groupId, '707380948')
  assert.equal(c.groupName, '测试群')
  assert.equal(c.messageId, `group:707380948:${T0}`)
  assert.deepEqual(c.messages, messages)
  assert.equal(h.digest.stats.saved, 0)
  assert.equal(h.digest.stats.transcriptSaved, 1)
})

test('退役提示只打一次 info：第一次调用打，之后不重复刷', async () => {
  const h = setup()
  const first = await h.digest.save({ groupId: '1', messages: msgs(2), at: T0 })
  assert.equal(first.ok, true)
  await h.digest.save({ groupId: '1', messages: msgs(3), at: T0 + 1 })
  const notices = h.infos.filter((m) => m === '[channel-bridge] 群摘要已退役（改用轮次记忆）')
  assert.equal(notices.length, 1)
  assert.equal(h.digest.stats.retired, 1)
})

test('transcript 拿全部消息（不截 10 条），同 at/messageId', async () => {
  const h = setup()
  const messages = msgs(15)
  const r = await h.digest.save({ groupId: '1', groupName: '群', messages, at: T0 })
  assert.equal(h.transcriptCalls.length, 1)
  assert.equal(h.transcriptCalls[0].messages.length, 15) // 全文，不截断
  assert.equal(h.transcriptCalls[0].at, T0)
  assert.equal(h.transcriptCalls[0].messageId, `group:1:${T0}`)
  assert.equal(r.count, 15)
  assert.equal(h.digestCalls.length, 0)
})

test('transcript 失败只 warn、不重试；没有摘要兜底，整体失败', async () => {
  const h = setup({ transcriptFail: true })
  const r = await h.digest.save({ groupId: '1', messages: msgs(3), at: T0 })
  assert.equal(h.digestCalls.length, 0)
  assert.equal(h.transcriptCalls.length, 1) // 只调一次
  assert.equal(r.ok, false)
  assert.equal(r.transcript.ok, false)
  assert.equal(h.digest.stats.transcriptFailed, 1)
  assert.ok(h.warns.some((w) => w.includes('全文归档失败')))
})

test('空窗口不调用；dyMemory 缺失跳过（digest/transcript 都不调）', async () => {
  const h = setup()
  const r1 = await h.digest.save({ groupId: '1', messages: [], at: T0 })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'E_EMPTY')
  assert.equal(h.digestCalls.length + h.transcriptCalls.length, 0)

  const h2 = setup({ memory: null })
  const r2 = await h2.digest.save({ groupId: '1', messages: msgs(2), at: T0 })
  assert.equal(r2.code, 'E_MEMORY_UNAVAILABLE')
  assert.equal(h2.digestCalls.length + h2.transcriptCalls.length, 0)
})

test('memory 只有摘要能力（没有 transcript）：跳过，不回头调已退役的摘要', async () => {
  const h = setup({ withTranscript: false })
  const r = await h.digest.save({ groupId: '1', messages: msgs(2), at: T0 })
  assert.equal(r.code, 'E_MEMORY_UNAVAILABLE')
  assert.equal(h.digestCalls.length, 0)
  assert.equal(h.transcriptCalls.length, 0)
})

test('跟话窗口：8 条用完 / idle 超时各触发一次 onClose（reason 正确）；续窗不关', () => {
  let t = T0
  const closes = []
  const w = createFollowUpWindow({ messages: 8, idleMs: 600000, now: () => t, log: null, onClose: (x) => closes.push(x.reason) })
  w.open()
  w.renew()
  for (let i = 0; i < 8; i += 1) w.consume()
  assert.deepEqual(closes, ['exhausted'])
  t += 1000
  w.open()
  t += 600000
  assert.equal(w.isOpen(), false)
  assert.deepEqual(closes, ['exhausted', 'idle'])
})
