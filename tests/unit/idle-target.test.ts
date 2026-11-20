/**
 * 挂机去向（主线 / 技能副本 / 强化副本）。
 *
 * 三个去向**共用同一份时间账本**（设计稿 §3）：
 * 「切换前结清旧目标的收益，之后的时间用于新目标」。
 *
 * 守三件事：
 * 1. 切换去向**先结清旧去向**（不结清 = 玩家白白损失一段时间的收益）；
 * 2. 切换后 `save.idle.target` 真的变成新去向（**服务端权威**，
 *    客户端直接写会在下一次响应时被覆盖——铁律 #28）；
 * 3. 未解锁的副本**不能**被设成去向（否则挂机跑到不存在的副本上）。
 */
import { describe, expect, it } from 'vitest'
import { applyAction, type ActionContext } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { makeTestRelic } from './helpers.ts'
import { Rng } from '../../src/core/rng.ts'
import { GAME_ERROR_CODES } from '../../src/core/config/game-errors.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function makeCtx(now = NOW): { ctx: ActionContext; rng: Rng } {
  const rng = new Rng(777)
  return { ctx: { now, rng, randomSeed: () => 777 }, rng }
}

/** 有队伍、有遗物、且土系技能还能升的存档 */
function makeSave(): SaveData {
  const save = createNewSave(NOW, 7)
  for (const id of ['xiangyu', 'hanxin']) {
    save.heroes[id] = { ...createHeroState(id, NOW), level: 240, star: 6, skillLevels: [1, 1, 1] }
  }
  save.team.slots[0] = 'xiangyu'
  save.team.slots[1] = 'hanxin'
  const rng = new Rng(3)
  save.relics = [makeTestRelic('set_zhanshen_1', rng, 1)]
  save.idle.target = { kind: 'campaign' }
  return save
}

