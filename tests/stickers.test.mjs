import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanStickerDir, loadStickerIndex, searchStickers } from '../lib/stickers.js'

const DIR = mkdtempSync(join(tmpdir(), 'bridge-stickers-'))
const d1 = join(DIR, 'a'); mkdirSync(d1)
writeFileSync(join(d1, '开心_撒娇.png'), 'x')
writeFileSync(join(d1, '无语.png'), 'x')
writeFileSync(join(DIR, 'index.json'), JSON.stringify([{ file: join(d1, '开心_撒娇.png'), emotion: '开心', scene: '撒娇', desc: '摇尾巴', tags: ['可爱'] }]))

test('扫描目录 + 索引合并', () => {
  const files = scanStickerDir(d1)
  assert.equal(files.length, 2)
  const items = loadStickerIndex({ dirs: [d1], indexFile: join(DIR, 'index.json') })
  const hit = items.find((x) => x.name.startsWith('开心'))
  assert.equal(hit.emotion, '开心')
  assert.ok(hit.tags.includes('可爱'))
})

test('按情绪/场景/关键词检索', () => {
  const items = loadStickerIndex({ dirs: [d1], indexFile: join(DIR, 'index.json') })
  assert.equal(searchStickers(items, { emotion: '开心' })[0].emotion, '开心')
  assert.equal(searchStickers(items, { scene: '撒娇' })[0].scene, '撒娇')
  assert.equal(searchStickers(items, { query: '无语' })[0].name, '无语.png')
})

test.after(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })
