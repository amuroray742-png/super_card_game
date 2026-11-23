/**
 * 挂机账本的**权威性**（挂机改版 v11：三通道并行）。
 *
 * ## 这里守的是什么
 *
 * 旧版是「三个去向共用一份时间账本」，一旦有一条线出问题，
 * 三条线一起停摆；新版是**三条通道各自一份账本**，
 * 于是「哪条线在发、发了多少、会不会重复发」都必须**可核对**。
 *
 * 守四条：
 *
 * 1. **唯一账本**：存档里的 `save.idle.channels.*` 是唯一事实，
 *    core 没有任何第二份"内部计数"；
 * 2. **不重复发**：重复领取不会把同一段时间发两次；
 * 3. **关闭再启用不追溯**：通道关闭期间的时间不补发，
 *    重新打开后从打开时刻重新起算；
 * 4. **分批领取 == 一次领取**：分几次领与一次领的产出总量一致。
 *
 * ⚠ 随机序列同样是账本的一部分（铁律 #24）：
 *   计数器必须随存档落盘，否则刷新页面就回到序列开头 ⇒ 玩家可以无限"刷新重抽"。
 */
import { describe, expect, it } from 'vitest'
import { applyAction, syncRngState } from '../../src/core/systems/actions.ts'
import { settleIdleChannels } from '../../src/core/systems/idle.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { Rng } from '../../src/core/rng.ts'
import { dungeonStageId } from '../../src/core/config/dungeons.ts'
import { START_RESOURCES } from '../../src/core/config/economy.ts'
import type { ActionContext } from '../../src/core/systems/actions.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
/** 技能副本「土 · 简易」关卡 id（唯一出处是 `dungeonStageId`） */
const SKILL_EARTH_EASY = dungeonStageId('skillEarth', 'easy')

function makeSave(seed = 7): SaveData {
  const save = createNewSave(NOW, seed)
  save.campaign.clearedStage = 5
  save.dungeons.cleared[SKILL_EARTH_EASY] = true
  return save
}

function makeCtx(now: number, seed = 42): ActionContext {
  return { now, rng: new Rng(seed), randomSeed: () => seed }
}

describe('挂机账本：唯一事实', () => {
  it('core 只认存档里的水位（没有第二份账本）', () => {
    // ⚠ 计划文档写的是「客户端改 save.idle.* 不被 core 认可」，
    //   但 core 本身**没有**"权威 / 非权威"的概念——它只读存档里的水位。
    //   真正的权威在**服务端**：客户端改的只是本地缓存，
    //   服务端会以自己的存档为准（铁律 #11 / #28）。
    //
    //   这条锁的是「core 只有一份账本」：水位改了，产出就跟着改；
    //   如果 core 内部还藏着一份计数，这里就会对不上。
    const save = makeSave()
    const ch = save.idle.channels.main
    ch.target = { kind: 'main', stageId: 5 }
    ch.measuredAt = NOW
    ch.effectiveMs = 2 * 6_000

    const result = settleIdleChannels(save, { now: NOW, rng: new Rng(1) })
    expect(result.rolls).toBe(2)
    expect(ch.effectiveMs).toBe(0)
  })

  it('结算写回存档：预算扣减 + 总时长累计（账本不是只读的影子）', () => {
    const save = makeSave()
    const ctx = makeCtx(NOW + 60_000)
    const res = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.rolls).toBe(10)
    // 10 次 × 6 秒 = 60 秒计入总时长
    expect(save.idle.totalIdleSeconds).toBe(60)
    expect(save.idle.channels.main.effectiveMs).toBe(0)
  })

  it('随机计数器随存档落盘（刷新页面不会回到序列开头）', () => {
    // ⚠ 铁律 #24：种子与计数器必须持久化。
    //   只存在内存里时，刷新页面就回到序列开头 ⇒ 玩家可以无限"刷新重抽"。
    //
    // ⚠ **挂机改版 v11**：挂机掷奖走**每条通道各自的持久化序列**
    //   （`save.rng.channels[kind]`），所以落盘的是**通道计数器**，
    //   全局计数器（抽卡 / 战斗用）不因挂机前进。
    const save = makeSave()
    const rng = new Rng(3)
    const ctx: ActionContext = { now: NOW + 60_000, rng, randomSeed: () => 3 }
    applyAction(save, { type: 'idle.tick' }, ctx)
    syncRngState(save, rng)

    // 全局序列：挂机不消耗它 ⇒ 计数器不动（但仍然与传入的 rng 一致）
    expect(save.rng.counter).toBe(rng.snapshot().counter)
    // 通道序列：计数器**必须**前进，且随存档落盘
    const channel = save.rng.channels.main
    expect(channel.counter).toBeGreaterThan(0)
    // 快照能忠实复原序列位置（不是返回内部状态）
    const restored = Rng.fromSnapshot(channel.seed, channel.counter)
    expect(restored.snapshot()).toEqual(channel)
  })
})

