import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLog, createFileSink } from '../lib/log.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bridge-log-'))

test('文件日志：append + ISO 时间戳', () => {
  const d = dir()
  const f = join(d, 'b.log')
  const sink = createFileSink(f)
  sink('第一行')
  sink('第二行')
  const text = readFileSync(f, 'utf8')
  assert.match(text, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] 第一行$/m)
  assert.match(text, /第二行/)
  rmSync(d, { recursive: true, force: true })
})

test('超过 maxBytes 轮转成 .1，只留一份', () => {
  const d = dir()
  const f = join(d, 'b.log')
  const sink = createFileSink(f, { maxBytes: 160 })
  for (let i = 0; i < 6; i += 1) sink(`第 ${i} 条日志内容占位`)
  assert.ok(existsSync(`${f}.1`))
  assert.ok(readFileSync(f, 'utf8').length < 400)
  rmSync(d, { recursive: true, force: true })
})

test('createLog 走 sink，且 Bearer/token 被脱敏', () => {
  const d = dir()
  const f = join(d, 'b.log')
  const log = createLog({ sink: createFileSink(f), logger: null })
  log.info('连上了 Bearer abc.def-123 token=xyz')
  const text = readFileSync(f, 'utf8')
  assert.match(text, /Bearer \*\*\*/)
  assert.match(text, /token=\*\*\*/)
  assert.ok(!text.includes('abc.def-123'))
  rmSync(d, { recursive: true, force: true })
})

test('写不进去时静默停掉（不影响桥）', () => {
  const sink = createFileSink('/proc/definitely/not/writable.log')
  assert.doesNotThrow(() => sink('x'))
  assert.doesNotThrow(() => sink('y'))
})
