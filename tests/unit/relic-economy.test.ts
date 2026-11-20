/**
 * 遗物强化的经济口径（实施修正 · roadmap P1-2 后期银两 / 强化石过剩）。
 *
 * 守的是三条**互相咬合**的规则，缺一条就会出现新的「配置齐全 ≠ 功能可用」：
 *
 * 1. **强化价格随等级指数上升**
 *    恒定单位价格 ⇒ 出口总量恒定（36 件 × 60 级 × 500 银两 = 1.06×10⁶），
 *    而银两产出是 2.7×/章 的指数增长 ⇒ 恒定出口永远吸收不了指数产出，必然过剩。
 *    指数价格让「攒了多少银两」直接决定「遗物能推到多少级」。
 *
 * 2. **淬炼段收益递减**
 *    淬炼段是**回收阀门**，不是新的战力来源。若每级仍 +3%，
 *    推到 Lv160 就是 ×4.6 倍遗物倍率，难度曲线会被单方面拉爆。
 *
 * 3. **分解返还 ≤ 累计投入**
 *    「强化到满级再分解」不能变成造币漏洞 —— 旧口径
 *    （500 × 等级 × 稀有度系数）下 SSR 遗物净赚 2.54×。
 *
 * 全部口径取 core 的唯一实现（铁律 #4）：测试里不另写一份价格公式。
 */
import { describe, expect, it } from 'vitest'
import { RELIC } from '../../src/core/config/economy.ts'
import {
  decomposeValue,
  getRelicMods,
  relicMainMultiplier,
  relicTotalCost,
  relicUpgradeCost,
} from '../../src/core/systems/relic.ts'
import { applyAction, type ActionContext } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { Rng } from '../../src/core/rng.ts'
import { makeTestRelic } from './helpers.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000

/** 三档强化石的道具 id（口径取自 RELIC.STONE_TIERS，不写死字符串） */
const TIER1 = RELIC.STONE_TIERS[0].id
const TIER2 = RELIC.STONE_TIERS[1].id
const TIER3 = RELIC.STONE_TIERS[2].id

/** 强化石消耗（按档位拆分的 map）里取某一档的数量 */
function stonesOf(stones: Partial<Record<string, number>>, tierId: string): number {
  return stones[tierId] ?? 0
}

/** 强化石 map 的总量（跨档时逐档累加） */
function sumStones(stones: Partial<Record<string, number>>): number {
  let sum = 0
  for (const n of Object.values(stones)) sum += n ?? 0
  return sum
}

function makeCtx(save: SaveData): { ctx: ActionContext } {
  const rng = new Rng(99)
  return {
    ctx: {
      now: NOW,
      rng,
      randomSeed: () => 12345,
    } as ActionContext,
  }
}

/** 某稀有度的一件 1 级遗物（遗物 id 按套装内序号：1=SSR / 2=SR / 3~4=R / 5=N） */
function relicAt(rarity: 'N' | 'R' | 'SR' | 'SSR', level = 1) {
  const rng = new Rng(7)
  const ids = {
    SSR: 'set_zhanshen_1',
    SR: 'set_zhanshen_2',
    R: 'set_zhanshen_3',
    N: 'set_zhanshen_5',
  } as const
  return makeTestRelic(ids[rarity], rng, level)
}