describe('挂机账本：不重复发', () => {
  it('重复领取不重复发：第二次结算 rolls = 0', () => {
    // ⚠ 历史教训：旧版「在线 tick」与「离线领取」是两条路径，
    //   两条路径都能对同一段时间发奖 ⇒ 玩家点两下就双倍收益。
    //   现在两条路径共用同一个入口（`settleIdleAndApply`），账本只有一份。
    const save = makeSave()
    const ctx = makeCtx(NOW + 60_000)
    const first = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.result.rolls).toBe(10)
    const silverAfterFirst = save.player.silver

    const second = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.result.rolls).toBe(0)
    expect(second.result.channels).toHaveLength(0)
    expect(save.player.silver).toBe(silverAfterFirst)
  })

  it('在线领取与离线领取是同一条路径、同一份账本', () => {
    const save = makeSave()
    const ctx = makeCtx(NOW + 60_000)
    const tick = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(tick.ok).toBe(true)
    if (!tick.ok) return
    expect(tick.result.rolls).toBe(10)

    // 紧接着用"离线领取"入口再领一次 ⇒ 同一段时间不能被领第二次
    const offline = applyAction(save, { type: 'idle.claimOffline' }, ctx)
    expect(offline.ok).toBe(true)
    if (!offline.ok) return
    expect(offline.result.rolls).toBe(0)
  })
})

describe('挂机账本：关闭与重开', () => {
  it('通道关闭期间的时间不补发，重新打开后从打开时刻起算', () => {
    // ⚠ 历史教训：旧版切通道会把旧目标的时间**吞掉**（不结清 = 白白损失）；
    //   新版结清旧目标，但**关闭期间**的时间不追溯——
    //   否则玩家"关掉再打开"就能凭空刷出这段时间的收益。
    const save = makeSave()
    const ctx = makeCtx(NOW)

    // 打开技能通道
    const open = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )
    expect(open.ok).toBe(true)

    // 挂 60 秒后关闭（关闭前先结清）
    ctx.now = NOW + 60_000
    const close = applyAction(save, { type: 'idle.setChannel', channel: 'skill', disabled: true }, ctx)
    expect(close.ok).toBe(true)
    if (!close.ok) return
    expect(close.result.settled).toHaveLength(1)
    expect(close.result.settled[0].rolls).toBe(10)
    expect(save.idle.channels.skill.target).toBeNull()

    // 关闭期间空挂 10 分钟
    ctx.now = NOW + 10 * 60_000
    const reopen = applyAction(
      save,
      { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY },
      ctx,
    )
    expect(reopen.ok).toBe(true)
    // 重新打开 ⇒ 预算从 0 起算，关闭期间那 10 分钟不补发
    expect(save.idle.channels.skill.effectiveMs).toBe(0)

    // 重新打开后再挂 60 秒 ⇒ 只有这 60 秒的量
    ctx.now = NOW + 10 * 60_000 + 60_000
    const tick = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(tick.ok).toBe(true)
    if (!tick.ok) return
    const skill = tick.result.channels.find((c) => c.channel === 'skill')
    expect(skill?.rolls).toBe(10)
  })

  it('关闭通道不影响另外两条通道的账本', () => {
    // ⚠ 三条通道**各自独立**：关掉技能通道，主线照常发。
    const save = makeSave()
    const ctx = makeCtx(NOW)
    applyAction(save, { type: 'idle.setChannel', channel: 'skill', dungeonStageId: SKILL_EARTH_EASY }, ctx)

    ctx.now = NOW + 60_000
    applyAction(save, { type: 'idle.setChannel', channel: 'skill', disabled: true }, ctx)

    ctx.now = NOW + 120_000
    const tick = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(tick.ok).toBe(true)
    if (!tick.ok) return
    const main = tick.result.channels.find((c) => c.channel === 'main')
    // ⚠ 主线拿到的是**完整的 120 秒**（20 次）：
    //   关闭技能通道时只结算了技能那一条（`only`），主线的水位没有被推进，
    //   所以这 120 秒一段都没丢——切换通道不许吃掉别的通道的时间。
    expect(main?.rolls).toBe(20)
    expect(tick.result.channels.find((c) => c.channel === 'skill')).toBeUndefined()
  })
})

