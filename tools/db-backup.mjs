/**
 * 整库备份（roadmap P1-3「演练整库备份恢复与回滚」）。
 *
 * ## 为什么用 `VACUUM INTO` 而不是直接复制文件
 *
 * SQLite 开了 WAL（`server/src/db.ts` 的 `openDb` 里设了 `journal_mode = WAL`），
 * 直接复制 `.db` 文件会**漏掉还在 WAL 里没落盘的事务**，
 * 而且复制过程中若有写入，得到的文件是撕裂的。
 * `VACUUM INTO` 会走 SQLite 自己的备份流程：产出**一致性快照**（单文件、无 WAL 伴随文件）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/db-backup.mjs                          # 备份默认库到 server/backups/
 * node tools/db-backup.mjs --db /data/app.db --out /data/backups --keep 14
 * ```
 *
 * 在 compose 的 api 容器里跑：
 *
 * ```bash
 * docker compose exec api node tools/db-backup.mjs
 * ```
 *
 * ## 路径怎么来的
 *
 * 默认值全部来自环境变量，服务端和运维脚本因此共用同一份口径
 * （容器里 `SGW_DB_PATH=/data/app.db`，备份就落在 `/data/backups`，与库同卷）：
 *
 * - 库路径：`--db` > `SGW_DB_PATH` > `server/data/app.db`
 * - 备份目录：`--out` > `SGW_BACKUP_DIR` > `<库所在目录>/backups`
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
function argValue(flag, fallback) {
  const i = args.indexOf(flag)
  if (i < 0) return fallback
  const value = args[i + 1]
  return value && !value.startsWith('--') ? value : fallback
}

const DB_PATH = resolve(argValue('--db', process.env.SGW_DB_PATH || 'server/data/app.db'))
const OUT_DIR = resolve(
  argValue('--out', process.env.SGW_BACKUP_DIR || join(dirname(DB_PATH), 'backups')),
)
const KEEP = Math.max(1, Number(argValue('--keep', '7')) || 7)

if (!existsSync(DB_PATH)) {
  console.error(`[backup] 找不到数据库：${DB_PATH}`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

/** 时间戳文件名（本地时区，排序即时间序） */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

const target = join(OUT_DIR, `app-${stamp()}.db`)
// VACUUM INTO 要求目标文件**不存在**
if (existsSync(target)) rmSync(target)

const db = new DatabaseSync(DB_PATH, { readOnly: true })
try {
  // 表清单按实际存在的表统计，缺表不算错（不同 schema 版本）
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
  const counts = {}
  for (const table of tables) {
    try {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n
    } catch {
      counts[table] = -1
    }
  }
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  console.log('[backup] 已备份到：' + target)
  console.log(`[backup] 体积：${(statSync(target).size / 1024).toFixed(1)} KB`)
  for (const [table, n] of Object.entries(counts)) {
    console.log(`[backup]   ${table}: ${n} 行`)
  }
} finally {
  db.close()
}

// 保留最近 KEEP 份，其余按时间从旧到新删
const backups = readdirSync(OUT_DIR)
  .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
  .sort()
if (backups.length > KEEP) {
  for (const old of backups.slice(0, backups.length - KEEP)) {
    rmSync(join(OUT_DIR, old))
    console.log('[backup] 已清理旧备份：' + old)
  }
}
console.log(`[backup] 当前保留 ${Math.min(backups.length, KEEP)} 份`)
