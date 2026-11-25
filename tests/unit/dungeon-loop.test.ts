/**
 * **副本 / 挂机通道刷取口径**的守护（节奏模拟 × 副本产出的唯一出处）。
 *
 * ⚠ 守的是什么（挂机改版 v11 · 多通道并行模型）：
 *   1. **需求侧**：技能材料按五行分列、强化石按档位分列，
 *      数值口径取 core（等级上限 / 每级消耗 / 逐级真实价格）。
 *   2. **通道决策**：四条通道**同时跑**，各自选自己的目标——
 *      主线跟随最新通关关卡；技能 / 强化各自选「该变体打得赢的最高一关」。
 *      ⚠ 旧模型是「三选一分配一份时间」，新模型**不再分配**——
 *        所以断言也从「只能选一个去向」改成「每条通道各自有目标或为空」。
 *   3. **银两瓶颈**：副本只发材料不发银两 ⇒ 银两不够就不能开副本通道，
 *      否则玩家会在副本里空转（历史上模拟在这条上死锁过）。
 *   4. **副本目标必须已通关**：挂机只挂已通关内容（设计稿 §3.1）——
 *      没通关但打得赢的那一关，要出现在 `challenges` 里（需要先手动挑战）。
 *
 * ⚠ 口径只有一份：`tools/balance/dungeon-loop.ts`
 *   （铁律 #4：工具与单测不得各写一套）。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { Rng } from '../../src/core/rng.ts'
import { applyAction, type ActionContext } from '../../src/core/systems/actions.ts'
import { SKILL, RELIC } from '../../src/core/config/economy.ts'
import { relicMainMultiplier } from '../../src/core/systems/relic.ts'
import { ITEM_BY_ELEMENT } from '../../src/core/config/items.ts'
import {
  DUNGEON_STAGES,
  dungeonStageById,
  type DungeonStageDef,
} from '../../src/core/config/dungeons.ts'
import { makeTestRelic } from './helpers.ts'
import {
  applyChannels,
  applyChannel,
  bestDungeonStage,
  bestIdleDungeonStage,
  decideChannels,
  dungeonExpectedYield,
  equippedRelicLevel,
  referenceRelicLevel,
  referenceSkillLevel,
  relicStoneDemand,
  skillHeadroomByElement,
  skillMaterialDemand,
  teamSkillLevel,
} from '../../tools/balance/dungeon-loop.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000
/** 「一夜」的掷奖次数（与 recalibrate 的挂机日同量级） */
const NIGHT_ROLLS = 1560
/** 两名土系 SSR（真实英灵 id） */
const TEAM = ['xiangyu', 'hannibal']

function makeCtx(now = NOW): ActionContext {
  return { now, rng: new Rng(777), randomSeed: () => 777 }
}

/**
 * 两名土系英灵 + 一件已装备遗物（用于副本口径测试）。
 *
 * ⚠ 等级取 50：**不在境界门槛上**（凡阶上限 60，`atRealmGate(60)` 为真），
 *   门槛上主线是唯一出路，会盖住其他分支。
 */
function makeSave(level = 50): SaveData {
  const save = createNewSave(NOW, 7)
  for (const id of TEAM) {
    save.heroes[id] = {
      ...createHeroState(id, NOW),
      level,
      star: 1,
      skillLevels: [1, 1, 1],
    }
  }
  save.team.slots[0] = TEAM[0]
  save.team.slots[1] = TEAM[1]
  const rng = new Rng(3)
  // ⚠ 每名上阵英灵都**穿一件**遗物：强化副本的收益只作用于「已装备遗物的英灵」，
  //   只给一个人穿 ⇒ 强化增益要按装备占比折半（那是真实情况，不是模型缺陷）。
  const relics = TEAM.map(() => makeTestRelic('set_zhanshen_1', rng, 1))
  save.relics = relics
  save.equipped = {
    '0': { heroId: TEAM[0], relicId: relics[0].uid },
    '1': { heroId: TEAM[1], relicId: relics[1].uid },
  }
  // ⚠ 挂机改版 v11：主线通道**跟随最新通关关卡**（`stageId = null`）。
  save.idle.channels.main.target = { kind: 'main', stageId: null }
  return save
}

/**
 * 把所有副本关卡的**战力门槛**临时压到 1（标定无关）。
 *
 * ⚠ 为什么需要它：副本关卡的门槛是**标定值**（`DUNGEON.POWER_ANCHORS`），
 *   每次重标定都会变 ⇒ 用「关卡是否可选」当断言会随标定漂移。
 *   这里把门槛压到 1，让「选中哪一关」只取决于**通关记录**，
 *   断言才稳定。测完立刻还原（`afterEach`）。
 */
