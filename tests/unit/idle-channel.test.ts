/**
 * 挂机通道（主线 / 技能副本 / 强化副本）的设置与切换。
 *
 * ## 为什么单独一个文件
 *
 * 旧版叫「挂机去向」：三个去向**共用一份时间账本**，切一次就把另一条的时间吞掉；
 * 新版是**四条通道各自一份账本**，`idle.setChannel` 只动**被设置的那一条**。
 *
 * 守四件事：
 *
 * 1. **目标必须已通关**——主线只能挂已通关关卡，副本只能挂已通关的副本关卡；
 *    挂机只挂已通关内容 ⇒ 永不卡关（设计稿 §3.1）；
 * 2. **通道种类与目标必须匹配**——技能通道不能挂强化副本的关卡；
 * 3. **切换前先结清旧目标**——不结清 = 玩家白白损失一段时间的收益；
 * 4. **相同目标是无操作**——重复设置不报错，也不重复结清。
 *
 * ⚠ 服务端权威：切换后的目标写回 `save.idle.channels.*.target`，
 *   客户端直接改本地字段会在下一次响应时被覆盖（铁律 #28）。
 */
import { describe, expect, it } from 'vitest'
import { applyAction, type ActionContext } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { dungeonStageId } from '../../src/core/config/dungeons.ts'
import { GAME_ERROR_CODES } from '../../src/core/config/game-errors.ts'
import { Rng } from '../../src/core/rng.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000

/** 技能副本「土 · 简易 / 普通」与强化副本「初阶 · 简易」（id 唯一出处是 `dungeonStageId`） */
const SKILL_EARTH_EASY = dungeonStageId('skillEarth', 'easy')
const SKILL_EARTH_NORMAL = dungeonStageId('skillEarth', 'normal')
const ENHANCE_T1_EASY = dungeonStageId('enhanceTier1', 'easy')

function makeCtx(now = NOW): ActionContext {
  return { now, rng: new Rng(777), randomSeed: () => 777 }
}

/** 已通关第 5 关、并且土/初阶两个副本都已通关的存档 */
function makeSave(): SaveData {
  const save = createNewSave(NOW, 7)
  save.campaign.clearedStage = 5
  save.dungeons.cleared[SKILL_EARTH_EASY] = true
  save.dungeons.cleared[SKILL_EARTH_NORMAL] = true
  save.dungeons.cleared[ENHANCE_T1_EASY] = true
  return save
}

describe('挂机通道：主线', () => {
  it('只能选**已通关**的关卡', () => {
    // ⚠ 挂机只挂已通关内容 ⇒ 永不卡关（设计稿 §3.1）。
    //   允许挂未通关关卡 = 玩家挂一晚上，醒来发现收益是 0。
    const save = makeSave()
    const ctx = makeCtx()
    const bad = applyAction(save, { type: 'idle.setChannel', channel: 'main', stageId: 6 }, ctx)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe(GAME_ERROR_CODES.NOT_FOUND)
    // 目标没被改掉（失败时存档一个字节未变）
    expect(save.idle.channels.main.target).toEqual({ kind: 'main', stageId: null })

    const good = applyAction(save, { type: 'idle.setChannel', channel: 'main', stageId: 3 }, ctx)
    expect(good.ok).toBe(true)
    expect(save.idle.channels.main.target).toEqual({ kind: 'main', stageId: 3 })
  })

  it('跟随模式（省略 stageId）= 跟随最新通关关卡', () => {
    const save = makeSave()
    const ctx = makeCtx()
    const res = applyAction(save, { type: 'idle.setChannel', channel: 'main' }, ctx)
    expect(res.ok).toBe(true)
    expect(save.idle.channels.main.target).toEqual({ kind: 'main', stageId: null })
  })

  it('不存在的关卡被拒', () => {
    const save = makeSave()
    const ctx = makeCtx()
    const res = applyAction(save, { type: 'idle.setChannel', channel: 'main', stageId: 99999 }, ctx)
    expect(res.ok).toBe(false)
    expect(save.idle.channels.main.target).toEqual({ kind: 'main', stageId: null })
  })

  it('主线通道不能关闭（主线是默认通道，关掉就完全没有挂机）', () => {
    const save = makeSave()
    const ctx = makeCtx()
    const res = applyAction(save, { type: 'idle.setChannel', channel: 'main', disabled: true }, ctx)
    expect(res.ok).toBe(false)
    expect(save.idle.channels.main.target).toEqual({ kind: 'main', stageId: null })
  })
})

