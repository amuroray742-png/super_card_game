/**
 * 卡面批次构建器（Phase 8b）。
 *
 * 按名册生成 H3 Image 的 `requests` 批次文件：
 *   - 每次调用最多 10 条，故按 10 张一批切分；
 *   - 每条 request 的 `output_file` 直接用英灵 id，便于回执与落盘对账；
 *   - 同时产出 manifest.json，记录每批的英灵 id 顺序（回执里若缺 file_name 可按 index 回溯）。
 *
 * 用法：
 *   npx tsx tools/artgen/build-batch.ts <style> [format] [outDir] [excludeIds]
 *   style  ∈ cg | ink | cel
 *   format ∈ card | avatar
 *   excludeIds 逗号分隔的英灵 id，这些不进入批次
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { buildCardPrompt, type FormatKey, type StyleKey } from './prompt.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BATCH_SIZE = 10

/** 版式 → 宽高比 */
const ASPECT: Record<FormatKey, string> = { card: '3:4', avatar: '1:1' }

const style = (process.argv[2] ?? 'cg') as StyleKey
const format = (process.argv[3] ?? 'card') as FormatKey
const outDir = join(ROOT, process.argv[4] ?? 'tools/artgen/out')
/** 排除的英灵 id（逗号分隔）：已有成图的（例如已出过风格样张的）不再重复生成 */
const exclude = new Set(
  (process.argv[5] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

if (!['cg', 'ink', 'cel'].includes(style)) {
  console.error(`未知画风：${style}（可选 cg / ink / cel）`)
  process.exit(1)
}
if (!['card', 'avatar'].includes(format)) {
  console.error(`未知版式：${format}（可选 card / avatar）`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

const ids = HEROES.map((h) => h.id).filter((id) => !exclude.has(id))
const batches: string[][] = []
for (let i = 0; i < ids.length; i += BATCH_SIZE) {
  batches.push(ids.slice(i, i + BATCH_SIZE))
}

const manifest: { style: StyleKey; format: FormatKey; batches: { file: string; ids: string[] }[] } = {
  style,
  format,
  batches: [],
}

batches.forEach((batchIds, index) => {
  const requests = batchIds.map((id) => ({
    prompt: buildCardPrompt(id, style, format),
    aspect_ratio: ASPECT[format],
    area: '1K',
    n: 1,
    output_file: id,
    output_format: 'jpeg',
  }))
  const file = `batch-${String(index + 1).padStart(2, '0')}.json`
  writeFileSync(join(outDir, file), JSON.stringify({ requests }, null, 2), 'utf8')
  manifest.batches.push({ file, ids: batchIds })
})

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

console.log('='.repeat(56))
console.log(`卡面批次已生成（画风：${style} · 版式：${format}）`)
console.log('='.repeat(56))
console.log(`  英灵总数 ${ids.length} · 每批 ${BATCH_SIZE} 张 · 共 ${batches.length} 批 · 比例 ${ASPECT[format]}`)
if (exclude.size > 0) console.log(`  已排除 ${exclude.size} 张：${[...exclude].join(', ')}`)
console.log(`  输出目录 ${outDir}`)
for (const b of manifest.batches) {
  console.log(`  ${b.file}  ${b.ids[0]} … ${b.ids[b.ids.length - 1]}`)
}
