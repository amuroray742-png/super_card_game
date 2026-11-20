/**
 * **材料副本刷取口径**的守护（节奏模拟 × 副本产出的唯一出处）。
 *
 * ⚠ 守的是什么：
 *   1. **需求侧**：技能材料按五行分列、强化石按档位分列，
 *      数值口径取 core（等级上限 / 每级消耗 / 逐级真实价格）。
 *   2. **策略**：按「一夜能换多少战力」分配挂机时间；
 *      并且**不能死锁**——银两不够就不去刷副本（副本只发材料不发银两），
 *      境界门槛上主线是唯一出路（突破要银两）。
 *   3. **时间账本**：去向是**存档状态**，切换时先按**旧去向**结清。
 *
 * ⚠ 口径只有一份：`tools/balance/dungeon-loop.ts`
 *   （铁律 #4：工具与单测不得各写一套）。
 */
import { describe, expect, it } from 'vitest'

import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { Rng } from '../../src/core/rng.ts'
import { applyAction, type ActionContext } from '../../src/core/systems/actions.ts'
import { SKILL, RELIC } from '../../src/core/config/economy.ts'
import { relicMainMultiplier } from '../../src/core/systems/relic.ts'
import { ITEM_BY_ELEMENT } from '../../src/core/config/items.ts'
import { makeTestRelic } from './helpers.ts'
import {
  applyIdleTarget,
  decideIdleTarget,
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
/** 「一夜」的场次（与 recalibrate 的挂机日同量级） */
const NIGHT_BATTLES = 1560
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
  save.idle.target = { kind: 'campaign' }
  return save
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

describe('副本口径：去向策略', () => {
  it('材料不缺 → 回主线（副本不写 campaign，进度不能停）', () => {
    const save = makeSave(50)
    // 技能已满、遗物已到初阶石档的上限 ⇒ 没有值得刷的材料
    save.heroes.xiangyu.skillLevels = [20, 20, 20]
    save.heroes.hannibal.skillLevels = [20, 20, 20]
    for (const relic of save.relics) relic.level = 60
    save.player.silver = 1_000_000
    const plan = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES).plan
    expect(plan.kind).toBe('campaign')
  })

  it('技能材料是瓶颈且银两够 → 去技能副本（缺口最大的那一行）', () => {
    const save = makeSave(50)
    save.player.silver = 1_000_000
    save.items[ITEM_BY_ELEMENT.土] = 0
    const decision = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES)
    expect(decision.plan.kind).toBe('skill')
    expect(decision.plan.element).toBe('土')
  })

  it('⚠ 银两不够时不去刷副本（副本只发材料不发银两 ⇒ 会死锁）', () => {
    const save = makeSave(50)
    // 技能差得很多 ⇒ 边际收益高，但银两是 0 ⇒ 材料到了也花不出去
    save.player.silver = 0
    save.items[ITEM_BY_ELEMENT.土] = 0
    const plan = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES).plan
    expect(plan.kind).toBe('campaign')
  })

  it('⚠ 境界门槛上主线是唯一出路（突破要银两，银两只有主线给）', () => {
    const save = makeSave(60) // 凡阶末尾 ⇒ 卡门槛
    save.player.silver = 1_000_000
    save.items[ITEM_BY_ELEMENT.土] = 0
    const decision = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES)
    expect(decision.plan.kind).toBe('campaign')
    expect(decision.gains.campaign).toBe(Number.POSITIVE_INFINITY)
  })

  it('未解锁的副本不会被选（不替玩家开挂）', () => {
    const save = createNewSave(NOW, 7)
    // 没有英灵 ⇒ 技能副本全锁；也没有遗物 ⇒ 强化副本全锁
    const plan = decideIdleTarget(save, makeCtx(), [], 'easy', NIGHT_BATTLES).plan
    expect(plan.kind).toBe('campaign')
  })

  it('强化石是瓶颈时去强化副本，石档 = 下一次升级要用的那一档', () => {
    const save = makeSave(50)
    save.player.silver = 1_000_000
    // 技能已满 ⇒ 技能不是瓶颈
    save.heroes.xiangyu.skillLevels = [20, 20, 20]
    save.heroes.hannibal.skillLevels = [20, 20, 20]
    // 遗物只有 Lv1 ⇒ 石头是瓶颈
    const plan = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES).plan
    expect(plan.kind).toBe('enhance')
    expect(plan.tier).toBe('relicStoneTier1')
  })

  it('三个去向的增益是可比的 ln 口径', () => {
    const save = makeSave(50)
    save.player.silver = 1_000_000
    const decision = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES)
    expect(decision.gains.campaign).toBeGreaterThan(0)
    expect(decision.gains.skill).toBeGreaterThanOrEqual(0)
    expect(decision.gains.enhance).toBeGreaterThanOrEqual(0)
  })

  it('⚠ 技能增益按「人均」折算（不是全队合计）', () => {
    const save = makeSave(50)
    save.player.silver = 160_000
    const decision = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES)
    // 两名土系英灵 × 3 技能 × (Lv50 上限 20 − 当前 1) = 114 级 ⇒ 人均 57 级 × 每级 2%
    expect(decision.gains.skill).toBeCloseTo(
      (114 / TEAM.length) * SKILL.PCT_PER_LEVEL,
      6,
    )
  })

  it('⚠ 银两不够时，技能增益按「买得起的级数」算', () => {
    const save = makeSave(50)
    // 只够买 20 级（16,000 ÷ 800）——材料够也不该虚增
    save.player.silver = 16_000
    const decision = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES)
    expect(decision.gains.skill).toBeCloseTo(
      (20 / TEAM.length) * SKILL.PCT_PER_LEVEL,
      6,
    )
  })

  it('⚠ 强化增益按「已装备遗物的英灵占比」折算', () => {
    const save = makeSave(50)
    save.heroes.xiangyu.skillLevels = [20, 20, 20]
    save.heroes.hannibal.skillLevels = [20, 20, 20]
    save.player.silver = 1_000_000
    const decision = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES)
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

describe('副本口径：时间账本（去向是存档状态）', () => {
  it('切换去向前先按旧去向结清：旧去向的场次先跑掉', () => {
    const save = makeSave(50)
    const start = NOW
    save.idle.measuredAt = start
    save.lastTickAt = start
    const ctx = makeCtx(start + 2 * 3_600_000)
    // 先让账本积累 2 小时，再切到副本
    const res = applyAction(
      save,
      { type: 'idle.setTarget', kind: 'skill', element: '土', difficulty: 'easy' },
      ctx,
    )
    expect(res.ok).toBe(true)
    // 旧去向（主线）的收益已入账，账本清零
    expect(save.player.silver).toBeGreaterThan(0)
    expect(save.idle.effectiveMs).toBe(0)
    expect(save.idle.target).toEqual({ kind: 'skill', element: '土', difficulty: 'easy' })
  })

  it('去向没变时不重设（保住主线的回退刷取状态）', () => {
    const save = makeSave(50)
    // 前置：材料不缺 ⇒ 决策本来就该是主线（否则会拿到技能副本，测的就不是「没变」）
    save.heroes.xiangyu.skillLevels = [20, 20, 20]
    save.heroes.hannibal.skillLevels = [20, 20, 20]
    save.relics[0].level = 60
    save.player.silver = 1_000_000
    save.idle.farm = { stage: 3, winsUntilRetry: 2 }
    const plan = decideIdleTarget(save, makeCtx(), TEAM, 'easy', NIGHT_BATTLES).plan
    expect(plan.kind).toBe('campaign')
    // 目标本来就是主线 ⇒ 不该重设（`idle.setTarget` 会清掉 farm 状态）
    applyIdleTarget(save, makeCtx(), plan)
    expect(save.idle.farm).toBeTruthy()
  })
})