describe('遗物强化：价格随等级指数上升（回收阀门）', () => {
  it('标准段（Lv ≤ 60）价格恒定——早期经济逐位不变', () => {
    for (let level = RELIC.MIN_LEVEL; level < RELIC.OVER_SEGMENT_START; level++) {
      const cost = relicUpgradeCost(level)!
      expect(cost.silver, `Lv${level} 应仍是基准价`).toBe(RELIC.SILVER_PER_LEVEL)
      // ⚠ 资源/背包版本 v10：强化石分三档，Lv ≤ 60 的目标等级落在初阶
      expect(stonesOf(cost.stones, TIER1), `Lv${level} 应仍是基准价`).toBe(RELIC.STONES_PER_LEVEL)
      expect(sumStones(cost.stones), `Lv${level} 只该消耗一档强化石`).toBe(RELIC.STONES_PER_LEVEL)
    }
  })

  it('淬炼段按指数递增，且与标准段在 Lv61 处连续（不跳价）', () => {
    const lastStandard = relicUpgradeCost(RELIC.OVER_SEGMENT_START - 1)!
    const firstOver = relicUpgradeCost(RELIC.OVER_SEGMENT_START)!
    expect(firstOver.silver).toBe(Math.round(RELIC.SILVER_PER_LEVEL * RELIC.COST_GROWTH))
    expect(lastStandard.silver).toBe(RELIC.SILVER_PER_LEVEL)
    expect(firstOver.silver).toBeGreaterThan(lastStandard.silver)

    let prev = firstOver
    for (let level = RELIC.OVER_SEGMENT_START + 1; level <= 120; level++) {
      const cost = relicUpgradeCost(level)!
      expect(cost.silver, `Lv${level} 的银两价格应高于 Lv${level - 1}`).toBeGreaterThan(prev.silver)
      // ⚠ 强化石价格会取整，早期几级可能持平 → 断言「不下降」而不是「严格递增」
      const prevStones = sumStones(prev.stones)
      const curStones = sumStones(cost.stones)
      expect(curStones, `Lv${level} 的强化石价格不应低于 Lv${level - 1}`).toBeGreaterThanOrEqual(prevStones)
      const overSteps = level - (RELIC.OVER_SEGMENT_START - RELIC.MIN_LEVEL)
      expect(cost.silver).toBe(
        Math.round(RELIC.SILVER_PER_LEVEL * Math.pow(RELIC.COST_GROWTH, overSteps)),
      )
      // Lv61~130 的目标等级落在**中阶**石
      expect(stonesOf(cost.stones, TIER2)).toBe(
        Math.max(1, Math.round(RELIC.STONES_PER_LEVEL * Math.pow(RELIC.STONE_COST_GROWTH, overSteps))),
      )
      prev = cost
    }
  })

  it('累计投入 = 逐级价格之和（与玩家逐级点的账逐位对得上）', () => {
    let silver = 0
    const stones: Record<string, number> = {}
    for (let level = RELIC.MIN_LEVEL; level < 150; level++) {
      const cost = relicUpgradeCost(level)!
      silver += cost.silver
      for (const [id, n] of Object.entries(cost.stones)) {
        stones[id] = (stones[id] ?? 0) + (n ?? 0)
      }
    }
    const total = relicTotalCost(150)
    expect(total.silver).toBe(silver)
    // 逐档累加：Lv1~60 初阶、61~130 中阶、131~149 高阶
    expect(total.stones).toEqual(stones)
    expect(stonesOf(total.stones, TIER1)).toBeGreaterThan(0)
    expect(stonesOf(total.stones, TIER2)).toBeGreaterThan(0)
    expect(stonesOf(total.stones, TIER3)).toBeGreaterThan(0)
  })

  it('强化石的价格底数比银两平缓（石头产出只 1.3×/章，银两 2.7×/章）', () => {
    expect(RELIC.STONE_COST_GROWTH).toBeLessThan(RELIC.COST_GROWTH)
  })

  it('淬炼段的累计投入足够吸收后期的指数产出（出口总量 ≫ 标准段的 1.06×10⁶）', () => {
    // 旧口径的终身出口：36 件 × 59 级 × 500 银两 = 1.06×10⁶
    const oldTotal = 36 * (RELIC.OVER_SEGMENT_START - 1) * RELIC.SILVER_PER_LEVEL
    const newTotal = 36 * relicTotalCost(RELIC.OVER_SEGMENT_START + 100).silver
    expect(newTotal).toBeGreaterThan(oldTotal * 100)
  })
})

