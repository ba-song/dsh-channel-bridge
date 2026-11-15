import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCardSegment, renderCard } from '../lib/card.js'

/** 构造 json 卡片段（value 可以是对象或原始字符串）。 */
function jsonSeg(value) {
  return { type: 'json', data: { data: typeof value === 'string' ? value : JSON.stringify(value) } }
}

test('QQ 分享 json：meta.news 标题/摘要/jumpUrl', () => {
  const raw = JSON.stringify({
    app: 'com.tencent.structmsg',
    prompt: '[分享] Claude 更新',
    meta: { news: { title: 'Claude 更新了', desc: '新模型上线', jumpUrl: 'https://www.anthropic.com/news?a=1&b=2' } },
  })
  const card = parseCardSegment({ type: 'json', data: { data: raw } })
  assert.equal(card.kind, 'json')
  assert.equal(card.app, 'com.tencent.structmsg')
  assert.equal(card.title, 'Claude 更新了')
  assert.equal(card.desc, '新模型上线')
  assert.equal(card.url, 'https://www.anthropic.com/news?a=1&b=2')
  assert.equal(card.raw, raw)
})

test('小程序 json：meta.detail_1 + qqdocurl', () => {
  const card = parseCardSegment(jsonSeg({
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序] 天气',
    meta: { detail_1: { title: '今日天气', desc: '多云 26℃', qqdocurl: 'https://m.weather.com.cn/x?id=1' } },
  }))
  assert.equal(card.app, 'com.tencent.miniapp_01')
  assert.equal(card.title, '今日天气')
  assert.equal(card.desc, '多云 26℃')
  assert.equal(card.url, 'https://m.weather.com.cn/x?id=1')
})

test('简单 json 形态：{app,title,desc,url}', () => {
  const card = parseCardSegment(jsonSeg({ app: 'com.tencent.structmsg', title: '文章标题', desc: '摘要', url: 'https://example.com/a' }))
  assert.equal(card.kind, 'json')
  assert.equal(card.title, '文章标题')
  assert.equal(card.desc, '摘要')
  assert.equal(card.url, 'https://example.com/a')
})

test('json 无标题时用 prompt 兜底', () => {
  const card = parseCardSegment(jsonSeg({ app: 'com.tencent.structmsg', prompt: '[分享] 只有 prompt' }))
  assert.equal(card.title, '[分享] 只有 prompt')
})

test('json 段 data.data 是对象也兼容', () => {
  const data = { app: 'com.tencent.structmsg', title: '对象形态', url: 'https://x.y/z' }
  const card = parseCardSegment({ type: 'json', data: { data } })
  assert.equal(card.title, '对象形态')
  assert.equal(card.url, 'https://x.y/z')
  assert.equal(card.raw, JSON.stringify(data))
})

test('null / 非卡片 / 坏 json / 非对象 json 都返回 null', () => {
  const bad = [
    null,
    undefined,
    'x',
    42,
    {},
    { type: 'text', data: { data: '{}' } },
    { type: 'json' },
    { type: 'json', data: {} },
    { type: 'json', data: { data: '' } },
    { type: 'json', data: { data: 'not json' } },
    { type: 'json', data: { data: 'null' } },
    { type: 'json', data: { data: '[]' } },
    { type: 'json', data: { data: '"str"' } },
    { type: 'json', data: { data: '123' } },
    { type: 'xml', data: { data: 123 } },
    { type: 'xml', data: { data: 'hello' } },
  ]
  for (const seg of bad) assert.equal(parseCardSegment(seg), null, JSON.stringify(seg))
})

test('xml 卡片：title/summary + 实体解码 + msg url 属性', () => {
  const xml = '<?xml version="1.0" encoding="utf-8"?><msg serviceID="1" templateID="1" action="web" '
    + 'brief="[分享] 一篇文章" url="https://example.com/post?a=1&amp;b=2"><item layout="2">'
    + '<title>文章 &amp; 标题</title><summary>这是 &lt;摘要&gt;</summary></item></msg>'
  const card = parseCardSegment({ type: 'xml', data: { data: xml } })
  assert.equal(card.kind, 'xml')
  assert.equal(card.app, '')
  assert.equal(card.title, '文章 & 标题')
  assert.equal(card.desc, '这是 <摘要>')
  assert.equal(card.url, 'https://example.com/post?a=1&b=2')
  assert.equal(card.raw, xml)
})

