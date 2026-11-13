/**
 * 养成系统（§5.4）回归测试。
 *
 * 重点覆盖三个曾经出错的地方：
 *   1. skillLevelCap 的境界门槛（曾恒等于 20，等于没有门槛）
 *   2. expToNext 的境界间经验缩放（expScale）
 *   3. 境界突破链路（曾只有配置没有实现，英灵实测卡死在 Lv60）
 */
import { describe, it, expect } from 'vitest'
import {
  expToNext,
  totalExpToReach,
  skillLevelCap,
  skillEffectPct,
  starUpCost,
  applyExp,
  applyRealmBreak,
  atRealmGate,
  canBreakRealm,
  createHeroState,
  realmBreakCost,
} from '../../src/core/systems/growth.ts'
import { getRealm } from '../../src/core/systems/stats.ts'
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

describe('境界突破（境界门槛）', () => {
  it('门槛停在各境界末级', () => {
    expect(atRealmGate(60)).toBe(true)
    expect(atRealmGate(59)).toBe(false)
    expect(atRealmGate(120)).toBe(true)
    expect(atRealmGate(121)).toBe(false)
    expect(atRealmGate(180)).toBe(true)
    // 最高境界没有下一境界，不存在门槛
    expect(atRealmGate(LEVEL.MAX)).toBe(false)
  })

  it('突破消耗是英灵印记，且逐境界递增', () => {
    const c1 = realmBreakCost(60)!
    const c2 = realmBreakCost(120)!
    const c3 = realmBreakCost(180)!
    expect(c1.emblems).toBeGreaterThan(0)
    expect(c2.emblems).toBeGreaterThan(c1.emblems)
    expect(c3.emblems).toBeGreaterThan(c2.emblems)
    // 突破后进入新境界的第 1 级
    expect(c1.targetLevel).toBe(61)
    expect(c2.targetLevel).toBe(121)
    expect(c3.targetLevel).toBe(181)
  })

  it('最高境界没有突破消耗；起始境界有消耗但未到门槛不能突破', () => {
    // 最高境界没有下一个境界 → 无突破消耗
    expect(realmBreakCost(LEVEL.MAX)).toBeNull()
    // 起始境界有「进入名阶」的消耗，但等级还没到门槛，不能突破
    expect(realmBreakCost(LEVEL.MIN)).not.toBeNull()
    expect(canBreakRealm(LEVEL.MIN, 9999)).toBe(false)
  })

  it('印记不足时不能突破', () => {
    const cost = realmBreakCost(60)!
    expect(canBreakRealm(60, cost.emblems)).toBe(true)
    expect(canBreakRealm(60, cost.emblems - 1)).toBe(false)
  })

  it('未到门槛时不能突破', () => {
    expect(canBreakRealm(59, 9999)).toBe(false)
  })

  it('突破后等级跨入新境界，境界乘区随之生效', () => {
    const hero = createHeroState('probe', 0)
    hero.level = 60
    expect(getRealm(hero.level).id).toBe('mortal')
    expect(applyRealmBreak(hero)).toBe(true)
    expect(hero.level).toBe(61)
    expect(getRealm(hero.level).id).toBe('famed')
  })

  it('★ 回归：喂经验 + 突破可以一路到 Lv240', () => {
    // ⚠ 历史 bug：境界突破只有配置没有实现，applyExp 的硬上限把英灵卡死在 Lv60，
    //   实测喂多少经验都不再升级（玩家经验池喂干也白喂）。
    const hero = createHeroState('probe', 0)
    let guard = 0
    while (hero.level < LEVEL.MAX && guard++ < 10_000) {
      applyExp(hero, 1_000_000)
      if (atRealmGate(hero.level)) {
        expect(applyRealmBreak(hero)).toBe(true)
      }
    }
    expect(hero.level).toBe(LEVEL.MAX)
  })

  it('卡在门槛时经验不丢，突破后立即兑现', () => {
    const hero = createHeroState('probe', 0)
    hero.level = 59
    const res = applyExp(hero, 5_000)
    // Lv59 → Lv60 后卡住
    expect(hero.level).toBe(60)
    expect(res.blockedByRealm).toBe(true)
    // 没用完的经验存在英灵身上
    const banked = hero.exp
    expect(banked).toBeGreaterThan(0)

    applyRealmBreak(hero)
    expect(hero.level).toBe(61)
    // 突破后立即把存下来的经验兑现成等级
    const after = applyExp(hero, 0)
    expect(after.levelsGained).toBeGreaterThan(0)
    expect(hero.level).toBeGreaterThan(61)
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
