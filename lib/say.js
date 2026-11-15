/**
 * `dy_say` 校验（纯函数）：qq / email 两个渠道。
 * qq：四参必填、渠道/kind/号码/长度/联系人/模式；目标是主人无条件放行，否则联系人目录 7 天内。
 * email：不要 kind；contactId 是邮箱地址；正文 ≤5000；白名单由 dyMail.ownerAddresses() 在工具里校验。
 */

export const SILENT = '[SILENT]'
export const EMAIL_DEFAULT_SUBJECT = '汐的邮件'
export const EMAIL_MAX_CHARS = 5000

export function validateSay(input, deps = {}) {
  const {
    mode = 'observe',
    ownerIds = [],
    maxTextChars = 2000,
    maxEmailChars = EMAIL_MAX_CHARS,
    windowMs = 7 * 24 * 60 * 60 * 1000,
    now = () => Date.now(),
    contactOf = () => null,
  } = deps
  const a = input ?? {}
  const channel = a.channel === undefined || a.channel === null ? '' : String(a.channel)
  const contactId = a.contactId === undefined || a.contactId === null ? '' : String(a.contactId)
  const kind = a.kind === undefined || a.kind === null ? '' : String(a.kind)
  const text = a.text === undefined || a.text === null ? '' : String(a.text)

  if (!channel) return { ok: false, code: 'E_MISSING_PARAM', detail: '缺参数：channel' }

  if (channel === 'email') {
    const missing = []
    if (!contactId) missing.push('contactId')
    if (!text.trim()) missing.push('text')
    if (missing.length) return { ok: false, code: 'E_MISSING_PARAM', detail: `缺参数：${missing.join(', ')}` }
    if (!/^[^@\s]+@[^@\s]+$/.test(contactId)) return { ok: false, code: 'E_FORMAT', detail: `不是合法邮箱：${contactId}` }
    const len = [...text].length
    if (len > maxEmailChars) return { ok: false, code: 'E_TEXT_TOO_LONG', detail: `正文 ${len} 字，超过邮件上限 ${maxEmailChars}` }
    if (text.includes(SILENT)) return { ok: true, silent: true, via: 'email' }
    if (mode === 'observe') return { ok: false, code: 'E_OBSERVE_ONLY', detail: '当前 observe 模式：只观察，不发送' }
    if (mode === 'deliver') return { ok: false, code: 'E_DELIVER_ONLY', detail: '当前 deliver 模式：只投递，不发送' }
    if (mode !== 'send') return { ok: false, code: 'E_OBSERVE_ONLY', detail: `未知模式 ${mode}，按 observe 处理` }
    return { ok: true, silent: false, via: 'email' }
  }

  if (channel !== 'qq') return { ok: false, code: 'E_UNKNOWN_CHANNEL', detail: `未知渠道：${channel}（目前只支持 qq / email）` }

  const missing = []
  if (!contactId) missing.push('contactId')
  if (!kind) missing.push('kind')
  if (!text.trim()) missing.push('text')
  if (missing.length) return { ok: false, code: 'E_MISSING_PARAM', detail: `缺参数：${missing.join(', ')}` }

  if (kind !== 'private' && kind !== 'group') return { ok: false, code: 'E_BAD_KIND', detail: `kind 必须是 private 或 group，收到 ${kind}` }
  if (!/^\d{5,12}$/.test(contactId)) return { ok: false, code: 'E_UNKNOWN_CONTACT', detail: `contactId 必须是 5–12 位纯数字，收到 ${contactId}` }

  const len = [...text].length
  if (len > maxTextChars) return { ok: false, code: 'E_TEXT_TOO_LONG', detail: `正文 ${len} 字，超过上限 ${maxTextChars}` }

  const owners = (ownerIds ?? []).map((x) => String(x))
  let via = ''
  if (owners.includes(contactId)) {
    if (kind !== 'private') return { ok: false, code: 'E_OWNER_KIND', detail: '主人只能按 private 发，不能当群发' }
    via = 'owner-proactive'
  } else {
    const row = contactOf(channel, contactId, kind)
    if (!row) return { ok: false, code: 'E_UNKNOWN_CONTACT', detail: '只能回刚给你写过消息的人（7 天内来过），或主动找主人' }
    const last = Number(row.last_seen_at ?? 0)
    if (now() - last > windowMs) return { ok: false, code: 'E_UNKNOWN_CONTACT', detail: '这个联系人超过 7 天没来过消息了' }
    via = 'reply'
  }

  if (text.includes(SILENT)) return { ok: true, silent: true, via }

  if (mode === 'observe') return { ok: false, code: 'E_OBSERVE_ONLY', detail: '当前 observe 模式：只观察，不发送' }
  if (mode === 'deliver') return { ok: false, code: 'E_DELIVER_ONLY', detail: '当前 deliver 模式：只投递，不发送' }
  if (mode !== 'send') return { ok: false, code: 'E_OBSERVE_ONLY', detail: `未知模式 ${mode}，按 observe 处理` }

  return { ok: true, silent: false, via }
}
