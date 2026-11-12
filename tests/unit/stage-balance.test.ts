/**
 * 关卡难度与战门槛的**实战**守护（§5.8 / §6.5）。
 *
 * ⚠ 为什么要单测真实战斗：`npm run balance` 只比战力数字（computePower vs
 *   powerRequired），**不跑战斗**。历史上第 7~10 章 BOSS 的实战通关率长期为 0%
 *   （配置齐全、机制空转、战力模型却显示「能通关」），只有真跑战斗才能发现。
 *
 * 本文件守护三条不变量：
 *   1. **各章 BOSS 在该章玩家水平下可通关**（通关率 ≥ 80%）——直接防止「第 7~10 章
 *      BOSS 通关率 0%」这类断层复发。
 *   2. **门槛放行不早于「打得赢」**：门槛是挂机自动推进的放行线，
 *      若门槛低于实际战力需求，挂机会把玩家推进到打不过的关卡 → 打输 →
 *      结算中断 → 玩家零收益卡死。逐章核对「门槛锚点」与「刚能稳过的水平」。
 *   3. **关卡门槛与敌方缩放单调递增**，章边界不倒挂。
 */
import { describe, expect, it } from 'vitest'
import { STAGES, getStage } from '../../src/core/config/stages.ts'
import { STAGE } from '../../src/core/config/economy.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { generateRelic } from '../../src/core/systems/relic.ts'
import { getTeamPower, preferredSlotForRole } from '../../src/core/systems/team.ts'
import { simulateWinRate } from '../../src/core/systems/battle.ts'
import { Rng } from '../../src/core/rng.ts'
import type { HeroRuntime, HeroState } from '../../src/core/model/types.ts'
import '../../src/core/config/relics.ts'

/** 满编 SSR 队伍（标定用的标准队伍） */
const ROSTER = HEROES.filter((h) => h.rarity === 'SSR').slice(0, 6)

/** 养成档位：[等级, 星级, 技能等级, 遗物强化等级]（与 tools/balance/simulate.ts 一致） */
const PROFILES: Array<[number, number, number, number]> = [
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

/** 经验投放模型推出的玩家等级阶梯（章末水平） */
const LADDER = [10, 31, 62, 78, 108, 133, 164, 193, 225, 240]

/** 「刚能稳过该章 BOSS」的最低等级（门槛锚点即该等级对应的战力） */
const MIN_LADDER = [1, 15, 45, 57, 77, 105, 140, 177, 207, 225]

function gearAt(level: number): [number, number, number] {
  if (level <= PROFILES[0][0]) return [PROFILES[0][1], PROFILES[0][2], PROFILES[0][3]]
  for (let i = 0; i < PROFILES.length - 1; i++) {
    if (level >= PROFILES[i][0] && level <= PROFILES[i + 1][0]) {
      const lo = PROFILES[i]
      const hi = PROFILES[i + 1]
      const t = (level - lo[0]) / (hi[0] - lo[0])
      const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
      return [mix(lo[1], hi[1]), mix(lo[2], hi[2]), mix(lo[3], hi[3])]
    }
  }
  const last = PROFILES[PROFILES.length - 1]
  return [last[1], last[2], last[3]]
}

function buildTeam(level: number): HeroRuntime[] {
  const [star, skill, relic] = gearAt(level)
  const rng = new Rng(20261110)
  const front = ROSTER.filter((h) => preferredSlotForRole(h.role) === 'front')
  const back = ROSTER.filter((h) => preferredSlotForRole(h.role) === 'back')
  const frontLine = [...front, ...back].slice(0, 3)
  const backLine = [...back, ...front].filter((h) => !frontLine.includes(h)).slice(0, 3)
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
    const relics = Array.from({ length: 6 }, (_, i) =>
      generateRelic(`${setId}_${(i % 5) + 1}`, rng, relic),
    )
    return { def, state, relics, slot }
  })
}

const bossStages = STAGES.filter((s) => s.isBoss)

describe('关卡难度：各章 BOSS 实战可通关', () => {
  it('每章 BOSS 在该章玩家水平下通关率 ≥ 80%', () => {
    for (let c = 0; c < bossStages.length; c++) {
      const stage = bossStages[c]
      const heroes = buildTeam(LADDER[c])
      const result = simulateWinRate(
        {
          allies: heroes,
          enemies: [getEnemy(stage.enemyIds[0])],
          enemyScale: stage.enemyScale,
          ctx: { mode: 'pve' },
        },
        12,
      )
      expect(
        result.winRate,
        `第 ${stage.chapter} 章 BOSS 在 Lv${LADDER[c]} 的通关率为 ${(result.winRate * 100).toFixed(0)}%`,
      ).toBeGreaterThanOrEqual(0.8)
    }
  })

  it('门槛放行线不早于「打得赢」：门槛锚点对应的水平即可通关该章 BOSS', () => {
    for (let c = 0; c < bossStages.length; c++) {
      const stage = bossStages[c]
      const heroes = buildTeam(MIN_LADDER[c])
      const power = getTeamPower(heroes, { mode: 'pve' })
      // 门槛锚点 = 该水平下的战力（容差 1% 取整误差）
      expect(
        Math.abs(power - STAGE.POWER_ANCHORS[c]) / STAGE.POWER_ANCHORS[c],
        `第 ${stage.chapter} 章门槛锚点 ${STAGE.POWER_ANCHORS[c]} 与 Lv${MIN_LADDER[c]} 战力 ${power} 不符`,
      ).toBeLessThan(0.05)
      // 放行那一刻就能打 → 挂机不会推进到打不过的关卡
      const result = simulateWinRate(
        {
          allies: heroes,
          enemies: [getEnemy(stage.enemyIds[0])],
          enemyScale: stage.enemyScale,
          ctx: { mode: 'pve' },
        },
        12,
      )
      expect(
        result.winRate,
        `第 ${stage.chapter} 章 BOSS 在门槛放行水平 Lv${MIN_LADDER[c]} 的通关率为 ${(result.winRate * 100).toFixed(0)}%`,
      ).toBeGreaterThanOrEqual(0.75)
    }
  })

  it('普通关的门槛不超过该章 BOSS 门槛（章内单调）', () => {
    for (const stage of bossStages) {
      const first = getStage((stage.chapter - 1) * 31 + 1)
      expect(first.powerRequired).toBeLessThan(stage.powerRequired)
      expect(first.enemyScale).toBeLessThan(stage.enemyScale)
    }
  })
})
