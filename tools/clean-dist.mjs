/**
 * 构建前清理 dist（可在中文路径下工作）。
 *
 * 为什么需要它：Node 的 `fs.rmSync` 在**非 ASCII 路径**下会静默失效
 * （不报错、文件也不删；同目录下 `fs.unlinkSync`、PowerShell 的 `Remove-Item` 正常，
 * ASCII 路径下 `rmSync` 也正常）。而 vite 自身的 dist 清理正是走 `rmSync`，
 * 于是中文路径下每次构建都会把旧哈希产物留在 `dist/` 里逐渐堆积
 * （实测 586 个 vs 干净构建 209 个），preview 可能命中陈旧产物。
 *
 * 本脚本先走 `rmSync`（常规路径一步到位），校验发现没清掉时回退到逐项
 * `unlinkSync` + `rmdirSync`（这两个在中文路径下正常）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 项目根目录（本文件位于 <root>/tools/ 下） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 清理目标目录。必须与 `vite.config.ts` 的 `build.outDir` 保持一致。
 * 可用环境变量 `SGW_OUT_DIR` 覆盖。
 */
const TARGET = path.resolve(ROOT, process.env.SGW_OUT_DIR ?? 'dist')

/** 统计目录下残留的文件数（用于校验清理是否真的生效） */
export function countFiles(dir) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += countFiles(full)
    else total += 1
  }
  return total
}

/** 回退清理：逐项 unlinkSync / rmdirSync（避开失效的 rmSync） */
function fallbackRemove(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) fallbackRemove(full)
    else {
      try {
        fs.unlinkSync(full)
      } catch {
        /* 被占用则保留，交由上层判定 */
      }
    }
  }
  try {
    fs.rmdirSync(dir)
  } catch {
    /* 非空或被占用则保留空目录 */
  }
}

/**
 * 清理目录，返回清理后的残留文件数。
 * @returns 残留文件数，0 表示清理干净
 */
export function cleanDir(dir) {
  if (!fs.existsSync(dir)) return 0
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    /* 落到回退分支 */
  }
  if (countFiles(dir) > 0) fallbackRemove(dir)
  return countFiles(dir)
}

const left = cleanDir(TARGET)
if (left === 0) {
  console.log(`[clean-dist] 已清理 ${path.relative(ROOT, TARGET) || TARGET}`)
} else {
  // 不阻断构建（构建本身没问题），但要明确警告：旧产物会残留
  console.warn(
    `[clean-dist] 警告：${path.relative(ROOT, TARGET)} 仍有 ${left} 个文件未清理` +
      `（通常是有进程占用，如 vite preview）。构建继续，但旧产物会残留。`,
  )
}
