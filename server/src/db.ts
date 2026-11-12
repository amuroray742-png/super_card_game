/**
 * SQLite 数据访问层。
 *
 * 用 Node 24 内置的 `node:sqlite`（DatabaseSync）——零原生依赖、免编译，
 * 与 better-sqlite3 读写同一份 SQLite 文件格式。
 *
 * 迁移用 `PRAGMA user_version`，与前端的 `SAVE_VERSION` 迁移链相互独立：
 * 服务端只管自己的表结构，不参与游戏存档的版本升级。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);

CREATE TABLE IF NOT EXISTS saves (
  user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload   TEXT NOT NULL,
  saved_at  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
`

export function openDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') {
    db.prepare('PRAGMA journal_mode = WAL').get()
  }
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version < 1) {
    db.exec(SCHEMA)
    db.exec('PRAGMA user_version = 1')
  }
}

export interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: number
  last_login_at: number | null
}

export interface SessionRow {
  id: number
  user_id: number
  refresh_hash: string
  expires_at: number
  created_at: number
  revoked_at: number | null
}

export interface SaveRow {
  user_id: number
  payload: string
  saved_at: number
  updated_at: number
}

/**
 * 查询单行并收口成业务行类型。
 *
 * `node:sqlite` 的 `get()` 返回 `Record<string, SQLOutputValue> | undefined`，
 * 直接 `as UserRow` 会触发 TS2352（两者没有足够重叠）。这里统一走这个助手，
 * 避免每个路由各写一遍双重断言。
 */
export function getRow<T>(db: Db, sql: string, ...params: (string | number)[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined
}
