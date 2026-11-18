/**
 * 关卡难度与战门槛的**实战**守护（§5.8 / §6.5）。
 *
 * ⚠ 为什么要单测真实战斗：`npm run balance` 只比战力数字（computePower vs
 *   powerRequired），**不跑战斗**。历史上第 7~10 章 BOSS 的实战通关率长期为 0%
 *   （配置齐全、机制空转、战力模型却显示「能通关」），只有真跑战斗才能发现。
 *
 * 本文件守护四条不变量：
 *   1. **每章 BOSS 在设计等级下必可通关**（通关率 ≥ 80%）——直接防止「第 7~10 章
 *      BOSS 通关率 0%」这类断层复发。
 *   2. **门槛放行不早于「打得赢」**：门槛是挂机自动推进的放行线，
 *      若门槛低于实际战力需求，挂机会把玩家推进到打不过的关卡 → 打输 →
 *      结算中断 → 玩家零收益卡死。逐章核对「门槛锚点」与「刚能稳过的水平」。
 *   3. **关卡门槛与敌方缩放单调递增**，章边界不倒挂。
 *   4. **末关余量 ≥ 1.5×**（满养成战力 vs 末关门槛）。
 *
 * ⚠ 参考队伍（阵容 / 星级 / 技能 / 遗物）由 tools/balance/reference-build.ts 独家产出，
 *   与 `npm run balance:recalibrate` 的标定口径**完全一致**——
 *   两边算的不是同一支队伍，门槛就会对不上（铁律 #4 单一数据源）。
 */
import { describe, expect, it } from 'vitest'
import { STAGES, getStage } from '../../src/core/config/stages.ts'
import { STAGE } from '../../src/core/config/economy.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { referenceTeam } from '../../tools/balance/reference-build.ts'
import { getTeamPower } from '../../src/core/systems/team.ts'
import { simulateWinRate } from '../../src/core/systems/battle.ts'
import '../../src/core/config/relics.ts'

/**
 * **设计阶梯**：每章 BOSS 的目标等级。
 *
 * ⚠ 这是**设计常数**：每章 24 级 = LEVEL.MAX / CHAPTERS。
 *   章内难度跨度（IN_CHAPTER_SPAN × BOSS_MULTIPLIER = 2.03）就是按它定的
 *   （2.03 = 1.03^24），所以「难度曲线」与「养成速度」是同一件事的两面。
 */
const LADDER = [24, 48, 72, 96, 120, 144, 168, 192, 216, 240]

/**
 * 「刚好打得赢」的等级阶梯（挂机放行门槛对应的等级）。
 *
 * ⚠ 由 `npm run balance:recalibrate` 实测标定得出：
 *   门槛取参考队伍「刚好能以 ≥90% 通关该章 BOSS」那一档的战力。
 *   取设计等级会让末关余量只有 1.0×（门槛 = 满养成战力），违反 ≥1.5× 不变量。
 */
const MIN_LADDER = [10, 27, 57, 63, 99, 134, 155, 176, 194, 222]

const bossStages = STAGES.filter((s) => s.isBoss)

describe('关卡难度：各章 BOSS 实战可通关', () => {
  it('每章 BOSS 在设计等级下必可通关（通关率 ≥ 80%）', () => {
    for (let c = 0; c < bossStages.length; c++) {
      const stage = bossStages[c]
      const heroes = referenceTeam(LADDER[c])
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

  it('门槛放行不早于「打得赢」：门槛点的战力与通关率都对得上', () => {
    for (let c = 0; c < bossStages.length; c++) {
      const stage = bossStages[c]
      const heroes = referenceTeam(MIN_LADDER[c])
      const power = getTeamPower(heroes, { mode: 'pve' })
      // 门槛点 = 参考队伍「刚好打得赢」那一档的战力（1% 容差吞掉取整误差）
      expect(
        Math.abs(power - STAGE.POWER_ANCHORS[c]) / STAGE.POWER_ANCHORS[c],
        `第 ${stage.chapter} 章门槛 ${STAGE.POWER_ANCHORS[c]} 与 Lv${MIN_LADDER[c]} 战力 ${power} 不符`,
      ).toBeLessThan(0.01)
      // 门槛放行线绝不会把机器推进到「打不过」的关卡
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
        `第 ${stage.chapter} 章 BOSS 在门槛点 Lv${MIN_LADDER[c]} 的通关率为 ${(result.winRate * 100).toFixed(0)}%`,
      ).toBeGreaterThanOrEqual(0.75)
    }
  })

  it('跨章门槛与敌方缩放单调递增（章边界不倒挂）', () => {
    for (const stage of bossStages) {
      const first = getStage((stage.chapter - 1) * 31 + 1)
      expect(first.powerRequired).toBeLessThan(stage.powerRequired)
      expect(first.enemyScale).toBeLessThan(stage.enemyScale)
    }
  })

  it('末关余量 ≥ 1.5×（满养成战力 vs 末关门槛）', () => {
    const power = getTeamPower(referenceTeam(240), { mode: 'pve' })
    const margin = power / STAGE.POWER_ANCHORS[STAGE.CHAPTERS - 1]
    expect(margin, `末关余量仅 ${margin.toFixed(2)}×`).toBeGreaterThanOrEqual(1.5)
  })
})
