import test from 'node:test'
import assert from 'node:assert/strict'
import { nextDelay } from '../lib/backoff.js'

test('指数：1s → 2s → 4s', () => {
  const o = { baseMs: 1000, maxMs: 60000, jitter: 0, random: () => 0.5 }
  assert.equal(nextDelay(0, o), 1000)
  assert.equal(nextDelay(1, o), 2000)
  assert.equal(nextDelay(2, o), 4000)
})

test('封顶 60s', () => {
  assert.equal(nextDelay(10, { baseMs: 1000, maxMs: 60000, jitter: 0, random: () => 0.5 }), 60000)
})

test('抖动在 ±20% 内', () => {
  const lo = nextDelay(0, { baseMs: 1000, maxMs: 60000, jitter: 0.2, random: () => 0 })
  const hi = nextDelay(0, { baseMs: 1000, maxMs: 60000, jitter: 0.2, random: () => 1 })
  assert.equal(lo, 800)
  assert.equal(hi, 1200)
})

test('非法 attempt/参数不炸', () => {
  assert.equal(nextDelay(-5, { baseMs: 1000, jitter: 0, random: () => 0.5 }), 1000)
  assert.equal(nextDelay('x', { baseMs: 1000, jitter: 0, random: () => 0.5 }), 1000)
  // baseMs<=0 视为非法，回落到 1000 → 第 1 次重试 2000
  assert.equal(nextDelay(1, { baseMs: 0, jitter: 0, random: () => 0.5 }), 2000)
})
