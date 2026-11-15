/**
 * json/xml 卡片段解析（2026-11-16）。
 *
 * 桥以前把 json/xml 段统一渲染成 `[卡片]`，标题/摘要/链接全丢；
 * 这里把常见 QQ 分享卡片、小程序卡片、XML 链接卡片提成结构化字段，
 * 供 parse.js 渲染进 prompt。不引入新依赖，任何异常都吞掉返回 null。
 *
 * 纯函数：不改入参、不写文件、不抛错。
 */

/** 字段长度硬上限（按码点截断，超长补 `…`）。 */
const TITLE_MAX = 120
const DESC_MAX = 500
const URL_MAX = 1000
const RAW_MAX = 4000

/** 按码点截断，中文/emoji 不劈半。 */
function clip(text, max) {
  const chars = [...String(text ?? '')]
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, max).join('') + '…'
}

/** 宽松取字符串：只认 string/number，去掉首尾空白；其它一律 ''。 */
function asString(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 依次取第一个非空字符串。 */
function pickString(...values) {
  for (const value of values) {
    const text = asString(value)
    if (text) return text
  }
  return ''
}

/** 对象/JSON 字符串 → 普通对象；其它返回 null。 */
function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(value)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj
    } catch {}
  }
  return null
}

/** 数字实体安全转码点。 */
function codePointText(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** XML 文本解码：CDATA / 数字实体 / 命名实体（&amp; 最后处理）。 */
function decodeXmlText(input) {
  return String(input ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => codePointText(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePointText(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 取第一个匹配标签的文本（忽略标签属性）。 */
function xmlTag(xml, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')
    const m = re.exec(xml)
    if (!m) continue
    const text = decodeXmlText(m[1]).trim()
    if (text) return text
  }
  return ''
}

/** 取第一个同名属性的值（单/双引号都认）。 */
function xmlAttr(xml, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const m = re.exec(xml)
  if (!m) return ''
  return decodeXmlText(m[2] ?? m[3] ?? '').trim()
}

/** QQ 分享 json。 */
function parseJsonCard(raw) {
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  const meta = asObject(obj.meta) ?? {}
  const detail = asObject(meta.detail_1) ?? {}
  const news = asObject(meta.news) ?? {}

  const app = pickString(obj.app, meta.app)
  // 标题优先级照契约：meta.detail_1 → meta.news.title → meta.title → 顶层 → prompt。
  const title = pickString(
    detail.title,
    news.title,
    meta.title,
    obj.title,
    asString(meta.detail_1),
    obj.prompt,
  )
  const desc = pickString(obj.desc, meta.desc, detail.desc, news.desc)
  const url = pickString(
    obj.url,
    meta.url,
    meta.qqdocurl,
    detail.qqdocurl,
    detail.url,
    news.jumpUrl,
    news.url,
    meta.jumpUrl,
  )

  return {
    kind: 'json',
    app: clip(app, TITLE_MAX),
    title: clip(title, TITLE_MAX),
    desc: clip(desc, DESC_MAX),
    url: clip(url, URL_MAX),
    raw: clip(raw, RAW_MAX),
  }
}

/** QQ XML 卡片。 */
function parseXmlCard(raw) {
  // 一个标签都没有，不当作 XML 卡片。
  if (!/<[a-zA-Z][^>]*>/.test(raw)) return null

  const title = xmlTag(raw, ['title']) || xmlAttr(raw, 'brief')
  const desc = xmlTag(raw, ['summary', 'des', 'description'])
  const url = xmlTag(raw, ['url']) || xmlAttr(raw, 'url')

  return {
    kind: 'xml',
    app: '',
    title: clip(title, TITLE_MAX),
    desc: clip(desc, DESC_MAX),
    url: clip(url, URL_MAX),
    raw: clip(raw, RAW_MAX),
  }
}

/**
 * 解析 json/xml 卡片段 → 结构化；无法解析返回 null。
 *
 * @param {object} seg OneBot 段 `{type:'json'|'xml', data:{data?:string, ...}}`
 * @returns {{kind:'json'|'xml', app:string, title:string, desc:string, url:string, raw:string}|null}
 */
export function parseCardSegment(seg) {
  try {
    if (!seg || typeof seg !== 'object') return null
    const kind = String(seg.type ?? '')
    if (kind !== 'json' && kind !== 'xml') return null

    const data = seg.data ?? {}
    let raw = ''
    if (typeof data.data === 'string') raw = data.data
    else if (data.data && typeof data.data === 'object') {
      try {
        const text = JSON.stringify(data.data)
        raw = typeof text === 'string' ? text : ''
      } catch {
        return null
      }
    }
    if (!raw.trim()) return null

    return kind === 'json' ? parseJsonCard(raw) : parseXmlCard(raw)
  } catch {
    return null
  }
}

/** 常见 app 名的短标签；不认识的长包名不显示，避免把一行挤爆。 */
const APP_LABELS = [
  [/miniapp/i, '小程序'],
  [/structmsg|share/i, '分享'],
  [/music/i, '音乐'],
  [/video/i, '视频'],
  [/doc|file/i, '文件'],
  [/group|troop/i, '群分享'],
]

function appLabel(app) {
  const text = asString(app)
  if (!text) return ''
  for (const [re, label] of APP_LABELS) {
    if (re.test(text)) return label
  }
  if (text.length <= 12 && !text.includes('.') && !text.includes(':')) return text
  return ''
}

/** 按码点截断整行，总长不超过 max（含省略号）。 */
function clipLine(text, maxChars) {
  const limit = Number(maxChars)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const chars = [...String(text ?? '')]
  if (chars.length <= limit) return chars.join('')
  if (limit === 1) return '…'
  return chars.slice(0, limit - 1).join('') + '…'
}

/**
 * 渲染成一行人类可读文本；空内容返回 ''。
 *
 * @param {{app?:string, title?:string, url?:string}|null} card
 * @param {{maxChars?:number}} [opts]
 * @returns {string} 例：`[卡片 分享·标题] https://…`；无标题无链接 → `[卡片]`
 */
export function renderCard(card, { maxChars = 120 } = {}) {
  try {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return ''

    const title = asString(card.title).replace(/\s+/g, ' ')
    const url = asString(card.url)
    if (!title && !url) return clipLine('[卡片]', maxChars)

    const label = appLabel(card.app)
    const head = title ? `[卡片 ${label ? `${label}·` : ''}${title}]` : '[卡片]'
    return clipLine(url ? `${head} ${url}` : head, maxChars)
  } catch {
    return ''
  }
}