describe('挂机账本：分批领取 == 一次领取', () => {
  it('分 6 次领与一次领：产出总量一致（动作层）', () => {
    // ⚠ 玩家每隔一会儿点一次领取是**常态**。
    //   如果分批会少发，玩家就会觉得"挂着不如不挂"，
    //   这条是挂机系统最容易被做坏的地方。
    const one = makeSave()
    const oneCtx = makeCtx(NOW + HOUR, 1234)
    const oneRes = applyAction(one, { type: 'idle.tick' }, oneCtx)
    expect(oneRes.ok).toBe(true)
    if (!oneRes.ok) return
    expect(oneRes.result.rolls).toBe(600)

    const split = makeSave()
    // ⚠ 同一条随机序列（存档里的计数器只前进不复现）
    const splitCtx = makeCtx(NOW, 1234)
    for (let i = 1; i <= 6; i++) {
      splitCtx.now = NOW + (HOUR / 6) * i
      const res = applyAction(split, { type: 'idle.tick' }, splitCtx)
      expect(res.ok).toBe(true)
    }

    expect(split.player.silver).toBe(one.player.silver)
    expect(split.items).toEqual(one.items)
    expect(split.idle.totalIdleSeconds).toBe(one.idle.totalIdleSeconds)
  })

  it('分批领取不会让总时长虚增（离线曲线被重复积分）', () => {
    // ⚠ 旧版离线曲线按「累计时长」折算，若分段计量时把累计值重复算一遍，
    //   玩家每 5 秒点一次就能把 1 小时的离线收益刷成好几倍。
    const save = makeSave()
    const ctx = makeCtx(NOW, 55)
    for (let i = 1; i <= 12; i++) {
      ctx.now = NOW + i * 5 * 60_000
      applyAction(save, { type: 'idle.tick' }, ctx)
    }
    // 1 小时 ⇒ 满效率 3600 秒 ⇒ 600 次
    expect(save.idle.totalIdleSeconds).toBe(600 * 6)
  })

  it('新号的挂机账本从建档时刻起算（不追溯建档前的时间）', () => {
    const save = createNewSave(NOW, 7)
    const ctx = makeCtx(NOW)
    const res = applyAction(save, { type: 'idle.tick' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.rolls).toBe(0)
    expect(save.player.silver).toBe(START_RESOURCES.silver)
  })
})

// ─────────────────────────── 通道随机序列独立（v11） ───────────────────────────

describe('挂机账本：三条通道各有各的随机序列', () => {
  it('开不开另一条通道，不改变本通道的掉落', () => {
    // ⚠ **挂机改版 v11（设计稿 §3.3 / §3.6）**：每条通道用**自己的**持久化
    //   随机序列。若三条共用一条全局序列，开 / 关一条通道就会改变另外两条的
    //   掉落 —— 那正是「产出互不干扰」被破坏的样子。
    //
    //   这里比的是**技能通道**：主线在遍历顺序里排第一（`IDLE_CHANNEL_KINDS`），
    //   所以「主线开着 / 关着」会改变技能通道拿到的随机数位置 ——
    //   共用序列时这里必然不等。
    const withoutMain = makeSave()
    withoutMain.campaign.clearedStage = 0
    withoutMain.idle.channels.skill.target = { kind: 'skill', dungeonStageId: SKILL_EARTH_EASY }

    const withMain = makeSave()
    withMain.idle.channels.skill.target = { kind: 'skill', dungeonStageId: SKILL_EARTH_EASY }

    const a = settleIdleChannels(withoutMain, { now: NOW + 60_000, rng: new Rng(1) })
    const b = settleIdleChannels(withMain, { now: NOW + 60_000, rng: new Rng(1) })

    const skillA = a.channels.find((c) => c.channel === 'skill')!
    const skillB = b.channels.find((c) => c.channel === 'skill')!
    expect(skillA).toBeDefined()
    expect(skillB).toBeDefined()
    expect(skillA.rolls).toBe(skillB.rolls)
    expect(skillA.rewards).toEqual(skillB.rewards)

    // 三条通道的计数器**各自**前进（不是共用一个）
    expect(withMain.rng.channels.main.counter).toBeGreaterThan(0)
    expect(withMain.rng.channels.skill.counter).toBeGreaterThan(0)
    expect(withMain.rng.channels.skill.counter).not.toBe(withMain.rng.channels.main.counter)
  })

  it('先结清一条通道，不影响另一条通道之后的掉落', () => {
    // ⚠ 同上：切换 / 结清某一条通道时，另外两条的序列位置不许被带偏。
    const plain = makeSave()
    plain.idle.channels.skill.target = { kind: 'skill', dungeonStageId: SKILL_EARTH_EASY }

    const settledFirst = makeSave()
    settledFirst.idle.channels.skill.target = { kind: 'skill', dungeonStageId: SKILL_EARTH_EASY }
    // 先只结清主线（等价于「切换主线通道时只结清那一条」）
    settleIdleChannels(settledFirst, { now: NOW + 60_000, rng: new Rng(1) }, { only: 'main' })
    const second = settleIdleChannels(settledFirst, { now: NOW + 60_000, rng: new Rng(1) })

    const first = settleIdleChannels(plain, { now: NOW + 60_000, rng: new Rng(1) })
    const skillPlain = first.channels.find((c) => c.channel === 'skill')!
    const skillSecond = second.channels.find((c) => c.channel === 'skill')!
    expect(skillPlain.rewards).toEqual(skillSecond.rewards)
  })
})