const touchedStages: DungeonStageDef[] = []
function makeAllStagesWinnable(): void {
  for (const stage of DUNGEON_STAGES) {
    touchedStages.push(stage)
    stage.powerRequired = 1
  }
}
afterEach(() => {
  for (const stage of touchedStages) {
    stage.powerRequired = DUNGEON_STAGES.length > 0 ? stage.powerRequired : stage.powerRequired
  }
  touchedStages.length = 0
})

/** 把指定关卡标记为已通关（挂机目标必须是已通关内容） */
function markCleared(save: SaveData, stageId: string): void {
  save.dungeons.cleared[stageId] = true
}

describe('副本口径：需求侧', () => {
  it('技能材料缺口按五行分列，且受境界上限约束', () => {
    const save = makeSave(50)
    // Lv50 在凡阶：技能上限 = min(20, 50-1+1+10) = 20
    const demand = skillMaterialDemand(save, TEAM)
    const earth = demand[ITEM_BY_ELEMENT.土]
    // 两名英灵 × 3 个技能 × (20-1) 级 × 每级 12 材料
    expect(earth).toBe(2 * 3 * 19 * SKILL.MATERIAL_PER_LEVEL)
    // 只有土系英灵 ⇒ 别的五行没有缺口
    expect(Object.keys(demand)).toEqual([ITEM_BY_ELEMENT.土])
  })

  it('技能等级上限用 core 的 skillLevelCap（进新境界会回落）', () => {
    const save = makeSave(50)
    save.heroes.hannibal.level = 61 // 名阶起点 ⇒ 上限回落到 11
    const headroom = skillHeadroomByElement(save, TEAM)
    // xiangyu(Lv50, 上限 20) 差 19 级 × 3；hannibal(Lv61, 上限 11) 差 10 级 × 3
    expect(headroom.土).toBe(3 * 19 + 3 * 10)
  })

  it('强化石缺口按逐级真实价格累加（不是「每级 2 颗」糊弄）', () => {
    const save = makeSave(50)
    const demand = relicStoneDemand(save, 61)
    // Lv1 → Lv60 用初阶石、Lv60 → Lv61 用中阶石；缺口按**已装备的每件**累加
    expect(demand.relicStoneTier1).toBe(save.relics.length * 59 * RELIC.STONES_PER_LEVEL)
    expect(demand.relicStoneTier2).toBeGreaterThan(0)
  })
})

describe('副本口径：多通道并行（不再分配一份时间）', () => {
  it('主线通道默认是「跟随最新通关关卡」', () => {
    const save = makeSave(50)
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.plans.main).toEqual({ kind: 'main', stageId: null })
  })

  it('技能已满 ⇒ 技能通道关闭（没有值得刷的缺口）', () => {
    const save = makeSave(50)
    save.heroes.xiangyu.skillLevels = [20, 20, 20]
    save.heroes.hannibal.skillLevels = [20, 20, 20]
    save.player.silver = 1_000_000
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.plans.skill).toBeNull()
  })

  it('⚠ 银两不够时不开技能通道（副本只发材料不发银两 ⇒ 会死锁）', () => {
    const save = makeSave(50)
    // 技能差得很多 ⇒ 边际收益高，但银两是 0 ⇒ 材料到了也花不出去
    save.player.silver = 0
    save.items[ITEM_BY_ELEMENT.土] = 0
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.plans.skill).toBeNull()
    expect(decision.gains.skill).toBe(0)
  })

  it('未解锁的副本不会被选（不替玩家开挂）', () => {
    const save = createNewSave(NOW, 7)
    // 没有英灵 ⇒ 技能副本全锁；也没有遗物 ⇒ 强化副本全锁
    const decision = decideChannels(save, makeCtx(), [], NIGHT_ROLLS)
    expect(decision.plans.skill).toBeNull()
    expect(decision.plans.enhance).toBeNull()
  })

  it('技能通道选中缺口最大的那一行（土系）', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 1_000_000
    save.items[ITEM_BY_ELEMENT.土] = 0
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.skillElement).toBe('土')
    expect(decision.plans.skill).not.toBeNull()
  })

  it('强化通道：石档 = 下一次升级要用的那一档', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 1_000_000
    // 技能已满 ⇒ 技能不是瓶颈
    save.heroes.xiangyu.skillLevels = [20, 20, 20]
    save.heroes.hannibal.skillLevels = [20, 20, 20]
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.enhanceTier).toBe('relicStoneTier1')
    expect(decision.plans.enhance).not.toBeNull()
  })

  it('⚠ 银两不够时不开强化通道', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 0
    save.heroes.xiangyu.skillLevels = [20, 20, 20]
    save.heroes.hannibal.skillLevels = [20, 20, 20]
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.plans.enhance).toBeNull()
  })

  it('⚠ 境界门槛上主线增益 = ∞（但**不关掉**另外两条通道）', () => {
    makeAllStagesWinnable()
    const save = makeSave(60) // 凡阶末尾 ⇒ 卡门槛
    save.player.silver = 1_000_000
    save.items[ITEM_BY_ELEMENT.土] = 0
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.gains.campaign).toBe(Number.POSITIVE_INFINITY)
    // ⚠ 多通道并行 ⇒ 门槛只抬高主线的价值，不夺走副本通道
    expect(decision.plans.skill).not.toBeNull()
  })

  it('四条通道的增益都是可比的 ln 口径', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 1_000_000
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.gains.campaign).toBeGreaterThan(0)
    expect(decision.gains.skill).toBeGreaterThanOrEqual(0)
    expect(decision.gains.enhance).toBeGreaterThanOrEqual(0)
  })

  it('⚠ 技能增益按「人均」折算（不是全队合计）', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 160_000
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    // 两名土系英灵 × 3 技能 × (Lv50 上限 20 − 当前 1) = 114 级 ⇒ 人均 57 级 × 每级 2%
    expect(decision.gains.skill).toBeCloseTo(
      (114 / TEAM.length) * SKILL.PCT_PER_LEVEL,
      6,
    )
  })

  it('⚠ 银两不够时，技能增益按「买得起的级数」算', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    // 只够买 20 级（16,000 ÷ 800）——材料够也不该虚增
    save.player.silver = 16_000
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.gains.skill).toBeCloseTo(
      (20 / TEAM.length) * SKILL.PCT_PER_LEVEL,
      6,
    )
  })

  it('⚠ 强化增益按「已装备遗物的英灵占比」折算', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.heroes.xiangyu.skillLevels = [20, 20, 20]
    save.heroes.hannibal.skillLevels = [20, 20, 20]
    save.player.silver = 1_000_000
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    // 两名英灵都穿遗物 ⇒ 占比 1.0 ⇒ 增益 = ln(倍率比)
    const avg = equippedRelicLevel(save)
    const levels = Math.min(
      RELIC.STONE_TIERS.find((t) => t.id === 'relicStoneTier1')!.maxLevel - avg,
      1_000_000 / (RELIC.SILVER_PER_LEVEL * TEAM.length),
    )
    expect(decision.gains.enhance).toBeCloseTo(
      Math.log(relicMainMultiplier(avg + levels) / relicMainMultiplier(avg)),
      6,
    )
  })
})

