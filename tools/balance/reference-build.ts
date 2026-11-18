/**
 * 参考养成（reference build）——某个等级下的「标准队伍」。
 *
 * ⚠ 为什么要有这个模块：
 *   难度曲线标定（§6.5）与守护它的单测（tests/unit/stage-balance.test.ts）
 *   必须用**同一支队伍**，否则「门槛 = 玩家刚好打得赢时的战力」这条断言
 *   两边算的不是同一个数（铁律 #4 单一数据源）。
 *   以前这套构造写在测试文件里，标定脚本只能各写一份——数值一改就分叉。
 *
 * 队伍构造口径（沿用 tools/balance/simulate.ts 的既有约定）：
 *   - 阵容：6 名 SSR（标准名单的前 6 位），按定位排前后排；
 *   - 星级 / 技能等级 / 遗物强化等级：按等级在 PROFILES 之间线性插值。
 *
 * ⚠ 这不是「玩家队伍」：真实玩家的卡池出身、遗物与养成顺序都不同。
 *   它是**难度标定的公共基准**——标定与守护必须用同一把尺。
 */
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { preferredSlotForRole } from '../../src/core/systems/team.ts'
import { generateRelic, makeRelicUid } from '../../src/core/systems/relic.ts'
import { Rng } from '../../src/core/rng.ts'
import type { HeroRuntime, HeroState } from '../../src/core/model/types.ts'
import '../../src/core/config/relics.ts'

/** [等级, 星级, 技能等级, 遗物强化等级] */
export const REFERENCE_PROFILES: Array<[number, number, number, number]> = [
  [1, 1, 1, 1],
  [30, 2, 5, 10],
  [60, 3, 10, 25],
  [90, 3, 12, 32],
  [120, 4, 15, 40],
  [150, 4, 16, 45],
  [180, 5, 18, 50],
  [210, 5, 19, 55],
  [240, 6, 20, 60],
]

/** 参考遗物的固定种子（标定脚本与单测必须一致，否则战力对不上） */
export const REFERENCE_SEED = 20261110

/** 按等级插值出 [星级, 技能等级, 遗物强化等级] */
export function referenceGearAt(level: number): [number, number, number] {
  if (level <= REFERENCE_PROFILES[0][0]) {
    const [, star, skill, relic] = REFERENCE_PROFILES[0]
    return [star, skill, relic]
  }
  for (let i = 0; i < REFERENCE_PROFILES.length - 1; i++) {
    const lo = REFERENCE_PROFILES[i]
    const hi = REFERENCE_PROFILES[i + 1]
    if (level >= lo[0] && level <= hi[0]) {
      const t = (level - lo[0]) / (hi[0] - lo[0])
      const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
      return [mix(lo[1], hi[1]), mix(lo[2], hi[2]), mix(lo[3], hi[3])]
    }
  }
  const last = REFERENCE_PROFILES[REFERENCE_PROFILES.length - 1]
  return [last[1], last[2], last[3]]
}

/** 构造某等级下的参考队伍（6 人满编，按定位前后排各 3 人） */
export function referenceTeam(level: number, seed: number = REFERENCE_SEED): HeroRuntime[] {
  const [star, skill, relic] = referenceGearAt(level)
  const rng = new Rng(seed)
  const roster = HEROES.filter((h) => h.rarity === 'SSR').slice(0, 6)
  const front = roster.filter((h) => preferredSlotForRole(h.role) === 'front')
  const back = roster.filter((h) => preferredSlotForRole(h.role) === 'back')
  const frontLine = [...front, ...back].slice(0, 3)
  const backLine = [...back, ...front].filter((h) => !frontLine.includes(h)).slice(0, 3)
  let relicSeq = 0
  return [...frontLine, ...backLine].map((def, slot) => {
    const state: HeroState = {
      id: def.id,
      level,
      exp: 0,
      star,
      skillLevels: [skill, skill, skill],
      shards: 0,
      coreAwakened: star >= 4,
      obtainedAt: 0,
    }
    const setId = def.relicAffinity[0]
    const relics = Array.from({ length: 6 }, (_, i) => {
      relicSeq += 1
      return generateRelic(`${setId}_${(i % 5) + 1}`, rng, relic, makeRelicUid(relicSeq))
    })
    return { def, state, relics, slot }
  })
}
