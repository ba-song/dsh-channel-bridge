#!/usr/bin/env node
/** 扫表情包目录生成/补全 index.json（保留已有 emotion/scene/tags/desc）。用法：node scripts/sticker-index.mjs [--write] */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadStickerIndex } from '../lib/stickers.js'

const args = process.argv.slice(2)
const dirs = ['/sdcard/DSHA/表情包', '/sdcard/DSHA/生活/数据/stickers']
const file = '/sdcard/DSHA/生活/数据/stickers/index.json'
const old = new Map()
try { for (const e of JSON.parse(readFileSync(file, 'utf8'))) old.set(e.file, e) } catch {}
const items = loadStickerIndex({ dirs, indexFile: '' })
const out = items.map((x) => ({ ...(old.get(x.file) ?? {}), file: x.file, name: x.name, tags: old.get(x.file)?.tags ?? x.tags, emotion: old.get(x.file)?.emotion ?? '', scene: old.get(x.file)?.scene ?? '', desc: old.get(x.file)?.desc ?? '' }))
console.log(`scanned=${out.length} existingIndex=${old.size} file=${file}`)
if (args.includes('--write')) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')
  console.log('written')
}