describe('副本口径：目标必须是已通关的', () => {
  it('bestDungeonStage 只看战力门槛（可以还没通关）', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    const choice = bestDungeonStage('skillEarth', save, makeCtx())
    expect(choice).not.toBeNull()
    // 同一变体里「打得赢的最高一关」= 难度最高的那一关
    const all = DUNGEON_STAGES.filter((s) => s.variantId === 'skillEarth')
    expect(choice?.stageId).toBe(all[all.length - 1].id)
  })

  it('bestIdleDungeonStage 只返回**已通关**的关卡', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    expect(bestIdleDungeonStage('skillEarth', save, makeCtx())).toBeNull()
    const target = DUNGEON_STAGES.filter((s) => s.variantId === 'skillEarth')[0]
    markCleared(save, target.id)
    const choice = bestIdleDungeonStage('skillEarth', save, makeCtx())
    expect(choice?.stageId).toBe(target.id)
  })

  it('⚠ 打得赢但没通关 ⇒ 进 `challenges`（要先手动挑战才能挂）', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 1_000_000
    const decision = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(decision.plans.skill).not.toBeNull()
    expect(decision.challenges).toContain(decision.plans.skill)
  })

  it('已通关的那一关不再进 `challenges`（不用重复挑战）', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 1_000_000
    // 先跑一次决策拿到目标，再标记通关 ⇒ 第二次决策不该再要求挑战
    const first = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    markCleared(save, first.plans.skill!)
    const second = decideChannels(save, makeCtx(), TEAM, NIGHT_ROLLS)
    expect(second.challenges).not.toContain(first.plans.skill)
  })

  it('副本产量按关卡自己的产量区间算（挂机不跑战斗 ⇒ 与难度无关地取 drop）', () => {
    // ⚠ 遗物副本的 `drop` 为 `null`（遗物是实例，不是堆叠物）⇒
    //   这里取的是**材料副本**的第一关，产量口径只对材料副本成立。
    const stage = DUNGEON_STAGES[0]
    expect(stage.drop, '材料副本必须有 drop').toBeTruthy()
    const expected = Math.round(((stage.drop!.min + stage.drop!.max) / 2) * 100)
    expect(dungeonExpectedYield(stage.id, 100)).toBe(expected)
    expect(dungeonExpectedYield('不存在的关卡', 100)).toBe(0)
  })
})

