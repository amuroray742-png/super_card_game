/**
 * 本地 qwen-image2.1 图标流水线（遗物 + 资源）。
 *
 * 替代云端 `tools/artgen/run-batches.ts` 的生图环节：提示词仍然由
 * `icon-prompt.ts` 独家产出（与卡面同源），只是执行者换成本机 GPU。
 *
 * 三个子命令：
 *   build    生成任务清单（jobs.json），不跑模型
 *   run      调起本地 Python 执行器（一次加载权重，循环出图，支持续跑）
 *   publish  产物 PNG → 发布用 WebP，并回填 core 的路径口径
 *
 * 用法：
 *   npx tsx tools/artgen/run-local-icons.ts build [--only relic|resource|both] [--steps N]
 *   npx tsx tools/artgen/run-local-icons.ts run   [--limit N] [--steps N]
 *   npx tsx tools/artgen/run-local-icons.ts publish
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashSeed } from '../../src/core/rng.ts'
import { RELIC_ICON_EXT, RESOURCE_ICON_EXT } from '../../src/core/config/art.ts'
import { buildRelicPrompts, buildResourcePrompt, assertResourceIconCoverage, RESOURCE_ICONS } from './icon-prompt.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT_DIR = join(ROOT, 'tools/artgen/local-out')
const PNG_DIR = join(OUT_DIR, 'png')
const JOBS_FILE = join(OUT_DIR, 'jobs.json')

/** 本机 conda 环境里的 python（qwen-image2.1 专用环境） */
const PYTHON = process.env.SGW_PYTHON ?? 'C:\\Users\\wepie\\anaconda3\\envs\\qwen-image21\\python.exe'
const RUNNER = join(ROOT, 'tools/artgen/qwen-runner.py')

/** 默认推理步数：图标是简单物件，30 步足够（实测 512×512 约 2.2s/step） */
const DEFAULT_STEPS = 30
const DEFAULT_SIZE = 512

