import test from 'node:test'
import assert from 'node:assert/strict'
import { createEchoGuard } from '../lib/echo.js'

const T0 = 1793900000000
const p = (over = {}) => ({ channel: 'qq', kind: 'private', contactId: '2971030080', text: '在吗', ...over })
function setup() {
  let t = T0
  const g = createEchoGuard({ windowMs: 3000, now: () => t })
  return { g, at: () => t, advance: (ms) => { t += ms }, set: (v) => { t = v } }
}

test('3 秒内同文 → 判回声（不同 message_id 也一样）', () => {
  const h = setup()
  assert.equal(h.g.isEcho({ ...p(), messageId: '111' }), false) // 第一条正常
  h.advance(1000)
  assert.equal(h.g.isEcho({ ...p(), messageId: '222' }), true) // 同文不同 id，1 秒后 → 回声
  assert.equal(h.g.stats.skipped, 1)
})

test('边界：正好 3000ms 算回声，3001ms 不算', () => {
  const h = setup()
  h.g.isEcho(p())
  h.advance(3000)
  assert.equal(h.g.isEcho(p()), true)
  const h2 = setup()
  h2.g.isEcho(p())
  h2.advance(3001)
  assert.equal(h2.g.isEcho(p()), false)
})

test('超过 3 秒同文 → 正常投递（主人真的重复发）', () => {
  const h = setup()
  h.g.isEcho(p())
  h.advance(10_000)
  assert.equal(h.g.isEcho(p()), false)
  assert.equal(h.g.stats.skipped, 0)
})

test('不同文本/不同联系人不受影响', () => {
  const h = setup()
  h.g.isEcho(p())
  assert.equal(h.g.isEcho(p({ text: '别的' })), false)
  assert.equal(h.g.isEcho(p({ contactId: '12345678' })), false)
  assert.equal(h.g.isEcho(p({ kind: 'group', contactId: '707380948' })), false)
})

test('连续回声按最近一次算（不会把窗口无限拉长）', () => {
  const h = setup()
  h.g.isEcho(p())
  h.advance(2000)
  assert.equal(h.g.isEcho(p()), true)
  h.advance(2500) // 距第一次 4.5s，距最近一次 2.5s → 仍算回声
  assert.equal(h.g.isEcho(p()), true)
  h.advance(3500) // 距最近一次 3.5s → 放行
  assert.equal(h.g.isEcho(p()), false)
})
