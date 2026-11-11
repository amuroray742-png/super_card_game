/**
 * 卡面客观复检（Phase 8b）。
 *
 * 第一轮校验模型对「史实严谨性」过敏（AAA 手游立绘的艺术夸张被当成问题），
 * 信号噪声比低。本脚本改用**客观二元问题**复检，只查两件硬事实：
 *   1. 画面中是否出现任何文字 / 字母 / 数字 / 水印 / 符文笔画
 *   2. 可见手指的数量与结构是否正确（多指 / 粘连 / 断裂 / 扭曲）
 *
 * 用法：npx tsx tools/artgen/focus-check.ts [每批张数] [--force]
 *   --force 覆盖已有分组结果（重生成卡面后重跑复检时用）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AI_CARD_EXT } from '../../src/core/config/art.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = join(ROOT, 'tools/artgen/out')
const GROUP = Number(process.argv[2] ?? 8)

const CHECK_PROMPT = [
  '这是一张游戏角色卡面。请只做两项客观检查，每项只回答「有」或「无」，不要评价画风、服饰年代或美术风格。',
  '',
  'A. 文字：画面中（任何位置，含背景、光效、衣纹、器物、旗幡）是否存在可辨认的文字、汉字、字母、',
  '数字、logo、水印，或类似符文/篆刻/碑文的笔画形态？',
  'B. 手部：画面中可见的手（含持物的手）是否出现手指数量错误（多指/缺指）、手指粘连、断裂、扭曲、',
  '或明显畸形的关节？',
  '',
  '请严格按下面两行格式回答，不要附加分析：',
  'A.无 / A.有（位置）',
  'B.无 / B.有（位置）',
].join('\n')

function runCli(args: string[]): string {
  const cmd = ['mcode-tools', ...args]
    .map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
  return execFileSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true })
}

interface Receipt {
  success_items?: { node_id?: string; file_name?: string }[]
}

function collect(): { id: string; nodeId?: string }[] {
  const map = new Map<string, string>()
  // 回执按文件名排序遍历，**后写入的覆盖先写入的**：
  // 重生成的批次号更大（如 batch-09 > batch-01），其回执指向的是最新那张图。
  // 若用「首次出现优先」，复检会拿旧图做判读，重生成成果无法被验证。
  for (const f of readdirSync(OUT).filter((x) => /-receipt\.json$/.test(x)).sort()) {
    const r = JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Receipt
    for (const item of r.success_items ?? []) {
      if (!item.node_id || !item.file_name) continue
      const id = item.file_name.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+$/, '')
      map.set(id, item.node_id)
    }
  }
  const local = readdirSync(join(ROOT, 'public/portraits'))
    .filter((f) => f.endsWith(AI_CARD_EXT))
    .map((f) => f.replace(new RegExp(`${AI_CARD_EXT}$`), ''))
    .filter((id) => !map.has(id))
    .sort()
  return [...[...map.keys()].map((id) => ({ id, nodeId: map.get(id)! })), ...local.map((id) => ({ id }))]
}

function assetUrl(item: { id: string; nodeId?: string }): string {
  if (item.nodeId) {
    const parsed = JSON.parse(runCli(['get_asset_url', item.nodeId])) as { download_url?: string }
    if (parsed.download_url) return parsed.download_url
  }
  const file = join(ROOT, 'public/portraits', `${item.id}${AI_CARD_EXT}`)
  const parsed = JSON.parse(runCli(['upload_temp_url', file])) as { temp_url?: string; url?: string }
  const url = parsed.temp_url ?? parsed.url
  if (!url) throw new Error(`${item.id} 无法取得可访问地址`)
  return url
}

const items = collect()
const groups: { id: string; nodeId?: string }[][] = []
for (let i = 0; i < items.length; i += GROUP) groups.push(items.slice(i, i + GROUP))

// 分组 → 英灵 id 的映射是复检结果的唯一归属依据。
// 落盘给 focus-report.ts 读取，避免两边各算一遍顺序（历史踩坑：顺序不一致导致结论张冠李戴）。
writeFileSync(join(OUT, 'focus-groups.json'), JSON.stringify(groups.map((g) => g.map((x) => x.id)), null, 2), 'utf8')

// --force：覆盖已有分组结果，用于重生成后重跑复检。
// 不加时保留「跳过已完成分组」的续跑行为（分批跑时有用）。
const FORCE = process.argv.includes('--force')

console.log(`复检 ${items.length} 张，分 ${groups.length} 组${FORCE ? '（强制覆盖已有结果）' : ''}`)

groups.forEach((group, gi) => {
  const outFile = join(OUT, `focus-check-${String(gi + 1).padStart(2, '0')}.json`)
  if (existsSync(outFile) && !FORCE) {
    console.log(`  跳过第 ${gi + 1} 组`)
    return
  }
  process.stdout.write(`  复检第 ${gi + 1} 组… `)
  const image_info = group.map((g) => ({
    url: assetUrl(g),
    mime_type: 'image/webp',
    prompt: CHECK_PROMPT,
  }))
  const argsFile = join(OUT, `focus-check-args-${String(gi + 1).padStart(2, '0')}.json`)
  writeFileSync(argsFile, JSON.stringify({ image_info }, null, 2), 'utf8')
  try {
    const raw = execFileSync(
      `mcode-tools connector call connector__matrix__describe_images --args-file "${argsFile}"`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true },
    )
    writeFileSync(outFile, raw, 'utf8')
    console.log('完成')
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    console.log(`失败：${(e.stderr ?? e.message ?? '').trim().slice(0, 200)}`)
  }
})

console.log('客观复检结束。')
