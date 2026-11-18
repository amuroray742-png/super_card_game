/**
 * 从服务端数据库读出**完整**存档（存档主体 + 遗物表）。
 *
 * ⚠ 存档分包后，`saves.payload` 里**没有遗物**（遗物在 `relic_instances` 表里），
 *   直接 `deserialize(payload)` 拿到的遗物数组是空的。
 *   断言「服务端仓库里有几件」「服务端账本推进到哪了」必须走这个函数。
 */
import type { Db } from '../../../server/src/db.ts'
import { readRelics, readSave } from '../../../server/src/game/repo.ts'
import { readSaveBody, restoreSave } from '../../../src/core/save/serialize.ts'
import type { SaveData } from '../../../src/core/model/types.ts'

/** 读服务端权威存档（主体 + 遗物合并，并走迁移链） */
export function readServerSave(db: Db, userId: number): SaveData {
  const row = readSave(db, userId)
  if (!row) throw new Error(`No save for user ${userId}`)
  const { body, legacyRelics } = readSaveBody(row.payload)
  const relics = legacyRelics ?? readRelics(db, userId)
  return restoreSave(body, relics)
}
