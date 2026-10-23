#!/usr/bin/env node
/**
 * Same Typr-based check as verify_troika.mjs, but for the optional
 * "CJK Ext-A included" variant produced by measure_extA route:
 *   research/fonts/work/variant-extA.ttf / .woff
 *
 * Confirms troika's bundled Typr can parse the bigger file and that the
 * rare-ideograph codepoints (CJK Ext-A U+3400-U+4DBF) map to real glyphs.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const fontDir = join(here, '..', 'work')
globalThis.self ??= globalThis

const typrFactory = (await import(pathToFileURL(join(here, 'typr.factory.js')).href)).default
const woff2otfFactory = (await import(pathToFileURL(join(here, 'woff2otf.factory.js')).href)).default
const Typr = typrFactory()
const woff2otf = woff2otfFactory()

function toAB(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

function check(label, buffer) {
  console.log(`\n=== ${label} (${buffer.byteLength} bytes) ===`)
  const t0 = performance.now()
  const font = Typr.parse(buffer)[0]
  console.log(`Typr.parse: ${(performance.now() - t0).toFixed(1)} ms; numGlyphs=${font.maxp.numGlyphs}; cmap=${Object.keys(font.cmap).length}`)

  let extA = 0, missingA = []
  for (let cp = 0x3400; cp <= 0x4dbf; cp++) {
    if (Typr.U.codeToGlyph(font, cp)) extA++
    else missingA.push(cp)
  }
  let pathOk = 0, pathEmpty = 0
  const t1 = performance.now()
  for (let cp = 0x3400; cp <= 0x4dbf; cp++) {
    const gid = Typr.U.codeToGlyph(font, cp)
    if (!gid) continue
    const path = Typr.U.glyphToPath(font, gid)
    if (path.cmds.length && path.crds.length) pathOk++
    else pathEmpty++
  }
  console.log(`CJK Ext-A mapped: ${extA}/6592 (missing ${missingA.length}); glyphToPath over them: ${(performance.now() - t1).toFixed(0)} ms, pathOk=${pathOk}, pathEmpty=${pathEmpty}`)

  for (const ch of ['㐀', '㐁', '龘', '𠀀', '中']) {
    const gid = Typr.U.codeToGlyph(font, ch.codePointAt(0))
    console.log(`  '${ch}' U+${ch.codePointAt(0).toString(16).toUpperCase()} gid=${gid}${gid ? ' pathCmds=' + Typr.U.glyphToPath(font, gid).cmds.length : ' (missing)'}`)
  }
}

check('Ext-A variant TTF', toAB(readFileSync(join(fontDir, 'zilux2-sans-sc-regular-exta.ttf'))))

const woffAB = toAB(readFileSync(join(fontDir, 'zilux2-sans-sc-regular-exta.woff')))
const t0 = performance.now()
const otf = woff2otf(woffAB)
console.log(`\nwoff2otf inflate: ${(performance.now() - t0).toFixed(1)} ms -> ${otf.byteLength} bytes`)
check('Ext-A variant WOFF1 -> OTF', otf)
