import test from 'node:test'
import assert from 'node:assert/strict'
import { createMode } from '../lib/mode.js'

function fakeFs(initial, { mtime = 1, size = 10 } = {}) {
  const state = { content: initial, mtime, size: initial.length }
  return {
    state,
    stat: () => ({ mtimeMs: state.mtime, size: state.size }),
    read: () => state.content,
    set(obj) {
      if (obj.content !== undefined) state.content = obj.content
      state.mtime += 1
      state.size = state.content.length
    },
  }
}

test('默认 observe；没有文件也是 observe', () => {
  const m = createMode({ file: '/nope.json', initial: 'observe', stat: () => { throw new Error('no') }, now: () => 0 })
  assert.equal(m.current(), 'observe')
})

test('文件 mode=deliver 生效', () => {
  const fs = fakeFs('{"mode":"deliver"}')
  let t = 0
  const m = createMode({ file: '/x.json', initial: 'observe', stat: fs.stat, read: fs.read, now: () => t })
  assert.equal(m.current(), 'deliver')
})

test('非法值保持上一个合法值', () => {
  const fs = fakeFs('{"mode":"send"}')
  let t = 0
  const m = createMode({ file: '/x.json', initial: 'observe', stat: fs.stat, read: fs.read, now: () => t })
  assert.equal(m.current(), 'send')
  fs.set({ content: '{"mode":"乱写"}' })
  t += 1000
  assert.equal(m.current(), 'send')
})

test('JSON 坏了也保持', () => {
  const fs = fakeFs('{"mode":"deliver"}')
  let t = 0
  const m = createMode({ file: '/x.json', initial: 'observe', stat: fs.stat, read: fs.read, now: () => t })
  assert.equal(m.current(), 'deliver')
  fs.set({ content: '{oops' })
  t += 1000
  assert.equal(m.current(), 'deliver')
})

test('文件里没有 mode 键 → 用 profile 初值', () => {
  const fs = fakeFs('{"enabled":true}')
  let t = 0
  const m = createMode({ file: '/x.json', initial: 'send', stat: fs.stat, read: fs.read, now: () => t })
  assert.equal(m.current(), 'send')
})

test('500ms 内不重复读；refresh 强制读', () => {
  const fs = fakeFs('{"mode":"observe"}')
  let t = 0
  let reads = 0
  const m = createMode({ file: '/x.json', initial: 'observe', stat: fs.stat, read: () => { reads += 1; return fs.read() }, now: () => t })
  m.current(); m.current()
  assert.equal(reads, 1)
  fs.set({ content: '{"mode":"send"}' })
  m.current()
  assert.equal(m.current(), 'observe') // 仍在 500ms 内
  t += 600
  assert.equal(m.current(), 'send')
  assert.equal(m.refresh(), 'send')
})

test('hotSwitch:false（默认）不读模式文件：profile/设置页是唯一事实源', () => {
  const fs = fakeFs('{"mode":"send"}')
  const m = createMode({ file: '/x.json', initial: 'observe', hotSwitch: false, stat: fs.stat, read: fs.read })
  assert.equal(m.current(), 'observe')
})
