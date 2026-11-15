/** 日志：60 字截断 + 同 key 节流 + URL/token 脱敏。
 *  - 控制台：走宿主 logger
 *  - 文件：`/root/.dsh/dsh-channel-bridge.log`（append、带时间戳、5MB 轮转）
 *  不打印正文，只打印渠道/联系人/长度/摘要。
 */
import { appendFileSync, statSync, renameSync } from 'node:fs'

/** 按码点截断，中文不劈半。 */
export function truncate(text, max = 60) {
  const arr = [...String(text ?? '')]
  if (arr.length <= max) return arr.join('')
  return arr.slice(0, max).join('') + '…'
}

/** 去掉 URL 的 query/hash/userinfo（token 常在 query 里）。 */
export function redactUrl(url) {
  const s = String(url ?? '')
  try {
    const u = new URL(s)
    u.search = ''
    u.hash = ''
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return s.split('?')[0].split('#')[0]
  }
}

/** 把 Bearer/token=… 形态的串替换成 ***。 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
    .replace(/(token|access_token|authorization)=([^&\s]+)/gi, '$1=***')
}

export function createLog({ logger = null, sink = null, textMax = 60, throttleMs = 30000, now = () => Date.now() } = {}) {
  const lines = []
  const lastByKey = new Map()
  const counters = {
    events: 0,
    messages: 0,
    notMessage: 0,
    parseFail: 0,
    selfSkipped: 0,
    dup: 0,
    inbound: 0,
    delivered: 0,
    deliverFail: 0,
    out: 0,
    silent: 0,
    sendFail: 0,
    reconnect: 0,
    echoSkipped: 0,
  }

  function emit(level, msg) {
    const line = redactSecrets(String(msg ?? ''))
    lines.push(line)
    if (sink) {
      try {
        sink(line)
      } catch {}
    }
    const fn = logger?.[level]
    if (typeof fn === 'function') {
      try {
        fn.call(logger, line)
      } catch {}
    }
  }

  return {
    lines,
    counters,
    info(msg) {
      emit('info', msg)
    },
    warn(msg) {
      emit('warn', msg)
    },
    error(msg) {
      emit('error', msg)
    },
    /** 同 key 在节流窗口内只记第一条，其余累计到下一条的「另有 N 条」。 */
    throttled(key, msg) {
      const t = now()
      const prev = lastByKey.get(key)
      if (prev && t - prev.at < throttleMs) {
        prev.skipped += 1
        return false
      }
      const skipped = prev?.skipped ?? 0
      lastByKey.set(key, { at: t, skipped: 0 })
      emit('info', skipped > 0 ? `${msg}（另有 ${skipped} 条同类未逐条记）` : msg)
      return true
    },
    /** 入站摘要：qq · 私聊 · 名字(id) · "前 60 字" */
    inbound(parsed) {
      const who = `${parsed.contactName || '-'}(${parsed.contactId})`
      const kind = parsed.kind === 'group' ? '群' : '私聊'
      emit('info', `[channel-bridge] ${parsed.channel} · ${kind} · ${who} · "${truncate(parsed.text, textMax)}"`)
    },
    resetThrottle() {
      lastByKey.clear()
    },
  }
}

/** 文件日志：每行 `[ISO 时间] 内容`；超过 maxBytes 轮转成 `<file>.1`（只留一份）。 */
export function createFileSink(file, { maxBytes = 5 * 1024 * 1024, fs = null } = {}) {
  const io = fs ?? { appendFileSync, statSync, renameSync }
  let size = -1
  let disabled = false
  return function sink(line) {
    if (disabled || !file) return
    try {
      const text = `[${new Date().toISOString()}] ${String(line ?? '')}\n`
      const bytes = Buffer.byteLength(text)
      if (size < 0) {
        try {
          size = io.statSync(file).size
        } catch {
          size = 0
        }
      }
      if (size + bytes > maxBytes) {
        try {
          io.renameSync(file, `${file}.1`)
        } catch {}
        size = 0
      }
      io.appendFileSync(file, text)
      size += bytes
    } catch {
      disabled = true // 写不动就安静停掉，不影响桥
    }
  }
}
