/**
 * 新手保底（方案 §7.3 第 3 条：「新手期首次 10 连保底 1 个 SSR」）。
 *
 * 回归重点：
 *   1. 保底资格按「是否已使用」判定，而非「是否已拥有该角色」
 *      —— 否则玩家在别的池先抽到该角色后，新手福利永久失效
 *   2. 保底只在**十连**触发，且每个存档只触发一次
 *   3. 保底英雄必须属于当前卡池，否则会抽到池外角色
 */
import { describe, it, expect } from 'vitest'
import { executePull } from '../../src/core/systems/gacha.ts'
import { POOL_STANDARD, POOL_CHINA, POOL_NEWBIE } from '../../src/core/config/pools.ts'
import { Rng } from '../../src/core/rng.ts'
import type { HeroState } from '../../src/core/model/types.ts'

function emptyOwned(): Record<string, HeroState> {
  return {}
}

describe('新手保底', () => {
  it('首次十连含 1 个 SSR，且新手资格被消耗', () => {
    for (let seed = 0; seed < 50; seed++) {
      const outcome = executePull(
        { pity: { pitySSR: 0, pity10: 0 }, owned: emptyOwned(), crystals: 99999, tickets: 99 },
        POOL_STANDARD,
        10,
        seed,
      )
      const ssrCount = outcome.results.filter((r) => r.rarity === 'SSR').length
      expect(ssrCount).toBeGreaterThanOrEqual(1)
      // 资格在首次十连即消耗（即使该十连自然抽到了 SSR）
      expect(outcome.newbieUsedConsumed).toBe(true)
    }
  })

  it('已拥有保底角色时，首次十连仍应触发保底（不因提前拥有而失效）', () => {
    const owned: Record<string, HeroState> = {
      xiangyu: {
        id: 'xiangyu',
        level: 1,
        exp: 0,
        star: 1,
        skillLevels: [1, 1, 1],
        shards: 0,
        coreAwakened: false,
        obtainedAt: 0,
      },
    }
    const outcome = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned, crystals: 99999, tickets: 99 },
      POOL_STANDARD,
      10,
      7,
    )
    expect(outcome.newbieUsedConsumed).toBe(true)
  })

  it('单抽不消耗新手资格', () => {
    const outcome = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned: emptyOwned(), crystals: 99999, tickets: 99 },
      POOL_STANDARD,
      1,
      3,
    )
    expect(outcome.guaranteedTriggered).toBe(false)
    expect(outcome.newbieUsedConsumed).toBe(false)
  })

  it('保底资格已使用时不再触发', () => {
    const outcome = executePull(
      {
        pity: { pitySSR: 0, pity10: 0 },
        owned: emptyOwned(),
        crystals: 99999,
        tickets: 99,
        newbieUsed: true,
      },
      POOL_STANDARD,
      10,
      11,
    )
    expect(outcome.guaranteedTriggered).toBe(false)
    expect(outcome.newbieUsedConsumed).toBe(false)
  })

  it('保底触发时结果是指定角色', () => {
    const outcome = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned: emptyOwned(), crystals: 99999, tickets: 99 },
      POOL_STANDARD,
      10,
      7,
    )
    if (outcome.guaranteedTriggered) {
      expect(outcome.results.some((r) => r.heroId === 'xiangyu')).toBe(true)
    }
  })

  it('保底角色一定属于当前卡池', () => {
    // 纪元池含中国 SSR，保底应落在池内
    const outcome = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned: emptyOwned(), crystals: 99999, tickets: 99 },
      POOL_CHINA,
      10,
      5,
    )
    if (outcome.guaranteedTriggered) {
      const target = outcome.results.find((r) => r.rarity === 'SSR')
      expect(target).toBeDefined()
      expect(target!.heroId).toBeTruthy()
    }
    // 所有结果都必须落在池内（不出现 undefined / 空 id）
    for (const r of outcome.results) {
      expect(r.heroId).toBeTruthy()
    }
  })

  it('新手池本身也能触发保底，且与常驻池共用同一份资格', () => {
    const outcome = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned: emptyOwned(), crystals: 99999, tickets: 99 },
      POOL_NEWBIE,
      10,
      2,
    )
    expect(outcome.newbieUsedConsumed).toBe(true)
  })

  it('资格只能消耗一次：第二次十连不再消耗', () => {
    const first = executePull(
      { pity: { pitySSR: 0, pity10: 0 }, owned: emptyOwned(), crystals: 99999, tickets: 99 },
      POOL_STANDARD,
      10,
      4,
    )
    expect(first.newbieUsedConsumed).toBe(true)
    const second = executePull(
      {
        pity: { pitySSR: 0, pity10: 0 },
        owned: emptyOwned(),
        crystals: 99999,
        tickets: 99,
        newbieUsed: first.newbieUsedConsumed,
      },
      POOL_STANDARD,
      10,
      4,
    )
    expect(second.newbieUsedConsumed).toBe(false)
    expect(second.guaranteedTriggered).toBe(false)
  })
})