test('xml 卡片：<des> 与 <url> 标签', () => {
  const xml = '<msg><item><title>链接卡片</title><des>描述</des><url>https://a.cn/x?q=1&amp;r=2</url></item></msg>'
  const card = parseCardSegment({ type: 'xml', data: { data: xml } })
  assert.equal(card.title, '链接卡片')
  assert.equal(card.desc, '描述')
  assert.equal(card.url, 'https://a.cn/x?q=1&r=2')
})

test('xml 卡片：CDATA 与数字实体', () => {
  const xml = '<msg><item><title><![CDATA[早安 世界]]></title><summary>第&#49;条</summary></item></msg>'
  const card = parseCardSegment({ type: 'xml', data: { data: xml } })
  assert.equal(card.title, '早安 世界')
  assert.equal(card.desc, '第1条')
})

test('xml 卡片：无子标签时用 brief/url 属性兜底', () => {
  const card = parseCardSegment({ type: 'xml', data: { data: '<msg brief="[分享] 只有标题" url="https://b.cn/y"></msg>' } })
  assert.equal(card.title, '[分享] 只有标题')
  assert.equal(card.url, 'https://b.cn/y')
})

test('空内容卡片仍解析，渲染成 [卡片]', () => {
  const card = parseCardSegment(jsonSeg({}))
  assert.equal(card.kind, 'json')
  assert.equal(card.title, '')
  assert.equal(card.url, '')
  assert.equal(renderCard(card), '[卡片]')
  assert.equal(renderCard({ app: 'com.tencent.structmsg' }), '[卡片]')
})

test('parseCardSegment 超长字段截断', () => {
  const card = parseCardSegment(jsonSeg({ app: 'com.tencent.structmsg', title: '长'.repeat(5000), url: 'https://x.cn/' }))
  assert.equal([...card.title].length, 121)
  assert.ok(card.title.endsWith('…'))
  assert.equal([...card.raw].length, 4001)
})

test('parseCardSegment 不修改入参', () => {
  const seg = jsonSeg({ app: 'com.tencent.structmsg', title: '标题' })
  const before = JSON.stringify(seg)
  parseCardSegment(seg)
  assert.equal(JSON.stringify(seg), before)
})

test('renderCard：空/非法入参返回空串', () => {
  for (const value of [null, undefined, '', 'card', 42, []]) assert.equal(renderCard(value), '')
})

test('renderCard：分享卡片一行文本', () => {
  const card = { app: 'com.tencent.structmsg', title: '标题', url: 'https://a.com/x' }
  assert.equal(renderCard(card), '[卡片 分享·标题] https://a.com/x')
})

test('renderCard：小程序标签 / 未知 app 不显示包名', () => {
  assert.equal(renderCard({ app: 'com.tencent.miniapp_01', title: '天气' }), '[卡片 小程序·天气]')
  assert.equal(renderCard({ app: 'com.foo.bar', title: '标题' }), '[卡片 标题]')
  assert.equal(renderCard({ title: '无 app' }), '[卡片 无 app]')
})

test('renderCard：无标题只给链接', () => {
  assert.equal(renderCard({ url: 'https://x.cn/1' }), '[卡片] https://x.cn/1')
})

test('renderCard：按 maxChars 截断（总长不超过上限）', () => {
  const card = { app: 'com.tencent.structmsg', title: '很长'.repeat(100), url: 'https://example.com/' }
  const out = renderCard(card, { maxChars: 24 })
  assert.equal([...out].length, 24)
  assert.ok(out.endsWith('…'))
  assert.equal(renderCard(card, { maxChars: 0 }), '')
})

test('renderCard：坏对象不抛错', () => {
  assert.equal(renderCard({ get title() { throw new Error('boom') } }), '')
  assert.equal(typeof renderCard({ title: {}, url: 42 }), 'string')
})
