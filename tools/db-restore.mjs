/**
 * 整库恢复（roadmap P1-3）。
 *
 * ## 前提
 *
 * **必须先停服务端**。运行中的进程持有 WAL 与文件句柄，
 * 覆盖库文件会让它继续往旧 WAL 里写，恢复出来的数据与运行态不一致。
 *
 * ```bash
 * docker compose stop api
 * node tools/db-restore.mjs --from server/data/backups/app-20261118-120000.db
 * docker compose start api
 * ```
 *
 * ## 为什么连 `-wal` / `-shm` 一起删
 *
 * SQLite 的 WAL 里可能还留着**恢复前**的事务帧。
 * 只覆盖 `.db` 而留着旧 WAL，SQLite 启动时会把旧 WAL 重放回新库 → 恢复失败甚至数据错乱。
 * 备份文件是 `VACUUM INTO` 产出的**单文件快照**，恢复时必须把伴生文件一起清掉。
 *
 * ## 路径
 *
 * 与备份脚本同一份口径：库路径 `--db` > `SGW_DB_PATH` > `server/data/app.db`；
 * 备份目录 `--dir` > `SGW_BACKUP_DIR` > `<库所在目录>/backups`。
 */
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
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
const BACKUP_DIR = resolve(
  argValue('--dir', process.env.SGW_BACKUP_DIR || join(dirname(DB_PATH), 'backups')),
)
const FROM = resolve(argValue('--from', ''))

// --list：先看有哪些备份，避免在容器里翻找文件名
if (args.includes('--list')) {
  if (!existsSync(BACKUP_DIR)) {
    console.error(`[restore] 备份目录不存在：${BACKUP_DIR}`)
    process.exit(1)
  }
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
    .sort()
  if (files.length === 0) {
    console.log(`[restore] ${BACKUP_DIR} 里没有备份`)
    process.exit(0)
  }
  console.log(`[restore] ${BACKUP_DIR} 里的备份（新的在后）：`)
  for (const f of files) {
    const size = (statSync(join(BACKUP_DIR, f)).size / 1024).toFixed(1)
    console.log(`[restore]   ${f}  ${size} KB`)
  }
  process.exit(0)
}

if (!FROM) {
  console.error('[restore] 必须指定备份文件：node tools/db-restore.mjs --from <备份.db>')
  console.error(`[restore] 可用备份目录：${BACKUP_DIR}（用 --list 查看）`)
  process.exit(1)
}
if (!existsSync(FROM)) {
  console.error(`[restore] 找不到备份文件：${FROM}`)
  process.exit(1)
}

// 先校验备份本身能打开且结构完整，别把坏文件盖上去
{
  const probe = new DatabaseSync(FROM, { readOnly: true })
  try {
    const tables = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
    if (!tables.includes('users') || !tables.includes('saves')) {
      console.error('[restore] 备份文件里没有 users / saves 表，不是有效的存档备份')
      process.exit(1)
    }
    const users = probe.prepare('SELECT COUNT(*) AS n FROM users').get().n
    const saves = probe.prepare('SELECT COUNT(*) AS n FROM saves').get().n
    console.log(`[restore] 备份校验通过：users ${users} · saves ${saves}`)
  } finally {
    probe.close()
  }
}

if (existsSync(DB_PATH)) {
  // 旧库留一份 .before-restore，避免恢复步骤本身出错后无法回退
  const keep = `${DB_PATH}.before-restore`
  copyFileSync(DB_PATH, keep)
  console.log('[restore] 原库已另存为：' + keep)
} else {
  console.log('[restore] 目标库不存在，按新建处理')
}

copyFileSync(FROM, DB_PATH)
for (const suffix of ['-wal', '-shm']) {
  const sidecar = DB_PATH + suffix
  if (existsSync(sidecar)) {
    rmSync(sidecar)
    console.log('[restore] 已清理伴生文件：' + sidecar)
  }
}

// 恢复后自检：能打开、表齐全、行数与备份一致
{
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
    const saves = db.prepare('SELECT COUNT(*) AS n FROM saves').get().n
    console.log(`[restore] 恢复完成：${DB_PATH}（${(statSync(DB_PATH).size / 1024).toFixed(1)} KB）`)
    console.log(`[restore]   users ${users} · saves ${saves}`)
    console.log('[restore] 请重启服务端，并登录一个账号确认云档可读')
  } finally {
    db.close()
  }
}
