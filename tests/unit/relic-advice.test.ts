/**
 * 遗物一键推荐 + 套装阶梯加成（§5.4）。
 *
 * 守两件事：
 * 1. **套装 2/4/6 件的阶梯加成真的进属性**（不是只写在配置里）；
 * 2. **一键推荐给出的配置战力不低于玩家当前配置**，且会**利用套装加成**。
 *
 * ⚠ 同 AGENTS.md 铁律 #22 的教训：「配置齐全」≠「功能可用」。
 *   套装效果早就配好了（`config/relics.ts` + `getSetMods`），
 *   但界面**完全没展示**它——玩家不知道「再凑 1 件就能开 4 件套」，
 *   这条养成线等于隐形。
 */
import { describe, expect, it } from 'vitest'
import { recommendRelicLoadout, activeSetTiers } from '../../src/core/systems/relic-advice.ts'
import { getSetMods } from '../../src/core/systems/relic.ts'
import { resolveStats, computePower } from '../../src/core/systems/stats.ts'
import { Rng } from '../../src/core/rng.ts'
import { makeTestRelic, nakedHero } from './helpers.ts'
import type { RelicInstance } from '../../src/core/model/types.ts'
import '../../src/core/config/relics.ts'

/** 战神套 6 件（SSR/SR/R/R/N + 再来一件 SSR） */
function zhanshenSet(level = 60): RelicInstance[] {
  const rng = new Rng(20260117)
  return ['set_zhanshen_1', 'set_zhanshen_2', 'set_zhanshen_3', 'set_zhanshen_4', 'set_zhanshen_5', 'set_zhanshen_1'].map(
    (id) => makeTestRelic(id, rng, level),
  )
}

/** 探破套 4 件 */
function tanpoSet(level = 60): RelicInstance[] {
  const rng = new Rng(88888)
  return ['set_tanpo_1', 'set_tanpo_2', 'set_tanpo_3', 'set_tanpo_4'].map((id) =>
    makeTestRelic(id, rng, level),
  )
}

describe('套装阶梯加成（2 / 4 / 6 件）', () => {
  it('1 件不触发任何档位', () => {
    const pieces = zhanshenSet()
    expect(activeSetTiers(pieces.slice(0, 1))['set_zhanshen']).toBe(0)
  })

  it('件数决定生效档位：2 → 4 → 6', () => {
    const pieces = zhanshenSet()
    expect(activeSetTiers(pieces.slice(0, 2))['set_zhanshen']).toBe(2)
    expect(activeSetTiers(pieces.slice(0, 4))['set_zhanshen']).toBe(4)
    expect(activeSetTiers(pieces.slice(0, 6))['set_zhanshen']).toBe(6)
  })

  it('套装加成真的进 PVE 属性，且档位越高加成越大', () => {
    const hero = nakedHero('xiangyu')
    const ctx = { mode: 'pve' as const, seed: 0 }
    const pieces = zhanshenSet()

    /** 只看「套装加成」带来的攻击差（剥掉单件词条的影响） */
    const setDelta = (n: number) => {
      const relics = pieces.slice(0, n)
      const rt = { ...hero, relics }
      const withSet = resolveStats(rt, ctx, { setMods: getSetMods(relics) }).atk
      const withoutSet = resolveStats(rt, ctx).atk
      return withSet - withoutSet
    }

    expect(setDelta(1)).toBe(0)
    expect(setDelta(2)).toBeGreaterThan(0)
    expect(setDelta(4)).toBeGreaterThan(setDelta(2))
    expect(setDelta(6)).toBeGreaterThan(setDelta(4))
  })
})

describe('遗物一键推荐', () => {
  it('推荐结果的战力不低于玩家当前配置', () => {
    const hero = nakedHero('xiangyu')
    const pool = zhanshenSet()
    const current = pool.slice(0, 1)
    const advice = recommendRelicLoadout(hero, pool, current)
    expect(advice.power).toBeGreaterThanOrEqual(advice.currentPower)
    expect(advice.gain).toBe(advice.power - advice.currentPower)
  })

  it('空候选池时保持玩家当前配置（不乱动）', () => {
    const hero = nakedHero('xiangyu')
    const current = zhanshenSet().slice(0, 2)
    const advice = recommendRelicLoadout(hero, [], current)
    expect(advice.gain).toBe(0)
    // 槽位数组恒为 6 长（未填满的位置是 null），前 N 位应与当前配置一致
    expect(advice.slots.slice(0, current.length).map((r) => r?.uid ?? null)).toEqual(
      current.map((r) => r.uid),
    )
    expect(advice.slots.slice(current.length).every((r) => r === null)).toBe(true)
  })

  it('候选池里只会出现候选遗物（不凭空造件）', () => {
    const hero = nakedHero('xiangyu')
    const pool = zhanshenSet()
    const uids = new Set(pool.map((r) => r.uid))
    const advice = recommendRelicLoadout(hero, pool, [])
    for (const r of advice.slots) {
      if (r) expect(uids.has(r.uid)).toBe(true)
    }
  })

  it('会挑更强的遗物：满强化 SSR 胜过 1 级白装', () => {
    const hero = nakedHero('xiangyu')
    const rng = new Rng(7)
    const weak = makeTestRelic('set_jiangtun_5', rng, 1)
    const strong = makeTestRelic('set_zhanshen_1', rng, 60)
    const advice = recommendRelicLoadout(hero, [weak, strong], [])
    expect(advice.slots[0]?.uid).toBe(strong.uid)
  })

  it('会利用套装加成：优先把同一套装凑成 4 件套，而不是拆开', () => {
    const hero = nakedHero('xiangyu')
    // 4 件战神 + 4 件探破，共 8 件候选，只有 6 个槽位
    const pool = [...zhanshenSet(), ...tanpoSet()]
    const advice = recommendRelicLoadout(hero, pool, [])
    const tiers = advice.activeTiers
    // 至少有一套凑到了 4 件档（而不是 3+3 各不成套）
    expect(Math.max(tiers['set_zhanshen'] ?? 0, tiers['set_tanpo'] ?? 0)).toBeGreaterThanOrEqual(4)
    // 推荐确实比「随便摊开」更强
    const spread = [...zhanshenSet().slice(0, 3), ...tanpoSet().slice(0, 3)]
    const spreadPower = computePower(
      resolveStats({ ...hero, relics: spread }, { mode: 'pve', seed: 0 }, { setMods: getSetMods(spread) }),
    )
    expect(advice.power).toBeGreaterThanOrEqual(spreadPower)
  })

  it('推荐是确定性的（同样输入给出同样结果）', () => {
    const hero = nakedHero('xiangyu')
    const pool = [...zhanshenSet(), ...tanpoSet()]
    const a = recommendRelicLoadout(hero, pool, [])
    const b = recommendRelicLoadout(hero, pool, [])
    expect(a.slots.map((r) => r?.uid ?? null)).toEqual(b.slots.map((r) => r?.uid ?? null))
    expect(a.power).toBe(b.power)
  })
})