interface JobItem {
  id: string
  /** 产物类别：relic / resource */
  kind: 'relic' | 'resource'
  prompt: string
  seed: number
  steps: number
  width: number
  height: number
  out: string
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// ─────────────────────────── build ───────────────────────────

function build(): void {
  const only = arg('only') ?? 'both'
  const steps = Number(arg('steps') ?? DEFAULT_STEPS)
  mkdirSync(PNG_DIR, { recursive: true })

  // 生图侧清单与 core 的 RESOURCE_ICON_KEYS 必须完全一致，否则直接失败
  assertResourceIconCoverage()

  const items: JobItem[] = []

  // ⚠ 顺序：**资源在前、遗物在后**。
  //   资源图标只占 10 张却排在最显眼的位置（顶部资源条常驻），且显示尺寸最小（18px），
  //   风险最高——先出先看，发现不对还能在遗物跑完前改提示词。
  if (only === 'resource' || only === 'both') {
    for (const spec of RESOURCE_ICONS) {
      items.push({
        id: spec.key,
        kind: 'resource',
        prompt: buildResourcePrompt(spec),
        seed: hashSeed(`resource:${spec.key}`),
        steps,
        width: DEFAULT_SIZE,
        height: DEFAULT_SIZE,
        out: join(PNG_DIR, `${spec.key}.png`),
      })
    }
  }

  if (only === 'relic' || only === 'both') {
    for (const { id, prompt } of buildRelicPrompts()) {
      items.push({
        id,
        kind: 'relic',
        prompt,
        seed: hashSeed(`relic:${id}`),
        steps,
        width: DEFAULT_SIZE,
        height: DEFAULT_SIZE,
        out: join(PNG_DIR, `${id}.png`),
      })
    }
  }

  // 按 id 白名单裁剪（试跑 / 重跑单张）：`--ids a,b,c`
  const ids = arg('ids')
  let finalItems = items
  if (ids) {
    const want = new Set(ids.split(',').map((s) => s.trim()).filter(Boolean))
    finalItems = items.filter((i) => want.has(i.id))
  }

  // 提示词 A/B 对比用：`--out-suffix _v2` 让产物落到不同文件名，不覆盖已有结果
  const suffix = arg('out-suffix') ?? ''
  if (suffix) {
    finalItems = finalItems.map((i) => ({
      ...i,
      out: i.out.replace(/\.png$/, `${suffix}.png`),
    }))
  }

  writeFileSync(JOBS_FILE, JSON.stringify({ model: 'Qwen/Qwen-Image-2.1', items: finalItems }, null, 2), 'utf8')

  const relicCount = finalItems.filter((i) => i.kind === 'relic').length
  const resCount = finalItems.length - relicCount
  console.log('='.repeat(56))
  console.log('任务清单已生成')
  console.log('='.repeat(56))
  console.log(`  遗物 ${relicCount} 张 · 资源 ${resCount} 张 · 合计 ${finalItems.length} 张`)
  console.log(`  步数 ${steps} · 尺寸 ${DEFAULT_SIZE}×${DEFAULT_SIZE}`)
  console.log(`  输出：${JOBS_FILE}`)
}

// ─────────────────────────── run ───────────────────────────

function run(): void {
  if (!existsSync(JOBS_FILE)) {
    console.error('没有任务清单，请先运行 build。')
    process.exit(1)
  }
  if (!existsSync(PYTHON)) {
    console.error(`找不到 python：${PYTHON}（可用 SGW_PYTHON 环境变量覆盖）`)
    process.exit(1)
  }

  const args = [RUNNER, '--jobs', JOBS_FILE]
  const limit = arg('limit')
  if (limit) args.push('--limit', limit)
  const steps = arg('steps')
  if (steps) args.push('--steps', steps)
  if (process.argv.includes('--force')) args.push('--force')

  console.log(`调用本地执行器：${PYTHON}`)
  const code = execFileSync(PYTHON, args, { stdio: 'inherit', encoding: 'utf8' })
  process.exitCode = Number(code) || 0
}

// ─────────────────────────── publish ───────────────────────────

/**
 * 产物 PNG → 发布用 WebP。
 *
 * 遗物落到 `public/relics/<defId>.webp`，资源落到 `public/resources/<key>.webp`，
 * 与 `src/core/config/art.ts` 的 `relicIconPath()` / `resourceIconPath()` 同源。
 *
 * ⚠ 按 **jobs.json 清单**发布，不扫目录：
 *   目录里会残留提示词 A/B 试验的产物（`*_v2` / `*_v3` …），
 *   扫目录会把试验图一起发布出去。
 */
async function publish(): Promise<void> {
  const { default: sharp } = await import('sharp')
  if (!existsSync(PNG_DIR)) {
    console.error('没有产物目录。')
    process.exit(1)
  }
  if (!existsSync(JOBS_FILE)) {
    console.error('没有任务清单，请先运行 build。')
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(JOBS_FILE, 'utf8')) as { items: JobItem[] }

  const relicsDir = join(ROOT, 'public/relics')
  const resourcesDir = join(ROOT, 'public/resources')
  mkdirSync(relicsDir, { recursive: true })
  mkdirSync(resourcesDir, { recursive: true })

  let ok = 0
  let failed = 0
  let skipped = 0
  let srcBytes = 0
  let outBytes = 0

  for (const item of manifest.items) {
    const src = item.out
    if (!existsSync(src) || statSync(src).size === 0) {
      skipped++
      continue
    }
    const outPath =
      item.kind === 'relic'
        ? join(relicsDir, `${item.id}${RELIC_ICON_EXT}`)
        : join(resourcesDir, `${item.id}${RESOURCE_ICON_EXT}`)
    try {
      const raw = readFileSync(src)
      const encoded = await sharp(raw)
        .resize({ width: 256, height: 256, fit: 'cover' })
        .webp({ quality: 88, effort: 6 })
        .toBuffer()
      writeFileSync(outPath, encoded)
      srcBytes += raw.length
      outBytes += encoded.length
      ok++
    } catch (err) {
      failed++
      console.error(`  ✗ ${item.id}：${(err as Error).message}`)
    }
  }

  // 源图清理：只清清单内的产物（试验图留着做对比，不属于发布物）
  let removed = 0
  for (const item of manifest.items) {
    if (!existsSync(item.out)) continue
    try {
      unlinkSync(item.out)
      removed++
    } catch {
      /* 删不掉不影响发布结果 */
    }
  }

  console.log('='.repeat(56))
  console.log('发布（PNG → WebP）')
  console.log('='.repeat(56))
  console.log(`  发布 ${ok} 张 · 失败 ${failed} · 缺产物跳过 ${skipped} · 移除源图 ${removed} 张`)
  if (ok > 0) {
    console.log(
      `  体积：${(srcBytes / 1024 / 1024).toFixed(1)}MB → ${(outBytes / 1024 / 1024).toFixed(1)}MB` +
        `（降到 ${((outBytes / srcBytes) * 100).toFixed(1)}%）`,
    )
    console.log(`  单张均值：${Math.round(srcBytes / ok / 1024)}KB → ${Math.round(outBytes / ok / 1024)}KB`)
  }
  console.log(`  遗物 → public/relics/ · 资源 → public/resources/`)
}

const cmd = process.argv[2] ?? 'build'
if (cmd === 'build') build()
else if (cmd === 'run') run()
else if (cmd === 'publish') await publish()
else {
  console.error(`未知子命令：${cmd}（可用 build / run / publish）`)
  process.exit(1)
}
