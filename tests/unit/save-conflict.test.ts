/**
 * 存档并发写入冲突保护（core/save/conflict.ts）。
 *
 * 背景：存档只有一个槽位，但可能同时存在多个写入方（玩家两个标签页、
 * 自动化脚本访问同一 origin）。后写入的一方可能握着过期存档，
 * 直接覆盖会静默抹掉另一方的进度。
 */
import { describe, expect, it } from 'vitest'
import { hasExternalUpdate, nextStamp } from '../../src/core/save/conflict.ts'
import { createNewSave, migrate, normalizeSave, SAVE_VERSION } from '../../src/core/save/schema.ts'
import { deserialize, serialize } from '../../src/core/save/serialize.ts'

describe('存档写入时间戳', () => {
  it('严格递增：同一毫秒内的连续写入不会拿到相同戳', () => {
    const a = nextStamp(1000, 1000)
    const b = nextStamp(1000, a)
    expect(b).toBeGreaterThan(a)
  })

  it('系统时钟回拨时仍保持递增', () => {
    const a = nextStamp(5000, 5000)
    const b = nextStamp(1000, a)
    expect(b).toBeGreaterThan(a)
  })

  it('正常情况下取当前时间', () => {
    expect(nextStamp(12345, 100)).toBe(12345)
  })
})

describe('外部更新检测', () => {
  it('存储为空时不视为外部更新', () => {
    expect(hasExternalUpdate(null, 1000)).toBe(false)
  })

  it('存储中的版本更新 → 判定为外部更新（不得覆盖）', () => {
    const stored = createNewSave(2000)
    stored.savedAt = 2000
    expect(hasExternalUpdate(stored, 1000)).toBe(true)
  })

  it('存储中的版本相同或更旧 → 不算外部更新', () => {
    const stored = createNewSave(2000)
    stored.savedAt = 1000
    expect(hasExternalUpdate(stored, 1000)).toBe(false)
    stored.savedAt = 500
    expect(hasExternalUpdate(stored, 1000)).toBe(false)
  })

  it('旧档没有时间戳（按 0 处理）→ 不会误判成外部更新', () => {
    const stored = createNewSave(2000)
    stored.savedAt = 0
    expect(hasExternalUpdate(stored, 0)).toBe(false)
  })
})

describe('存档结构：写入时间戳参与迁移与序列化', () => {
  it('新存档的写入时间戳为 0（尚未落盘）', () => {
    expect(createNewSave(1000).savedAt).toBe(0)
  })

  it('v3 旧档迁移到当前版本后补齐时间戳 0', () => {
    const old = createNewSave(3000) as unknown as Record<string, unknown>
    old.version = 3
    delete old.savedAt
    const migrated = migrate(normalizeSave(old))
    expect(migrated.version).toBe(SAVE_VERSION)
    expect(migrated.savedAt).toBe(0)
    expect(migrated.player.silver).toBe(createNewSave(0).player.silver)
  })

  it('规范化保留已有时间戳', () => {
    const save = createNewSave(1000)
    save.savedAt = 9999
    expect(normalizeSave(save).savedAt).toBe(9999)
  })

  it('序列化 → 反序列化 往返保留时间戳', () => {
    const save = createNewSave(2000)
    save.savedAt = 8888
    expect(deserialize(serialize(save)).savedAt).toBe(8888)
  })
})
