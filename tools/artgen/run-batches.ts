/**
 * 批次生成执行器（Phase 8b）。
 *
 * 逐批调用 H3 Image 生成卡面，回执逐批落盘（供 save-results 消费）。
 * 已存在回执的批次会跳过，中断后可续跑。
 *
 * 用法：npx tsx tools/artgen/run-batches.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = join(ROOT, 'tools/artgen/out')

/**
 * Windows 上 mcode-tools 是 `.cmd` 包装器，Node 的 execFileSync 不带 shell 时
 * 无法解析 .cmd（会报 spawnSync ENOENT），因此统一走 shell 调用。
 */
function runCli(args: string[]): string {
  const cmd = ['mcode-tools', ...args]
    .map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
  return execFileSync(cmd, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  })
}

const files = readdirSync(OUT)
  .filter((f) => /^batch-\d+\.json$/.test(f))
  .sort()

if (files.length === 0) {
  console.error('没有批次文件，请先运行 build-batch.ts')
  process.exit(1)
}

/** 读回执 */
function readReceipt(file: string): { code?: number; total_success?: number; total_requested?: number } | null {
  try {
    return JSON.parse(
      execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`], {
        encoding: 'utf8',
      }),
    ) as { code?: number; total_success?: number; total_requested?: number }
  } catch {
    return null
  }
}

/** 回执是否代表「本批已全部成功」 */
function isFullyOk(r: { code?: number; total_success?: number; total_requested?: number } | null): boolean {
  if (!r || r.code !== 0) return false
  if (typeof r.total_requested === 'number' && r.total_success !== r.total_requested) return false
  return (r.total_success ?? 0) > 0
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 批次之间的节流间隔：服务端限流约 20 张/分钟，10 张一批留足余量 */
const THROTTLE_MS = 45_000
/** 命中限流后的退避等待 */
const BACKOFF_MS = 70_000
const MAX_RETRY = 4

for (const file of files) {
  const receiptFile = join(OUT, file.replace(/\.json$/, '-receipt.json'))
  if (existsSync(receiptFile) && isFullyOk(readReceipt(receiptFile))) {
    console.log(`跳过 ${file}（已有成功回执）`)
    continue
  }
  if (existsSync(receiptFile)) {
    try {
      unlinkSync(receiptFile)
    } catch {
      /* 覆盖写即可，删除失败不阻塞 */
    }
  }

  let done = false
  for (let attempt = 1; attempt <= MAX_RETRY && !done; attempt++) {
    if (attempt > 1) {
      console.log(`  … 等待 ${BACKOFF_MS / 1000}s 后重试（第 ${attempt} 次）`)
      await sleep(BACKOFF_MS)
    }
    const t0 = Date.now()
    process.stdout.write(`生成中 ${file} … `)
    try {
      const out = runCli([
        'connector',
        'call',
        'connector__matrix__generate_image',
        '--args-file',
        join(OUT, file),
      ])
      writeFileSync(receiptFile, out, 'utf8')
      const parsed = JSON.parse(out) as {
        total_success?: number
        total_requested?: number
        total_failed?: number
        message?: string
      }
      const ok =
        parsed.total_success !== undefined &&
        parsed.total_requested !== undefined &&
        parsed.total_success === parsed.total_requested
      if (ok) {
        console.log(
          `${parsed.total_success}/${parsed.total_requested} 成功（${((Date.now() - t0) / 1000).toFixed(0)}s）`,
        )
        done = true
      } else {
        console.log(
          `${parsed.total_success ?? 0}/${parsed.total_requested ?? '?'} 成功，${parsed.total_failed ?? 0} 失败：${parsed.message ?? ''}`,
        )
      }
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      const msg = (e.stderr ?? e.message ?? '').trim().slice(0, 300)
      console.log(`失败：${msg}`)
      writeFileSync(receiptFile, JSON.stringify({ code: -1, message: msg }, null, 2), 'utf8')
    }
  }

  if (!done) console.log(`  ! ${file} 仍未完成，稍后重跑本脚本可续跑`)
  else await sleep(THROTTLE_MS)
}

console.log('全部批次处理完毕。')
