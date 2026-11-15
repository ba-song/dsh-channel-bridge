import test from 'node:test'
import assert from 'node:assert/strict'
import { buildChannelPrompt, ROOM_RULES, ROOM_RULES_TOOL, ROOM_RULES_MIRROR, AUTO_RULES, markerOf } from '../lib/prompt.js'

const base = { channel: 'qq', kind: 'private', contactId: '2971030080', contactName: '饲养员', senderName: '饲养员', at: 1, text: '在吗' }
const withRules = (over = {}, opts = {}) => buildChannelPrompt({ ...base, ...over }, { mode: 'send', includeRules: true, ...opts })

test('默认（mirror 关）= tool 版规则常量；mirror 开 = 自动显示版（常量本身）', () => {
  assert.ok([...ROOM_RULES].length <= 200, `规则 ${[...ROOM_RULES].length} 字，超过 200`)
  assert.match(ROOM_RULES, /【这个房间的规矩】/)
  assert.match(ROOM_RULES, /只有 dy_say 能送到对方/)
  assert.match(ROOM_RULES, /把同一句原样写一遍（只写这一句）/)
  assert.match(ROOM_RULES, /拆成 2–4 条/)
  assert.match(ROOM_RULES, /不想接就不接/)
  assert.match(ROOM_RULES, /你也是家里那个汐/)
  assert.ok(!ROOM_RULES.includes('正文留空，或只写 [SILENT]'))
  assert.ok([...ROOM_RULES_MIRROR].length <= 200)
})

test('**默认不带规则**；includeRules:true 才带（tool/mirror 两版）', () => {
  for (const mode of ['send', 'deliver', 'observe']) {
    const text = buildChannelPrompt(base, { mode })
    assert.ok(!text.includes('【这个房间的规矩】'), `${mode} 模式默认不该带规则`)
  }
  const tool = withRules()
  assert.ok(tool.endsWith(ROOM_RULES_TOOL))
  assert.ok(!tool.includes('对话页里会自动显示你发出去的原文'))
  const mirrored = withRules({}, { mirrorEnabled: true })
  assert.ok(mirrored.endsWith(ROOM_RULES_MIRROR))
  assert.ok(mirrored.includes('对话页里会自动显示你发出去的原文'))
})

test('observe：不带规则时仍保留只读提示', () => {
  const text = buildChannelPrompt(base, { mode: 'observe' })
  assert.ok(text.includes('通道当前只读，发送会被拦'))
  assert.ok(!text.includes('【这个房间的规矩】'))
})

test('群里也带（标记不同）', () => {
  const text = withRules({ kind: 'group', contactId: '707380948', contactName: '测试群', senderName: '霸宋' })
  assert.ok(text.startsWith('[QQ·群·测试群(707380948)] 霸宋：在吗'))
  assert.ok(text.endsWith(ROOM_RULES))
})

test('长正文不被截断（2000+ 字原样带出）', () => {
  const long = '字'.repeat(2500)
  const text = withRules({ text: long })
  assert.ok(text.includes(long))
  assert.ok(text.endsWith(ROOM_RULES))
})

test('附件行在正文后、规则前；补收前缀在正文前', () => {
  const text = withRules({ attachments: ['[图片] /sdcard/x/1.jpg'], replay: true, replayLabel: '08:41' })
  const iAttach = text.indexOf('[图片] /sdcard/x/1.jpg')
  const iRules = text.indexOf(ROOM_RULES)
  assert.ok(iAttach > 0 && iRules > iAttach)
  assert.match(text.split('\n')[0], /\[补收·08:41\]/)
})

test('markerOf：私聊/群各带号码', () => {
  assert.equal(markerOf(base), '[QQ·私聊·饲养员(2971030080)]')
  assert.equal(markerOf({ ...base, kind: 'group', contactName: '测试群', contactId: '707380948' }), '[QQ·群·测试群(707380948)]')
})

test('outbound=auto：includeRules 时换成自动发送规则（≤200 字）', () => {
  assert.ok([...AUTO_RULES].length <= 200, `auto 规则 ${[...AUTO_RULES].length} 字`)
  const text = buildChannelPrompt(base, { mode: 'send', outbound: 'auto', includeRules: true })
  assert.ok(text.endsWith(AUTO_RULES))
  assert.ok(!text.includes('只有 dy_say 能送到对方'))
  assert.ok(!buildChannelPrompt(base, { mode: 'send', outbound: 'auto' }).includes('【这个房间的规矩】'))
})

test('outbound=tool（默认）：includeRules 时仍是 dy_say 规则', () => {
  const text = withRules()
  assert.ok(text.endsWith(ROOM_RULES))
  assert.ok(!text.includes('最后一条消息会被原样发到 QQ'))
})

test('群里主人发言带【主人】标记，群友不带', () => {
  const group = { ...base, kind: 'group', contactId: '707380948', contactName: '测试群' }
  const owner = buildChannelPrompt({ ...group, isOwner: true, senderName: '杰克霜精' }, { mode: 'send' })
  assert.ok(owner.includes('【主人】杰克霜精：'))
  const other = buildChannelPrompt({ ...group, isOwner: false, senderName: '群友A' }, { mode: 'send' })
  assert.ok(other.includes('群友A：'))
  assert.ok(!other.includes('【主人】'))
})
