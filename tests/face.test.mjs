import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSegments, splitSegments } from '../lib/parse.js'
import { faceText, mfaceText } from '../lib/face.js'

test('QQ 小表情渲染成中文名，不再一律 [表情]', () => {
  assert.equal(faceText(14), '[表情:微笑]')
  assert.equal(faceText(0), '[表情:惊讶]')
  assert.equal(faceText(300), '[表情#300]') // 表外 id 至少可区分
  assert.equal(faceText(''), '[表情]')
  const msg = [{ type: 'text', data: { text: '你好' } }, { type: 'face', data: { id: 14 } }]
  assert.equal(renderSegments(msg), '你好[表情:微笑]')
  assert.equal(splitSegments(msg).text, '你好[表情:微笑]')
})

test('表情包（mface）带 summary 名字', () => {
  assert.equal(mfaceText({ summary: '本鱼已停止思考' }), '[表情包:本鱼已停止思考]')
  assert.equal(mfaceText({}), '[表情包]')
  assert.equal(renderSegments([{ type: 'mface', data: { summary: '狗头' } }]), '[表情包:狗头]')
})

test('表情包有图时进 media（能落盘给她看），没图只有名字', () => {
  const withUrl = splitSegments([{ type: 'mface', data: { summary: '狗头', url: 'https://x/y.png' } }])
  assert.equal(withUrl.text, '[表情包:狗头]')
  assert.equal(withUrl.media.length, 1)
  assert.equal(withUrl.media[0].url, 'https://x/y.png')
  const noUrl = splitSegments([{ type: 'mface', data: { summary: '狗头' } }])
  assert.equal(noUrl.media.length, 0)
})

test('安卓 QQ 表：78=握手、76=赞(点赞)、77=踩', () => {
  assert.equal(faceText(78), '[表情:握手(你好)]')
  assert.equal(faceText(76), '[表情:赞(点赞)]')
  assert.equal(faceText(77), '[表情:踩(踩/不认同)]')
  assert.equal(faceText(22), '[表情:白眼(无语)]')
})
