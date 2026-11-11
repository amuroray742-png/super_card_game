/**
 * 卡面存量转码（Phase 8b）。
 *
 * 把 `public/portraits/` 下已生成的 JPEG 卡面批量转成发布用 WebP，
 * 并按需移除源图（默认移除，避免仓库里同时存两种格式、体积翻倍）。
 *
 * 转码规则来自 `card-encode.ts`（与 `save-results.ts` 共用同一函数）。
 *
 * 用法：
 *   npx tsx tools/artgen/transcode.ts              # 转码并移除源图
 *   npx tsx tools/artgen/transcode.ts --keep-source # 只转码，保留 JPEG
 *   npx tsx tools/artgen/transcode.ts --force      # 已有 WebP 也重新转码
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AI_CARD_EXT } from '../../src/core/config/art.ts'
import { encodeCard } from './card-encode.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PORTRAIT_DIR = join(ROOT, 'public/portraits')

const KEEP_SOURCE = process.argv.includes('--keep-source')
const FORCE = process.argv.includes('--force')

/** 源图扩展名：生图产出与历史产物都是 JPEG */
const SOURCE_EXT = '.jpg'

async function main() {
  const sources = readdirSync(PORTRAIT_DIR).filter((f) => f.toLowerCase().endsWith(SOURCE_EXT))
  if (sources.length === 0) {
    console.log(`没有需要转码的 ${SOURCE_EXT} 卡面（${PORTRAIT_DIR}）`)
    return
  }

  let srcBytes = 0
  let outBytes = 0
  let converted = 0
  let skipped = 0
  const failed: { id: string; reason: string }[] = []

  for (const name of sources) {
    const id = name.slice(0, -SOURCE_EXT.length)
    const srcPath = join(PORTRAIT_DIR, name)
    const outPath = join(PORTRAIT_DIR, `${id}${AI_CARD_EXT}`)

    if (existsSync(outPath) && !FORCE) {
      skipped++
      continue
    }

    try {
      const raw = readFileSync(srcPath)
      const encoded = await encodeCard(raw)
      writeFileSync(outPath, encoded)
      srcBytes += raw.length
      outBytes += encoded.length
      converted++
    } catch (err) {
      failed.push({ id, reason: (err as Error).message })
    }
  }

  // 源图移除：转码成功且产物存在才删，避免转码失败把原图弄丢
  let removed = 0
  if (!KEEP_SOURCE) {
    for (const name of sources) {
      const id = name.slice(0, -SOURCE_EXT.length)
      const outPath = join(PORTRAIT_DIR, `${id}${AI_CARD_EXT}`)
      if (!existsSync(outPath)) continue
      const srcPath = join(PORTRAIT_DIR, name)
      if (statSync(outPath).size === 0) continue
      unlinkSync(srcPath)
      removed++
    }
  }

  console.log('='.repeat(56))
  console.log('卡面转码（→ WebP）')
  console.log('='.repeat(56))
  console.log(`  扫描源图 ${sources.length} 张 · 转码 ${converted} · 跳过（已有产物）${skipped} · 失败 ${failed.length}`)
  console.log(`  移除源图 ${removed} 张${KEEP_SOURCE ? '（--keep-source，未移除）' : ''}`)
  if (converted > 0) {
    console.log(
      `  体积：${(srcBytes / 1024 / 1024).toFixed(1)}MB → ${(outBytes / 1024 / 1024).toFixed(1)}MB` +
        `（降到 ${((outBytes / srcBytes) * 100).toFixed(1)}%，省 ${((1 - outBytes / srcBytes) * 100).toFixed(1)}%）`,
    )
    console.log(`  单张均值：${Math.round(srcBytes / converted / 1024)}KB → ${Math.round(outBytes / converted / 1024)}KB`)
  }
  for (const f of failed) console.log(`  ✗ ${f.id}：${f.reason}`)
  console.log('')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
