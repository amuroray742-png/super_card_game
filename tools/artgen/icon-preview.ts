/**
 * 图标「真实显示尺寸」预览拼版。
 *
 * 为什么需要这个工具：
 *   512px 原图里刺眼的瑕疵（模型固有的右侧竖条，实测 Δ≈1/255），
 *   缩到 UI 的真实显示尺寸后**完全不可见**——只看原图会为不存在的问题
 *   推翻整批产物；只看小图又漏掉构图问题。**两张都要出。**
 *
 * ⚠ **源必须是「已发布的产物」**（`public/relics/` + `public/resources/`），
 *   不是中间 PNG：
 *   中间 PNG 是**临时件**（发布后就被清掉了），
 *   拿它当源 → 工具在「产物已入库」之后反而跑不起来（死资产）。
 *   已发布的 WebP 才是玩家真正看到的东西。
 *
 * 产出（默认落到 `artifacts/art-preview/`）：
 *   icon-relic-44.png      遗物实际显示尺寸（44px，界面里最常见的尺寸）
 *   icon-relic-256.png     放大细看（查伪影、查构图）
 *   icon-resource-18.png   资源条实际显示尺寸（18px）
 *   icon-resource-256.png  放大细看
 *
 * 用法：
 *   npx tsx tools/artgen/icon-preview.ts [--out <输出目录>]
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const OUT_DIR = resolve(arg('out', join(ROOT, 'artifacts/art-preview')))

/** 一批图标：目录 + 真实显示尺寸 */
interface IconBatch {
  dir: string
  /** UI 里的实际显示边长（px） */
  displaySize: number
  /** 拼版文件名前缀 */
  slug: string
  /** 拼版标题 */
  title: string
}

const BATCHES: IconBatch[] = [
  {
    dir: join(ROOT, 'public/relics'),
    displaySize: 44,
    slug: 'icon-relic',
    title: '遗物实际显示尺寸 44px',
  },
  {
    dir: join(ROOT, 'public/resources'),
    displaySize: 18,
    slug: 'icon-resource',
    title: '资源条实际显示尺寸 18px',
  },
]

const COLS = 6
const PAD = 12
const LABEL_H = 16

/** 单元格边长随显示尺寸放大，保证小图也有足够留白 */
function cellFor(size: number): number {
  return Math.max(72, Math.ceil((size * 1.7) / 8) * 8)
}

/** 渲染一版拼版 */
async function sheet(
  batch: IconBatch,
  files: string[],
  size: number,
  outName: string,
  label: string,
): Promise<void> {
  const CELL = cellFor(size)
  const rows = Math.ceil(files.length / COLS)
  const w = COLS * (CELL + PAD) + PAD
  const h = rows * (CELL + LABEL_H + PAD) + PAD + 26
  const composites: OverlayOptions[] = []

  for (let i = 0; i < files.length; i++) {
    const id = files[i].replace(/\.webp$/i, '')
    const cellX = PAD + (i % COLS) * (CELL + PAD)
    const cellY = PAD + Math.floor(i / COLS) * (CELL + LABEL_H + PAD)
    const imgX = cellX + Math.floor((CELL - size) / 2)
    const imgY = cellY + Math.floor((CELL - size) / 2)

    composites.push({
      input: await sharp(join(batch.dir, files[i])).resize(size, size).png().toBuffer(),
      left: imgX,
      top: imgY,
    })

    // id 标注：用 SVG 文本合成（sharp 自带 librsvg）
    const fontSize = Math.max(9, Math.round(CELL / 11))
    const labelSvg = `<svg width="${CELL}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
      <text x="${CELL / 2}" y="${fontSize + 2}" font-size="${fontSize}" fill="#9aa0b5"
            font-family="sans-serif" text-anchor="middle">${id}</text>
    </svg>`
    composites.push({
      input: Buffer.from(labelSvg),
      left: cellX,
      top: cellY + CELL,
    })
  }

  const titleSvg = `<svg width="${w}" height="26" xmlns="http://www.w3.org/2000/svg">
    <text x="${PAD}" y="18" font-size="14" fill="#d6d8e4" font-family="sans-serif">${label}（共 ${files.length} 张）</text>
  </svg>`
  composites.push({ input: Buffer.from(titleSvg), left: 0, top: 0 })

  await sharp({ create: { width: w, height: h, channels: 3, background: '#101018' } })
    .composite(composites)
    .png()
    .toFile(join(OUT_DIR, outName))
  console.log(`  ${label} → ${join(OUT_DIR, outName)}`)
}

mkdirSync(OUT_DIR, { recursive: true })

for (const batch of BATCHES) {
  if (!existsSync(batch.dir)) {
    console.error(`没有产物目录：${batch.dir}（先跑 npm run art:icons:publish）`)
    process.exit(1)
  }
  const files = readdirSync(batch.dir)
    .filter((f) => f.toLowerCase().endsWith('.webp'))
    .sort()
  if (files.length === 0) {
    console.error(`没有 WebP 产物：${batch.dir}`)
    process.exit(1)
  }
  console.log(`拼版 ${files.length} 张（源：${batch.dir}）`)
  await sheet(batch, files, batch.displaySize, `${batch.slug}-${batch.displaySize}.png`, batch.title)
  await sheet(batch, files, 256, `${batch.slug}-256.png`, `${batch.title.replace(/\d+\s*px$/, '').trim()} · 放大细看 256px`)
}
