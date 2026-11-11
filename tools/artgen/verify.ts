/**
 * 卡面技术校验（Phase 8b）。
 *
 * 对 `public/portraits/*` 下的发布格式卡面做逐张技术检查：
 *   - 文件存在、非空、是真正的 WebP（RIFF/WEBP 魔数校验）
 *   - 尺寸与 3:4 比例（卡面版式）
 *   - 无内容重复（哈希去重，避免「同一张图发给多人」）
 *   - 覆盖率：哪些英灵还没有 AI 卡面（会回落到 SVG 占位）
 *
 * 用法：npx tsx tools/artgen/verify.ts
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { AI_CARD_EXT } from '../../src/core/config/art.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PORTRAIT_DIR = join(ROOT, 'public/portraits')

const TARGET_RATIO = 3 / 4
const RATIO_TOLERANCE = 0.04
const MIN_BYTES = 10 * 1024

interface Check {
  id: string
  ok: boolean
  bytes: number
  width: number
  height: number
  ratio: number
  issues: string[]
}

/** WebP 魔数：'RIFF' + 4 字节长度 + 'WEBP' */
function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
}

const checks: Check[] = []
const hashes = new Map<string, string>()
const duplicates: string[] = []

for (const hero of HEROES) {
  const file = join(PORTRAIT_DIR, `${hero.id}${AI_CARD_EXT}`)
  const issues: string[] = []

  if (!existsSync(file)) {
    checks.push({
      id: hero.id,
      ok: false,
      bytes: 0,
      width: 0,
      height: 0,
      ratio: 0,
      issues: ['缺少卡面文件（将回落 SVG 占位）'],
    })
    continue
  }

  const buf = readFileSync(file)
  let size: { width?: number; height?: number } | null = null
  if (!isWebp(buf)) {
    issues.push('不是有效 WebP（RIFF/WEBP 魔数异常）')
  } else {
    try {
      const meta = await sharp(buf).metadata()
      size = { width: meta.width, height: meta.height }
    } catch {
      issues.push('WebP 解析失败')
    }
  }
  if (size?.width && size?.height) {
    const ratio = size.width / size.height
    if (Math.abs(ratio - TARGET_RATIO) > RATIO_TOLERANCE) {
      issues.push(`比例 ${size.width}×${size.height} 偏离 3:4`)
    }
    if (size.width < 512 || size.height < 512) {
      issues.push(`尺寸过小 ${size.width}×${size.height}`)
    }
  }
  if (buf.length < MIN_BYTES) {
    issues.push(`文件过小 ${(buf.length / 1024).toFixed(1)}KB，疑似空白图`)
  }

  const hash = createHash('sha256').update(buf).digest('hex')
  const prev = hashes.get(hash)
  if (prev) {
    issues.push(`与 ${prev} 内容完全相同（重复图）`)
    duplicates.push(`${hero.id} ≡ ${prev}`)
  } else {
    hashes.set(hash, hero.id)
  }

  checks.push({
    id: hero.id,
    ok: issues.length === 0,
    bytes: buf.length,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    ratio: size?.width && size?.height ? size.width / size.height : 0,
    issues,
  })
}

const passed = checks.filter((c) => c.ok)
const failed = checks.filter((c) => !c.ok)
const totalBytes = passed.reduce((sum, c) => sum + c.bytes, 0)

console.log('='.repeat(56))
console.log('卡面技术校验')
console.log('='.repeat(56))
console.log(`  英灵总数 ${checks.length} · 通过 ${passed.length} · 未通过 ${failed.length}`)
console.log(`  覆盖率 ${((passed.length / checks.length) * 100).toFixed(1)}%`)
console.log(`  体积合计 ${(totalBytes / 1024 / 1024).toFixed(1)}MB · 平均 ${(totalBytes / Math.max(1, passed.length) / 1024).toFixed(0)}KB`)
if (duplicates.length > 0) console.log(`  重复图 ${duplicates.length} 组`)
console.log('')

if (failed.length > 0) {
  console.log('  未通过明细：')
  for (const c of failed) {
    console.log(`   ✗ ${c.id.padEnd(16)} ${c.issues.join('；')}`)
  }
  console.log('')
}

console.log('  尺寸分布：')
const bySize = new Map<string, number>()
for (const c of passed) {
  const key = `${c.width}×${c.height}`
  bySize.set(key, (bySize.get(key) ?? 0) + 1)
}
for (const [k, v] of [...bySize.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(12)} ${v} 张`)
}

process.exit(failed.length === 0 ? 0 : 1)
