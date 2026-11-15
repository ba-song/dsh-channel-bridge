import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.js'
import { openBridgeDb } from '../lib/store.js'

function setup({ modeValue = 'send', ok = true, data = null } = {}) {
  const defs = []
  const calls = []
  const store = openBridgeDb(':memory:')
  const sender = {
    callAction: async (action, params) => {
      calls.push({ action, params })
      return ok ? { ok: true, data, raw: { data } } : { ok: false, code: 'E_SEND_FAILED', detail: 'boom' }
    },
  }
  registerTools({
    tools: { register: (d) => defs.push(d) },
    cfg: { owner: { qqIds: ['2971030080'] }, say: {}, qq: {}, groupCwd: '/sdcard/DSHA/渠道/qq-群', selfId: '2190097528' },
    mode: { current: () => modeValue },
    sender,
    store,
    log: null,
  })
  const tool = (n) => defs.find((d) => d.name === n)
  return { defs, calls, store, tool }
}

const ownerExec = { agent: { session: { header: { cwd: '/sdcard/DSHA/渠道/qq' } } } }
const subExec = { agent: { session: { header: { parentSession: 'p' } } } }
const groupExec = { agent: { session: { header: { cwd: '/sdcard/DSHA/渠道/qq-群' } } } }

test('dy_qq_recall：参数 → delete_msg，审计只记 message_id', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_recall').execute({ messageId: -123456 }, ownerExec)
  assert.equal(r.ok, true)
  assert.deepEqual(h.calls[0], { action: 'delete_msg', params: { message_id: -123456 } })
  const op = h.store.listQqOps(1)[0]
  assert.equal(op.action, 'recall')
  assert.match(op.fields, /message_id:-123456/)
  assert.equal(op.ok, 1)
})

test('dy_qq_recall：门禁/参数/失败不重试', async () => {
  const h = setup()
  assert.match((await h.tool('dy_qq_recall').execute({ messageId: 1 }, subExec)).detail, /E_PERMISSION/)
  assert.match((await h.tool('dy_qq_recall').execute({ messageId: 1 }, groupExec)).detail, /E_PERMISSION/)
  assert.match((await h.tool('dy_qq_recall').execute({ messageId: 'abc' }, ownerExec)).detail, /E_PARAM/)
  assert.equal(h.calls.length, 0)
  const h2 = setup({ ok: false })
  assert.match((await h2.tool('dy_qq_recall').execute({ messageId: 5 }, ownerExec)).detail, /E_SEND_FAILED/)
  assert.equal(h2.calls.length, 1)
  assert.equal(h2.store.listQqOps(1)[0].ok, 0)
})

test('dy_qq_forward：私聊/群两种目标调用不同 action', async () => {
  const h = setup({ data: { message_id: 777 } })
  const r1 = await h.tool('dy_qq_forward').execute({ messageId: -5, toKind: 'private', toId: '2971030080' }, ownerExec)
  assert.equal(r1.ok, true)
  assert.deepEqual(h.calls[0], { action: 'forward_friend_single_msg', params: { message_id: -5, user_id: 2971030080 } })
  const r2 = await h.tool('dy_qq_forward').execute({ messageId: -5, toKind: 'group', toId: '707380948' }, ownerExec)
  assert.equal(r2.ok, true)
  assert.deepEqual(h.calls[1], { action: 'forward_group_single_msg', params: { message_id: -5, group_id: 707380948 } })
  assert.equal(h.store.listQqOps(2).length, 2)
  assert.match((await h.tool('dy_qq_forward').execute({ messageId: 1, toKind: 'room', toId: '1' }, ownerExec)).detail, /E_PARAM/)
})

test('dy_qq_friend_request：list 只读、返回脱敏列表', async () => {
  const data = [{ uid: 'u1', user_id: 12345, nick: '小明', source: 'search', msg: '你好', group_code: '', reqTime: 1 }]
  const h = setup({ data })
  const r = await h.tool('dy_qq_friend_request').execute({ action: 'list' }, ownerExec)
  assert.equal(r.ok, true)
  assert.deepEqual(h.calls[0], { action: 'get_doubt_friends_add_request', params: { count: 20 } })
  const body = JSON.parse(r.detail)
  assert.deepEqual(body.requests[0], { flag: 'u1', userId: 12345, nick: '小明', source: 'search', msg: '你好', groupCode: '', reqTime: 1 })
})

test('dy_qq_friend_request：approve 缺 confirm 零调用；reject 可无 confirm', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_friend_request').execute({ action: 'approve', flag: 'u1' }, ownerExec)
  assert.match(r.detail, /E_CONFIRM_REQUIRED/)
  assert.equal(h.calls.length, 0)
  const r2 = await h.tool('dy_qq_friend_request').execute({ action: 'approve', flag: 'u1', confirm: true }, ownerExec)
  assert.equal(r2.ok, true)
  assert.deepEqual(h.calls[0], { action: 'set_doubt_friends_add_request', params: { flag: 'u1', approve: true } })
  const r3 = await h.tool('dy_qq_friend_request').execute({ action: 'reject', flag: 'u2' }, ownerExec)
  assert.equal(r3.ok, true)
  assert.deepEqual(h.calls[1], { action: 'set_doubt_friends_add_request', params: { flag: 'u2', approve: false } })
})

test('dy_qq_friend_request：缺 flag → E_PARAM；失败不重试；审计不含正文', async () => {
  const h = setup()
  assert.match((await h.tool('dy_qq_friend_request').execute({ action: 'approve', confirm: true }, ownerExec)).detail, /E_PARAM/)
  const h2 = setup({ ok: false })
  const r = await h2.tool('dy_qq_friend_request').execute({ action: 'reject', flag: 'u3' }, ownerExec)
  assert.match(r.detail, /E_SEND_FAILED/)
  assert.equal(h2.calls.length, 1)
  const ops = JSON.stringify(h2.store.listQqOps(5))
  assert.ok(!ops.includes('u3')) // flag 也不落审计
  assert.equal(h2.store.listQqOps(1)[0].ok, 0)
})

test('dy_qq_friend_request：陌生人（子智能体）不能调', async () => {
  const h = setup()
  const r = await h.tool('dy_qq_friend_request').execute({ action: 'list' }, subExec)
  assert.match(r.detail, /E_PERMISSION/)
  assert.equal(h.calls.length, 0)
})
