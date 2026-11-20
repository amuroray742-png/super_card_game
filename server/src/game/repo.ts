/**
 * 存档与幂等日志的数据访问层。
 *
 * 只做「SQL ↔ 行对象」的转换，不含任何业务规则——
 * 规则一律在 `core/systems/actions.ts`（铁律 #4：单一数据源）。
 *
 * ⚠ **存档分包**：存档主体存在 `saves.payload`（与遗物数量无关），
 *   遗物实例存在 `relic_instances`（每件一行）。
 *   两者的读写必须在**同一事务**里，否则会出现「主体写了、遗物没写」。
 */
import type { RelicInstance, StatMod } from '../../../src/core/model/types.ts'
import { RELIC_INDEX } from '../../../src/core/config/relics.ts'
import { getRow, type Db, type SaveRow } from '../db.ts'

export interface ActionLogRow {
  id: number
  user_id: number
  action_id: string
  result: string
  created_at: number
}

/** 读存档行；不存在返回 undefined */
export function readSave(db: Db, userId: number): SaveRow | undefined {
  return getRow<SaveRow>(db, 'SELECT * FROM saves WHERE user_id = ?', userId)
}

/** 写存档行（覆盖） */
export function writeSave(
  db: Db,
  userId: number,
  payload: string,
  savedAt: number,
  updatedAt: number,
): void {
  db.prepare(
    `INSERT INTO saves (user_id, payload, saved_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, saved_at = excluded.saved_at, updated_at = excluded.updated_at`,
  ).run(userId, payload, savedAt, updatedAt)
}

/** 读幂等日志；命中返回该 actionId 上次的执行结果 */
export function readActionLog(
  db: Db,
  userId: number,
  actionId: string,
): ActionLogRow | undefined {
  return getRow<ActionLogRow>(
    db,
    'SELECT * FROM action_log WHERE user_id = ? AND action_id = ?',
    userId,
    actionId,
  )
}

/** 写幂等日志（只记成功动作） */
export function writeActionLog(
  db: Db,
  userId: number,
  actionId: string,
  result: string,
  createdAt: number,
): void {
  db.prepare(
    'INSERT INTO action_log (user_id, action_id, result, created_at) VALUES (?, ?, ?, ?)',
  ).run(userId, actionId, result, createdAt)
}

/** 清除过期响应正文，保留动作 ID 与时间作为已执行凭据。 */
export function expireActionResults(db: Db, userId: number, expiresBefore: number): void {
  db.prepare(
    "UPDATE action_log SET result = '' WHERE user_id = ? AND created_at <= ? AND result <> ''",
  ).run(userId, expiresBefore)
}

/** 读账号标记（如「存量旧档已迁走」）；不存在返回 undefined */
export function readFlag(db: Db, userId: number, key: string): number | undefined {
  const row = getRow<{ value: number }>(
    db,
    'SELECT value FROM user_flags WHERE user_id = ? AND key = ?',
    userId,
    key,
  )
  return row?.value
}

/** 写账号标记 */
export function writeFlag(db: Db, userId: number, key: string, value: number): void {
  db.prepare(
    `INSERT INTO user_flags (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(userId, key, value)
}

// ─────────────────────────── 遗物实例（存档分包） ───────────────────────────

interface RelicRow {
  uid: string
  def_id: string
  level: number
  sub_stats: string
  locked: number
}

/** 行 → 遗物实例 */
function toRelic(row: RelicRow): RelicInstance {
  let subStats: StatMod[] = []
  try {
    const parsed = JSON.parse(row.sub_stats)
    if (Array.isArray(parsed)) subStats = parsed as StatMod[]
  } catch {
    subStats = []
  }
  return {
    uid: row.uid,
    defId: row.def_id,
    level: row.level,
    subStats,
    locked: row.locked === 1,
  }
}

/** 读某账号的全部遗物实例 */
export function readRelics(db: Db, userId: number): RelicInstance[] {
  const rows = db
    .prepare('SELECT uid, def_id, level, sub_stats, locked FROM relic_instances WHERE user_id = ? ORDER BY level DESC, uid')
    .all(userId) as unknown as RelicRow[]
  return rows.map(toRelic)
}

/**
 * 只读指定的若干件遗物。
 *
 * ⚠ 心跳专用：心跳只需要「已装备」的那几件（≤36 件），
 *   而仓库里可能有几千件——每 5 秒把整张表拉一遍是纯浪费
 *   （1.4 MB 垃圾 / 次，堆内存会被 GC 压得很难看）。
 */
export function readRelicsByUids(db: Db, userId: number, uids: string[]): RelicInstance[] {
  if (uids.length === 0) return []
  const placeholders = uids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT uid, def_id, level, sub_stats, locked FROM relic_instances
       WHERE user_id = ? AND uid IN (${placeholders})`,
    )
    .all(userId, ...uids) as unknown as RelicRow[]
  return rows.map(toRelic)
}

