import test from 'node:test'
import assert from 'node:assert/strict'
import { createSender } from '../lib/sender.js'

test('禁词包：命中直接拦下，不发送', async () => {
  const sender = createSender({ getClient: () => null, styleBanned: ['挡'] })
  const r = await sender.sendText({ kind: 'private', contactId: '1', text: '我挡一下' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_BANNED')
})
test('禁词包为空时正常走发送（未连接返回 E_NOT_CONNECTED）', async () => {
  const sender = createSender({ getClient: () => null, styleBanned: [] })
  const r = await sender.sendText({ kind: 'private', contactId: '1', text: '正常' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NOT_CONNECTED')
})
