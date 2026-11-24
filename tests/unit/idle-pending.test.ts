/**
 * **挂机待结算次数的显示口径**（回归：推征页「全部领取（N 次）」曾永远显示 0）。
 *
 * ## 这次修的是什么
 *
 * 推征页的「全部领取（N 次）」原来读的是**客户端镜像**里的
 * `save.idle.channels[kind].effectiveMs`。但：
 *
 * - 客户端镜像只在服务端**回包**时刷新；
 * - 服务端**回包前必先结算**（入口预结算 / 动作自身结算）⇒ 镜像里的余额
 *   恒是「不足一次」的余数（< `IDLE.SECONDS_PER_ROLL`）。
 *
 * ⇒ 界面永远显示「0 次」，而点下去服务端照发（数字自相矛盾，玩家以为按钮坏了）。
 *
 * ## 现在守住的不变量
 *
 * 1. **心跳回执带各通道待结算次数**（服务端账本的真相，几十字节）。
 * 2. **★ 按钮上写的次数 == 点下去实际拿到的次数**（这是玩家真正在意的）。
 * 3. **没有有效目标的通道 = 0 次**（未开启 / 未通关 / 目标失效）。
 * 4. **展示与结算用同一份换算**（`rollsFromEffectiveMs`）——
 *    两处各算一遍，差一个浮点余数就是「写 0 次、发 1 次」。
 * 5. **客户端镜像算不出次数**（回包前已结算）⇒ 界面不得拿镜像当真相。
 */
import { describe, expect, it } from 'vitest'
import { applyAction, type ActionContext } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { serializePublicSave, deserializePublicSave } from '../../src/core/save/serialize.ts'
import { dungeonStageId } from '../../src/core/config/dungeons.ts'
import { IDLE } from '../../src/core/config/economy.ts'
import {
  idleChannelRolls,
  idlePendingRolls,
  rollsFromEffectiveMs,
  settleIdleChannels,
} from '../../src/core/systems/idle.ts'
import { Rng } from '../../src/core/rng.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000
/** 一次掷奖的毫秒数（口径唯一出处） */
const ROLL_MS = IDLE.SECONDS_PER_ROLL * 1000

const SKILL_EARTH_EASY = dungeonStageId('skillEarth', 'easy')
const ENHANCE_T1_EASY = dungeonStageId('enhanceTier1', 'easy')

function makeCtx(now = NOW): ActionContext {
  return { now, rng: new Rng(777), randomSeed: () => 777 }
}

/** 已通关第 5 关的存档（主线通道跟随最新通关关卡） */
function makeSave(): SaveData {
  const save = createNewSave(NOW, 7)
  save.campaign.clearedStage = 5
  return save
}

/** 跑一次心跳，返回各通道待结算次数 */
function heartbeatPending(save: SaveData, ctx: ActionContext) {
  const res = applyAction(save, { type: 'idle.heartbeat' }, ctx)
  expect(res.ok).toBe(true)
  if (!res.ok) throw new Error('心跳失败')
  return res.result.pending
}

