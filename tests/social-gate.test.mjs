import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocialGate } from '../lib/social-gate.js'

test('群社交闸：arm 后最多 N 条，过期/其他群不受影响', () => {
  let t = 1_000_000
  const g = createSocialGate({ now: () => t })
  g.arm({ contactId: 'g1', max: 2 })
  assert.equal(g.take({ contactId: 'g1' }).ok, true)
  assert.equal(g.take({ contactId: 'g1' }).ok, true)
  assert.equal(g.take({ contactId: 'g1' }).ok, false)
  assert.equal(g.take({ contactId: 'g2' }).ok, true)
  t += 6 * 60 * 1000
  assert.equal(g.take({ contactId: 'g1' }).ok, true)
})