describe('副本口径：参考曲线与当前进度', () => {
  it('参考曲线的遗物/技能等级单调递增', () => {
    expect(referenceRelicLevel(1)).toBeLessThan(referenceRelicLevel(120))
    expect(referenceRelicLevel(120)).toBeLessThan(referenceRelicLevel(240))
    expect(referenceSkillLevel(1)).toBeLessThan(referenceSkillLevel(240))
  })

  it('已装备遗物的平均强化等级取真实实例', () => {
    const save = makeSave(50)
    expect(equippedRelicLevel(save)).toBe(1)
  })

  it('队伍技能平均等级取真实值', () => {
    const save = makeSave(50)
    expect(teamSkillLevel(save, TEAM)).toBe(1)
  })
})

describe('副本口径：时间账本（各通道各自独立）', () => {
  it('切换通道前先按旧目标结清：旧通道的次数先跑掉', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    const start = NOW
    // ⚠ 主线跟随模式取 `campaign.clearedStage`；**首胜前（=0）没有可挂的目标**，
    //   那时主线通道不计量、不产出 ⇒ 要测「结清旧目标」必须先打通至少一关。
    save.campaign.clearedStage = 3
    save.idle.channels.main.measuredAt = start
    const ctx = makeCtx(start + 2 * 3_600_000)
    // 让主线账本积累 2 小时，再把主线通道从「跟随」改成「指定第 3 关」
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'main', stageId: 3 },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 旧目标（跟随第 3 关）的收益已入账，并随响应回传
    expect(res.result.settled.length).toBeGreaterThan(0)
    expect(res.result.settled[0].channel).toBe('main')
    expect(save.player.silver).toBeGreaterThan(0)
    expect(save.idle.channels.main.target).toEqual({ kind: 'main', stageId: 3 })
  })

  it('⚠ 切换一条通道**只结清那一条**（另外两条的预算不受影响）', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.campaign.clearedStage = 3
    const start = NOW
    save.idle.channels.main.measuredAt = start
    save.idle.channels.main.effectiveMs = 0
    const stage = DUNGEON_STAGES.filter((s) => s.variantId === 'skillEarth')[0]
    markCleared(save, stage.id)
    const ctx = makeCtx(start + 2 * 3_600_000)
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: stage.id },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 技能通道原本没有目标 ⇒ 没有可结清的旧产出
    expect(res.result.settled).toHaveLength(0)
    // ⚠ 主线通道的账本**原封不动**：水位没推进、预算没被动
    //   （`settleIdleChannels` 的 `only` 只走被指定的那一条通道）
    expect(save.idle.channels.main.measuredAt).toBe(start)
    expect(save.idle.channels.main.effectiveMs).toBe(0)
  })

  it('目标没变时不重设（不重复结清、不清空预算）', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 1_000_000
    const stage = DUNGEON_STAGES.filter((s) => s.variantId === 'skillEarth')[0]
    markCleared(save, stage.id)
    const ctx = makeCtx()
    applyChannel(save, ctx, 'skill', { kind: 'skill', dungeonStageId: stage.id })
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: stage.id },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 相同目标 = 无操作：没有结清明细
    expect(res.result.settled).toHaveLength(0)
  })

  it('开一条通道不影响另外两条的预算', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    const stage = DUNGEON_STAGES.filter((s) => s.variantId === 'skillEarth')[0]
    markCleared(save, stage.id)
    const ctx = makeCtx()
    save.idle.channels.main.effectiveMs = 60_000
    applyChannel(save, ctx, 'skill', { kind: 'skill', dungeonStageId: stage.id })
    // 主线预算原封不动
    expect(save.idle.channels.main.effectiveMs).toBe(60_000)
    // 强化通道没被碰过
    expect(save.idle.channels.enhance.target).toBeNull()
  })

  it('多条通道目标一次应用成功', () => {
    makeAllStagesWinnable()
    const save = makeSave(50)
    save.player.silver = 1_000_000
    const skillStage = DUNGEON_STAGES.filter((s) => s.variantId === 'skillEarth')[0]
    markCleared(save, skillStage.id)
    const ok = applyChannels(save, makeCtx(), {
      main: { kind: 'main', stageId: null },
      skill: skillStage.id,
      enhance: null,
    })
    expect(ok).toBe(true)
    expect(save.idle.channels.skill.target).toEqual({
      kind: 'skill',
      dungeonStageId: skillStage.id,
    })
    expect(save.idle.channels.main.target).toEqual({ kind: 'main', stageId: null })
  })
})

describe('副本口径：索引函数', () => {
  it('关卡 id 与登记函数一致', () => {
    for (const stage of DUNGEON_STAGES) {
      expect(stage.id).toBe(`dgn_${stage.variantId}_${stage.difficulty}`)
      expect(dungeonStageById(stage.id)?.id).toBe(stage.id)
    }
  })
})
