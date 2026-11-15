/**
 * 渠道会话：每 (channel, kind) 一个会话；优先复用**活着的** agent，只有拿不到才新建。
 *
 * 解析顺序（P0：修「每条消息都新建会话」）：
 *   1) 内存缓存里的 handle（且宿主里仍是活的）
 *   2) `agents.get(prevId)` —— 宿主里已有的 live agent（同一会话不能被 resume 两次）
 *   3) `agents.resume({resumeSessionId})`
 *   4) 只有前三条都拿不到，才 `agents.create`
 *
 * 宿主 API（只读核对过 dsh-agent-loop）：
 *   agents.get(id) → agent | undefined
 *   agents.create({ sessionId, meta:{cwd}, agentOptions:{provider,model} })
 *   agents.resume({ resumeSessionId, agentOptions })
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve, normalize } from 'node:path'
import { computeUsage, shouldRotate, buildSeed, buildHandoffText, collectRecentMessages } from './rotation.js'
import { readSessionEvents } from './session-archive.js'

export function createSessions({
  getAgents,
  getModel,
  store,
  cfg,
  log = null,
  now = () => Date.now(),
  getMemory = () => null,
  readArchive = readSessionEvents,
} = {}) {
  const handles = new Map() // `${channel}:${kind}` → live agent
  const stats = { created: 0, resumed: 0, cached: 0, live: 0, failed: 0, lastPreset: null, rotated: 0, rotateFallback: 0, lastRotation: null, lastToolScope: null }
  const sessionsRoot = String(cfg?.sessionsRoot || cfg?.handover?.sessionsRoot || '/root/.dsh/sessions')
  const seedLimit = () => Math.max(1, Number(cfg?.rotation?.seedMessages ?? 50))
  const maxHandoffChars = () => Math.max(1, Number(cfg?.rotation?.handoffMaxChars ?? 12000))

  const kindLabel = (kind) => (String(kind ?? '').startsWith('group') ? 'group' : 'private')

  /** 读作用域内可见工具数（scope = agent 对象；拿不到就 null，绝不抛）。 */
  function countTools(tools, scope) {
    try {
      const schemas = tools?.schemas
      if (typeof schemas !== 'function') return null
      const list = schemas.call(tools, scope)
      return Array.isArray(list) ? list.length : null
    } catch {
      return null
    }
  }

  /**
   * 建会话时裁剪工具面：群聊 deny 一批「主人专属 / 管理类」工具；私聊默认不裁（返回 undefined）。
   *
   * restrict() 在 deny 里混进未注册的工具名时会整体抛错（不是忽略），所以先按 tools.get 过滤已注册的，
   * 再提交。整段 fail-open：任何异常只 warn，不影响建会话。
   * 返回 setup(agentCtx, agent)，由 agents.create 在 publish 之前用 agent 作用域 ctx 调用。
   */
  function scopeSetup(kind) {
    const label = kindLabel(kind)
    const configured = label === 'group' ? cfg?.tools?.groupDeny : cfg?.tools?.privateDeny
    const deny = [
      ...new Set((Array.isArray(configured) ? configured : []).filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())),
    ]
    if (!deny.length) return undefined
    return async (agentCtx, agent) => {
      const short = String(agent?.id ?? agent?.session?.id ?? '').slice(0, 8)
      // 群房间：挂一个只含 read_image 的预设（群友发的图片她要看得到）。
      // 预设不存在/挂载失败一律 fail-open——少一个看图能力，不能让整个会话建不起来。
      if (label === 'group') {
        try {
          const presets = agentCtx?.get?.('agentPresets')
          if (typeof presets?.mount === 'function') {
            await presets.mount(agentCtx, 'qq-room')
            log?.info?.(`[channel-bridge] 群房间预设已挂载：qq-room（会话 ${short || '?'}…）`)
          }
        } catch (e) {
          log?.warn?.(`[channel-bridge] 群房间预设挂载失败（不影响会话）：${e?.message ?? e}`)
        }
      }
      try {
        const tools = agentCtx?.tools
        if (typeof tools?.restrict !== 'function') return
        const known =
          typeof tools.get === 'function'
            ? deny.filter((n) => {
                try {
                  return Boolean(tools.get(n, agent))
                } catch {
                  return false
                }
              })
            : deny
        stats.lastToolScope = { kind: label, configured: deny.length, applied: known.length, sessionId: short || null }
        if (!known.length) {
          log?.warn?.(`[channel-bridge] 工具裁剪：${label} deny 全部未注册，跳过（配置 ${deny.length}）`)
          return
        }
        const before = countTools(tools, agent)
        tools.restrict({ deny: known })
        const after = countTools(tools, agent)
        log?.info?.(
          `[channel-bridge] 工具裁剪：${label} deny=${known.length}/${deny.length}，会话 ${short || '?'}… 工具面 ${before ?? '?'}→${after ?? '?'}`,
        )
      } catch (e) {
        log?.warn?.(`[channel-bridge] 工具裁剪失败（${label}）：${e?.message ?? e}`)
      }
    }
  }

  /** 建会话成功后复读一次工具面（setup 已提交 restrict），打一行最终值；拿不到就跳过。 */
  function logToolFaceAfterCreate(agent, kind) {
    const label = kindLabel(kind)
    const n = countTools(agent?.ctx?.tools, agent)
    if (n === null) return
    log?.info?.(`[channel-bridge] 工具面复核：${label} 会话 ${String(agent?.id ?? '').slice(0, 8) || '?'}… 共 ${n} 个`)
  }

  /** 会话 key：每个群 / 每个陌生私聊各自独立（group:<群号> / private:<QQ号>）。 */
  function keyFor(parsed) {
    const kind = parsed?.kind === 'group' ? 'group' : 'private'
    const raw = kind === 'group' ? parsed?.contactId : parsed?.senderId || parsed?.contactId
    const id = String(raw ?? '').replace(/\D/g, '') || 'unknown'
    return `${kind}:${id}`
  }

  const idOfKey = (key) => {
    const [, id = 'unknown'] = String(key ?? '').split(':')
    return id.replace(/[^0-9]/g, '') || 'unknown'
  }

  /** 每个 key 一个房间目录：qq-群/<群号>、qq-私聊/<QQ号>。 */
  function cwdForKey(key) {
    const kind = String(key ?? '').split(':')[0]
    const id = idOfKey(key)
    if (kind === 'group') return `${String(cfg?.groupCwd || '/sdcard/DSHA/渠道/qq-群')}/${id}`
    return `${String(cfg?.privateCwd || '/sdcard/DSHA/渠道/qq-私聊')}/${id}`
  }

  /** 兼容旧调用（只给 kind 时给出根目录；真正建会话用 cwdForKey）。 */
  function cwdFor(kind) {
    if (kind === 'group') return String(cfg?.groupCwd || '/sdcard/DSHA/渠道/qq-群')
    return String(cfg?.privateCwd || '/sdcard/DSHA/渠道/qq-私聊')
  }

  /** 建群/私聊会话前确保 cwd 存在：只允许白名单根（默认 /sdcard/DSHA）下，路径规范化。 */
  function ensureCwd(cwd) {
    const root = normalize(resolve(String(cfg?.cwdRoot || '/sdcard/DSHA')))
    const abs = normalize(resolve(String(cwd ?? '')))
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      return { ok: false, code: 'E_CWD', detail: `cwd 不在允许的根目录下：${abs}（root=${root}）` }
    }
    try {
      if (!existsSync(abs)) mkdirSync(abs, { recursive: true })
      return { ok: true, cwd: abs }
    } catch (error) {
      return { ok: false, code: 'E_CWD', detail: `创建会话目录失败：${abs}（${error?.code ?? error?.message ?? error}）` }
    }
  }

  function resolveModel() {
    try {
      const m = getModel?.()
      if (!m) return null
      const provider = m.provider ? String(m.provider) : ''
      const model = m.model ? String(m.model) : ''
      if (!provider || !model) return null
      const opts = { provider, model }
      if (m.reasoningEffort) opts.reasoningEffort = m.reasoningEffort
      return opts
    } catch {
      return null
    }
  }

  function pickAgent(out) {
    return out?.agent ?? out
  }

  function liveOf(agents, id) {
    if (!id || typeof agents?.get !== 'function') return null
    try {
      const a = agents.get(id)
      return a && typeof a.followup === 'function' ? a : null
    } catch {
      return null
    }
  }

  function readEvents(agent) {
    try {
      const s = agent?.session
      if (Array.isArray(s?.log)) return s.log
      if (typeof s?.snapshotEvents === 'function') return s.snapshotEvents(0)
    } catch {}
    return []
  }

  /**
   * 结构化简报：只读 dyMemory.handoffBrief；失败/为空一律跳过，绝不影响交接。
   * header 用旧 agent.session.header（补 cwd/id），群与陌生人只传 kind+contactId 让记忆侧收敛。
   */
  async function fetchBrief({ agent = null, sessionId = '', cwd = '', kind = '', events = [] } = {}) {
    try {
      const memory = getMemory?.()
      if (!memory || typeof memory.handoffBrief !== 'function') return ''
      const recent = collectRecentMessages(Array.isArray(events) ? events : [], seedLimit()).map((m) => ({
        role: m.role,
        text: m.content.map((c) => String(c.text ?? '')).join(''),
        at: m.at ?? null,
      }))
      if (!recent.length) return ''
      let header = {}
      try {
        header = agent?.session?.header ?? {}
      } catch {}
      if (!header || typeof header !== 'object' || Array.isArray(header)) header = {}
      const mergedHeader = {
        ...header,
        ...(header.id ? {} : sessionId ? { id: String(sessionId) } : {}),
        ...(header.cwd ? {} : cwd ? { cwd: String(cwd) } : {}),
      }
      const kindName = String(kind).startsWith('group') ? 'group' : 'private'
      const out = await Promise.resolve(
        memory.handoffBrief({
          header: mergedHeader,
          cwd,
          recent,
          kind: kindName,
          contactId: idOfKey(kind),
          maxChars: maxHandoffChars(),
        }),
      )
      if (!out || out.ok === false) return ''
      return String(out.text ?? '').trim()
    } catch (error) {
      log?.warn?.(`[channel-bridge] 结构化简报生成失败（跳过）：${error?.message ?? error}`)
      return ''
    }
  }

  /** 轮换：seed 旧会话最近 N 条真实消息（B 方案）；seed 失败退化成交接卡（A 方案）。 */
  async function rotateFrom(agents, prev, channel, kind, events) {
    const agentOptions = resolveModel()
    if (!agentOptions) return null
    const cwd = cwdForKey(kind)
    const cwdCheck = ensureCwd(cwd)
    if (!cwdCheck.ok) {
      log?.warn?.(`[channel-bridge] 轮换前 ${cwdCheck.code}：${cwdCheck.detail}`)
      return null
    }
    const preset = String(cfg?.agentPreset ?? '').trim()
    const baseMeta = preset ? { cwd, agentPreset: preset } : { cwd }
    const prevEvents = Array.isArray(events) ? events : []
    const brief = await fetchBrief({ agent: prev?.agent, sessionId: prev?.sessionId, cwd, kind, events: prevEvents })
    const built = buildSeed(prevEvents, { limit: seedLimit(), brief })
    const setup = scopeSetup(kind)

    // B：带 seed 新建
    const sessionId = randomUUID()
    try {
      const out = await agents.create({
        sessionId,
        seed: built.seed,
        meta: { ...baseMeta, isSeeded: true },
        inheritedEventCount: built.seed.length,
        agentOptions,
        setup,
      })
      const agent = pickAgent(out)
      if (!agent || typeof agent.followup !== 'function') throw new Error('create(seed) 未返回 agent')
      if (setup) logToolFaceAfterCreate(agent, kind)
      handles.set(`${channel}:${kind}`, agent)
      try {
        store?.saveSession?.({ channel, kind, sessionId, cwd, at: now(), prevSessionId: prev.sessionId, rotated: true, promptTokens: 0, contextWindow: 0 })
      } catch {}
      stats.rotated += 1
      stats.lastRotation = { at: now(), from: prev.sessionId, to: sessionId, seeded: built.messages, brief: built.hasBrief, fallback: false }
      log?.info?.(
        `[channel-bridge] 轮换：${String(prev.sessionId).slice(0, 8)}… → ${sessionId.slice(0, 8)}…（seed ${built.messages} 条真实消息${built.hasBrief ? ' + 简报' : ''}，最后一条是${built.lastIsUser ? '主人未回' : '她'}）`,
      )
      return { ok: true, agent, sessionId, created: true, rotated: true, seeded: built.messages, prevSessionId: prev.sessionId, via: 'rotate-seed' }
    } catch (error) {
      log?.warn?.(`[channel-bridge] seed 轮换失败，退化成交接卡：${error?.message ?? error}`)
    }

    // A：不带 seed，下一轮投递带【上次聊到】
    const sessionId2 = randomUUID()
    try {
      const out2 = await agents.create({ sessionId: sessionId2, meta: baseMeta, agentOptions, setup })
      const agent2 = pickAgent(out2)
      if (!agent2 || typeof agent2.followup !== 'function') throw new Error('create 未返回 agent')
      if (setup) logToolFaceAfterCreate(agent2, kind)
      const handoffText = buildHandoffText(prevEvents, { maxChars: maxHandoffChars(), limit: seedLimit(), brief })
      handles.set(`${channel}:${kind}`, agent2)
      try {
        store?.saveSession?.({ channel, kind, sessionId: sessionId2, cwd, at: now(), prevSessionId: prev.sessionId, rotated: true, handoffText, promptTokens: 0, contextWindow: 0 })
      } catch {}
      stats.rotated += 1
      stats.rotateFallback += 1
      stats.lastRotation = { at: now(), from: prev.sessionId, to: sessionId2, seeded: 0, fallback: true }
      log?.warn?.(`[channel-bridge] 轮换（退化 A）：${sessionId2.slice(0, 8)}… 交接卡 ${[...handoffText].length} 字`)
      return { ok: true, agent: agent2, sessionId: sessionId2, created: true, rotated: true, fallback: true, handoffText, prevSessionId: prev.sessionId, via: 'rotate-fallback' }
    } catch (error) {
      stats.failed += 1
      log?.warn?.(`[channel-bridge] 轮换失败（保持旧会话）：${error?.message ?? error}`)
      return null
    }
  }

  /** 正在跑回合？（agent.status 优先，退回看 log 里有没有未闭合的 turn） */
  function isBusy(agent) {
    try {
      if (agent && typeof agent.status === 'string') return agent.status === 'running'
    } catch {}
    let open = false
    for (const ev of readEvents(agent)) {
      if (ev?.type === 'turn/start') open = true
      else if (ev?.type === 'turn/end') open = false
    }
    return open
  }

  /** 手动/强制轮换（不等阈值）：给 `dy_bridge_rotate` 用。 */
  async function forceRotate({ channel = 'qq', kind = 'private', sessionKey = '', parsed = null } = {}) {
    const agents = getAgents?.()
    if (!agents || typeof agents.create !== 'function') return { ok: false, code: 'E_NO_AGENTS' }
    const k = kind === 'group' ? 'group' : 'private'
    let row = sessionKey ? store?.getSession?.(channel, sessionKey) ?? null : null
    if (!row) {
      row = store?.getSession?.(channel, k) ?? null // 旧数据（无冒号）或按 kind 的兼容
    }
    if (!row) {
      const rows = store?.listSessions?.(channel) ?? []
      row = rows.filter((r) => String(r.kind) === k || String(r.kind).startsWith(`${k}:`)).sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0] ?? null
    }
    if (!row?.session_id) return { ok: false, code: 'E_NO_SESSION', detail: '当前渠道还没有会话' }
    const key = `${channel}:${row.kind}`
    const agent = handles.get(key) ?? liveOf(agents, row.session_id)
    if (isBusy(agent)) return { ok: false, code: 'E_BUSY', detail: '这一轮还在处理中，等它结束后再换会话' }
    const events = readEvents(agent)
    const rotated = await rotateFrom(agents, { agent, sessionId: row.session_id }, channel, row.kind, events)
    if (!rotated) return { ok: false, code: 'E_ROTATE_FAILED', detail: '新建会话失败（旧会话保留）' }
    return {
      ok: true,
      oldSessionId: String(row.session_id),
      newSessionId: rotated.sessionId,
      seeded: rotated.seeded ?? 0,
      count: rotated.seeded ?? 0,
      fallback: Boolean(rotated.fallback),
      handoffText: rotated.handoffText ?? null,
    }
  }

  /** 每次拿到会话后：更新用量 → 到阈值就轮换。 */
  async function finish(result, agents, channel, kind) {
    if (!result?.ok || !result.agent) return result
    const events = readEvents(result.agent)
    const usage = computeUsage(events)
    try {
      store?.updateUsage?.({ channel, kind, promptTokens: usage.promptTokens, contextWindow: usage.contextWindow })
    } catch {}
    if (cfg.rotation?.enabled === false) return { ...result, usage }
    if (!shouldRotate(usage, cfg.rotation ?? {})) return { ...result, usage }
    const rotated = await rotateFrom(agents, result, channel, kind, events)
    return rotated ?? { ...result, usage }
  }

  async function ensure(parsed) {
    const agents = getAgents?.()
    if (!agents || typeof agents.create !== 'function') {
      return { ok: false, code: 'E_NO_AGENTS', detail: '宿主没有 agents 服务' }
    }
    const channel = String(parsed?.channel ?? 'qq')
    const kind = keyFor(parsed) // store 的 kind 列直接存 key（group:<id> / private:<id>）
    const key = `${channel}:${kind}`
    const row = store?.getSession?.(channel, kind) ?? null
    const prevId = row?.session_id ? String(row.session_id) : ''

    // 1) 内存缓存：宿主里还活着就直接用（同一会话不能 resume 两次）
    let staleEvents = []
    const cached = handles.get(key)
    if (cached && typeof cached.followup === 'function') {
      const stillLive = typeof agents.get === 'function' ? liveOf(agents, prevId || cached.id) === cached : true
      if (stillLive) {
        stats.cached += 1
        return finish({ ok: true, agent: cached, sessionId: prevId || cached.id || '', created: false, via: 'cache' }, agents, channel, kind)
      }
      staleEvents = readEvents(cached)
      handles.delete(key)
    }

    // 2) 宿主里已经有这个会话的 live agent
    const live = liveOf(agents, prevId)
    if (live) {
      handles.set(key, live)
      stats.live += 1
      return finish({ ok: true, agent: live, sessionId: prevId, created: false, via: 'live' }, agents, channel, kind)
    }

    const agentOptions = resolveModel()
    if (!agentOptions) return { ok: false, code: 'NO_MODEL', detail: '拿不到默认模型（provider/model），不建会话' }
    // 工具面裁剪：create 与 resume 都带（重启后存活房间走 resume，不带就等于没裁）
    const setup = scopeSetup(kind)

    // 3) resume 旧会话
    if (prevId) {
      try {
        const out = await agents.resume({ resumeSessionId: prevId, agentOptions, setup })
        const agent = pickAgent(out)
        if (!agent || typeof agent.followup !== 'function') throw new Error('resume 未返回 agent')
        if (setup) logToolFaceAfterCreate(agent, kind)
        handles.set(key, agent)
        stats.resumed += 1
        return finish({ ok: true, agent, sessionId: prevId, created: false, via: 'resume' }, agents, channel, kind)
      } catch (error) {
        log?.warn?.(`[channel-bridge] 会话 ${prevId.slice(0, 8)}… resume 失败，改建新会话：${error?.message ?? error}`)
      }
    }

    // 4) 只有前面都失败才新建。
    //    有 prevId（旧会话确实存在）时先读旧档案，带「最近 50 条原话 + 结构化简报」seed；
    //    读不到档案/没有旧会话才空建。
    const cwd = cwdForKey(kind)
    const cwdCheck = ensureCwd(cwd)
    if (!cwdCheck.ok) {
      log?.warn?.(`[channel-bridge] ${cwdCheck.code}：${cwdCheck.detail}`)
      return cwdCheck
    }
    // 房间 AGENTS.md / time-context 属于 agent preset，只有新建会话能带上；
    // resume 改不了头，所以只在 create 分支传。
    const preset = String(cfg?.agentPreset ?? '').trim()
    const meta = preset ? { cwd, agentPreset: preset } : { cwd }

    let seedEvents = []
    if (prevId) {
      try {
        seedEvents = await Promise.resolve(readArchive({ sessionsRoot, sessionId: prevId, log }))
      } catch (error) {
        log?.warn?.(`[channel-bridge] 读旧会话档案失败（改空建）：${error?.message ?? error}`)
      }
      if (!Array.isArray(seedEvents)) seedEvents = []
      // 档案还没落盘（例如刚崩溃）时，退回缓存里旧 agent 的事件
      if (!seedEvents.length && staleEvents.length) seedEvents = staleEvents
    }
    const brief = prevId ? await fetchBrief({ agent: null, sessionId: prevId, cwd, kind, events: seedEvents }) : ''
    const built = buildSeed(seedEvents, { limit: seedLimit(), brief })
    let handoffText = ''

    // 4a) 旧会话有真实内容：带 seed 新建（50 原话 + 简报）
    if (prevId && (built.messages > 0 || built.hasBrief)) {
      const seededId = randomUUID()
      try {
        const out = await agents.create({
          sessionId: seededId,
          seed: built.seed,
          meta: { ...meta, isSeeded: true },
          inheritedEventCount: built.seed.length,
          agentOptions,
          setup,
        })
        const agent = pickAgent(out)
        if (!agent || typeof agent.followup !== 'function') throw new Error('create(seed) 未返回 agent')
        if (setup) logToolFaceAfterCreate(agent, kind)
        handles.set(key, agent)
        try {
          store?.saveSession?.({ channel, kind, sessionId: seededId, cwd, at: now(), prevSessionId: prevId, promptTokens: 0, contextWindow: 0 })
        } catch {}
        stats.created += 1
        stats.lastPreset = preset || null
        log?.info?.(
          `[channel-bridge] 建会话 ${seededId.slice(0, 8)}…（${channel}/${kind}，resume 失败→带交接 seed ${built.messages} 条${built.hasBrief ? ' + 简报' : ''}）`,
        )
        return finish({ ok: true, agent, sessionId: seededId, created: true, prevSessionId: prevId, seeded: built.messages, via: 'create-seeded' }, agents, channel, kind)
      } catch (error) {
        log?.warn?.(`[channel-bridge] 带 seed 新建失败，退回空建 + 交接卡：${error?.message ?? error}`)
        handoffText = buildHandoffText(seedEvents, { maxChars: maxHandoffChars(), limit: seedLimit(), brief })
      }
    }

    // 4b) 空建（首会话 / 档案读不到 / seed 不被宿主支持）
    const sessionId = randomUUID()
    try {
      const out = await agents.create({ sessionId, meta, agentOptions, setup })
      const agent = pickAgent(out)
      if (!agent || typeof agent.followup !== 'function') throw new Error('create 未返回 agent')
      if (setup) logToolFaceAfterCreate(agent, kind)
      handles.set(key, agent)
      try {
        store?.saveSession?.({
          channel,
          kind,
          sessionId,
          cwd,
          at: now(),
          ...(prevId ? { prevSessionId: prevId } : {}),
          ...(handoffText ? { handoffText } : {}),
        })
      } catch {}
      stats.created += 1
      stats.lastPreset = preset || null
      log?.info?.(
        `[channel-bridge] 建会话 ${sessionId.slice(0, 8)}…（${channel}/${kind}，cwd=${cwd}，agentPreset=${preset || '（未设置）'}${prevId ? '，旧的留档' : ''}${handoffText ? '，带交接卡' : ''}）`,
      )
      return finish(
        {
          ok: true,
          agent,
          sessionId,
          created: true,
          prevSessionId: prevId || null,
          ...(handoffText ? { handoffText } : {}),
          via: handoffText ? 'create-fallback' : 'create',
        },
        agents,
        channel,
        kind,
      )
    } catch (error) {
      stats.failed += 1
      return { ok: false, code: 'E_SESSION_FAILED', detail: error?.message ?? String(error) }
    }
  }

  return {
    ensure,
    forceRotate,
    ensureCwd,
    isBusy,
    keyFor,
    cwdForKey,
    cwdFor,
    scopeSetup,
    stats,
    /** 测试/诊断：当前缓存了几个 handle。 */
    cachedKeys() {
      return [...handles.keys()]
    },
    dispose() {
      handles.clear()
    },
  }
}
