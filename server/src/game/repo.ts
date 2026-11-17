/**
 * 存档与幂等日志的数据访问层。
 *
 * 只做「SQL ↔ 行对象」的转换，不含任何业务规则——
 * 规则一律在 `core/systems/actions.ts`（铁律 #4：单一数据源）。
 */
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

/**
 * 只保留最近 `keep` 条幂等记录。
 *
 * 客户端的重试窗口是秒级，不需要永久留档；不裁剪的话日志表会无限增长。
 */
export function trimActionLogs(db: Db, userId: number, keep: number): void {
  db.prepare(
    `DELETE FROM action_log
      WHERE user_id = ?
        AND action_id NOT IN (
          SELECT action_id FROM action_log WHERE user_id = ? ORDER BY id DESC LIMIT ?
        )`,
  ).run(userId, userId, keep)
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
