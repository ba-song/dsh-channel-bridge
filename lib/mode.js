/**
 * 三模式 + 热切换（规格书 §5.3）。
 *
 * 文件：`/root/.dsh/dsh-channel-bridge.json` → `{"mode":"observe|deliver|send"}`
 * 读取：最多每 500ms 看一次 mtime/size，变了才重读；非法值保持上一个合法值；无 mode 用 profile 值。
 */
import { readFileSync, statSync } from 'node:fs'
import { MODES } from './config.js'

export function createMode({
  file,
  initial = 'observe',
  hotSwitch = true,
  now = () => Date.now(),
  stat = (p) => statSync(p),
  read = (p) => readFileSync(p, 'utf8'),
  pollMs = 500,
  log = null,
} = {}) {
  let current = MODES.includes(initial) ? initial : 'observe'
  let lastCheck = -Infinity
  let stamp = ''
  let warned = false

  function readFileMode() {
    if (!file || hotSwitch === false) return
    const t = now()
    if (t - lastCheck < pollMs) return
    lastCheck = t
    let st
    try {
      st = stat(file)
    } catch {
      stamp = ''
      return
    }
    const next = `${st.mtimeMs}:${st.size}`
    if (next === stamp) return
    stamp = next
    let parsed
    try {
      parsed = JSON.parse(read(file))
    } catch (error) {
      if (!warned) {
        log?.warn?.(`[channel-bridge] 模式文件不是合法 JSON，保持 ${current}：${error?.message ?? error}`)
        warned = true
      }
      return
    }
    const m = parsed?.mode
    if (m === undefined) return // 文件里没有 mode → 用 profile 的值
    if (!MODES.includes(m)) {
      log?.warn?.(`[channel-bridge] 模式值非法（${String(m)}），保持 ${current}`)
      return
    }
    if (m !== current) {
      log?.info?.(`[channel-bridge] 模式切换：${current} → ${m}`)
      current = m
    }
    warned = false
  }

  return {
    current() {
      readFileMode()
      return current
    },
    /** 强制读一次（测试/切换用）。 */
    refresh() {
      lastCheck = 0
      readFileMode()
      return current
    },
    get settled() {
      return current
    },
  }
}