describe('挂机待结算次数：心跳回执是服务端的真相', () => {
  it('心跳回执带各通道待结算次数', () => {
    const save = makeSave()
    // 60 秒 ⇒ 10 次掷奖（6 秒/次）
    const pending = heartbeatPending(save, makeCtx(NOW + 60_000))
    expect(pending).toEqual({ main: 10, skill: 0, enhance: 0 })
  })

  it('★ 按钮上写的次数 == 点「全部领取」实际拿到的次数', () => {
    // ⚠ 这是玩家真正在意的：界面写 N 次，点下去就得真的拿到 N 次。
    //   两处只要有一处口径不同（甚至差一个浮点余数），玩家就会看到
    //   「写 0 次却拿到东西」或「写 10 次却只拿到 9 次」。
    const save = makeSave()
    const ctx = makeCtx(NOW + 60_000)
    const pending = heartbeatPending(save, ctx)

    const tick = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(tick.ok).toBe(true)
    if (!tick.ok) return
    expect(tick.result.rolls).toBe(pending.main + pending.skill + pending.enhance)
    const main = tick.result.channels.find((c) => c.channel === 'main')
    expect(main?.rolls).toBe(pending.main)
  })

  it('三条通道各自报各自的次数（互不干扰）', () => {
    const save = makeSave()
    save.dungeons.cleared[SKILL_EARTH_EASY] = true
    save.dungeons.cleared[ENHANCE_T1_EASY] = true
    const ctx = makeCtx(NOW)
    applyAction(save, { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY }, ctx)
    applyAction(save, { type: 'idle.setChannel', channel: 'enhance', dungeonStageId: ENHANCE_T1_EASY }, ctx)

    ctx.now = NOW + 60_000
    const pending = heartbeatPending(save, ctx)
    expect(pending).toEqual({ main: 10, skill: 10, enhance: 10 })
    expect(pending.main + pending.skill + pending.enhance).toBe(30)
  })

  it('没有有效目标的通道报 0 次（未开启 / 未通关 / 目标失效）', () => {
    const save = makeSave()
    const ctx = makeCtx(NOW + 60_000)

    // 技能 / 强化通道没设目标 ⇒ 0 次
    expect(heartbeatPending(save, ctx)).toEqual({ main: 10, skill: 0, enhance: 0 })

    // 主线挂到**未通关**的关卡 ⇒ 目标失效 ⇒ 0 次（挂机只挂已通关内容）
    const bad = createNewSave(NOW, 7)
    bad.campaign.clearedStage = 5
    bad.idle.channels.main.target = { kind: 'main', stageId: 9 }
    expect(heartbeatPending(bad, ctx)).toEqual({ main: 0, skill: 0, enhance: 0 })
  })

  it('首胜前主线通道没有目标 ⇒ 0 次', () => {
    const save = createNewSave(NOW, 7)
    // 新档：主线跟随模式，但 `clearedStage = 0` ⇒ 没有可挂的关卡
    expect(heartbeatPending(save, makeCtx(NOW + 60_000))).toEqual({ main: 0, skill: 0, enhance: 0 })
  })
})

describe('挂机待结算次数：展示与结算同一份换算', () => {
  it('边界：恰好一个掷奖间隔 = 1 次', () => {
    expect(rollsFromEffectiveMs(ROLL_MS)).toBe(1)
    expect(rollsFromEffectiveMs(ROLL_MS - 1)).toBe(0)
    expect(rollsFromEffectiveMs(ROLL_MS * 10)).toBe(10)
    expect(rollsFromEffectiveMs(0)).toBe(0)
    expect(rollsFromEffectiveMs(-100)).toBe(0)
  })

  it('浮点余数不会让「写 0 次、发 1 次」（结算与展示必须同数）', () => {
    // ⚠ 结算用的是 `floor((effectiveMs + 1e-6) / ROLL_MS)`，
    //   展示必须用**同一个函数**，否则边界上两处会差一次。
    const save = makeSave()
    const ctx = makeCtx(NOW)
    const ch = save.idle.channels.main
    ch.effectiveMs = ROLL_MS
    ch.measuredAt = ctx.now

    const settled = settleIdleChannels(save, { now: ctx.now, rng: new Rng(1) })
    expect(settled.channels[0]?.rolls).toBe(1)
    expect(idleChannelRolls(ch)).toBe(0) // 结算后余额归零（余数不足一次）
  })

  it('`idlePendingRolls` 与逐条 `idleChannelRolls` 同数', () => {
    const save = makeSave()
    save.idle.channels.main.effectiveMs = ROLL_MS * 3
    const pending = idlePendingRolls(save)
    expect(pending.main).toBe(idleChannelRolls(save.idle.channels.main))
    expect(pending.main).toBe(3)
  })
})

describe('回归：客户端镜像算不出次数（回包前已结算）', () => {
  it('镜像里的余额恒是「不足一次」的余数 ⇒ 界面不得拿镜像当真相', () => {
    // ⚠ 这就是老 bug 的形状：服务端**回包前必先结算**，
    //   所以客户端镜像里的 `effectiveMs` 永远算不出可领次数。
    //   真相只能在**心跳回执**里（服务端账本的实时值）。
    const save = makeSave()
    const ctx = makeCtx(NOW + 60_000)
    const pending = heartbeatPending(save, ctx)
    expect(pending.main).toBe(10)

    // 服务端结算（回包前发生的事）
    const tick = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(tick.ok).toBe(true)

    // 回包给客户端的镜像 ⇒ 次数算出来是 0
    const mirror = deserializePublicSave(serializePublicSave(save))
    expect(idleChannelRolls(mirror.idle.channels.main)).toBe(0)
    expect(idlePendingRolls(mirror).main).toBe(0)
  })
})
