/**
 * 把重生成批次拆成单批文件（单次调用最多 10 条请求）。
 *
 * 用法：npx tsx tools/artgen/split-batch.ts <待拆分.json>
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = join(ROOT, 'tools/artgen/out')
const source = process.argv[2] ?? join(OUT, 'refix-batch.json')

const { requests } = JSON.parse(readFileSync(source, 'utf8')) as { requests: unknown[] }

// 接着已有批次编号往下排，避免与已完成批次冲突
const existing = readdirSync(OUT)
  .filter((f) => /^batch-(\d+)\.json$/.test(f))
  .map((f) => Number(/^batch-(\d+)\.json$/.exec(f)![1]))
let next = (existing.length > 0 ? Math.max(...existing) : 0) + 1

const SIZE = 10
for (let i = 0; i < requests.length; i += SIZE) {
  const file = join(OUT, `batch-${String(next++).padStart(2, '0')}.json`)
  writeFileSync(file, JSON.stringify({ requests: requests.slice(i, i + SIZE) }, null, 2), 'utf8')
  console.log(`${file}  ${requests.slice(i, i + SIZE).length} 张`)
}
