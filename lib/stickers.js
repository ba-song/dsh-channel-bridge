/**
 * 表情包知识库（2026-11-12 P1，参考素材视频 003328）
 * 目录里的图片 + 可选索引 stickers.json（[{file,emotion,tags,scene,desc}]）；
 * 没有索引时用文件名/目录名做弱标签。只读，不发送。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const norm = (s) => String(s ?? '').toLowerCase()
// 18 类情绪 + 相邻关系（参考 SurfCore 表情语义）
export const STICKER_EMOTIONS = ['开心','搞笑','得意','嘲讽','傲娇','害羞','卖萌','委屈','难过','生气','无语','摆烂','安慰','赞同','惊讶','告别','馋饿','害怕']
export const EMOTION_NEIGHBORS = {
  开心: ['搞笑','得意','赞同'], 搞笑: ['开心','嘲讽','卖萌'], 得意: ['傲娇','开心','嘲讽'],
  嘲讽: ['得意','无语','搞笑'], 傲娇: ['得意','害羞','卖萌'], 害羞: ['傲娇','卖萌','委屈'],
  卖萌: ['害羞','开心','安慰'], 委屈: ['难过','害羞','安慰'], 难过: ['委屈','害怕','安慰'],
  生气: ['无语','嘲讽','摆烂'], 无语: ['嘲讽','生气','摆烂'], 摆烂: ['无语','生气','安慰'],
  安慰: ['委屈','难过','赞同'], 赞同: ['开心','赞同','安慰'], 惊讶: ['开心','害怕'],
  告别: ['难过','安慰'], 馋饿: ['卖萌','开心'], 害怕: ['难过','委屈','惊讶'],
}

export function scanStickerDir(dir) {
  const out = []
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return out
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { out.push(...scanStickerDir(p)); continue }
      if (!IMG.has(extname(name).toLowerCase())) continue
      out.push({ file: p, name, tags: name.replace(extname(name), '').split(/[_\-.\s]+/).filter(Boolean), emotion: '', scene: '', desc: '' })
    }
  } catch {}
  return out
}

export function loadStickerIndex({ dirs = [], indexFile = '' } = {}) {
  const byFile = new Map()
  for (const d of dirs) for (const x of scanStickerDir(d)) byFile.set(x.file, x)
  if (indexFile && existsSync(indexFile)) {
    try {
      const arr = JSON.parse(readFileSync(indexFile, 'utf8'))
      for (const e of Array.isArray(arr) ? arr : []) {
        const file = String(e?.file ?? '')
        if (!file || !byFile.has(file)) continue
        const base = byFile.get(file)
        byFile.set(file, { ...base, emotion: String(e?.emotion ?? ''), scene: String(e?.scene ?? ''), desc: String(e?.desc ?? ''), tags: [...new Set([...(base.tags ?? []), ...(Array.isArray(e?.tags) ? e.tags : [])])] })
      }
    } catch {}
  }
  return [...byFile.values()]
}

/**
 * 表情排序（2026-11-13，参考 SurfCore）：情绪相似（含相邻）×0.46 + 内容/标签相似×0.38 + 新鲜度×0.16。
 * items 来自 index.json；没有标注时退回文件名。
 */
export function rankStickers(items, { text = '', moods = [], now = Date.now(), limit = 5 } = {}) {
  const q = norm(text)
  const mood = (Array.isArray(moods) ? moods : [moods]).map(String).filter(Boolean)
  const scored = []
  for (const it of items) {
    let emo = 0
    if (mood.length && it.emotion) {
      if (mood.includes(it.emotion)) emo = 1
      else if (mood.some((m) => (EMOTION_NEIGHBORS[m] ?? []).includes(it.emotion))) emo = 0.55
    }
    let content = 0
    const hay = `${it.desc ?? ''} ${it.scene ?? ''} ${(it.tags ?? []).join(' ')} ${it.name ?? ''}`.toLowerCase()
    if (q) {
      const words = q.split(/\s+/).filter((x) => x.length >= 2)
      const hit = words.filter((w) => hay.includes(w)).length
      content = words.length ? Math.min(1, hit / Math.min(3, words.length)) : 0
    }
    const last = Number(it.lastUsedAt) || Number(it.updatedAt) || 0
    const fresh = last > 0 ? Math.max(0, 1 - (now - last) / (30 * 86400000)) : 0.5
    const score = emo * 0.46 + content * 0.38 + fresh * 0.16
    if (score > 0 || (!mood.length && !q)) scored.push({ ...it, score: Number(score.toFixed(3)) })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))
}

/** 按情绪/场景/自由词打分；返回 top N，不读图片内容。 */
export function searchStickers(items, { emotion = '', scene = '', query = '', limit = 5 } = {}) {
  const eq = norm(emotion), sq = norm(scene), q = norm(query)
  const scored = []
  for (const it of items) {
    let score = 0
    const tags = (it.tags ?? []).map(norm)
    if (eq && norm(it.emotion) === eq) score += 4
    if (sq && norm(it.scene) === sq) score += 3
    if (q) {
      if (tags.some((t) => t.includes(q) || q.includes(t))) score += 2
      if (norm(it.desc).includes(q)) score += 2
      if (norm(it.name).includes(q)) score += 1
    }
    if (!eq && !sq && !q) score = 1
    if (score > 0) scored.push({ ...it, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))
}
