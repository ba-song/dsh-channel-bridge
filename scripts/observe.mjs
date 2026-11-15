#!/usr/bin/env node
/**
 * 活体冒烟（只读）：连 NapCat、get_login_info、观察 N 秒入站事件，打印脱敏摘要后退出。
 * **没有任何发送路径**：本脚本只 import parse/log/ws/config，不 import sender/tools。
 *
 *   node scripts/observe.mjs [--seconds=45] [--url=ws://127.0.0.1:3001/]
 *
 * token 来源：环境变量 DSH_CHANNEL_BRIDGE_TOKEN 或 /root/.dsh/dsh-channel-bridge.token
 */
import { loadConfig, resolveToken, wsUrl } from '../lib/config.js'
import { createLog, truncate } from '../lib/log.js'
import { createDedupe, dedupeKey } from '../lib/dedupe.js'
import { parseMessageEvent } from '../lib/parse.js'
import { createBridgeClient } from '../lib/ws.js'

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const seconds = Number(arg('seconds', 45))
const cfg = loadConfig({ host: '127.0.0.1', port: 3001, owner: { qqIds: ['2971030080'] } })
const url = arg('url', wsUrl(cfg))
const token = resolveToken(cfg)
const log = createLog({ logger: console, textMax: 40 })
const dedupe = createDedupe({ max: 2000 })
const counters = { events: 0, messages: 0, notMessage: 0, parseFail: 0, dup: 0, inbound: 0, self: 0 }
const seen = []

const client = createBridgeClient({
  url,
  token,
  reconnect: { baseMs: 1000, maxMs: 15000, jitter: 0.2 },
  log,
  onOpen: async () => {
    try {
      const res = await client.call('get_login_info', {}, { timeoutMs: 8000 })
      const id = String(res?.data?.user_id ?? '')
      console.log('[observe] get_login_info OK:', JSON.stringify({ user_id: id ? `${'*'.repeat(Math.max(0, id.length - 2))}${id.slice(-2)}` : '', nickname: res?.data?.nickname ?? '' }))
    } catch (e) {
      console.log('[observe] get_login_info FAILED:', e?.code ?? e?.message)
    }
  },
  onEvent: (evt) => {
    counters.events += 1
    if (String(evt?.post_type ?? '') !== 'message') {
      counters.notMessage += 1
      return
    }
    counters.messages += 1
    const parsed = parseMessageEvent(evt, { owner: { qqIds: ['2971030080'] }, channel: 'qq' })
    if (!parsed) {
      counters.parseFail += 1
      return
    }
    if (dedupe.seen(dedupeKey(evt))) {
      counters.dup += 1
      return
    }
    counters.inbound += 1
    seen.push({
      kind: parsed.kind,
      contact: `${'*'.repeat(Math.max(0, parsed.contactId.length - 2))}${parsed.contactId.slice(-2)}`,
      name: parsed.contactName ? `${parsed.contactName.slice(0, 1)}***` : '',
      len: [...parsed.text].length,
      text: truncate(parsed.text, 40),
      isOwner: parsed.isOwner,
      at: new Date(parsed.at).toISOString(),
    })
    console.log('[observe] 入站:', JSON.stringify(seen[seen.length - 1]))
  },
})

console.log(`[observe] 连接 ${url.replace(/\?.*$/, '')}（token=${token ? '有' : '无'}），观察 ${seconds}s，只读不发`)
client.start()

const timer = setTimeout(() => {
  client.stop()
  const st = client.status()
  console.log('[observe] 结束：', JSON.stringify({ ...counters, connects: st.connects, closes: st.closes, reconnects: st.reconnects, opens: st.opened }))
  console.log('[observe] 样本（脱敏）：', JSON.stringify(seen))
  process.exit(0)
}, Math.max(3, seconds) * 1000)
timer.unref?.()
