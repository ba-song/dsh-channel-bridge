import test from 'node:test'
import assert from 'node:assert/strict'
import { decideGroupSocial } from '../lib/group-social.js'

test('默认关；命令/太短/冷群不说话；主人提问可两条并引用', () => {
  assert.equal(decideGroupSocial({ parsed: { text: 'hi' }, cfg: {} }).speak, true)
  const on = { enabled: true, social: { enabled: true, maxCount: 2, closeAfterMessages: 12 } }
  assert.equal(decideGroupSocial({ parsed: { text: '/help' }, cfg: on }).speak, false)
  assert.equal(decideGroupSocial({ parsed: { text: '嗯' }, cfg: on }).speak, false)
  assert.equal(decideGroupSocial({ parsed: { text: '在吗', isOwner: true }, cfg: on }).count, 2)
  assert.equal(decideGroupSocial({ parsed: { text: '在吗', isOwner: true }, cfg: on }).quote, true)
  assert.equal(decideGroupSocial({ parsed: { text: '随便说说最近的事', }, cfg: on, recent: 20 }).speak, false)
})
