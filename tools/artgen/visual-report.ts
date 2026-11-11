/**
 * 卡面内容校验聚合（Phase 8b）。
 *
 * 汇总 `tools/artgen/out/visual-check-*.json`，按问题类型分流：
 *   - **解剖错误**（手部/肢体畸形）→ 必须重生成
 *   - **合规疑似文字**（背景出现类符文/笔画）→ 必须重生成
 *   - **风格化服饰**（偏奇幻/后世形制）→ 记录为观察项，游戏卡面允许艺术夸张，不自动重生成
 *
 * 并为「必须重生成」的 id 生成一份强化提示词的批次文件（强化手部结构与去文字）。
 *
 * 用法：npx tsx tools/artgen/visual-report.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROSTER } from '../../src/core/config/heroes/roster.ts'
import { buildCardPrompt, type StyleKey } from './prompt.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = join(ROOT, 'tools/artgen/out')

interface CheckResult {
  success: boolean
  description: string
  error?: string
}
interface CheckFile {
  code?: number
  results?: CheckResult[]
}

/**
 * 还原校验时的英灵顺序。
 * ⚠ 必须与 visual-check.ts 的 collect() 完全一致：
 *   先按回执文件名顺序收集 success_items 的 file_name（去重、保序），
 *   再追加「只有本地文件、没有回执」的 id（排序后追加）。
 */
function collectOrder(): string[] {
  const map = new Map<string, string>()
  for (const f of readdirSync(OUT).filter((x) => /-receipt\.json$/.test(x)).sort()) {
    const r = JSON.parse(readFileSync(join(OUT, f), 'utf8')) as {
      success_items?: { node_id?: string; file_name?: string }[]
    }
    for (const item of r.success_items ?? []) {
      if (!item.node_id || !item.file_name) continue
      const id = item.file_name.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+$/, '')
      if (!map.has(id)) map.set(id, item.node_id)
    }
  }
  const local = readdirSync(join(ROOT, 'public/portraits'))
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => f.replace(/\.jpg$/, ''))
    .filter((id) => !map.has(id))
    .sort()
  return [...map.keys(), ...local]
}

const GROUP = 8
const ids = collectOrder()
const groups: string[][] = []
for (let i = 0; i < ids.length; i += GROUP) groups.push(ids.slice(i, i + GROUP))

const files = readdirSync(OUT)
  .filter((f) => /^visual-check-\d+\.json$/.test(f))
  .sort()

/**
 * 问题分级。
 *
 * 校验模型对「史实严谨性」很敏感，会把 AAA 手游立绘的**艺术夸张**也算作问题
 * （如「兵器应更像丈八蛇矛」「必须戴冠帽」「出现盘扣」）。这些属于**观察项**：
 * 用户选定的就是游戏卡面风格，史实洁癖会让画面退化成博物馆陈列。
 *
 * 只有两类是**硬缺陷**，必须重生成：
 *   - 合规：出现文字 / 符文 / 水印 / 第二个人物
 *   - 解剖：手指数量错误、粘连、断裂、扭曲等明显畸形
 */
const RE_COMPLIANCE = /文字|符文|笔画|水印|logo|字母|汉字|第二个人物|印章|碑文|题字/
const RE_SEVERE_ANATOMY = /畸形|多指|粘连|断裂|缺指|扭曲|残缺|错位|融合|畸变/
const RE_MINOR_ANATOMY = /略显模糊|略不自然|细节软化|稍显|有些模糊|略显|轻微/
const RE_STYLIZATION = /服饰|兵器|形制|年代|甲胄|器物|发式|冠帽|款式|风格|现代|后世|蕾丝|仙侠/

type Verdict = 'pass' | 'severe-anatomy' | 'compliance' | 'minor-anatomy' | 'stylization' | 'other'
const results: { id: string; verdict: Verdict; note: string }[] = []

files.forEach((f, gi) => {
  const parsed = JSON.parse(readFileSync(join(OUT, f), 'utf8')) as CheckFile
  const groupIds = groups[gi] ?? []
  ;(parsed.results ?? []).forEach((r, ri) => {
    const id = groupIds[ri] ?? `#${gi + 1}-${ri + 1}`
    const text = r.description ?? ''
    let verdict: Verdict = 'pass'
    if (/需修改|不合格/.test(text)) {
      if (RE_COMPLIANCE.test(text)) verdict = 'compliance'
      else if (RE_SEVERE_ANATOMY.test(text)) verdict = 'severe-anatomy'
      else if (RE_MINOR_ANATOMY.test(text)) verdict = 'minor-anatomy'
      else if (RE_STYLIZATION.test(text)) verdict = 'stylization'
      else verdict = 'other'
    }
    results.push({ id, verdict, note: text.replace(/\s+/g, ' ').slice(0, 200) })
  })
})

const mustFix = results.filter((r) => r.verdict === 'severe-anatomy' || r.verdict === 'compliance')
const minor = results.filter((r) => r.verdict === 'minor-anatomy')
const styleOnly = results.filter((r) => r.verdict === 'stylization')
const other = results.filter((r) => r.verdict === 'other')
const passed = results.filter((r) => r.verdict === 'pass')

console.log('='.repeat(60))
console.log('卡面内容校验汇总')
console.log('='.repeat(60))
console.log(`  已检 ${results.length} 张`)
console.log(`  合格                     ${passed.length}`)
console.log(`  硬缺陷(需重生成)          ${mustFix.length}`)
console.log(`  轻微(手部略糊, 可接受)    ${minor.length}`)
console.log(`  观察项(服饰风格化)        ${styleOnly.length}`)
console.log(`  其他                     ${other.length}`)
console.log('')

if (mustFix.length > 0) {
  console.log('  必须重生成：')
  for (const r of mustFix) {
    const why = r.verdict === 'severe-anatomy' ? '解剖' : '合规'
    console.log(`   · ${r.id.padEnd(16)} [${why}]`)
  }
  console.log('')
}

// 强化提示词：把解剖与去文字的要求提到最前
function hardenedPrompt(id: string): string {
  const base = buildCardPrompt(id, 'cg' as StyleKey, 'card')
  return [
    '【最高优先级修正】',
    '双手与全部手指必须解剖正确：五指分明、数量正确、关节连贯、握持姿态自然，无粘连、无多指、无断指、无扭曲；',
    '面部与五官对称自然；',
    '背景中不得出现任何类似文字、汉字、字母、符文、印章、碑文的笔画或符号，只保留纯粹的材质与光影。',
    '',
    base,
  ].join('\n')
}

if (mustFix.length > 0) {
  const fixIds = mustFix.map((r) => r.id)
  const requests = fixIds.map((id) => ({
    prompt: hardenedPrompt(id),
    aspect_ratio: '3:4',
    area: '1K',
    n: 1,
    output_file: id,
    output_format: 'jpeg',
  }))
  writeFileSync(join(OUT, 'refix-batch.json'), JSON.stringify({ requests }, null, 2), 'utf8')
  writeFileSync(
    join(OUT, 'refix-manifest.json'),
    JSON.stringify({ style: 'cg', format: 'card', ids: fixIds }, null, 2),
    'utf8',
  )
  console.log(`  已生成重生成批次：tools/artgen/out/refix-batch.json（${fixIds.length} 张）`)
}

writeFileSync(
  join(OUT, 'visual-report.json'),
  JSON.stringify({ results, mustFix: mustFix.map((r) => r.id) }, null, 2),
  'utf8',
)
console.log('  明细：tools/artgen/out/visual-report.json')
if (!existsSync(join(OUT, 'refix-batch.json'))) {
  console.log('  无需重生成。')
}
