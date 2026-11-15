import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconciler } from '../lib/reconcile.js'
import { openBridgeDb } from '../lib/store.js'

/**
 * 群对账（补收）：不依赖 WS 推送，用 get_group_msg_history 拉最近群消息，
 * 过滤后必须过 @ 门禁（shouldDeliverGroup），成功才落库 + 推进游标。
 */
const T0 = Date.parse('2026-11-10T02:00:00Z')
const SELF = '2190097528'
const G1 = '707380948'
const G2 = '903533578'
const sec = (ms) => Math.floor(ms / 1000)

/** 近似 NapCat 历史事件（完整 OneBot message 事件）。atBot=@她。 */
function groupMsg(id, atMs, { text = '在吗', uid = '3490910889', gid = G1, atBot = false, atQq = '', withMeta = true } = {}) {
  const message = []
  if (atBot) message.push({ type: 'at', data: { qq: SELF } })
  else if (atQq) message.push({ type: 'at', data: { qq: atQq } })
  message.push({ type: 'text', data: { text } })
  return {
    ...(withMeta ? { post_type: 'message', message_type: 'group', self_id: Number(SELF) } : {}),
    message_id: id,
    group_id: Number(gid),
    time: sec(atMs),
    user_id: Number(uid),
    sender: { card: '', nickname: '群友甲' },
    message,
  }
}

function setup({ histories = {}, deliverImpl = null, reconcile = {}, group = { requireMention: true, mentionNames: [] }, groupRows = [{ contact: G1, name: '原神群' }], privateRows = [], log = null } = {}) {
  const store = openBridgeDb(':memory:')
  for (const g of groupRows) store.upsertContact({ contact: g.contact, kind: 'group', name: g.name, at: g.at ?? T0 })
  for (const p of privateRows) store.upsertContact({ contact: p.contact, kind: 'private', name: p.name, at: p.at ?? T0 })
  const calls = []
  const client = {
    call: async (action, params) => {
      calls.push({ action, params })
      const key = String(params.group_id ?? params.user_id ?? '')
      const h = histories[key]
      if (typeof h === 'function') return h(action, params)
      if (h && h.error) throw Object.assign(new Error(h.error.message ?? h.error.code ?? 'E_TIMEOUT'), { code: h.error.code ?? 'E_TIMEOUT' })
      return { status: 'ok', retcode: 0, data: { messages: h ?? [] } }
    },
  }
  const delivered = []
  const deliverCalls = []
  const messages = []
  let t = T0 + 120000
  const reconciler = createReconciler({
    cfg: { selfId: SELF, group, reconcile: { enabled: true, count: 20, groupCount: 20, ...reconcile } },
    store,
    getClient: () => client,
    deliverOne: async (parsed) => {
      deliverCalls.push(parsed)
      if (deliverImpl) return deliverImpl(parsed)
      delivered.push(parsed)
      return { ok: true, delivered: true }
    },
    onMessage: (p) => messages.push(p.messageId),
    log,
    now: () => t,
  })
  return { store, client, calls, delivered, deliverCalls, messages, reconciler, advance: (ms) => { t += ms }, now: () => t }
}

const groupCalls = (calls) => calls.filter((c) => c.action === 'get_group_msg_history')
const inboundRows = (store) => store.raw.prepare(`SELECT at, kind, contact, sender_id, text, message_id, meta FROM channel_events WHERE direction='in' ORDER BY at ASC`).all()

test('群历史有 2 条新 @ → 按时间投 2 条、落库、游标前进', async () => {
  const h = setup({
    histories: {
      [G1]: [
        groupMsg('B', T0 + 120000, { text: '第二', atBot: true }),
        groupMsg('A', T0 + 60000, { text: '第一', atBot: true }),
      ],
    },
  })
  await h.reconciler.runOnce()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['A', 'B'])
  assert.deepEqual(h.delivered.map((p) => p.text), ['@2190097528第一', '@2190097528第二'])
  assert.equal(h.delivered[0].kind, 'group')
  assert.equal(h.delivered[0].contactId, G1)
  assert.equal(h.delivered[0].contactName, '原神群') // 历史没 group_name → 用联系人表名字
  assert.equal(h.delivered[0].reconcile, true)
  assert.equal(h.delivered[0].at, T0 + 60000)
  assert.equal(h.delivered[0].wantGroupContext, true) // 和实时 @ 一样带近况+群上下文
  // 请求参数
  assert.equal(groupCalls(h.calls)[0].params.group_id, G1)
  assert.equal(groupCalls(h.calls)[0].params.count, 20)
  // 落库 + 游标
  const rows = inboundRows(h.store)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.message_id), ['A', 'B'])
  assert.equal(rows[0].kind, 'group')
  assert.equal(rows[0].contact, G1)
  assert.equal(JSON.parse(rows[0].meta).reconcile, true)
  assert.equal(h.store.contactOf('qq', G1, 'group').last_seen_at, T0 + 120000)
  assert.equal(h.reconciler.stats.groupDelivered, 2)
  assert.deepEqual(h.messages, ['A', 'B']) // health 复位回调
  // 第二轮：已落库 + 游标已过 → 不重复投
  await h.reconciler.runOnce()
  assert.equal(h.delivered.length, 2)
})