/**
 * 遗物统计（件数 + 按定义 id 分组 + 仓库最高等级）。
 *
 * 客户端镜像里只有已装备遗物（≤36 件），仓库总数与「每个定义有几件」
 * 只能由服务端统计——否则顶栏与图鉴的收藏数会永远显示 0。
 * 用 `GROUP BY` 一条 SQL 出结果，不把整表拉进内存。
 *
 * ⚠ `maxLevel`（仓库里的最高等级）同样是客户端算不出来的：
 *   强化副本的解锁线就是「持有该档解锁线以上的遗物」，
 *   而客户端镜像里 `save.relics` 只有**已装备**件 → 仓库里那件 Lv60 的
 *   客户端根本看不见 → 不由服务端统计，副本就会一直显示「未解锁」。
 */
export function readRelicStats(
  db: Db,
  userId: number,
): { total: number; byDefId: Record<string, number>; maxLevel: number } {
  const rows = db
    .prepare('SELECT def_id, COUNT(*) AS n FROM relic_instances WHERE user_id = ? GROUP BY def_id')
    .all(userId) as unknown as { def_id: string; n: number }[]
  const byDefId: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    byDefId[row.def_id] = row.n
    total += row.n
  }
  const maxRow = db
    .prepare('SELECT MAX(level) AS max_level FROM relic_instances WHERE user_id = ?')
    .get(userId) as unknown as { max_level: number | null } | undefined
  return { total, byDefId, maxLevel: maxRow?.max_level ?? 0 }
}

/**
 * 遗物件数（**带筛选**）。
 *
 * ⚠ 分页的 `total` 必须与 `items` 用**同一套筛选**：
 *   否则筛了稀有度之后，页数按全量算 → 玩家翻到后面全是空页。
 */
export function countRelics(
  db: Db,
  userId: number,
  opts: { rarity?: string; setId?: string; defId?: string } = {},
): number {
  const where: string[] = ['user_id = ?']
  const params: (string | number)[] = [userId]
  if (opts.defId) {
    where.push('def_id = ?')
    params.push(opts.defId)
  } else if (opts.rarity || opts.setId) {
    const ids = filterDefIds(opts.rarity, opts.setId)
    if (ids.length === 0) return 0
    where.push(`def_id IN (${ids.map(() => '?').join(',')})`)
    params.push(...ids)
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM relic_instances WHERE ${where.join(' AND ')}`)
    .get(...params) as unknown as { n: number }
  return row?.n ?? 0
}

/** 读单件遗物 */
export function readRelicByUid(db: Db, userId: number, uid: string): RelicInstance | undefined {
  const row = db
    .prepare('SELECT uid, def_id, level, sub_stats, locked FROM relic_instances WHERE user_id = ? AND uid = ?')
    .get(userId, uid) as unknown as RelicRow | undefined
  return row ? toRelic(row) : undefined
}

/** 遗物分页查询（仓库用） */
export function readRelicPage(
  db: Db,
  userId: number,
  opts: {
    limit: number
    offset: number
    rarity?: string
    setId?: string
    defId?: string
    sort?: string
  },
): RelicInstance[] {
  // 稀有度 / 套装要按定义过滤，定义在 core 配置里 → 这里用 IN 展开
  const where: string[] = ['user_id = ?']
  const params: (string | number)[] = [userId]
  if (opts.defId) {
    where.push('def_id = ?')
    params.push(opts.defId)
  } else if (opts.rarity || opts.setId) {
    const ids = filterDefIds(opts.rarity, opts.setId)
    if (ids.length === 0) return []
    where.push(`def_id IN (${ids.map(() => '?').join(',')})`)
    params.push(...ids)
  }
  const order = opts.sort === 'level' ? 'level ASC, uid ASC' : 'level DESC, uid ASC'
  const rows = db
    .prepare(
      `SELECT uid, def_id, level, sub_stats, locked FROM relic_instances
       WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit, opts.offset) as unknown as RelicRow[]
  return rows.map(toRelic)
}

