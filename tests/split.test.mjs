import test from 'node:test'
import assert from 'node:assert/strict'
import { splitForSend } from '../lib/split.js'

const PUNCT_START = /^[。！？!?；;，,、…：:]/
const purePunct = (s) => s.length > 0 && [...s].every((c) => /[。！？!?；;，,、…：:]/.test(c))

test('线上 bug 复现：长句里的「…135 条的。」不会被切出「的。」', () => {
  const text = '啊'.repeat(50) + '，还有之前那个 135 条的。'
  const segs = splitForSend(text, { maxLen: 60, maxSegments: 4 })
  assert.ok(!segs.includes('的。'), `segments=${JSON.stringify(segs)}`)
  for (const s of segs) assert.ok(!PUNCT_START.test(s), `段以标点开头：${s}`)
  for (const s of segs) assert.ok(!purePunct(s), `纯标点段：${s}`)
  assert.equal(segs.join(''), text)
})

test('切点紧邻标点：标点并入前一段，不单独成段', () => {
  const text = 'a'.repeat(60) + '。' + 'b'.repeat(5)
  const segs = splitForSend(text, { maxLen: 60, maxSegments: 4 })
  assert.equal(segs[0], 'a'.repeat(60) + '。') // 61 字：允许标点溢出
  assert.ok(!segs.includes('。'))
  for (const s of segs) assert.ok(!purePunct(s))
})

test('纯标点段被合并回前一段', () => {
  const text = '啊'.repeat(20) + '，' + '。' + '嗯'.repeat(3)
  const segs = splitForSend(text, { maxLen: 60, maxSegments: 4 })
  for (const s of segs) assert.ok(!purePunct(s), JSON.stringify(segs))
  assert.equal(segs.join(''), text)
})

test('超长句仍能拆成 ≤60 的段', () => {
  const text = '啊'.repeat(200)
  const segs = splitForSend(text, { maxLen: 60, maxSegments: 4 })
  assert.ok(segs.length >= 2 && segs.length <= 4)
  for (const s of segs) assert.ok([...s].length <= 60, `段长 ${[...s].length}`)
  assert.equal(segs.join(''), text)
})

test('优先在句末标点后切（其次逗号）', () => {
  const text = '第一句。' + '啊'.repeat(70) + '，第二部分结束。'
  const segs = splitForSend(text, { maxLen: 60, maxSegments: 4 })
  assert.ok(segs[0].endsWith('。'), `第一段应吃到句号：${segs[0]}`)
  assert.equal(segs.join(''), text)
})

test('30 字短句不拆', () => {
  const text = '今天天气不错，我打算出去走走，顺便买点东西回来。'
  assert.deepEqual(splitForSend(text, { maxLen: 60 }), [text])
})
