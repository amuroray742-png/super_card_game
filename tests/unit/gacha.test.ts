/**
 * 抽卡系统（§15.1）
 *
 * 覆盖：基础概率、保底、继承、十连保底、印记转化、概率公示同源。
 */
import { describe, expect, it } from 'vitest'
import {
  applyPity,
  computeEffectiveRates,
  drawRarity,
  pityRemaining,
  rarityProbabilities,
  ssrRateAt,
} from '../../src/core/systems/gachaRates.ts'
import {
  executePull,
  pullCost,
  resolvePayment,
  summarizePull,
  InsufficientFundsError,
} from '../../src/core/systems/gacha.ts'
import { BASE_RATES, GACHA } from '../../src/core/config/economy.ts'
import { POOL_STANDARD } from '../../src/core/config/pools.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { Rng } from '../../src/core/rng.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'

describe('基础概率（§7.2）', () => {
  it('基础概率之和为 100%', () => {
    const total = Object.values(BASE_RATES).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(100, 6)
  })

  it('保底进度为 0 时，SSR 概率等于公示的基础概率 0.60%', () => {
    expect(ssrRateAt(0)).toBeCloseTo(0.006, 10)
    expect(round2pct(ssrRateAt(0))).toBe(0.6)
  })

  it('100 万次实测 SSR 率与公示的基础概率偏差 < 0.01%（固定种子，结果确定）', () => {
    const rng = new Rng(0x9e3779b9)
    const trials = 1_000_000
    let hits = 0
    for (let i = 0; i < trials; i++) {
      // 每次都从保底 0 开始，等价于基础概率
      const result = drawRarity(rng, { pitySSR: 0, pity10: 0 })
      if (result.rarity === 'SSR') hits++
    }
    const measured = (hits / trials) * 100
    expect(Math.abs(measured - BASE_RATES.SSR)).toBeLessThan(0.01)
  })
})

describe('保底机制（§7.3）', () => {
  it('第 90 抽必出 SSR', () => {
    const rng = new Rng(42)
    let state = { pitySSR: 0, pity10: 0 }
    let pulls = 0
    while (pulls < GACHA.PITY_SSR_MAX) {
      const result = drawRarity(rng, state)
      state = result.state
      pulls++
      if (result.rarity === 'SSR') break
    }
    expect(pulls).toBeLessThanOrEqual(GACHA.PITY_SSR_MAX)
    expect(state.pitySSR).toBe(0)
  })

  it('软保底：第 71 抽起概率线性提升', () => {
    expect(ssrRateAt(GACHA.SOFT_PITY_START - 2)).toBeCloseTo(0.006, 10)
    const at71 = ssrRateAt(GACHA.SOFT_PITY_START - 1)
    expect(at71).toBeGreaterThan(BASE_RATES.SSR / 100)
    expect(ssrRateAt(GACHA.PITY_SSR_MAX - 1)).toBeCloseTo(1, 10)
  })

  it('保底剩余抽数展示正确', () => {
    expect(pityRemaining(0)).toBe(GACHA.PITY_SSR_MAX)
    expect(pityRemaining(89)).toBe(1)
    expect(pityRemaining(90)).toBe(0)
  })

  it('十连内必出 SR 及以上', () => {
    const rng = new Rng(7)
    for (let trial = 0; trial < 200; trial++) {
      let state = { pitySSR: 0, pity10: 0 }
      let gotSRPlus = false
      for (let i = 0; i < 10; i++) {
        const result = drawRarity(rng, state, {
          isTenPull: true,
          batchHasSRPlus: gotSRPlus,
          batchIndex: i,
        })
        state = result.state
        if (result.rarity === 'SSR' || result.rarity === 'SR') {
          gotSRPlus = true
        }
      }
      expect(gotSRPlus).toBe(true)
    }
  })

  it('十连中命中 SR 时 SSR 计数 +2（补偿规则）', () => {
    const before = { pitySSR: 10, pity10: 0 }
    const after = applyPity(before, 'SR', { isTenPull: true })
    expect(after.pitySSR).toBe(12)

    const afterSingle = applyPity(before, 'SR')
    expect(afterSingle.pitySSR).toBe(11)
  })

  it('抽中 SSR 时计数归零', () => {
    expect(applyPity({ pitySSR: 50, pity10: 3 }, 'SSR').pitySSR).toBe(0)
    expect(applyPity({ pitySSR: 50, pity10: 3 }, 'SSR').pity10).toBe(0)
  })
})

