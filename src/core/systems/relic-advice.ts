/**
 * 遗物一键推荐（§5.4）。
 *
 * 目标：**最大化该英灵的编队战力**——与界面显示的「战力」是同一口径
 * （`resolveStats` + `computePower`，铁律 #2：属性解析单一入口）。
 *
 * 做法是**贪心边际收益**：从空槽开始，每轮挑一件「装上去之后战力最高」的遗物。
 * 因为每次比较都走真实的 `resolveStats`，**套装加成是自动算进去的**——
 * 补齐 2/4/6 件的那一件会让战力跳一级，贪心自然会往成套的方向走，
 * 不需要另写一套「套装优先」的规则（两处各写一套必然对不上）。
 *
 * ⚠ 本模块单独成文件而不是塞进 `relic.ts`：
 *   `relic.ts` 被 `stats.ts` 依赖，反向 import 会形成循环依赖。
 *   这里单向依赖 `stats.ts` / `growth.ts` / `relic.ts`，无环。
 */
import type { HeroRuntime, RelicInstance } from '../model/types.ts'
import { RELIC_SLOT_COUNT } from './loadout.ts'
import { getHeroPassiveMods } from './growth.ts'
import { computePower, resolveStats } from './stats.ts'
import { getHeroSetMods, RELIC_DEFS, RELIC_SETS } from './relic.ts'

export interface RelicAdvice {
  /** 推荐后的 6 个槽位（填不满的位置为 null） */
  slots: (RelicInstance | null)[]
  /** 推荐方案的战力 */
  power: number
  /** 当前配置的战力 */
  currentPower: number
  /** 战力增量（>= 0；贪心偶尔不如手动配置时为 0，此时保留玩家当前配置） */
  gain: number
  /** 推荐方案里各套装的件数：setId → 件数 */
  sets: Record<string, number>
  /** 推荐方案里已激活的套装档位：setId → 已生效的件数档（如 4 表示 4 件套生效） */
  activeTiers: Record<string, number>
}

/** 给定遗物配置下该英灵的编队战力 */
function powerOf(hero: HeroRuntime, relics: (RelicInstance | null)[]): number {
  const rt: HeroRuntime = { ...hero, relics }
  return computePower(
    resolveStats(
      rt,
      { mode: 'pve', seed: 0 },
      { passives: getHeroPassiveMods(rt), setMods: getHeroSetMods(rt) },
    ),
  )
}

/** 各套装件数 */
function countSets(relics: (RelicInstance | null)[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of relics) {
    if (!r) continue
    const def = RELIC_DEFS.get(r.defId)
    if (!def) continue
    out[def.setId] = (out[def.setId] ?? 0) + 1
  }
  return out
}

/**
 * 推荐方案里每个套装**已生效的最高档位**（2 / 4 / 6），未生效为 0。
 *
 * 套装档位按 `RELIC_SETS[].bonuses` 的 `pieces` 判定（不硬编码 2/4/6，
 * 套装配置改了这里自动跟着改）。
 */
export function activeSetTiers(slots: (RelicInstance | null)[]): Record<string, number> {
  const counts = countSets(slots)
  const out: Record<string, number> = {}
  for (const [setId, count] of Object.entries(counts)) {
    const set = RELIC_SETS.get(setId)
    if (!set) continue
    let tier = 0
    for (const bonus of set.bonuses) {
      if (count >= bonus.pieces) tier = Math.max(tier, bonus.pieces)
    }
    out[setId] = tier
  }
  return out
}

/**
 * 为某英灵推荐一套遗物。
 *
 * @param hero      该英灵的运行时对象（属性基准：等级 / 星级 / 境界）
 * @param candidates 候选遗物（**不包含**装备在其他英灵身上的那些——
 *                  一键推荐不抢占别人的装备，候选池由调用方筛好）
 * @param current   该英灵当前装备的遗物（用于算战力增量与兜底）
 */
export function recommendRelicLoadout(
  hero: HeroRuntime,
  candidates: readonly RelicInstance[],
  current: readonly (RelicInstance | null)[],
): RelicAdvice {
  const currentSlots: (RelicInstance | null)[] = Array.from(
    { length: RELIC_SLOT_COUNT },
    (_, i) => current[i] ?? null,
  )
  const currentPower = powerOf(hero, currentSlots)

  // 贪心：从空槽开始，每轮挑一件让战力最高的遗物
  const chosen: (RelicInstance | null)[] = new Array(RELIC_SLOT_COUNT).fill(null)
  const used = new Set<string>()
  for (let slot = 0; slot < RELIC_SLOT_COUNT; slot++) {
    let best: RelicInstance | null = null
    let bestPower = -1
    for (const r of candidates) {
      if (used.has(r.uid)) continue
      const trial = chosen.slice()
      trial[slot] = r
      const p = powerOf(hero, trial)
      if (p > bestPower) {
        bestPower = p
        best = r
      }
    }
    if (!best) break
    chosen[slot] = best
    used.add(best.uid)
  }

  const greedyPower = powerOf(hero, chosen)

  // 兜底：贪心偶尔不如玩家手动配置（套装组合很刁钻时），此时保留玩家当前配置
  const slots = greedyPower >= currentPower ? chosen : currentSlots
  const power = Math.max(greedyPower, currentPower)

  return {
    slots,
    power,
    currentPower,
    gain: power - currentPower,
    sets: countSets(slots),
    activeTiers: activeSetTiers(slots),
  }
}
