/**
 * 卡面内容校验（Phase 8b · 人工校验清单的机器化）。
 *
 * 用视觉模型按 `artifacts/art-style.md` 的校验清单逐张检查生成的卡面：
 *   服饰年代 / 兵器 / 年龄 / 发式 / 姿态气质 / 五行配色 / 合规 / 解剖。
 *
 * 每张图配一条「该角色的期望设定」提示词，模型只回答结论与问题清单。
 * 回执与结果落在 `tools/artgen/out/visual-check-*.json`。
 *
 * 用法：npx tsx tools/artgen/visual-check.ts [每批张数]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROSTER } from '../../src/core/config/heroes/roster.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = join(ROOT, 'tools/artgen/out')
const GROUP = Number(process.argv[2] ?? 8)

/** 定位 → 期望气质（与 prompt.ts 的 ROLE_LOOK 对齐，用于校验姿态） */
const ROLE_EXPECT: Record<string, string> = {
  猛将: '高大结实的武将体格，持长兵器，披风重甲，气势逼人',
  统帅: '挺拔沉稳的统帅站姿，按剑或执节杖，目光沉静有统御感',
  谋士: '清瘦的士人长袍广袖，手持竹简卷轴或星盘，作推演之势，神情冷静',
  医者: '清瘦温润的医者，长袍罩衫，提药箱油灯或药草，眉眼柔和安详',
  器者: '清瘦专注的工匠或学者，双手托持精密器物（尺规镜筒齿轮罗盘），神情严谨',
}

/** 五行 → 期望背景与主色 */
const ELEMENT_EXPECT: Record<string, string> = {
  金: '冷白与淡金配色，背景为金属碎片、断裂刀刃或锐利几何光束',
  木: '青翠与嫩绿配色，背景为枝干、藤蔓或竹叶',
  土: '赭黄与暖褐配色，背景为层叠岩层、夯土城墙剪影或沙尘',
  水: '青蓝与月白配色，背景为流动水纹、涟漪或雾气',
  火: '赤红与橙金配色，背景为摇曳火焰或飞散余烬',
}

/** 逐张校验提示词 */
function checkPrompt(heroId: string): string {
  const h = ROSTER.find((x) => x.id === heroId)!
  return [
    `请校验这张游戏角色卡面是否符合下列设定，逐项检查并指出问题。`,
    ``,
    `【期望设定】`,
    `角色：${h.name}，${h.era}时期的${h.region}历史人物，定位「${h.role}」，五行属「${h.element}」。`,
    `服饰兵器应符合${h.era}的${h.region}形制，发式与冠帽符合当时当地，年龄为可信成年人。`,
    `姿态气质应表现为：${ROLE_EXPECT[h.role]}。`,
    `背景与配色应体现五行「${h.element}」：${ELEMENT_EXPECT[h.element]}。`,
    ``,
    `【检查项】`,
    `1. 服饰与兵器年代：有无后世形制或跨时代器物（重点看甲胄、冠帽、兵器形制）`,
    `2. 年龄与面貌：是否为可信成年人面貌，神情是否沉着（不应是幼童或夸张表情）`,
    `3. 发式：是否符合该时代该地域`,
    `4. 姿态气质：是否符合「${h.role}」定位`,
    `5. 五行背景配色：背景意象与主色是否对得上「${h.element}」`,
    `6. 合规：画面中是否出现任何文字、汉字、字母、数字、logo、水印、真实国旗徽章、第二个人物、现代物品、血腥`,
    `7. 解剖：手指、肢体、面部是否正常完整（有无多指、畸形肢体、面部错位）`,
    `8. 版式：竖版 3:4，人物半身居中，背景虚化不抢主体`,
    ``,
    `【回答格式】先给一行「结论：合格」或「结论：需修改」，`,
    `再逐条列出问题，每条写明属于第几项以及具体现象；若全部通过则只写「无问题」。`,
  ].join('\n')
}

function runCli(args: string[]): string {
  const cmd = ['mcode-tools', ...args]
    .map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
  return execFileSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true })
}

interface Receipt {
  success_items?: { node_id?: string; file_name?: string }[]
}

/** 收集所有回执里的 (英灵 id → node_id) */
function collect(): { id: string; nodeId?: string; local?: boolean }[] {
  const map = new Map<string, string>()
  for (const f of readdirSync(OUT).filter((x) => /-receipt\.json$/.test(x))) {
    const r = JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Receipt
    for (const item of r.success_items ?? []) {
      if (!item.node_id || !item.file_name) continue
      const id = item.file_name.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+$/, '')
      if (!map.has(id)) map.set(id, item.node_id)
    }
  }
  // 兜底：本地已有卡面但没有回执的（例如风格样张复用的那张）走本地上传
  const portraitDir = join(ROOT, 'public/portraits')
  const local = readdirSync(portraitDir)
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => f.replace(/\.jpg$/, ''))
    .filter((id) => !map.has(id))
  return [
    ...[...map.entries()].map(([id, nodeId]) => ({ id, nodeId })),
    ...local.map((id) => ({ id, local: true })),
  ]
}

/** 取可访问的 HTTPS 地址：优先 node_id 的资产地址，本地文件走临时上传 */
function assetUrl(item: { id: string; nodeId?: string; local?: boolean }): string {
  if (item.nodeId) {
    const raw = runCli(['get_asset_url', item.nodeId])
    const parsed = JSON.parse(raw) as { download_url?: string }
    if (parsed.download_url) return parsed.download_url
  }
  const file = join(ROOT, 'public/portraits', `${item.id}.jpg`)
  const raw = runCli(['upload_temp_url', file])
  const parsed = JSON.parse(raw) as { temp_url?: string; url?: string }
  const url = parsed.temp_url ?? parsed.url
  if (!url) throw new Error(`${item.id} 无法取得可访问地址`)
  return url
}

const items = collect()
console.log(`收集到 ${items.length} 张卡面`)

const groups: { id: string; nodeId?: string; local?: boolean }[][] = []
for (let i = 0; i < items.length; i += GROUP) groups.push(items.slice(i, i + GROUP))

console.log(`分 ${groups.length} 组校验，每组 ${GROUP} 张`)

const results: { group: number; raw: string }[] = []
groups.forEach((group, gi) => {
  const outFile = join(OUT, `visual-check-${String(gi + 1).padStart(2, '0')}.json`)
  if (existsSync(outFile)) {
    console.log(`  跳过第 ${gi + 1} 组（已有结果）`)
    results.push({ group: gi + 1, raw: readFileSync(outFile, 'utf8') })
    return
  }
  process.stdout.write(`  校验第 ${gi + 1} 组（${group.length} 张）… `)
  // 参数含复杂 JSON，走文件方式提交（Windows 下命令行转义不可靠）
  const image_info = group.map((g) => ({
    url: assetUrl(g),
    mime_type: 'image/jpeg',
    prompt: checkPrompt(g.id),
  }))
  const argsFile = join(OUT, `visual-check-args-${String(gi + 1).padStart(2, '0')}.json`)
  writeFileSync(argsFile, JSON.stringify({ image_info }, null, 2), 'utf8')
  try {
    const raw = execFileSync(
      `mcode-tools connector call connector__matrix__describe_images --args-file "${argsFile}"`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true },
    )
    writeFileSync(outFile, raw, 'utf8')
    results.push({ group: gi + 1, raw })
    console.log('完成')
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    console.log(`失败：${(e.stderr ?? e.message ?? '').trim().slice(0, 200)}`)
  }
})

console.log('='.repeat(56))
console.log('内容校验结束，结果见 tools/artgen/out/visual-check-*.json')
console.log('='.repeat(56))