test('非 @ 群消息 → 门禁拦下：不投、不落库、游标不动', async () => {
  const h = setup({ histories: { [G1]: [groupMsg('N1', T0 + 60000, { text: '随口一说' })] } })
  await h.reconciler.runOnce()
  assert.equal(h.deliverCalls.length, 0) // 连 deliverOne 都不该进
  assert.equal(inboundRows(h.store).length, 0)
  assert.equal(h.store.contactOf('qq', G1, 'group').last_seen_at, T0)
  assert.equal(h.reconciler.stats.groupGateSkipped, 1)
  assert.equal(h.reconciler.stats.groupFailed, 0) // 门禁不是失败
  assert.equal(h.reconciler.stats.groupNew, 1)
})

test('群消息 @ 的是别人 → 不投（门禁不放行）', async () => {
  const h = setup({ histories: { [G1]: [groupMsg('ATOTHER', T0 + 60000, { atQq: '10001' })] } })
  await h.reconciler.runOnce()
  assert.equal(h.deliverCalls.length, 0)
  assert.equal(h.reconciler.stats.groupGateSkipped, 1)
  assert.equal(inboundRows(h.store).length, 0)
})

test('group.requireMention=false → 非 @ 群消息也投（和实时一致）', async () => {
  const h = setup({
    histories: { [G1]: [groupMsg('FREE', T0 + 60000, { text: '不 @ 也回' })] },
    group: { requireMention: false, mentionNames: [] },
  })
  await h.reconciler.runOnce()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['FREE'])
  assert.equal(h.delivered[0].wantGroupContext, undefined) // 非 at-bot 不拉群上下文
})
test('deliverOne 回「过了闸但没下发」(skipped) → 不落库、游标不动，不算失败', async () => {
  const h = setup({
    histories: { [G1]: [groupMsg('S1', T0 + 60000, { atBot: true })] },
    deliverImpl: async () => ({ ok: true, skipped: true, reason: 'QUEUE_FULL' }),
  })
  await h.reconciler.runOnce()
  assert.equal(h.deliverCalls.length, 1)
  assert.equal(inboundRows(h.store).length, 0)
  assert.equal(h.store.contactOf('qq', G1, 'group').last_seen_at, T0)
  assert.equal(h.reconciler.stats.groupGateSkipped, 1)
  assert.equal(h.reconciler.stats.groupFailed, 0)
})

test('重复 message_id（WS/补收已投）→ 跳过不重复投', async () => {
  const h = setup({ histories: { [G1]: [groupMsg('D1', T0 + 60000, { atBot: true })] } })
  h.store.insertEvent({ at: T0 + 60000, channel: 'qq', kind: 'group', contact: G1, senderId: '3490910889', direction: 'in', text: '已由 WS 投过', messageId: 'D1' })
  await h.reconciler.runOnce()
  assert.equal(h.delivered.length, 0)
  assert.equal(h.reconciler.stats.groupSkipped, 1)
  assert.equal(h.reconciler.stats.groupFailed, 0)
})

test('自己发的群消息 → 跳过', async () => {
  const h = setup({ histories: { [G1]: [groupMsg('ME', T0 + 60000, { text: '她说的', uid: SELF, atBot: false })] } })
  await h.reconciler.runOnce()
  assert.equal(h.delivered.length, 0)
  assert.equal(h.reconciler.stats.groupSkipped, 0) // 自己发的不算「跳过」，直接过滤
  assert.equal(h.reconciler.stats.groupGateSkipped, 0)
})

test('同一批历史里回了两遍同一条 → 只投 1 次', async () => {
  const h = setup({
    histories: { [G1]: [groupMsg('TWIN', T0 + 60000, { atBot: true }), groupMsg('TWIN', T0 + 60000, { atBot: true })] },
  })
  await h.reconciler.runOnce()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['TWIN'])
  assert.equal(h.reconciler.stats.groupSkipped, 1)
  assert.equal(inboundRows(h.store).length, 1)
})

test('群历史超时 → 该群退避、其他群照常投；退避窗口过了再试', async () => {
  const warns = []
  const h = setup({
    histories: {
      [G1]: { error: { code: 'E_TIMEOUT' } },
      [G2]: [groupMsg('OK1', T0 + 60000, { gid: G2, atBot: true })],
    },
    groupRows: [
      { contact: G1, name: '坏群' },
      { contact: G2, name: '好群' },
    ],
    log: { info: () => {}, warn: (m) => warns.push(m) },
  })
  await h.reconciler.runOnce()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['OK1'])
  assert.equal(h.reconciler.stats.groupFailed, 1)
  assert.equal(h.reconciler.stats.groupDelivered, 1)
  assert.ok(h.reconciler.backoff.has(`group:${G1}`))
  assert.ok(!h.reconciler.backoff.has(`group:${G2}`))
  assert.match(warns.join('\n'), new RegExp(`群对账 group=${G1} 拉历史失败：E_TIMEOUT`))
  // 下一轮：坏群不再拉（退避），好群照常
  const before = groupCalls(h.calls).length
  await h.reconciler.runOnce()
  assert.equal(groupCalls(h.calls).length, before + 1) // 只有好群
  assert.equal(h.reconciler.stats.groupBackoffSkipped, 1)
  // 退避窗口过了 → 重新拉
  h.advance(3600001)
  await h.reconciler.runOnce()
  assert.equal(groupCalls(h.calls).filter((c) => c.params.group_id === G1).length, 2)
})