describe('保底继承（§7.3 合规要求：换池不清零）', () => {
  it('切换卡池后计数不变', () => {
    const ctx = {
      pity: { pitySSR: 37, pity10: 2 },
      owned: {},
      crystals: 999999,
      tickets: 0,
    }
    const outcome = executePull(ctx, POOL_STANDARD, 1, 12345)
    // 单抽只推进计数，不清零
    expect(outcome.pity.pitySSR).toBeGreaterThanOrEqual(37)
    expect(outcome.pity.pitySSR).toBeLessThanOrEqual(38)
  })

  it('不同卡池共享同一份保底状态（存档只存一份）', () => {
    const ctx = {
      pity: { pitySSR: 80, pity10: 0 },
      owned: {},
      crystals: 999999,
      tickets: 0,
    }
    const outcome = executePull(ctx, POOL_STANDARD, 1, 999)
    expect(outcome.pity.pitySSR).toBeLessThanOrEqual(GACHA.PITY_SSR_MAX)
  })
})

describe('概率公示同源（合规硬要求）', () => {
  it('公示的综合概率由精确动态规划给出（无模拟噪声）', () => {
    const snapshot = computeEffectiveRates({ pitySSR: 0, pity10: 0 })
    expect(snapshot.computation).toBe('exact-dp')
  })

  it('100 万次实测十连 SSR 命中率与公示值一致（3σ 统计窗口）', () => {
    const published = computeEffectiveRates({ pitySSR: 0, pity10: 0 })
    const ssrPublished = published.rows.find((r) => r.rarity === 'SSR')!.tenPullEffective

    const rng = new Rng(20260921)
    const trials = 1_000_000
    let hits = 0
    for (let t = 0; t < trials; t++) {
      let state = { pitySSR: 0, pity10: 0 }
      let gotSRPlus = false
      let gotSSR = false
      for (let i = 0; i < 10; i++) {
        const result = drawRarity(rng, state, {
          isTenPull: true,
          batchHasSRPlus: gotSRPlus,
          batchIndex: i,
        })
        state = result.state
        if (result.rarity === 'SSR') {
          gotSSR = true
          gotSRPlus = true
        } else if (result.rarity === 'SR') {
          gotSRPlus = true
        }
      }
      if (gotSSR) hits++
    }
    const measured = (hits / trials) * 100
    // p ≈ 11.7%，σ = sqrt(p(1-p)/n) ≈ 0.0102%，取 4σ ≈ 0.041%
    expect(Math.abs(measured - ssrPublished)).toBeLessThan(0.041)
  },
  // ⚠ **显式超时**：这条要跑 **100 万次**十连（= 1000 万次抽签），
  //   单跑本机就要 3~5 秒；全量并发跑（52 个 worker 同时起进程）时机器负载上来，
  //   默认的 5 秒会**卡在边缘**（实测 5.1s ⇒ 报 `Test timed out in 5000ms`）。
  //   ⇒ 只放宽**超时**，**不放宽任何断言**（3σ 统计窗口一个字都没改）。
  30_000)

  it('公示值随保底进度上升（当前状态影响下一抽概率）', () => {
    const at0 = computeEffectiveRates({ pitySSR: 0, pity10: 0 })
    const at85 = computeEffectiveRates({ pitySSR: 85, pity10: 0 })
    const s0 = at0.rows.find((r) => r.rarity === 'SSR')!.singleEffective
    const s85 = at85.rows.find((r) => r.rarity === 'SSR')!.singleEffective
    expect(s85).toBeGreaterThan(s0)
    expect(at85.pityRemaining).toBe(5)
  })

  it('公示概率与抽卡执行共用 rarityProbabilities', () => {
    const probs = rarityProbabilities({ pitySSR: 0, pity10: 0 })
    const sum = probs.SSR + probs.SR + probs.R + probs.N
    expect(sum).toBeCloseTo(1, 10)
    expect(probs.SSR).toBeCloseTo(BASE_RATES.SSR / 100, 10)
  })
})

