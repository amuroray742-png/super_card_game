/**
 * 养成系统（§5.4）回归测试。
 *
 * 重点覆盖两个曾经出错的地方：
 *   1. skillLevelCap 的境界门槛（曾恒等于 20，等于没有门槛）
 *   2. expToNext 的境界间经验缩放（expScale）
 */
import { describe, it, expect } from 'vitest'
import { expToNext, totalExpToReach, skillLevelCap, skillEffectPct, starUpCost } from '../../src/core/systems/growth.ts'
import { LEVEL, REALMS, SKILL, STAR } from '../../src/core/config/economy.ts'

describe('技能等级上限（境界门槛）', () => {
  it('刚入境界时上限回落到 11 级', () => {
    for (const realm of REALMS) {
      expect(skillLevelCap(realm.minLevel)).toBe(11)
    }
  })

  it('境界内推进时上限逐步解锁到 20 级', () => {
    expect(skillLevelCap(1)).toBe(11)
    expect(skillLevelCap(10)).toBe(20)
    expect(skillLevelCap(10)).toBeLessThanOrEqual(SKILL.MAX_LEVEL)
  })

  it('上限永不超过 MAX_LEVEL', () => {
    for (let lv = LEVEL.MIN; lv <= LEVEL.MAX; lv++) {
      const cap = skillLevelCap(lv)
      expect(cap).toBeGreaterThan(0)
      expect(cap).toBeLessThanOrEqual(SKILL.MAX_LEVEL)
    }
  })

  it('境界切换会使上限回落（不能靠跨境界囤积）', () => {
    // 名阶末级技能上限已解锁
    expect(skillLevelCap(120)).toBe(SKILL.MAX_LEVEL)
    // 进入圣阶后回落到 11
    expect(skillLevelCap(121)).toBe(11)
  })

  it('LV1 英雄不能直接满技能', () => {
    expect(skillLevelCap(LEVEL.MIN)).toBeLessThan(SKILL.MAX_LEVEL)
  })
})

describe('经验曲线', () => {
  it('同一境界内单调递增', () => {
    for (const realm of REALMS) {
      const start = realm.minLevel
      const end = Math.min(realm.maxLevel, start + 20)
      for (let lv = start; lv < end; lv++) {
        expect(expToNext(lv + 1)).toBeGreaterThan(expToNext(lv))
      }
    }
  })

  it('境界切换后经验需求向上跳升（门槛生效，不存在断崖）', () => {
    for (const realm of REALMS) {
      if (realm.minLevel <= LEVEL.MIN) continue
      const prevLast = expToNext(realm.minLevel - 1)
      const first = expToNext(realm.minLevel)
      // 境界切换必须是**向上**台阶
      expect(first).toBeGreaterThan(prevLast)
      // 且不能出现断崖式下跌（原实现会骤降 77 倍）
      expect(first).toBeGreaterThan(prevLast * 0.5)
    }
  })

  it('累计经验单调递增且为正', () => {
    let prev = 0
    for (const lv of [10, 60, 61, 120, 121, 180, 181, LEVEL.MAX]) {
      const total = totalExpToReach(lv)
      expect(total).toBeGreaterThan(prev)
      prev = total
    }
    expect(totalExpToReach(LEVEL.MIN)).toBe(0)
  })

  it('单人满级经验与关卡经验投放同量级', () => {
    const perHero = totalExpToReach(LEVEL.MAX)
    // 应落在百万量级（不是几千，也不是百亿）
    expect(perHero).toBeGreaterThan(1e6)
    expect(perHero).toBeLessThan(1e9)
  })
})

describe('星级与技能强度', () => {
  it('升星消耗随星级递增且有上限', () => {
    let prevShards = 0
    for (let s = STAR.MIN; s < STAR.MAX; s++) {
      const cost = starUpCost(s)
      expect(cost).not.toBeNull()
      expect(cost!.shards).toBeGreaterThanOrEqual(prevShards)
      prevShards = cost!.shards
    }
    expect(starUpCost(STAR.MAX)).toBeNull()
  })

  it('技能效果强度在满级封顶', () => {
    expect(skillEffectPct(SKILL.MIN_LEVEL)).toBe(0)
    expect(skillEffectPct(SKILL.MAX_LEVEL)).toBeCloseTo((SKILL.MAX_LEVEL - 1) * SKILL.PCT_PER_LEVEL, 10)
    // 超出上限不再增长
    expect(skillEffectPct(999)).toBeCloseTo(skillEffectPct(SKILL.MAX_LEVEL), 10)
  })
})
