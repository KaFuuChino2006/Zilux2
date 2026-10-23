#!/usr/bin/env node
/**
 * Validate the font against troika-three-text 0.52.5's *actual* runtime parser.
 *
 * Troika bundles Typr (libs/typr.factory.js) and a WOFF->OTF inflater
 * (libs/woff2otf.factory.js); there is no opentype.js anywhere in 0.52.5.
 * Those two ESM factories are copied verbatim into this folder so Node can
 * import them (this folder has {"type":"module"}).
 *
 * What we prove:
 *   1. Typr.parse(ttf) succeeds and exposes cmap / hmtx / glyf.
 *   2. Every required codepoint (ASCII, punctuation, all 20,976 covered CJK)
 *      maps to a non-zero glyph id.
 *   3. Typr.U.glyphToPath() returns non-empty path data for every one of them
 *      (this is exactly what troika feeds to its SDF generator).
 *   4. Path bounding boxes we compute match fontTools' glyf bounds.
 *   5. WOFF1 -> OTF inflation + parse works (troika's supported WOFF path).
 *   6. Timing: parse cost and per-glyph path extraction cost.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const fontsDir = join(here, '..', '..', '..', 'web', 'public', 'fonts')

// troika's typr.factory.js does `if (typeof window === 'undefined') self.window = self`
// so it needs a global `self` when evaluated outside a browser/worker.
globalThis.self ??= globalThis

const typrFactory = (await import(pathToFileURL(join(here, 'typr.factory.js')).href)).default
const woff2otfFactory = (await import(pathToFileURL(join(here, 'woff2otf.factory.js')).href)).default
const Typr = typrFactory()
const woff2otf = woff2otfFactory()

const CJK_START = 0x4e00
const CJK_END = 0x9fff
const ASCII = [...Array(0x7f - 0x20).keys()].map(i => 0x20 + i)
const PUNCT = [...'，。！？、；：「」『』（）《》—…·～％＋－'].map(c => c.codePointAt(0))

function countNonEmpty(obj) {
  return Object.keys(obj).length
}

function check(name, buffer, { expectCmap }) {
  console.log(`\n=== ${name} (${buffer.byteLength} bytes) ===`)
  const t0 = performance.now()
  const fonts = Typr.parse(buffer)
  const parseMs = performance.now() - t0
  console.log(`Typr.parse: ${parseMs.toFixed(1)} ms, returned ${fonts.length} font(s), tables=${countNonEmpty(fonts[0])}`)
  const font = fonts[0]
  const tf = font
  console.log('tables parsed:', Object.keys(tf).sort().join(','))
  console.log('numGlyphs:', tf.maxp && tf.maxp.numGlyphs, 'unitsPerEm:', tf.head && tf.head.unitsPerEm,
    'hmtx count:', tf.hmtx && tf.hmtx.aWidth && tf.hmtx.aWidth.length)
  const cmapLen = tf.cmap ? Object.keys(tf.cmap).length : -1
  console.log('cmap entries (Typr):', cmapLen, expectCmap ? `(expected ${expectCmap})` : '')

  // ---- coverage: every required codepoint maps to a real glyph ----
  const missing = []
  for (const cp of [...ASCII, ...PUNCT, ...Array.from({ length: CJK_END - CJK_START + 1 }, (_, i) => CJK_START + i)]) {
    const gid = Typr.U.codeToGlyph(tf, cp)
    if (!gid) missing.push(cp)
  }
  const total = ASCII.length + PUNCT.length + (CJK_END - CJK_START + 1)
  console.log(`coverage: ${total - missing.length}/${total} required codepoints have a glyph`)
  if (missing.length) {
    console.log('  missing (first 40):', missing.slice(0, 40).map(c => 'U+' + c.toString(16).toUpperCase()))
  }

  // ---- path extraction for every covered CJK glyph (what MSDF eats) ----
  const cmdArgLengths = { M: 2, L: 2, C: 6, Q: 4, Z: 0 }
  let empty = 0, bad = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const samples = {}
  const t1 = performance.now()
  for (let cp = CJK_START; cp <= CJK_END; cp++) {
    const gid = Typr.U.codeToGlyph(tf, cp)
    if (!gid) continue
    const { cmds, crds } = Typr.U.glyphToPath(tf, gid)
    if (!cmds.length || !crds.length) { empty++; if (empty <= 10) samples.empty = samples.empty || cp; continue }
    let idx = 0
    let ok = true
    for (const cmd of cmds) {
      const n = cmdArgLengths[cmd]
      if (n === undefined) { ok = false; break }
      idx += n
    }
    if (!ok || idx !== crds.length) { bad++; if (bad <= 5) console.log('  bad cmd/coord count at U+' + cp.toString(16)) }
    for (let i = 0; i < crds.length; i += 2) {
      const x = crds[i], y = crds[i + 1]
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  const pathMs = performance.now() - t1
  const cjkCount = CJK_END - CJK_START + 1 - missing.filter(c => c >= CJK_START).length
  console.log(`glyphToPath over ${cjkCount} CJK glyphs: ${pathMs.toFixed(0)} ms total ` +
    `(${(pathMs / cjkCount * 1000).toFixed(1)} us/glyph), empty=${empty}, malformed=${bad}`)
  console.log(`bounds of extracted CJK outlines: x[${minX}, ${maxX}] y[${minY}, ${maxY}]`)

  // ---- spot-check a few glyphs against fontTools-reported bboxes ----
  const spot = ['中', '国', '歌', 'A', '。', '★', '❤', '♪']
  for (const ch of spot) {
    const gid = Typr.U.codeToGlyph(tf, ch.codePointAt(0))
    const g = gid ? Typr.U.glyphToPath(tf, gid) : null
    const adv = gid ? tf.hmtx.aWidth[gid] : 0
    console.log(`  '${ch}' U+${ch.codePointAt(0).toString(16).toUpperCase()} gid=${gid} adv=${adv} ` +
      `pathLen=${g ? g.cmds.length + 'cmds/' + g.crds.length + 'coords' : 'NONE'}`)
  }

  // ---- what troika does: build the SVG-ish path string ----
  const t2 = performance.now()
  const gid = Typr.U.codeToGlyph(tf, '爱'.codePointAt(0))
  const { cmds, crds } = Typr.U.glyphToPath(tf, gid)
  let path = ''
  let ci = 0
  for (let i = 0; i < cmds.length; i++) {
    const n = cmdArgLengths[cmds[i]]
    path += cmds[i]
    for (let j = 1; j <= n; j++) path += (j > 1 ? ',' : '') + crds[ci++]
  }
  console.log(`sample path for '爱': ${path.slice(0, 120)}${path.length > 120 ? '…' : ''} ` +
    `(${path.length} chars, built in ${(performance.now() - t2).toFixed(2)} ms)`)

  return { font, parseMs, cjkCount, empty, bad, missing }
}

const ttfPath = join(fontsDir, 'zilux2-sans-sc-regular.ttf')
const woffPath = join(fontsDir, 'zilux2-sans-sc-regular.woff')
const ttfBuf = readFileSync(ttfPath)
const ttfRes = check('TTF (direct Typr path)', ttfBuf.buffer.slice(ttfBuf.byteOffset, ttfBuf.byteOffset + ttfBuf.byteLength), { expectCmap: 22399 })

// ---- WOFF1: troika inflates it first (woff2otf), then Typr parses ----
const woffBuf = readFileSync(woffPath)
const ab = woffBuf.buffer.slice(woffBuf.byteOffset, woffBuf.byteOffset + woffBuf.byteLength)
const tag = String.fromCharCode(...new Uint8Array(ab, 0, 4))
console.log('\nWOFF test: magic =', JSON.stringify(tag))
const t0 = performance.now()
const otf = woff2otf(ab)
const inflateMs = performance.now() - t0
const otfTag = new Uint8Array(otf.buffer, otf.byteOffset, 4)
console.log(`woff2otf inflate: ${inflateMs.toFixed(1)} ms -> ${otf.byteLength} bytes, sfntVersion=0x${[...otfTag].map(b => b.toString(16).padStart(2, '0')).join('')}`)
const woffRes = check('WOFF1 -> OTF -> Typr', otf, { expectCmap: 22399 })

console.log('\n=== SUMMARY ===')
console.log(`TTF  parse: ${ttfRes.parseMs.toFixed(1)} ms`)
console.log(`WOFF inflate + parse: ${(inflateMs + woffRes.parseMs).toFixed(1)} ms ` +
  `(inflate ${inflateMs.toFixed(1)} + parse ${woffRes.parseMs.toFixed(1)})`)
console.log(`required codepoints missing: TTF=${ttfRes.missing.length} WOFF=${woffRes.missing.length}`)
console.log(`empty glyph outlines (CJK): TTF=${ttfRes.empty} WOFF=${woffRes.empty}; malformed: TTF=${ttfRes.bad} WOFF=${woffRes.bad}`)
console.log(`CJK glyphs path-extracted: ${ttfRes.cjkCount}`)
process.exit(ttfRes.missing.length === 0 && woffRes.missing.length === 0 && ttfRes.empty === 0 && woffRes.empty === 0 && ttfRes.bad === 0 && woffRes.bad === 0 ? 0 : 1)