describe('遗物强化：淬炼段收益递减（护住难度曲线）', () => {
  it('标准段（Lv ≤ 60）的倍率与旧口径逐位相同', () => {
    // 旧口径：1 + (level - 1) × PCT_PER_LEVEL
    for (const level of [1, 20, 40, 60]) {
      expect(relicMainMultiplier(level)).toBeCloseTo(1 + (level - 1) * RELIC.PCT_PER_LEVEL, 10)
    }
  })

  it('淬炼段每级的增量严格小于标准段', () => {
    const standardStep = relicMainMultiplier(RELIC.OVER_SEGMENT_START) -
      relicMainMultiplier(RELIC.OVER_SEGMENT_START - 1)
    const overStep = relicMainMultiplier(RELIC.OVER_SEGMENT_START + 1) -
      relicMainMultiplier(RELIC.OVER_SEGMENT_START)
    expect(overStep).toBeLessThan(standardStep)
    expect(overStep).toBeCloseTo(RELIC.PCT_PER_LEVEL_OVER, 10)
  })

  it('推到上限的倍率增幅有界（不构成新的战力来源）', () => {
    const at60 = relicMainMultiplier(RELIC.OVER_SEGMENT_START)
    const atMax = relicMainMultiplier(RELIC.MAX_LEVEL)
    expect(atMax / at60).toBeLessThan(1.35)
  })

  it('主词条倍率确实随强化等级上升（界面展示与战斗取同一份）', () => {
    const low = getRelicMods(relicAt('SSR', 10)).map((m) => m.value)
    const high = getRelicMods(relicAt('SSR', 120)).map((m) => m.value)
    expect(high[0]).toBeGreaterThan(low[0])
  })
})

describe('遗物分解：返还不超过累计投入（不是造币漏洞）', () => {
  it('「强化到 L 再分解」的净收益不超过「直接分解」（升级不是造币通道）', () => {
    for (const rarity of ['N', 'R', 'SR', 'SSR'] as const) {
      const base = decomposeValue(relicAt(rarity, 1))
      const baseInvested = relicTotalCost(1)
      for (const level of [1, 2, 10, 60, 120, 200]) {
        const relic = relicAt(rarity, level)
        const back = decomposeValue(relic)
        const invested = relicTotalCost(level)
        expect(
          back.silver - invested.silver,
          `${rarity} Lv${level}：升级后分解的净收益不应高于直接分解`,
        ).toBeLessThanOrEqual(base.silver - baseInvested.silver)
      }
    }
  })

  it('1 级遗物的返还与旧口径一致（低等级经济不受影响）', () => {
    const relic = relicAt('SSR', 1)
    const back = decomposeValue(relic)
    // 旧口径：500 × 1 × 5 × 0.5 = 1250
    expect(back.silver).toBe(1250)
    // ⚠ 资源/背包版本 v10：分解**只返银两**，不返强化石（设计稿 §2）
    expect(back).not.toHaveProperty('stones')
  })

  it('高等级遗物分解是净亏（强化 → 分解不能循环刷资源）', () => {
    const relic = relicAt('SSR', 120)
    const back = decomposeValue(relic)
    const invested = relicTotalCost(120)
    expect(back.silver).toBeLessThan(invested.silver)
  })
})

describe('批量强化：扣费与逐级强化同一口径', () => {
  it('批量强化扣的银两 / 强化石 = 逐级累加', () => {
    const save = createNewSave(NOW)
    const relic = relicAt('SSR', 30)
    save.relics = [relic]
    save.player.silver = 1_000_000_000
    save.items[TIER1] = 1_000_000
    save.items[TIER2] = 1_000_000
    save.items[TIER3] = 1_000_000
    const { ctx } = makeCtx(save)

    const from = relicTotalCost(30)
    const to = relicTotalCost(40)
    const res = applyAction(
      save,
      { type: 'relic.upgradeBatch', uids: [relic.uid], targetLevel: 40 },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(save.player.silver).toBe(1_000_000_000 - (to.silver - from.silver))
    // 逐档扣：30 → 40 全程落在初阶石
    expect(save.items[TIER1]).toBe(1_000_000 - stonesOf(to.stones, TIER1) + stonesOf(from.stones, TIER1))
    expect(save.items[TIER2]).toBe(1_000_000)
    expect(save.items[TIER3]).toBe(1_000_000)
    expect(relic.level).toBe(40)
  })

  it('余额不足时批量强化被拒绝（不产生负数资源）', () => {
    const save = createNewSave(NOW)
    const relic = relicAt('SSR', 100)
    save.relics = [relic]
    save.player.silver = 1
    save.items[TIER2] = 1
    const { ctx } = makeCtx(save)
    const res = applyAction(
      save,
      { type: 'relic.upgradeBatch', uids: [relic.uid], targetLevel: 120 },
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(save.player.silver).toBe(1)
    expect(save.items[TIER2]).toBe(1)
    expect(relic.level).toBe(100)
  })
})