test('reconcile.groups=false → 完全不扫群', async () => {
  const h = setup({
    histories: { [G1]: [groupMsg('X', T0 + 60000, { atBot: true })] },
    privateRows: [{ contact: '2971030080', name: '主人' }],
    reconcile: { groups: false },
  })
  await h.reconciler.runOnce()
  assert.equal(groupCalls(h.calls).length, 0)
  assert.equal(h.reconciler.stats.groupFetched, 0)
  assert.equal(h.delivered.length, 0)
  assert.ok(h.calls.some((c) => c.action === 'get_friend_msg_history')) // 私聊不受影响
})

test('私聊 + 群同一轮：各走各的，统计字段不互相污染', async () => {
  const h = setup({
    histories: {
      [G1]: [groupMsg('GMSG', T0 + 90000, { atBot: true })],
      '2971030080': [{ message_id: 'PMSG', time: sec(T0 + 60000), user_id: 2971030080, sender: { nickname: '主人' }, message: [{ type: 'text', data: { text: '私聊' } }] }],
    },
    privateRows: [{ contact: '2971030080', name: '主人' }],
  })
  await h.reconciler.runOnce()
  assert.deepEqual(h.delivered.map((p) => `${p.kind}:${p.messageId}`), ['private:PMSG', 'group:GMSG'])
  assert.equal(h.reconciler.stats.delivered, 1) // 私聊口径不变
  assert.equal(h.reconciler.stats.fetched, 1)
  assert.equal(h.reconciler.stats.groupDelivered, 1)
  assert.equal(h.reconciler.stats.groupFetched, 1)
  assert.equal(inboundRows(h.store).length, 2)
  assert.equal(h.store.contactOf('qq', G1, 'group').last_seen_at, T0 + 90000)
  assert.equal(h.store.contactOf('qq', '2971030080', 'private').last_seen_at, T0 + 60000)
})

test('历史事件缺 post_type/message_type → 兜底解析仍能投（只 warn 一次）', async () => {
  const warns = []
  const h = setup({
    histories: { [G1]: [groupMsg('NM', T0 + 60000, { atBot: true, withMeta: false })] },
    log: { info: () => {}, warn: (m) => warns.push(m) },
  })
  await h.reconciler.runOnce()
  assert.deepEqual(h.delivered.map((p) => p.messageId), ['NM'])
  assert.equal(warns.filter((w) => w.includes('缺 post_type')).length, 1)
})

test('日志口径：群单独一行 + 汇总带群维度', async () => {
  const lines = []
  const h = setup({
    histories: { [G1]: [groupMsg('L1', T0 + 60000, { atBot: true }), groupMsg('L2', T0 + 120000, { atBot: true })] },
    log: { info: (m) => lines.push(m), warn: () => {} },
  })
  await h.reconciler.runOnce()
  const groupLine = lines.find((l) => l.includes('群对账：group='))
  assert.ok(groupLine, '缺群对账明细行')
  assert.match(groupLine, new RegExp(`群对账：group=${G1} 拉 2 / 新 2 / 投 2`))
  const summary = lines.find((l) => l.includes('对账：本轮拉取'))
  assert.ok(summary, '缺本轮汇总行')
  assert.match(summary, /群：拉 2 \/ 新 2 \/ 投 2 \/ 门禁跳 0 \/ 失败 0/)
  // 私聊汇总字段仍在（兼容）
  assert.match(summary, /本轮拉取 0 条/)
  assert.match(summary, /累计拉取 0/)
})

test('群也按 activeDays 过滤：太久没动静的群不扫', async () => {
  const h = setup({
    histories: { [G1]: [groupMsg('OLD', T0 + 60000, { atBot: true })] },
    groupRows: [{ contact: G1, name: '很久没动静', at: T0 - 8 * 24 * 3600 * 1000 - 1000 }],
  })
  await h.reconciler.runOnce()
  assert.equal(groupCalls(h.calls).length, 0)
  assert.equal(h.reconciler.stats.groupStaleSkipped, 1)
})

test('群历史 E_NOT_CONNECTED（重连瞬间）→ 只退避 2 分钟，不静音一小时', async () => {
  const h = setup({
    histories: { [G1]: { error: { code: 'E_NOT_CONNECTED' } } },
    groupRows: [{ contact: G1, name: '群' }],
  })
  await h.reconciler.runOnce()
  const b = h.reconciler.backoff.get(`group:${G1}`)
  assert.ok(b)
  assert.ok(b.skipUntil - h.now() <= 120000)
  h.advance(120001)
  await h.reconciler.runOnce()
  assert.equal(groupCalls(h.calls).filter((c) => c.params.group_id === G1).length, 2)
})
