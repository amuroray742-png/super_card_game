/**
 * 属性合成与战力公式（§15.1）
 */
import { describe, expect, it } from 'vitest'
import {
  applyZones,
  computeBaseStats,
  computePower,
  deriveStats,
  resolveStats,
  getRealm,
} from '../../src/core/systems/stats.ts'
import { POWER, ZONE } from '../../src/core/config/economy.ts'
import { makeHero, maxedHero, nakedHero } from './helpers.ts'

describe('属性合成：独立乘区', () => {
  it('各乘区独立生效，不同乘区相乘而非相加', () => {
    const base = { atk: 100, def: 100, hp: 1000, spd: 100, crit: 0, cdmg: 0 }
    const result = applyZones(base, [
      { stat: 'atk', kind: 'pct', value: 0.5, zone: 'relic' },
      { stat: 'atk', kind: 'pct', value: 0.5, zone: 'skill' },
    ])
    // 100 × 1.5 × 1.5 = 225（乘法），若为加法则是 200
    expect(result.atk).toBeCloseTo(225, 6)
  })

  it('同一乘区内的百分比相加', () => {
    const base = { atk: 100, def: 100, hp: 1000, spd: 100, crit: 0, cdmg: 0 }
    const result = applyZones(base, [
      { stat: 'atk', kind: 'pct', value: 0.2, zone: 'relic' },
      { stat: 'atk', kind: 'pct', value: 0.3, zone: 'relic' },
    ])
    expect(result.atk).toBeCloseTo(150, 6)
  })

  it('固定值先加、百分比后乘', () => {
    const base = { atk: 100, def: 100, hp: 1000, spd: 100, crit: 0, cdmg: 0 }
    const result = applyZones(base, [
      { stat: 'atk', kind: 'flat', value: 50, zone: 'relic' },
      { stat: 'atk', kind: 'pct', value: 0.5, zone: 'relic' },
    ])
    expect(result.atk).toBeCloseTo(225, 6)
  })

  it('任一乘区上限 +300% 生效', () => {
    const base = { atk: 100, def: 100, hp: 1000, spd: 100, crit: 0, cdmg: 0 }
    const result = applyZones(base, [
      { stat: 'atk', kind: 'pct', value: 10, zone: 'relic' },
    ])
    expect(result.atk).toBeCloseTo(100 * (1 + ZONE.MAX_PCT), 6)
  })
})

describe('战力公式（§5.2）', () => {
  it('与公式一致', () => {
    const stats = { atk: 100, def: 50, hp: 1000, spd: 100, crit: 0.1, cdmg: 0.5 }
    const expected =
      (100 * POWER.ATK_WEIGHT + 50 * POWER.DEF_WEIGHT + 1000 * POWER.HP_WEIGHT) *
      (1 + 0.1 * 0.5) *
      (1 + Math.min(100, POWER.SPD_CAP) * POWER.SPD_COEFF)
    expect(computePower(stats)).toBeCloseTo(expected, 6)
  })

  it('任一属性提升，战力必增（单调性）', () => {
    const base = { atk: 100, def: 50, hp: 1000, spd: 100, crit: 0.1, cdmg: 0.5 }
    const basePower = computePower(base)
    expect(computePower({ ...base, atk: 101 })).toBeGreaterThan(basePower)
    expect(computePower({ ...base, def: 51 })).toBeGreaterThan(basePower)
    expect(computePower({ ...base, hp: 1001 })).toBeGreaterThan(basePower)
    expect(computePower({ ...base, spd: 101 })).toBeGreaterThan(basePower)
    expect(computePower({ ...base, crit: 0.11 })).toBeGreaterThan(basePower)
    expect(computePower({ ...base, cdmg: 0.51 })).toBeGreaterThan(basePower)
  })

  it('速度乘区有上限，不会无限膨胀', () => {
    const base = { atk: 100, def: 50, hp: 1000, spd: 99999, crit: 0.1, cdmg: 0.5 }
    const capped = { ...base, spd: POWER.SPD_CAP }
    expect(computePower(base)).toBeCloseTo(computePower(capped), 6)
  })
})

describe('等级与星级 → 基础属性', () => {
  it('等级提升基础属性', () => {
    const low = computeBaseStats(nakedHero('xiangyu'))
    const high = computeBaseStats(makeHero('xiangyu', { level: 100 }))
    expect(high.atk).toBeGreaterThan(low.atk)
    expect(high.hp).toBeGreaterThan(low.hp)
  })

  it('星级提升基础属性倍率', () => {
    const one = computeBaseStats(makeHero('xiangyu', { star: 1 }))
    const six = computeBaseStats(makeHero('xiangyu', { star: 6 }))
    expect(six.atk).toBeGreaterThan(one.atk)
  })

  it('境界按等级正确划分', () => {
    expect(getRealm(1).name).toBe('凡阶')
    expect(getRealm(60).name).toBe('凡阶')
    expect(getRealm(61).name).toBe('名阶')
    expect(getRealm(120).name).toBe('名阶')
    expect(getRealm(121).name).toBe('圣阶')
    expect(getRealm(180).name).toBe('圣阶')
    expect(getRealm(181).name).toBe('神阶')
    expect(getRealm(240).name).toBe('神阶')
  })
})

describe('衍生属性', () => {
  it('闪避 / 命中 / 抵抗在合法区间内', () => {
    const derived = deriveStats({ atk: 100, def: 1000, hp: 1000, spd: 500, crit: 0.1, cdmg: 0.5 })
    expect(derived.dodge).toBeGreaterThanOrEqual(0)
    expect(derived.dodge).toBeLessThanOrEqual(0.35)
    expect(derived.hit).toBeGreaterThanOrEqual(0)
    expect(derived.hit).toBeLessThanOrEqual(1)
    expect(derived.res).toBeGreaterThanOrEqual(0)
    expect(derived.res).toBeLessThanOrEqual(0.6)
  })
})

describe('resolveStats 单一入口', () => {
  it('PVE 模式随养成提升而增强', () => {
    const low = resolveStats(nakedHero('hanxin'), { mode: 'pve', seed: 1 })
    const high = resolveStats(maxedHero('hanxin'), { mode: 'pve', seed: 1 })
    expect(computePower(high)).toBeGreaterThan(computePower(low))
  })

  it('竞技模式缺少 arenaProfile 时抛错（防止静默走 PVE 路径）', () => {
    expect(() => resolveStats(nakedHero('hanxin'), { mode: 'arena', seed: 1 })).toThrow()
  })
})
