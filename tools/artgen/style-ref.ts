/**
 * 画风 / 版式对比样张请求（Phase 8b 开工前的风格锁定用）。
 *
 * 用同一位英灵在多套画风与版式下各出一张，作为风格评审的比对面板。
 * 用法：npx tsx tools/artgen/style-ref.ts [heroId] [outFile]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCardPrompt, type FormatKey, type StyleKey } from './prompt.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const heroId = process.argv[2] ?? 'xiangyu'
const outFile = join(ROOT, process.argv[3] ?? 'tools/artgen/out/style-ref.json')

/** 画风 × 版式 组合 */
const COMBOS: { style: StyleKey; format: FormatKey; label: string }[] = [
  { style: 'cg', format: 'card', label: 'cg-card' },
  { style: 'ink', format: 'card', label: 'ink-card' },
  { style: 'cel', format: 'card', label: 'cel-card' },
  { style: 'cg', format: 'avatar', label: 'cg-avatar' },
]

const ASPECT: Record<FormatKey, string> = { card: '3:4', avatar: '1:1' }

const requests = COMBOS.map((c, i) => ({
  prompt: buildCardPrompt(heroId, c.style, c.format),
  aspect_ratio: ASPECT[c.format],
  area: '1K',
  n: 1,
  output_file: `styleref-${heroId}-${c.label}`,
  output_format: 'jpeg',
}))

mkdirSync(join(outDir(outFile)), { recursive: true })
writeFileSync(outFile, JSON.stringify({ requests }, null, 2), 'utf8')

console.log(`风格对比请求已生成：${requests.length} 张（英灵 ${heroId}）`)
for (const [i, c] of COMBOS.entries()) {
  console.log(`  ${i + 1}. ${c.label}  ${ASPECT[c.format]}  → ${requests[i].output_file}`)
}
console.log(`输出：${outFile}`)

function outDir(file: string): string {
  const idx = file.lastIndexOf('\\')
  const idx2 = file.lastIndexOf('/')
  const cut = Math.max(idx, idx2)
  return cut > 0 ? file.slice(0, cut) : '.'
}
