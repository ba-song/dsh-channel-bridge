/**
 * 只读/读写一体的 OneBot WS 客户端：
 * - 只收事件（onEvent），另有 call() 走同一连接发 action（发送消息用）
 * - 断线指数退避重连（1s→60s，±20%）
 * - token 只走 Authorization: Bearer；日志里的 URL 剥 query
 */
import WebSocket from 'ws'
import { nextDelay } from './backoff.js'
import { redactUrl } from './log.js'

const CONNECTING = 0
const OPEN = 1

export function createBridgeClient({
  url,
  token = '',
  reconnect = {},
  log = null,
  onEvent = null,
  onOpen = null,
  onClose = null,
  WebSocketImpl = WebSocket,
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
  setInterval: setI = setInterval,
  clearInterval: clearI = clearInterval,
  now = () => Date.now(),
  connectTimeoutMs = 10000,
  health = {},
} = {}) {
  const safeUrl = redactUrl(url)
  let ws = null
  let attempt = 0
  let timer = null
  let stopped = true
  let opened = false
  let connectTimer = null
  const pending = new Map()
  let seq = 0
  const stats = { connects: 0, closes: 0, messages: 0, badJson: 0, reconnects: 0, calls: 0, heartbeats: 0, heartbeatFails: 0, hardResets: 0 }
  const h = {
    heartbeatMs: 30000,
    heartbeatAction: 'get_status',
    heartbeatTimeoutMs: 10000,
    staleMs: 90000,
    tickMs: 15000,
    auto: true,
    ...(health ?? {}),
  }
  let healthTimer = null
  let lastFrameAt = 0
  let lastHeartbeatOkAt = 0
  let lastHeartbeatAt = 0
  let hbFails = 0

  function rejectAll(reason) {
    for (const [echo, item] of pending) {
      pending.delete(echo)
      try {
        clearT(item.timer)
      } catch {}
      item.reject(Object.assign(new Error(reason), { code: 'E_NOT_CONNECTED' }))
    }
  }

  function schedule() {
    if (stopped) return
    if (timer) clearT(timer)
    const delay = nextDelay(attempt, reconnect)
    attempt += 1
    stats.reconnects += 1
    log?.warn?.(`[channel-bridge] ${delay}ms 后重连（第 ${attempt} 次）`)
    timer = setT(connect, delay)
    timer?.unref?.()
  }

  function handleMessage(raw) {
    stats.messages += 1
    // 任何帧都算「活着」：推送事件、心跳响应、action 回包都刷新
    lastFrameAt = now()
    let data
    try {
      data = JSON.parse(typeof raw === 'string' ? raw : raw?.toString?.() ?? '')
    } catch (error) {
      stats.badJson += 1
      log?.warn?.(`[channel-bridge] 收到坏 JSON（已忽略）：${error?.message ?? error}`)
      return
    }
    const echo = data?.echo
    if (echo !== undefined && echo !== null && pending.has(String(echo))) {
      const item = pending.get(String(echo))
      pending.delete(String(echo))
      try {
        clearT(item.timer)
      } catch {}
      if (data?.status === 'failed' || (data?.retcode !== undefined && Number(data.retcode) !== 0)) {
        const wording = String(data?.wording || data?.message || 'action failed')
        // 只有明确的「非好友 / 不可聊」才标 E_NOT_FRIEND（对账按它做 1 小时退避）；
        // 其余失败保持 E_SEND_FAILED，对账按「瞬时错误」短退避重试。
        const code = /not\s*friend|非好友|不在好友|不是好友|not\s*joined|群未加入/i.test(wording)
          ? 'E_NOT_FRIEND'
          : 'E_SEND_FAILED'
        item.reject(Object.assign(new Error(wording), { code, payload: data }))
      } else {
        item.resolve(data)
      }
      return
    }
    try {
      onEvent?.(data)
    } catch (error) {
      log?.warn?.(`[channel-bridge] 事件处理异常（已忽略）：${error?.message ?? error}`)
    }
  }

  /** 主动废掉这条连接（半开/心跳失败）→ close 会触发重连。 */
  function hardReset(reason) {
    stats.hardResets += 1
    log?.warn?.(`[channel-bridge] 连接不健康（${reason}），主动断开重连`)
    opened = false
    lastHeartbeatAt = now()
    try {
      if (typeof ws?.terminate === 'function') ws.terminate()
      else ws?.close?.()
    } catch {}
    // 万一 close 事件没来，兜底自己排一次
    schedule()
  }

  /** 发一个 OneBot action（tick 与对外 call 共用）。 */
  function callInternal(action, params = {}, { timeoutMs = 15000 } = {}) {
    stats.calls += 1
    if (!opened || !ws) {
      return Promise.reject(Object.assign(new Error('未连上 NapCat'), { code: 'E_NOT_CONNECTED' }))
    }
    seq += 1
    const echo = `cb-${Date.now()}-${seq}`
    const payload = JSON.stringify({ action, params, echo })
    return new Promise((resolve, reject) => {
      const timer2 = setT(() => {
        pending.delete(echo)
        // 超时是「瞬时错误」，不能冒用 E_SEND_FAILED（对账会把它当成非好友、退避 1 小时）
        reject(Object.assign(new Error(`action ${action} 超时`), { code: 'E_TIMEOUT' }))
      }, timeoutMs)
      timer2?.unref?.()
      pending.set(echo, { resolve, reject, timer: timer2 })
      try {
        ws.send(payload)
      } catch (error) {
        pending.delete(echo)
        clearT(timer2)
        reject(Object.assign(new Error(error?.message ?? 'send failed'), { code: 'E_NOT_CONNECTED' }))
      }
    })
  }

  /** 心跳 + 看门狗（每 tickMs 跑一次；测试里可直接调）。 */
  function tick() {
    if (stopped || !opened) return
    const t = now()
    const silentMs = lastFrameAt ? t - lastFrameAt : 0
    const stale = h.staleMs > 0 && lastFrameAt > 0 && silentMs >= h.staleMs
    // 只有「无帧够久」**且**「心跳连续失败」才判定连接死了；心跳成功过就绝不主动断
    if (stale && hbFails >= 2) {
      hardReset(`${Math.round(silentMs / 1000)}s 没收到任何帧，且心跳连续 ${hbFails} 次失败`)
      return
    }
    if (h.heartbeatMs <= 0 || t - lastHeartbeatAt < h.heartbeatMs) return
    lastHeartbeatAt = t
    stats.heartbeats += 1
    callInternal(h.heartbeatAction || 'get_status', {}, { timeoutMs: h.heartbeatTimeoutMs })
      .then(() => {
        hbFails = 0
        lastHeartbeatOkAt = now()
      })
      .catch((error) => {
        hbFails += 1
        stats.heartbeatFails += 1
        log?.warn?.(`[channel-bridge] 心跳失败（${error?.code ?? error?.message ?? error}）第 ${hbFails} 次`)
        // 不再单凭心跳失败断线：等下一轮 tick 结合「无帧」一起判断
      })
  }

  function connect() {
    if (stopped) return
    let socket
    try {
      socket = new WebSocketImpl(safeUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    } catch (error) {
      log?.warn?.(`[channel-bridge] 建连失败：${error?.message ?? error}`)
      schedule()
      return
    }
    ws = socket
    stats.connects += 1
    connectTimer = setT(() => {
      if (socket.readyState === CONNECTING) {
        log?.warn?.('[channel-bridge] 连接超时，重试')
        try {
          socket.terminate?.() ?? socket.close?.()
        } catch {}
      }
    }, connectTimeoutMs)
    connectTimer?.unref?.()

    socket.on?.('open', () => {
      if (connectTimer) clearT(connectTimer)
      opened = true
      attempt = 0
      lastFrameAt = now()
      lastHeartbeatAt = now()
      lastHeartbeatOkAt = now()
      hbFails = 0
      log?.info?.(`[channel-bridge] 已连上 ${safeUrl}（token=${token ? '有' : '无'}）`)
      try {
        onOpen?.()
      } catch (error) {
        log?.warn?.(`[channel-bridge] onOpen 回调异常：${error?.message ?? error}`)
      }
    })
    socket.on?.('message', handleMessage)
    socket.on?.('close', (code, reason) => {
      opened = false
      stats.closes += 1
      if (connectTimer) clearT(connectTimer)
      rejectAll('连接已断开')
      log?.warn?.(`[channel-bridge] 连接断开（code=${code ?? '-'} ${reason ? String(reason).slice(0, 40) : ''}）`)
      try {
        onClose?.()
      } catch {}
      schedule()
    })
    socket.on?.('error', (error) => {
      log?.throttled?.('ws-error', `[channel-bridge] 连接错误：${error?.message ?? error}`)
    })
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      attempt = 0
      connect()
      if (h.auto !== false && !healthTimer) {
        healthTimer = setI(tick, Math.max(500, h.tickMs))
        healthTimer?.unref?.()
      }
    },
    stop() {
      stopped = true
      if (healthTimer) clearI(healthTimer)
      healthTimer = null
      if (timer) clearT(timer)
      if (connectTimer) clearT(connectTimer)
      opened = false
      rejectAll('客户端已停止')
      try {
        ws?.close?.()
      } catch {}
    },
    status() {
      return {
        url: safeUrl,
        opened,
        attempts: attempt,
        ...stats,
        pending: pending.size,
        lastFrameAt,
        lastEventAt: lastFrameAt, // 兼容旧字段名
        lastHeartbeatAt,
        lastHeartbeatOkAt,
        heartbeatFails: hbFails,
        now: now(),
      }
    },
    /** 主动强制重连（假在线/静默时用）；未连接返回 false。 */
    forceReconnect(reason = 'manual') {
      if (stopped || !opened) return false
      hardReset(reason)
      return true
    },
    /** 测试/诊断：手动跑一次心跳+看门狗。 */
    tick,
    get opened() {
      return opened
    },
    /** 发一个 OneBot action；未连接直接 E_NOT_CONNECTED（不排队、不重放）。 */
    call(action, params = {}, opts = {}) {
      return callInternal(action, params, opts)
    },
  }
}
