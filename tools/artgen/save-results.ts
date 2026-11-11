/**
 * 卡面落盘器（Phase 8b）。
 *
 * 读取 H3 Image 的生成回执，逐张取 node_id → 下载 → **转码为 WebP** →
 * 落到 `public/portraits/<heroId>.webp`，并回写 `src/core/config/art.ts` 的已产出登记表
 * （core 层不碰文件系统，可用性在构建期登记）。
 *
 * 转码规则见 `card-encode.ts`（降分辨率 + WebP，与存量转码共用同一函数）。
 *
 * 用法：
 *   npx tsx tools/artgen/save-results.ts <回执.json> [更多回执.json ...] [--manifest=<path>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AI_CARD_EXT } from '../../src/core/config/art.ts'
import { encodeCard } from './card-encode.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PORTRAIT_DIR = join(ROOT, 'public/portraits')
const ART_CONFIG = join(ROOT, 'src/core/config/art.ts')

interface Receipt {
  code?: number
  success_items?: { node_id?: string; file_name?: string; index?: number; image_index?: number }[]
  failed_items?: { index?: number; image_index?: number; reason?: string }[]
  total_failed?: number
}

const args = process.argv.slice(2)
const manifestArg = args.find((a) => a.startsWith('--manifest='))
const receiptPaths = args.filter((a) => !a.startsWith('--'))
if (receiptPaths.length === 0) {
  console.error('用法：npx tsx tools/artgen/save-results.ts <回执.json> [...] [--manifest=<path>]')
  process.exit(1)
}

const manifestPath =
  manifestArg?.slice('--manifest='.length) ?? join(ROOT, 'tools/artgen/out/manifest.json')

/** 读 JSON 文件 */
function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

const manifest = existsSync(manifestPath)
  ? readJson<{ batches: { file: string; ids: string[] }[] }>(manifestPath)
  : null

/** 回执 → 英灵 id：优先用 file_name（由 output_file 指定），退化到批次顺序 */
function resolveIds(items: { file_name?: string; index?: number }[], receiptName: string): string[] {
  const key = receiptName.split(/[\\/]/).pop() ?? receiptName
  const batch =
    manifest?.batches.find((b) => key.includes(b.file.replace(/\.json$/, ''))) ??
    manifest?.batches[0]
  return items.map((item) => {
    const fromName = item.file_name?.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+$/, '')
    if (fromName) return fromName
    if (batch && typeof item.index === 'number') return batch.ids[item.index] ?? ''
    return ''
  })
}

async function download(nodeId: string): Promise<Buffer> {
  // Windows 上 mcode-tools 是 .cmd 包装器，必须带 shell 才能被 spawn
  const raw = execFileSync(`mcode-tools get_asset_url ${nodeId}`, {
    encoding: 'utf8',
    shell: true,
  })
  const parsed = JSON.parse(raw) as { download_url?: string }
  if (!parsed.download_url) throw new Error(`node ${nodeId} 未返回下载地址`)
  const res = await fetch(parsed.download_url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const saved: string[] = []
  const failed: { id: string; reason: string }[] = []
  let totalFailedItems = 0
  let rawBytes = 0
  let outBytes = 0

  for (const receiptPath of receiptPaths) {
    const receipt = readJson<Receipt>(receiptPath)
    const items = receipt.success_items ?? []
    totalFailedItems += receipt.total_failed ?? receipt.failed_items?.length ?? 0

    if (items.length === 0) {
      console.log(`  ! ${receiptPath} 无成功条目（code=${receipt.code ?? '?'}）`)
      continue
    }

    const ids = resolveIds(items, receiptPath)
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const id = ids[i]
      if (!item.node_id || !id) {
        failed.push({ id: id || `#${i}`, reason: '回执缺少 node_id 或无法定位英灵 id' })
        continue
      }
      const dest = join(PORTRAIT_DIR, `${id}${AI_CARD_EXT}`)
      try {
        const raw = await download(item.node_id)
        // 生成即转码：仓库里只留发布格式，不留中间 JPEG
        const encoded = await encodeCard(raw)
        writeFileSync(dest, encoded)
        rawBytes += raw.length
        outBytes += encoded.length
        saved.push(id)
      } catch (err) {
        failed.push({ id, reason: (err as Error).message })
      }
    }
    console.log(`  · ${receiptPath.split(/[\\/]/).pop()}：${items.length} 张`)
  }

  // 回写已产出登记表（与既有条目合并）
  const existing = existsSync(ART_CONFIG) ? [...readIds(ART_CONFIG)] : []
  const merged = [...new Set([...existing, ...saved])].sort()

  // 只替换 AI_CARD_IDS 数组块：文件其余部分（扩展名常量、路径函数）是手工维护的，
  // 整文件覆盖会把它们一起冲掉。
  const text = readFileSync(ART_CONFIG, 'utf8')
  const block = /AI_CARD_IDS: readonly string\[\] = \[[^\]]*\]/
  if (!block.test(text)) {
    throw new Error('art.ts 中找不到 AI_CARD_IDS 数组块，未回写')
  }
  writeFileSync(
    ART_CONFIG,
    text.replace(block, `AI_CARD_IDS: readonly string[] = [\n${merged.map((id) => `  '${id}',`).join('\n')}\n]`),
    'utf8',
  )

  console.log('='.repeat(56))
  console.log('卡面落盘完成')
  console.log('='.repeat(56))
  console.log(`  本次落盘 ${saved.length} 张 · 失败 ${failed.length} 张 · 回执内失败条目 ${totalFailedItems}`)
  console.log(`  落盘目录 ${PORTRAIT_DIR}（格式 ${AI_CARD_EXT}）`)
  if (saved.length > 0) {
    console.log(
      `  体积：原图 ${(rawBytes / 1024 / 1024).toFixed(1)}MB → 转码后 ${(outBytes / 1024 / 1024).toFixed(1)}MB` +
        `（降到 ${((outBytes / rawBytes) * 100).toFixed(1)}%）`,
    )
  }
  console.log(`  登记表已更新：src/core/config/art.ts（累计 ${merged.length} / 72）`)
  for (const f of failed) console.log(`  ✗ ${f.id}：${f.reason}`)
}

/** 从既有 art.ts 里读出已登记的 id（只解析 AI_CARD_IDS 数组块，兼容单行/多行写法） */
function readIds(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const block = text.match(/AI_CARD_IDS[^=]*=\s*\[([^\]]*)\]/)
  if (!block) return []
  return [...block[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
