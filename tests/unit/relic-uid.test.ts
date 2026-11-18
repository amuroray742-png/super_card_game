/**
 * 遗物 uid 的唯一性（Stage A）。
 *
 * ⚠ 历史缺陷：uid 用「模块级全局计数器 + Math.random()」生成——
 *   ① 进程重启后计数器归零，会与存档里已有的 uid 重复；
 *   ② 随机后缀空间只有 1296，遗物量级上千后必然碰撞；
 *   ③ core 里出现 Math.random()，违反铁律 #1。
 *   碰撞的后果不是「多一件遗物」，而是 `find(uid)` 命中**错误遗物**——
 *   玩家点强化/分解，打到的是另一件。
 *
 * 现在 uid 一律由**存档内**自增序号派生，唯一性由构造保证。
 */
import { describe, expect, it } from 'vitest'
import { createNewSave } from '../../src/core/save/schema.ts'
import { makeRelicUid, nextRelicUid, parseLegacyRelicUid } from '../../src/core/systems/relic.ts'
import { Rng } from '../../src/core/rng.ts'
import '../../src/core/config/relics.ts'

describe('遗物 uid：存档内自增', () => {
  it('连续生成 10,000 个 uid 互不重复', () => {
    const save = createNewSave(0)
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i++) {
      const uid = nextRelicUid(save)
      expect(seen.has(uid)).toBe(false)
      seen.add(uid)
    }
    expect(seen.size).toBe(10_000)
  })

  it('uid 由存档内序号派生（不依赖任何随机源）', () => {
    const a = createNewSave(0)
    const b = createNewSave(0)
    const uidA = nextRelicUid(a)
    const uidB = nextRelicUid(b)
    // 同样的操作序列 → 同样的 uid（可复现；core 不读平台随机源）
    expect(uidA).toBe(uidB)
    expect(uidA).toBe(makeRelicUid(1))
  })

  it('存档序号单调递增，序号本身不复用', () => {
    const save = createNewSave(0)
    const first = nextRelicUid(save)
    const second = nextRelicUid(save)
    expect(first).not.toBe(second)
    expect(save.relicSeq).toBe(2)
  })

  it('重启等价场景：重新读档后新 uid 不与档内已有 uid 重复', () => {
    // 模拟「进程重启」：从存档恢复一份副本（计数器随存档一起落盘）
    const save = createNewSave(0)
    const existing: string[] = []
    for (let i = 0; i < 500; i++) existing.push(nextRelicUid(save))

    const restored = createNewSave(0)
    restored.relicSeq = save.relicSeq
    restored.relics = existing.map((uid, i) => ({
      uid,
      defId: 'set_zhanshen_1',
      level: 1,
      subStats: [],
      locked: false,
    }))

    const seen = new Set(existing)
    for (let i = 0; i < 500; i++) {
      const uid = nextRelicUid(restored)
      expect(seen.has(uid)).toBe(false)
      seen.add(uid)
    }
  })

  it('旧格式 uid 的计数器解析取「可能的最大值」', () => {
    // 旧格式 = r + 计数器(36) + 后缀(36)，两段长度不定 → 只能取上界
    expect(parseLegacyRelicUid('r1t')).toBe(1)
    expect(parseLegacyRelicUid('rt1')).toBe(29) // 't' = 29（36 进制）
    expect(parseLegacyRelicUid('r')).toBeNull()
    expect(parseLegacyRelicUid('x1t')).toBeNull()
  })
})
