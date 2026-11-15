import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutgoing } from '../lib/style-clean.js'

test('清洗：客服腔开头、短句句号、空行、markdown', () => {
  assert.equal(cleanOutgoing('好的，我明白了\n去吧').text, '去吧')
  assert.equal(cleanOutgoing('好的，我明白了').text, '', '纯客服腔清洗后为空，由发送层保留原文')
  assert.equal(cleanOutgoing('晚安。').text, '晚安')
  assert.equal(cleanOutgoing('第一段\n\n\n第二段').text, '第一段\n\n第二段')
  assert.equal(cleanOutgoing('这是**重点**').text, '这是重点')
})

test('不清洗正常长句与语气词', () => {
  const s = '今天打球累不累呀？洗完记得吹头，别着凉。'
  const r = cleanOutgoing(s)
  assert.equal(r.text, s)
  assert.equal(r.changed, false)
})

test('off 模式完全不动', () => {
  const s = '好的，我明白了。'
  assert.equal(cleanOutgoing(s, { enabled: false }).text, s)
})