describe('挂机通道：副本', () => {
  it('未通关的副本关卡不能设为通道', () => {
    // ⚠ 副本必须**手动挑战通关**才可挂机——挂机只挂已通关内容。
    const save = createNewSave(NOW, 7)
    save.campaign.clearedStage = 5
    const ctx = makeCtx()
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe(GAME_ERROR_CODES.NOT_FOUND)
    expect(save.idle.channels.skill.target).toBeNull()
  })

  it('已通关的副本关卡可以设为通道', () => {
    const save = makeSave()
    const ctx = makeCtx()
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(save.idle.channels.skill.target).toEqual({
      kind: 'skill',
      dungeonStageId: SKILL_EARTH_EASY,
    })
  })

  it('通道种类与副本关卡必须匹配（技能通道不能挂强化副本）', () => {
    // ⚠ 挂错 = 结算时按错误的产出物发奖（口径串了），玩家看到的材料对不上。
    const save = makeSave()
    const ctx = makeCtx()
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: ENHANCE_T1_EASY },
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(save.idle.channels.skill.target).toBeNull()
  })

  it('不存在的副本关卡被拒', () => {
    const save = makeSave()
    const ctx = makeCtx()
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: 'dgn_not_a_stage_easy' },
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(save.idle.channels.skill.target).toBeNull()
  })
})

describe('挂机通道：切换', () => {
  it('切换目标**先结清旧目标的完整次数**再换', () => {
    // ⚠ 历史教训：旧版切去向不结清 ⇒ 玩家切一次就白白损失一段时间的收益
    //   （旧文件的注释写的就是这条）。现在切换前必须按旧目标结清。
    const save = makeSave()
    const ctx = makeCtx(NOW)
    applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )

    // 挂 60 秒后切到另一个已通关的副本关卡
    ctx.now = NOW + 60_000
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_NORMAL },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 旧目标的完整次数（60 秒 ÷ 6 秒/次 = 10 次）先结清
    expect(res.result.settled).toHaveLength(1)
    expect(res.result.settled[0].channel).toBe('skill')
    expect(res.result.settled[0].rolls).toBe(10)
    // 结算的产出真的入账了（不是只写在回执里）
    expect(save.items.skillMatEarth).toBeGreaterThan(0)
    // 新目标立即生效
    expect(res.result.target).toEqual({ kind: 'skill', dungeonStageId: SKILL_EARTH_NORMAL })
    expect(save.idle.channels.skill.target).toEqual({
      kind: 'skill',
      dungeonStageId: SKILL_EARTH_NORMAL,
    })
  })

  it('相同目标重复设置 = 无操作（成功但不重复结清）', () => {
    // ⚠ 界面上"设置"按钮可能被连点；重复设置不该报错，
    //   更不该把刚攒下的预算再发一次。
    const save = makeSave()
    const ctx = makeCtx(NOW)
    applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )
    ctx.now = NOW + 60_000
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.settled).toHaveLength(0)
    // 无操作 ⇒ 计量水位没被推进（那 60 秒仍然挂着，一秒都没丢）
    expect(save.idle.channels.skill.measuredAt).toBe(NOW)
    // 之后正常领取，60 秒仍然是 10 次
    const tick = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(tick.ok).toBe(true)
    if (!tick.ok) return
    const skill = tick.result.channels.find((c) => c.channel === 'skill')
    expect(skill?.rolls).toBe(10)
  })

  it('切换一条通道**不影响**另外两条通道的账本', () => {
    const save = makeSave()
    const ctx = makeCtx(NOW)
    applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )
    applyAction(
      save,
      { type: 'idle.setChannel', channel: 'enhance', dungeonStageId: ENHANCE_T1_EASY },
      ctx,
    )

    ctx.now = NOW + 60_000
    const res = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_NORMAL },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 只结清了被切换的那一条
    expect(res.result.settled).toHaveLength(1)
    expect(res.result.settled[0].channel).toBe('skill')
    // 另外两条的水位没有被推进（时间一段没丢）
    expect(save.idle.channels.enhance.measuredAt).toBe(NOW)
    expect(save.idle.channels.main.measuredAt).toBe(NOW)
  })

  it('关闭通道：目标清空、预算归零', () => {
    const save = makeSave()
    const ctx = makeCtx(NOW)
    applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )
    ctx.now = NOW + 60_000
    const res = applyAction(save, { type: 'idle.setChannel', channel: 'skill', disabled: true }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.target).toBeNull()
    expect(save.idle.channels.skill.target).toBeNull()
    expect(save.idle.channels.skill.effectiveMs).toBe(0)
  })
})
