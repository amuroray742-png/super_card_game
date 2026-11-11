/**
 * 卡池有效概率（池外稀有度并入池内最低档）。
 *
 * 合规硬要求：公示 = 实际。
 * 纪元池只收录 SSR/SR，若不做投影，抽到 R/N 时会取不到英灵（抛错），
 * 且公示的 R/N 概率与实际不符。
 */
import { describe, it, expect } from 'vitest'
import {
  computeEffectiveRates,
  computeTenPullOutcomes,
  projectToPool,
  rarityProbabilities,
} from '../../src/core/systems/gachaRates.ts'
import { executePull } from '../../src/core/systems/gacha.ts'
import { POOL_CHINA, POOL_WORLD, POOL_STANDARD, resolvePoolHeroIds, groupByRarity } from '../../src/core/config/pools.ts'
import { BASE_RATES } from '../../src/core/config/economy.ts'
import { Rng } from '../../src/core/rng.ts'
import type { Rarity } from '../../src/core/model/types.ts'

describe('卡池有效稀有度投影', () => {
  it('全稀有度卡池不受影响', () => {
    const raw = { SSR: 0.006, SR: 0.051, R: 0.243, N: 0.7 }
    const out = projectToPool(raw, ['SSR', 'SR', 'R', 'N'])
    expect(out).toEqual(raw)
  })

  it('纪元池把 R/N 概率并入 SR，且总和仍为 1', () => {
    const raw = { SSR: 0.006, SR: 0.051, R: 0.243, N: 0.7 }
    const out = projectToPool(raw, ['SSR', 'SR'])
    expect(out.SSR).toBeCloseTo(0.006, 10)
    expect(out.SR).toBeCloseTo(0.051 + 0.243 + 0.7, 10)
    expect(out.R).toBe(0)
    expect(out.N).toBe(0)
    const sum = out.SSR + out.SR + out.R + out.N
    expect(sum).toBeCloseTo(1, 10)
  })

  it('rarityProbabilities 在纪元池下不产生 R/N', () => {
    const probs = rarityProbabilities({ pitySSR: 0, pity10: 0 }, { availableRarities: ['SSR', 'SR'] })
    expect(probs.R).toBe(0)
    expect(probs.N).toBe(0)
    expect(probs.SSR + probs.SR).toBeCloseTo(1, 10)
  })
})

describe('按池公示', () => {
  it('常驻池公示值等于全局基础概率', () => {
    const snap = computeEffectiveRates({ pitySSR: 0, pity10: 0 }, ['SSR', 'SR', 'R', 'N'])
    for (const row of snap.rows) {
      expect(row.baseRate).toBeCloseTo(BASE_RATES[row.rarity], 2)
      expect(row.inPool).toBe(true)
    }
  })

  it('纪元池公示的 R/N 为 0，SR 为并入后的值', () => {
    const snap = computeEffectiveRates({ pitySSR: 0, pity10: 0 }, ['SSR', 'SR'])
    const byRarity = Object.fromEntries(snap.rows.map((r) => [r.rarity, r]))
    expect(byRarity.SSR.baseRate).toBeCloseTo(BASE_RATES.SSR, 2)
    expect(byRarity.SR.baseRate).toBeCloseTo(100 - BASE_RATES.SSR, 2)
    expect(byRarity.R.baseRate).toBe(0)
    expect(byRarity.N.baseRate).toBe(0)
    expect(byRarity.R.inPool).toBe(false)
    expect(byRarity.N.inPool).toBe(false)
  })

  it('纪元池十连综合概率：SR+ 几乎必出，SSR 命中率不高于常驻池', () => {
    const standard = computeTenPullOutcomes({ pitySSR: 0, pity10: 0 }, ['SSR', 'SR', 'R', 'N'])
    const era = computeTenPullOutcomes({ pitySSR: 0, pity10: 0 }, ['SSR', 'SR'])

    // 纪元池只会产出 SSR/SR → "至少 1 次 R 或更高" 等价于 "至少 1 次 SR"，接近必出
    expect(era.rPlus).toBeGreaterThan(0.999)

    // 纪元池几乎必出 SR → 十连保底 floor（批次内未出 SR+ 时第 10 抽强制 SR+）
    // 不会触发，SSR 只能靠基础概率，故命中率**低于**常驻池（常驻池会被 floor 挤出 SSR）
    expect(era.ssr).toBeLessThan(standard.ssr)
    // 但仍应不低于纯基础概率 1-(1-0.6%)^10 ≈ 5.85%
    expect(era.ssr).toBeGreaterThan(0.055)
  })
})

describe('纪元池抽卡不再崩溃', () => {
  it('单抽与十连都只产出池内英灵', () => {
    for (const pool of [POOL_CHINA, POOL_WORLD]) {
      const byRarity = groupByRarity(resolvePoolHeroIds(pool))
      for (let seed = 0; seed < 200; seed++) {
        const outcome = executePull(
          { pity: { pitySSR: 0, pity10: 0 }, owned: {}, crystals: 999999, tickets: 999999 },
          pool,
          10,
          seed,
        )
        expect(outcome.results).toHaveLength(10)
        for (const r of outcome.results) {
          expect(r.heroId).toBeTruthy()
          expect(byRarity[r.rarity]?.length ?? 0).toBeGreaterThan(0)
        }
      }
    }
  })

  it('抽卡结果的稀有度都在该池收录范围内', () => {
    const available = (['SSR', 'SR'] as Rarity[])
    const outcome = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned: {}, crystals: 999999, tickets: 999999 },
      POOL_CHINA,
      10,
      42,
    )
    for (const r of outcome.results) {
      expect(available).toContain(r.rarity)
    }
  })

  it('常驻池仍覆盖全部四档稀有度', () => {
    const byRarity = groupByRarity(resolvePoolHeroIds(POOL_STANDARD))
    for (const r of ['SSR', 'SR', 'R', 'N'] as Rarity[]) {
      expect(byRarity[r]?.length ?? 0).toBeGreaterThan(0)
    }
  })
})