/** 按稀有度 / 套装筛选遗物定义 id（定义表在 core，仓库查询时展开成 IN 条件） */
let defIdCache: { rarity?: string; setId?: string; ids: string[] } | null = null
function filterDefIds(rarity?: string, setId?: string): string[] {
  const key = `${rarity ?? ''}|${setId ?? ''}`
  if (defIdCache && `${defIdCache.rarity ?? ''}|${defIdCache.setId ?? ''}` === key) {
    return defIdCache.ids
  }
  // 延迟 import：core 的遗物定义注册表在模块加载时填充
  const ids = [...RELIC_INDEX.values()]
    .filter((def) => {
      if (rarity && def.rarity !== rarity) return false
      if (setId && def.setId !== setId) return false
      return true
    })
    .map((def) => def.id)
  defIdCache = { rarity, setId, ids }
  return ids
}

/**
 * **增量**同步遗物行（只写变化的部分）。
 *
 * ⚠ 不能「全量删除 + 全量插入」：仓库里几千件时，每次动作都重写全部行
 *   会让事务时间随遗物数线性增长（而心跳每 5 秒就来一次）。
 *
 * @param before 动作执行前的遗物快照（uid → 等级 / 锁定状态）
 * @param after  动作执行后的遗物实例
 */
export function syncRelics(
  db: Db,
  userId: number,
  before: Map<string, { level: number; locked: boolean }>,
  after: RelicInstance[],
): void {
  const insert = db.prepare(
    `INSERT INTO relic_instances (user_id, uid, def_id, level, sub_stats, locked)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, uid) DO UPDATE SET
       def_id = excluded.def_id, level = excluded.level,
       sub_stats = excluded.sub_stats, locked = excluded.locked`,
  )
  const remove = db.prepare('DELETE FROM relic_instances WHERE user_id = ? AND uid = ?')

  const seen = new Set<string>()
  for (const relic of after) {
    seen.add(relic.uid)
    const prev = before.get(relic.uid)
    if (
      prev &&
      prev.level === relic.level &&
      prev.locked === relic.locked
    ) {
      continue
    }
    insert.run(
      userId,
      relic.uid,
      relic.defId,
      relic.level,
      JSON.stringify(relic.subStats),
      relic.locked ? 1 : 0,
    )
  }
  for (const uid of before.keys()) {
    if (!seen.has(uid)) remove.run(userId, uid)
  }
}

/** 全量替换遗物行（首次拆分存量档时用；幂等） */
export function replaceRelics(db: Db, userId: number, relics: RelicInstance[]): void {
  db.prepare('DELETE FROM relic_instances WHERE user_id = ?').run(userId)
  const insert = db.prepare(
    `INSERT INTO relic_instances (user_id, uid, def_id, level, sub_stats, locked)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, uid) DO UPDATE SET
       def_id = excluded.def_id, level = excluded.level,
       sub_stats = excluded.sub_stats, locked = excluded.locked`,
  )
  for (const relic of relics) {
    insert.run(
      userId,
      relic.uid,
      relic.defId,
      relic.level,
      JSON.stringify(relic.subStats),
      relic.locked ? 1 : 0,
    )
  }
}
