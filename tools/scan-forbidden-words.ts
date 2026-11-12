/**
 * 禁用词扫描（Phase 8 / §2.2 合规）。
 *
 * 禁用词表来自 src/content/compliance/forbidden-words.md（唯一数据源）。
 * 扫描 src/ tools/ tests/ 下的文本文件，跳过注释行，避免把
 * 代码注释里的说明性措辞误判为对外文案。
 *
 * 退出码：0 = 无命中；1 = 有命中。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TABLE_PATH = join(ROOT, 'src/content/compliance/forbidden-words.md')
// 服务端也要扫：它的中文文案会经接口返回给客户端，属于对外文案
const SCAN_ROOTS = ['src', 'tools', 'tests', 'server']
const EXTENSIONS = new Set(['.ts', '.vue', '.md', '.json'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'playwright-report'])
/**
 * 生成的中间产物目录：AI 视觉复核原文、批次回执等。
 * 这些是工具链的缓存与日志，不是任何对外文案，
 * 模型复述里出现「极致」「必出」等词不代表游戏文案违规，故排除。
 */
const SKIP_RELATIVE = ['tools/artgen/out']

interface Rule {
  category: string
  words: string[]
}

/** 解析禁用词表：`- 词1 | 词2 | 词3`，按 `## 分类` 分组 */
function parseTable(markdown: string): Rule[] {
  const rules: Rule[] = []
  let category = '未分类'
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      category = heading[1].trim()
      continue
    }
    if (!line.startsWith('- ')) continue
    const words = line
      .slice(2)
      .split('|')
      .map((w) => w.trim())
      .filter((w) => w.length > 0)
    if (words.length > 0) rules.push({ category, words })
  }
  return rules
}

/** 判断某行是否为注释行（不参与扫描） */
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('<!--') ||
    t.startsWith('#')
  )
}

function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const rel = relative(ROOT, full).replace(/\\/g, '/')
    if (SKIP_RELATIVE.some((p) => rel === p || rel.startsWith(`${p}/`))) continue
    const st = statSync(full)
    if (st.isDirectory()) {
      collectFiles(full, out)
    } else if (EXTENSIONS.has(extname(name))) {
      out.push(full)
    }
  }
  return out
}

interface Hit {
  file: string
  line: number
  column: number
  category: string
  word: string
  text: string
}

const rules = parseTable(readFileSync(TABLE_PATH, 'utf8'))
const tableAbs = TABLE_PATH.replace(/\\/g, '/')

const files: string[] = []
for (const root of SCAN_ROOTS) collectFiles(join(ROOT, root), files)

const hits: Hit[] = []
let scannedLines = 0

for (const file of files) {
  const abs = file.replace(/\\/g, '/')
  // 跳过禁用词表自身与本扫描器
  if (abs === tableAbs || abs.endsWith('/tools/scan-forbidden-words.ts')) continue
  const content = readFileSync(file, 'utf8')
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isCommentLine(line)) continue
    scannedLines++
    for (const rule of rules) {
      for (const word of rule.words) {
        const idx = line.indexOf(word)
        if (idx >= 0) {
          hits.push({
            file: relative(ROOT, file).replace(/\\/g, '/'),
            line: i + 1,
            column: idx + 1,
            category: rule.category,
            word,
            text: line.trim().slice(0, 120),
          })
        }
      }
    }
  }
}

// ─────────────────────────── 输出 ───────────────────────────

console.log('='.repeat(78))
console.log('《超级圣杯战争》禁用词扫描')
console.log('='.repeat(78))
console.log(`\n  禁用词表：${relative(ROOT, TABLE_PATH).replace(/\\/g, '/')}`)
console.log(`  规则 ${rules.length} 类，词条 ${rules.reduce((a, r) => a + r.words.length, 0)} 个`)
console.log(`  扫描 ${files.length} 个文件，${scannedLines} 行有效代码/文案`)

if (hits.length === 0) {
  console.log('\n未发现禁用词 ✓')
  process.exit(0)
}

console.log(`\n【命中】${hits.length} 处\n`)
const byCategory = new Map<string, Hit[]>()
for (const h of hits) {
  const list = byCategory.get(h.category) ?? []
  list.push(h)
  byCategory.set(h.category, list)
}
for (const [category, list] of byCategory) {
  console.log(`  ── ${category}（${list.length} 处）`)
  for (const h of list) {
    console.log(`     ${h.file}:${h.line}:${h.column}  「${h.word}」`)
    console.log(`        ${h.text}`)
  }
  console.log('')
}
console.log('请改写上述文案后重新运行。')
process.exit(1)
