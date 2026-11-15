import test from 'node:test'
import assert from 'node:assert/strict'
import { isPlaceholderOnly, shouldSkipPrivate } from '../lib/filters.js'

const p = (over = {}) => ({ channel: 'qq', kind: 'private', contactId: '2010741172', contactName: 'QQ邮箱提醒', text: '', media: [], isOwner: false, ...over })

test('纯占位判定：卡片/转发/视频 无正文无媒体 → true；混正文/图片 → false', () => {
  assert.equal(isPlaceholderOnly(p({ text: '[卡片]' })), true)
  assert.equal(isPlaceholderOnly(p({ text: ' [转发] ' })), true)
  assert.equal(isPlaceholderOnly(p({ text: '[视频]' })), true)
  assert.equal(isPlaceholderOnly(p({ text: '[卡片] 你有一封新邮件' })), false)
  assert.equal(isPlaceholderOnly(p({ text: '' })), false)
  assert.equal(isPlaceholderOnly(p({ text: '[图片]', media: [{ kind: 'image' }] })), false)
})

test('非主人纯卡片 → 跳过；正常文字 → 投', () => {
  assert.deepEqual(shouldSkipPrivate(p({ text: '[卡片]' })), { skip: true, reason: 'placeholder' })
  const ok = shouldSkipPrivate(p({ text: '你好呀' }))
  assert.equal(ok.skip, false)
})

test('图片消息（有 media）不拦', () => {
  const r = shouldSkipPrivate(p({ text: '[图片]', media: [{ kind: 'image', url: 'x' }] }))
  assert.equal(r.skip, false)
})

test('主人自己的卡片不拦', () => {
  const r = shouldSkipPrivate(p({ text: '[卡片]', isOwner: true }))
  assert.equal(r.skip, false)
})

test('群消息不受影响（群仍走 @ 门禁）', () => {
  const r = shouldSkipPrivate(p({ kind: 'group', contactId: '707380948', text: '[卡片]' }))
  assert.equal(r.skip, false)
})

test('ignoreCards:false 放行；ignoreContacts 按号码兜底', () => {
  assert.equal(shouldSkipPrivate(p({ text: '[卡片]' }), { ignoreCards: false }).skip, false)
  const r = shouldSkipPrivate(p({ text: '正常文字' }), { ignoreContacts: ['2010741172'] })
  assert.deepEqual(r, { skip: true, reason: 'contact' })
})
