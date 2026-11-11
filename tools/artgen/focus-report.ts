/**
 * 客观复检汇总（Phase 8b）。
 *
 * 读取 focus-check-*.json，解析每张图的 A（文字）/ B（手部）二元结论，
 * 输出需要重生成的 id 清单，并生成强化提示词的批次文件。
 *
 * 用法：npx tsx tools/artgen/focus-report.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCardPrompt } from './prompt.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = join(ROOT, 'tools/artgen/out')
const GROUP = 9

interface FocusFile {
  code?: number
  results?: { success: boolean; description: string; error?: string }[]
}

/**
 * 复检分组：**唯一来源是 focus-check.ts 落盘的 focus-groups.json**。
 * 历史上两边各算一遍顺序，改动后立刻对不上号，结论张冠李戴。
 */
function collectGroups(): string[][] {
  const manifest = join(OUT, 'focus-groups.json')
  if (existsSync(manifest)) {
    return JSON.parse(readFileSync(manifest, 'utf8')) as string[][]
  }
  // 兜底：manifest 缺失时按回执顺序推导（后写入的覆盖先写入的）
  const map = new Map<string, string>()
  for (const f of readdirSync(OUT).filter((x) => /-receipt\.json$/.test(x)).sort()) {
    const r = JSON.parse(readFileSync(join(OUT, f), 'utf8')) as {
      success_items?: { node_id?: string; file_name?: string }[]
    }
    for (const item of r.success_items ?? []) {
      if (!item.node_id || !item.file_name) continue
      const id = item.file_name.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+$/, '')
      map.set(id, item.node_id)
    }
  }
  const local = readdirSync(join(ROOT, 'public/portraits'))
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => f.replace(/\.jpg$/, ''))
    .filter((id) => !map.has(id))
    .sort()
  const ids = [...map.keys(), ...local]
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += GROUP) out.push(ids.slice(i, i + GROUP))
  return out
}

const groups = collectGroups()
const ids = groups.flat()

const files = readdirSync(OUT)
  .filter((f) => /^focus-check-\d+\.json$/.test(f))
  .sort()

/**
 * 保留清单：判定为「文字/符文」但实为**风格元素**的卡面，不重生成。
 * 魔法法阵、星图这类光效纹样属于画面语言，不是文字，不违反「画面无文字」的要求。
 */
const KEEP_STYLISTIC = new Set(['zhugeliang', 'aristotle', 'wangzhaojun'])

/**
 * 人工裁定：模型把装饰纹样误判成文字时，以人工看过原图后的判定为准。
 * 数据落盘在 tools/artgen/manual-adjudication.json（**进版本库**，结论可回溯），
 * 理由随条目一起保存，便于复核。
 */
interface Adjudication {
  verdict: 'keep' | 'fix'
  note: string
}
function loadAdjudication(): Map<string, Adjudication> {
  const file = join(ROOT, 'tools/artgen/manual-adjudication.json')
  if (!existsSync(file)) return new Map()
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Adjudication>
  const map = new Map<string, Adjudication>()
  for (const [id, v] of Object.entries(raw)) {
    if (id.startsWith('_')) continue
    if (v && (v.verdict === 'keep' || v.verdict === 'fix')) map.set(id, v)
  }
  return map
}
const adjudication = loadAdjudication()

const rows: { id: string; text: boolean; hands: boolean; raw: string }[] = []

files.forEach((f, gi) => {
  const parsed = JSON.parse(readFileSync(join(OUT, f), 'utf8')) as FocusFile
  const groupIds = groups[gi] ?? []
  ;(parsed.results ?? []).forEach((r, ri) => {
    const id = groupIds[ri] ?? `#${gi + 1}-${ri + 1}`
    const t = (r.description ?? '').replace(/\s+/g, ' ').trim()
    const flagged = /A\.\s*有/.test(t)
    // 人工裁定优先于模型判定：keep → 整张保留（文字项与手部项都按「无问题」处理）。
    const keep = adjudication.get(id)?.verdict === 'keep'
    const text = flagged && !KEEP_STYLISTIC.has(id) && !keep
    const hands = /B\.\s*有/.test(t) && !keep
    rows.push({ id, text, hands, raw: t.slice(0, 120) })
  })
})

const hasText = rows.filter((r) => r.text)
const badHands = rows.filter((r) => r.hands)
const mustFix = rows.filter((r) => r.text || r.hands)
const kept = rows.filter((r) => !r.text && !r.hands && adjudication.get(r.id)?.verdict === 'keep')

console.log('='.repeat(60))
console.log('客观复检汇总（只查文字与手部）')
console.log('='.repeat(60))
console.log(`  已检 ${rows.length} 张`)
console.log(`  出现文字/符文/水印  ${hasText.length} 张`)
console.log(`  手部畸形            ${badHands.length} 张`)
console.log(`  需重生成            ${mustFix.length} 张`)
console.log(`  保留（风格元素）     ${KEEP_STYLISTIC.size} 张：${[...KEEP_STYLISTIC].join(', ')}`)
if (kept.length > 0) {
  console.log(`  人工裁定保留         ${kept.length} 张：${kept.map((r) => r.id).join(', ')}`)
}
console.log('')

if (hasText.length > 0) {
  console.log('  含文字/符文：')
  for (const r of hasText) console.log(`   · ${r.id}`)
  console.log('')
}
if (badHands.length > 0) {
  console.log('  手部畸形：')
  for (const r of badHands) console.log(`   · ${r.id}`)
  console.log('')
}

function hardenedPrompt(id: string): string {
  return [
    '【最高优先级修正】',
    '双手必须解剖正确：五指分明、数量正确、关节连贯、握持姿态自然，无粘连、无多指、无断指、无扭曲；面部五官对称。',
    '画面任何位置都不得出现文字、汉字、字母、数字、logo、水印、印章或类似符文/篆刻的笔画，背景只保留纯粹的材质与光影。',
    '人物手持的器物表面必须完全素净：尺、简、卷、牌、镜、扇等器物上不得刻字、题跋、铭文、纹样或刻度数字，只保留材质本身的纹理与自然磨损。',
    '',
    buildCardPrompt(id, 'cg', 'card'),
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
  console.log(`  已生成重生成批次：tools/artgen/out/refix-batch.json（${fixIds.length} 张）`)
} else {
  console.log('  无需重生成。')
}

writeFileSync(
  join(OUT, 'focus-report.json'),
  JSON.stringify({ rows, mustFix: mustFix.map((r) => r.id) }, null, 2),
  'utf8',
)
if (!existsSync(join(OUT, 'focus-report.json'))) console.log('  明细未写入')