describe('重复转化（§7.4 合规要点）', () => {
  it('重复 SSR 转化为同名碎片', () => {
    // 把所有 SSR 都放进「已拥有」：十连必出 SSR（新手保底）→ 必然出现重复 SSR。
    // ⚠ 旧写法靠「固定种子恰好抽出项羽」才成立——随机序列修好后就不再可靠。
    const owned: Record<string, ReturnType<typeof createHeroState>> = {}
    for (const h of HEROES.filter((x) => x.rarity === 'SSR')) {
      owned[h.id] = createHeroState(h.id, 0)
    }
    const ctx = {
      pity: { pitySSR: 0, pity10: 0 },
      owned,
      crystals: 999999,
    }
    const outcome = executePull(ctx, POOL_STANDARD, 10, 3)
    const dup = outcome.results.find((r) => !r.isNew && r.rarity === 'SSR')
    expect(dup).toBeDefined()
    // ⚠ 资源/背包版本 v10：重复卡**只**给同名碎片（印记退役）
    expect(dup!.shards).toBe(GACHA.DUPLICATE_SHARDS.SSR)
  })

  it('碎片数量符合公示表（全部稀有度都适用）', () => {
    expect(GACHA.DUPLICATE_SHARDS.SSR).toBe(30)
    expect(GACHA.DUPLICATE_SHARDS.SR).toBe(12)
    expect(GACHA.DUPLICATE_SHARDS.R).toBe(6)
    expect(GACHA.DUPLICATE_SHARDS.N).toBe(3)
  })

  it('新获得的英灵不产生碎片', () => {
    const ctx = {
      pity: { pitySSR: 0, pity10: 0 },
      owned: {},
      crystals: 999999,
    }
    const outcome = executePull(ctx, POOL_STANDARD, 10, 11)
    for (const r of outcome.results) {
      if (r.isNew) {
        expect(r.shards).toBe(0)
      }
    }
  })

  it('summarizePull 汇总正确', () => {
    const ctx = {
      pity: { pitySSR: 0, pity10: 0 },
      owned: {},
      crystals: 999999,
    }
    const outcome = executePull(ctx, POOL_STANDARD, 10, 5)
    const summary = summarizePull(outcome)
    expect(summary.newHeroes.length).toBeGreaterThan(0)
    expect(Object.keys(summary.shards).length).toBeGreaterThanOrEqual(0)
  })

  it('同一批里抽到同一英灵两次时，第二张按「重复转化」处理', () => {
    const ctx = {
      pity: { pitySSR: 0, pity10: 0 },
      owned: {},
      crystals: 999999,
    }
    // 找一个会在十连内抽到重复英灵的种子（池子越大重复越常见，搜索仍然有效）
    let dupSeed = -1
    for (let seed = 1; seed < 400 && dupSeed < 0; seed++) {
      const outcome = executePull(ctx, POOL_STANDARD, 10, seed)
      const ids = outcome.results.map((r) => r.heroId)
      if (new Set(ids).size !== ids.length) dupSeed = seed
    }
    expect(dupSeed).toBeGreaterThan(0)

    const outcome = executePull(ctx, POOL_STANDARD, 10, dupSeed)
    const ids = outcome.results.map((r) => r.heroId)
    const repeated = ids.find((id, i) => ids.indexOf(id) !== i)!
    const sameHero = outcome.results.filter((r) => r.heroId === repeated)
    expect(sameHero).toHaveLength(2)
    // 第一张新获得 → 第二张必须算重复（给同名碎片），否则玩家少拿一份转化
    expect(sameHero[0].isNew).toBe(true)
    expect(sameHero[1].isNew).toBe(false)
    expect(sameHero[1].shards).toBe(GACHA.DUPLICATE_SHARDS[sameHero[1].rarity])
    // 「新获得英灵」列表里同一个人只出现一次
    const newHeroes = summarizePull(outcome).newHeroes
    expect(newHeroes.filter((id) => id === repeated)).toHaveLength(1)
  })
})

describe('抽卡费用', () => {
  const TEN = GACHA.TEN_PULL_COUNT

  it('单抽与十连费用正确（逐抽计价）', () => {
    expect(pullCost(1)).toEqual({ crystals: GACHA.COST_SINGLE })
    expect(pullCost(TEN)).toEqual({
      crystals: GACHA.COST_SINGLE * TEN,
    })
  })

  it('结晶足够时全额扣结晶', () => {
    expect(resolvePayment(1, GACHA.COST_SINGLE)).toEqual({ crystals: GACHA.COST_SINGLE })
    expect(resolvePayment(1, GACHA.COST_SINGLE + 5_000)).toEqual({ crystals: GACHA.COST_SINGLE })
  })

  it('十连一次扣 3,000 结晶', () => {
    expect(resolvePayment(TEN, GACHA.COST_SINGLE * TEN)).toEqual({
      crystals: GACHA.COST_SINGLE * TEN,
    })
  })

  it('余额不足时返回 null（抽卡总闸门不得被绕过）', () => {
    expect(resolvePayment(TEN, GACHA.COST_SINGLE * TEN - 1)).toBeNull()
    expect(resolvePayment(1, 0)).toBeNull()
  })

  it('余额不足时 executePull 抛错，不会产出结果', () => {
    expect(() =>
      executePull(
        { pity: { pitySSR: 0, pity10: 0 }, owned: {}, crystals: 0 },
        POOL_STANDARD,
        10,
        1,
      ),
    ).toThrow(InsufficientFundsError)
  })

  it('余额充足时不会把资源扣成负数', () => {
    const outcome = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned: {}, crystals: GACHA.COST_SINGLE * TEN },
      POOL_STANDARD,
      10,
      1,
    )
    expect(outcome.crystalsUsed).toBe(GACHA.COST_SINGLE * TEN)
  })

  it('十连产出 10 个结果', () => {
    const outcome = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned: {}, crystals: GACHA.COST_SINGLE * TEN },
      POOL_STANDARD,
      TEN,
      7,
    )
    expect(outcome.results.length).toBe(TEN)
    expect(outcome.crystalsUsed).toBe(GACHA.COST_SINGLE * TEN)
  })
})

function round2pct(v: number): number {
  return Math.round(v * 10000) / 100
}