describe('挂机去向：切换', () => {
  it('主线 → 技能副本：目标真的换掉（服务端权威）', () => {
    const save = makeSave()
    const { ctx } = makeCtx()
    const res = applyAction(
      save,
      { type: 'idle.setTarget', kind: 'skill', element: '土', difficulty: 'easy' },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(save.idle.target).toEqual({ kind: 'skill', element: '土', difficulty: 'easy' })
  })

  it('技能副本 → 强化副本：目标真的换掉', () => {
    const save = makeSave()
    const { ctx } = makeCtx()
    applyAction(save, { type: 'idle.setTarget', kind: 'skill', element: '土', difficulty: 'easy' }, ctx)
    const res = applyAction(
      save,
      { type: 'idle.setTarget', kind: 'enhance', tier: 'relicStoneTier1', difficulty: 'normal' },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(save.idle.target).toEqual({ kind: 'enhance', tier: 'relicStoneTier1', difficulty: 'normal' })
  })

  it('副本 → 主线：切回主线并清掉 farm 回刷状态', () => {
    const save = makeSave()
    const { ctx } = makeCtx()
    applyAction(save, { type: 'idle.setTarget', kind: 'skill', element: '土', difficulty: 'easy' }, ctx)
    save.idle.farm = { stage: 3, winsUntilRetry: 2 }
    const res = applyAction(save, { type: 'idle.setTarget', kind: 'campaign', stageId: 1 }, ctx)
    expect(res.ok).toBe(true)
    expect(save.idle.target).toEqual({ kind: 'campaign' })
    expect(save.idle.farm).toBeUndefined()
  })
})

describe('挂机去向：切换前先结清旧去向', () => {
  it('主线跑了一段再切副本：旧去向的收益先入账', () => {
    const save = makeSave()
    const start = NOW
    // 让挂机账本积累 2 小时
    save.idle.measuredAt = start
    save.lastTickAt = start

    const { ctx } = makeCtx(start + 2 * HOUR)
    const res = applyAction(
      save,
      { type: 'idle.setTarget', kind: 'skill', element: '土', difficulty: 'easy' },
      ctx,
    )
    expect(res.ok).toBe(true)
    // 旧去向的挂机收益在切换时结算（银两 / 经验书已入账）
    expect(save.player.silver).toBeGreaterThan(0)
    // 切换本身不产生场次：账本被清零，重新计量
    expect(save.idle.effectiveMs).toBe(0)
  })

  it('从副本切走时，副本已产出的材料留在背包里（不被回滚）', () => {
    const save = makeSave()
    const { ctx } = makeCtx()
    applyAction(save, { type: 'idle.setTarget', kind: 'skill', element: '土', difficulty: 'easy' }, ctx)
    // 手动跑几场副本
    const tick = applyAction(save, { type: 'idle.tick', battles: 3 }, makeCtx(NOW + 60_000).ctx)
    expect(tick.ok).toBe(true)
    const before = save.items.skillMatEarth
    expect(before).toBeGreaterThan(0)
    const res = applyAction(save, { type: 'idle.setTarget', kind: 'campaign', stageId: 1 }, makeCtx(NOW + 120_000).ctx)
    expect(res.ok).toBe(true)
    // ⚠ 切换时**先按旧去向（副本）结清**——所以材料只会变多，绝不会变少
    expect(save.items.skillMatEarth).toBeGreaterThanOrEqual(before)
    expect(save.idle.target).toEqual({ kind: 'campaign' })
  })
})

describe('挂机去向：校验', () => {
  it('未解锁的技能副本不能被设为去向', () => {
    const save = makeSave()
    // 队伍里没有水属性英灵 → 水技能副本锁定
    const { ctx } = makeCtx()
    const res = applyAction(
      save,
      { type: 'idle.setTarget', kind: 'skill', element: '水', difficulty: 'easy' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe(GAME_ERROR_CODES.MATERIAL_UNLOCKED)
    // 目标没被改掉
    expect(save.idle.target).toEqual({ kind: 'campaign' })
  })

  it('未解锁的强化副本不能被设为去向', () => {
    const save = createNewSave(NOW, 7)
    const { ctx } = makeCtx()
    const res = applyAction(
      save,
      { type: 'idle.setTarget', kind: 'enhance', tier: 'relicStoneTier3', difficulty: 'easy' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe(GAME_ERROR_CODES.MATERIAL_UNLOCKED)
  })

  it('不存在的副本变体被拒', () => {
    const save = makeSave()
    const { ctx } = makeCtx()
    const res = applyAction(
      save,
      // ⚠ 故意传非法值：类型层已经挡住，运行时还要再挡一次 → 这里绕开类型（`as never`）。
      { type: 'idle.setTarget', kind: 'enhance', tier: 'not_a_tier' as never, difficulty: 'easy' },
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(save.idle.target).toEqual({ kind: 'campaign' })
  })

  it('不存在的难度被拒', () => {
    const save = makeSave()
    const { ctx } = makeCtx()
    const res = applyAction(
      save,
      // ⚠ 故意传非法值：类型层已经挡住，运行时还要再挡一次 → 这里绕开类型（`as never`）。
      { type: 'idle.setTarget', kind: 'skill', element: '土', difficulty: 'nightmare' as never },
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(save.idle.target).toEqual({ kind: 'campaign' })
  })

  it('主线去向：关卡必须已解锁', () => {
    const save = makeSave()
    const { ctx } = makeCtx()
    const res = applyAction(save, { type: 'idle.setTarget', kind: 'campaign', stageId: 9999 }, ctx)
    expect(res.ok).toBe(false)
  })
})

describe('挂机去向：副本结算', () => {
  it('副本去向的挂机结算带回副本明细（战败位置 + 降难度建议）', () => {
    const save = makeSave()
    const { ctx } = makeCtx()
    applyAction(save, { type: 'idle.setTarget', kind: 'skill', element: '土', difficulty: 'easy' }, ctx)
    const res = applyAction(save, { type: 'idle.tick', battles: 2 }, makeCtx(NOW + 120_000).ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.dungeon).toBeTruthy()
    expect(res.result.dungeon!.itemId).toBe('skillMatEarth')
  })

  it('主线去向的挂机结算**不带**副本明细', () => {
    const save = makeSave()
    const res = applyAction(save, { type: 'idle.tick', battles: 2 }, makeCtx(NOW + 120_000).ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.dungeon).toBeUndefined()
  })
})
