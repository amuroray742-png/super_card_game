/**
 * 挂机与离线结算（挂机改版 v11：**三通道并行 + 已通关直挂**）。
 *
 * ## 与旧版的根本差别
 *
 * - 旧版挂机 = 「跑战斗自动推进主线」，产出里**带遗物**；
 * - 新版挂机 = 「按掉落表**逐次掷奖**」，**永不卡关**（目标必须已通关），
 *   产出**不含遗物**（遗物改走独立入口 `relic.acquire`，见 §1.3 / U3）。
 *
 * 三条通道（主线 / 技能副本 / 强化副本）**各自独立计量**同一段墙钟时间、
 * 各自记账，产出互不干扰——玩家可以同时挂三条。
 *
 * ## 本文件守住的语义
 *
 * 1. 离线收益曲线三段（1h 满效率 / 1~3h 线性衰减 / 3h 封顶）+ 在线 3 倍；
 * 2. 三条通道各自独立计量、**互不扣别人的预算**；
 * 3. 目标必须**已通关**（主线指定关卡 / 副本关卡）——挂机永不卡关；
 * 4. 余数保留、分批领取 == 一次领取；
 * 5. 时钟回退不计量、水位保持原值；
 * 6. 通道关闭 → 预算与离线累计归零；
 * 7. 发奖扣账 + 单次结算次数上限；
 * 8. **掉落口径**：主线只发银两 + 经验书，**`rewards.relics` 永远为空**。
 *
 * ⚠ 时间与随机全部**注入**（铁律 #1）：本文件不出现 `Date.now()` / `Math.random()`。
 */
import { describe, expect, it } from 'vitest'
import {
  IDLE_CHANNEL_KINDS,
  OFFLINE_CAP_SECONDS,
  ROLL_MS,
  computeOfflineEfficiency,
  idleChannelRemainingMs,
  idleChannelRolls,
  measureIdleChannels,
  mergeRewardBundles,
  offlineEffectiveSeconds,
  resolveChannelTarget,
  rollChannelRewards,
  rollDungeonDrop,
  rollMainDrop,
  settleIdleChannels,
  type IdleSettleContext,
  type ResolvedChannelTarget,
} from '../../src/core/systems/idle.ts'
import { EXP_BOOK, IDLE, START_RESOURCES } from '../../src/core/config/economy.ts'
import { isExpBook } from '../../src/core/config/items.ts'
import { STAGE_INDEX } from '../../src/core/config/stages.ts'
import { dungeonStageById, dungeonStageId } from '../../src/core/config/dungeons.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { Rng } from '../../src/core/rng.ts'
import type { RewardBundle, SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
/** 单次掷奖的毫秒数（口径取 core 的常量，不在测试里另写一份） */
const ROLL = ROLL_MS

/** 技能副本「土 · 简易」关卡 id（副本关卡 id 的唯一出处是 `dungeonStageId`） */
const SKILL_EARTH_EASY = dungeonStageId('skillEarth', 'easy')
/** 强化副本「初阶 · 简易」关卡 id */
const ENHANCE_T1_EASY = dungeonStageId('enhanceTier1', 'easy')

/** 造一份存档：已通关第 5 关（主线通道有目标可挂） */
function makeSave(seed = 7): SaveData {
  const save = createNewSave(NOW, seed)
  save.campaign.clearedStage = 5
  return save
}

/** 结算上下文（时间与随机都注入） */
function settleCtx(now: number, seed = 42): IdleSettleContext {
  return { now, rng: new Rng(seed) }
}

/** 把多份奖励包合并成一份（聚合口径取 core 的 `mergeRewardBundles`） */
function mergeAll(list: RewardBundle[]): RewardBundle {
  const merged: RewardBundle = {}
  for (const one of list) mergeRewardBundles(merged, one)
  return merged
}

// ─────────────────────────── 离线收益曲线 ───────────────────────────

describe('离线收益曲线（§5.7）', () => {
  it('满效率时长内效率为 100%', () => {
    expect(computeOfflineEfficiency(0)).toBe(0)
    expect(computeOfflineEfficiency(3600)).toBeCloseTo(1, 6)
    expect(computeOfflineEfficiency(IDLE.FULL_EFFICIENCY_HOURS * 3600)).toBeCloseTo(
      IDLE.FULL_EFFICIENCY_HOURS,
      6,
    )
  })

  it('满效率时长之后线性衰减至 TAIL_RATE，积分与请求次数无关', () => {
    // 曲线由 FULL_EFFICIENCY_HOURS / CAP_HOURS / TAIL_RATE 三段定义，
    // 数值口径见 economy.ts 的 IDLE（实施修正：roadmap P1-2 收窄为 1h / 3h）。
    const tail = IDLE.CAP_HOURS - IDLE.FULL_EFFICIENCY_HOURS
    const tailAvg = (1 + IDLE.TAIL_RATE) / 2
    expect(computeOfflineEfficiency(IDLE.CAP_HOURS * 3600)).toBeCloseTo(
      IDLE.FULL_EFFICIENCY_HOURS + tail * tailAvg,
    )
    expect(IDLE.ONLINE_MULTIPLIER).toBe(3)
  })

  it('收益封顶时长后不再产出', () => {
    expect(computeOfflineEfficiency(IDLE.CAP_HOURS * 3600)).toBeCloseTo(
      computeOfflineEfficiency(48 * 3600),
      6,
    )
    expect(OFFLINE_CAP_SECONDS).toBe(IDLE.CAP_HOURS * 3600)
  })

  it('有效时长 = 真实时长 × 效率', () => {
    expect(offlineEffectiveSeconds(3600)).toBeCloseTo(3600, 6)
    expect(offlineEffectiveSeconds(IDLE.FULL_EFFICIENCY_HOURS * 3600)).toBeCloseTo(
      IDLE.FULL_EFFICIENCY_HOURS * 3600,
      6,
    )
  })

  it('持续在线 3 倍：满效率时长的离线等价于三分之一的在线时长', () => {
    const offline = offlineEffectiveSeconds(IDLE.FULL_EFFICIENCY_HOURS * 3600)
    expect(offline / IDLE.ONLINE_MULTIPLIER).toBe(
      (IDLE.FULL_EFFICIENCY_HOURS * 3600) / 3,
    )
  })
})

// ─────────────────────────── 三通道并行 ───────────────────────────

describe('三通道并行：各自独立计量', () => {
  /** 三条通道全部打开的存档 */
  function threeChannels(): SaveData {
    const save = makeSave()
    save.dungeons.cleared[SKILL_EARTH_EASY] = true
    save.dungeons.cleared[ENHANCE_T1_EASY] = true
    save.idle.channels.main.target = { kind: 'main', stageId: null }
    save.idle.channels.skill.target = { kind: 'skill', dungeonStageId: SKILL_EARTH_EASY }
    save.idle.channels.enhance.target = { kind: 'enhance', dungeonStageId: ENHANCE_T1_EASY }
    return save
  }

  it('同一段墙钟时间里，三条通道各自结算，互不扣别人的预算', () => {
    // ⚠ 历史教训：旧版三个去向**共用一份时间账本**，切一次就把另一条的时间吞掉。
    //   这里守的是「三条通道各自计量」——每条都拿到完整的 60 秒。
    const save = threeChannels()
    const result = settleIdleChannels(save, settleCtx(NOW + 60_000))

    expect(result.channels).toHaveLength(3)
    expect(result.rolls).toBe(30)
    for (const kind of IDLE_CHANNEL_KINDS) {
      const detail = result.channels.find((c) => c.channel === kind)
      expect(detail, `${kind} 通道没有结算`).toBeTruthy()
      // 60 秒 ÷ 6 秒/次 = 10 次（**每条通道都是 10**，不是共享一个 10）
      expect(detail!.rolls).toBe(10)
      // 结算后各自的预算都被扣光，互不影响
      expect(save.idle.channels[kind].effectiveMs).toBe(0)
    }
  })

  it('一条通道的目标失效**不影响**另外两条', () => {
    // ⚠ 铁律 #3 的反面：系统逻辑必须遍历配置表，一条通道挂掉不能连累另外两条。
    const save = threeChannels()
    // 让技能副本目标失效（通关记录被清掉）
    delete save.dungeons.cleared[SKILL_EARTH_EASY]
    const result = settleIdleChannels(save, settleCtx(NOW + 60_000))

    const kinds = result.channels.map((c) => c.channel).sort()
    expect(kinds).toEqual(['enhance', 'main'])
    expect(result.channels.find((c) => c.channel === 'skill')).toBeUndefined()
    // 失效的那条通道预算归零（目标没了，时间也就没有意义）
    expect(save.idle.channels.skill.effectiveMs).toBe(0)
  })

  it('三条通道的产出物互不串味：主线发银两/经验书，副本只发自己的材料', () => {
    const save = threeChannels()
    const result = settleIdleChannels(save, settleCtx(NOW + 60_000))

    const main = result.channels.find((c) => c.channel === 'main')!
    const skill = result.channels.find((c) => c.channel === 'skill')!
    const enhance = result.channels.find((c) => c.channel === 'enhance')!

    expect(main.rewards.silver).toBeGreaterThan(0)
    for (const id of Object.keys(main.rewards.items ?? {})) {
      expect(isExpBook(id as never), `主线不该发 ${id}`).toBe(true)
    }
    // 副本只发自己的材料：不发银两、不发经验书
    expect(skill.rewards.silver).toBeUndefined()
    expect(Object.keys(skill.rewards.items ?? {})).toEqual(['skillMatEarth'])
    expect(enhance.rewards.silver).toBeUndefined()
    expect(Object.keys(enhance.rewards.items ?? {})).toEqual(['relicStoneTier1'])
  })
})

// ─────────────────────────── 目标解析（已通关直挂） ───────────────────────────

describe('通道目标解析：必须已通关', () => {
  it('主线跟随模式：解析为最新通关关卡', () => {
    const save = makeSave()
    const target = resolveChannelTarget(save, 'main', { kind: 'main', stageId: null })
    expect(target).not.toBeNull()
    expect(target!.stageId).toBe(5)
    expect(target!.name).toBe(STAGE_INDEX.get(5)!.name)
    expect(target!.dropTableId).toBe(STAGE_INDEX.get(5)!.dropTableId)
  })

  it('主线跟随模式：首胜前（clearedStage = 0）解析为 null，但水位仍推进', () => {
    // ⚠ 没有可挂的目标 ⇒ **不产出**，但计量水位必须照常前进，
    //   否则玩家首胜后那段时间会被白白吞掉（`measuredAt` 不回退）。
    const save = makeSave()
    save.campaign.clearedStage = 0
    expect(resolveChannelTarget(save, 'main', { kind: 'main', stageId: null })).toBeNull()

    const result = settleIdleChannels(save, settleCtx(NOW + 60_000))
    expect(result.channels).toHaveLength(0)
    expect(result.rolls).toBe(0)
    expect(save.idle.channels.main.measuredAt).toBe(NOW + 60_000)
  })

  it('主线指定模式：只能选**已通关**的关卡', () => {
    const save = makeSave() // clearedStage = 5
    expect(resolveChannelTarget(save, 'main', { kind: 'main', stageId: 3 })).not.toBeNull()
    // 未通关的关卡挂上去 ⇒ 挂机就会卡在打不通的关卡上（永不卡关是根本保证）
    expect(resolveChannelTarget(save, 'main', { kind: 'main', stageId: 6 })).toBeNull()
    expect(resolveChannelTarget(save, 'main', { kind: 'main', stageId: 0 })).toBeNull()
  })

  it('副本通道：目标必须属于该通道种类', () => {
    // ⚠ 技能通道挂强化副本 ⇒ 结算会按错误的产出物发奖（口径串了）。
    const save = makeSave()
    save.dungeons.cleared[ENHANCE_T1_EASY] = true
    expect(
      resolveChannelTarget(save, 'skill', { kind: 'skill', dungeonStageId: ENHANCE_T1_EASY }),
    ).toBeNull()
  })

  it('副本通道：目标必须**已通关**', () => {
    const save = makeSave()
    expect(
      resolveChannelTarget(save, 'skill', { kind: 'skill', dungeonStageId: SKILL_EARTH_EASY }),
    ).toBeNull()
    save.dungeons.cleared[SKILL_EARTH_EASY] = true
    const target = resolveChannelTarget(save, 'skill', {
      kind: 'skill',
      dungeonStageId: SKILL_EARTH_EASY,
    })
    expect(target).not.toBeNull()
    expect(target!.dungeonStageId).toBe(SKILL_EARTH_EASY)
    expect(target!.dropTableId).toBeNull()
    expect(target!.drop!.itemId).toBe('skillMatEarth')
  })
})

// ─────────────────────────── 计量与发奖 ───────────────────────────

describe('计量与发奖', () => {
  it('余数保留：不足一次时不发奖，余数留在预算里', () => {
    // ⚠ 历史教训：旧版把「不足一场的毫秒」直接抹掉，
    //   玩家每 6 秒以下就领一次 ⇒ 收益被系统吃掉。
    const save = makeSave()
    const ch = save.idle.channels.main
    ch.target = { kind: 'main', stageId: 5 }

    const first = settleIdleChannels(save, settleCtx(NOW + 3_000))
    expect(first.rolls).toBe(0)
    expect(first.channels).toHaveLength(0)
    expect(ch.effectiveMs).toBe(3_000)

    // 再过 3 秒 → 凑满一次
    const second = settleIdleChannels(save, settleCtx(NOW + 6_000))
    expect(second.rolls).toBe(1)
    expect(ch.effectiveMs).toBe(0)
  })

  it('发奖扣账：结算后预算减去本次消耗的次数 × ROLL_MS', () => {
    const save = makeSave()
    const ch = save.idle.channels.main
    ch.target = { kind: 'main', stageId: 5 }

    settleIdleChannels(save, settleCtx(NOW + 65_000))
    // 65 秒 → 10 次（60 秒），余 5 秒留在预算里
    expect(ch.effectiveMs).toBe(65_000 - 10 * ROLL)
    expect(idleChannelRolls(ch)).toBe(0)
    expect(idleChannelRemainingMs(ch)).toBe(5_000)
  })

  it('单次结算有次数上限（maxRolls），剩下的预算留到下次', () => {
    // ⚠ 防卡顿 / 防造币：一次结算最多掷 IDLE.MAX_ROLLS_PER_SETTLEMENT 次。
    const save = makeSave()
    const ch = save.idle.channels.main
    ch.target = { kind: 'main', stageId: 5 }

    const result = settleIdleChannels(save, settleCtx(NOW + 600_000), { maxRolls: 3 })
    expect(result.rolls).toBe(3)
    // 未结算的部分仍然留在预算里（不是被没收）
    expect(ch.effectiveMs).toBe(600_000 - 3 * ROLL)
    expect(IDLE.MAX_ROLLS_PER_SETTLEMENT).toBe(2000)
  })

  it('时钟回退：该通道不计量，水位保持原值', () => {
    // ⚠ 时钟回退（客户端改系统时间 / 跨时区）不能让水位倒退，
    //   否则那段被"回退"掉的时间会在下次结算里被重复计算。
    const save = makeSave()
    const ch = save.idle.channels.main
    ch.target = { kind: 'main', stageId: 5 }

    const result = settleIdleChannels(save, settleCtx(NOW - 60_000))
    expect(result.rolls).toBe(0)
    expect(result.channels).toHaveLength(0)
    expect(ch.measuredAt).toBe(NOW)
    expect(ch.effectiveMs).toBe(0)
  })

  it('时钟回退：**已挣到的预算不会被清空**，下一次前进结算照发', () => {
    // ⚠ 这是 core 的真实行为（`measureChannel` 回退时直接 return，不动预算）：
    //   回退只保证「不计量、不改水位」，**不清空已结算出来的存量预算**。
    //   若这条行为被改成清空，玩家改一次系统时间就能吞掉自己的收益。
    const save = makeSave()
    const ch = save.idle.channels.main
    ch.target = { kind: 'main', stageId: 5 }

    settleIdleChannels(save, settleCtx(NOW + 60_000))
    expect(ch.effectiveMs).toBe(0)

    // 攒 5 秒（不足一次），然后时钟回退
    settleIdleChannels(save, settleCtx(NOW + 65_000))
    expect(ch.effectiveMs).toBe(5_000)
    const measuredAt = ch.measuredAt
    settleIdleChannels(save, settleCtx(NOW + 10_000))
    expect(ch.measuredAt).toBe(measuredAt)
    expect(ch.effectiveMs).toBe(5_000)
  })

  it('通道关闭：target = null 时不计量、不产出，预算与离线累计归零', () => {
    const save = makeSave()
    const ch = save.idle.channels.skill
    ch.target = null
    // 模拟"曾经攒下的预算"
    ch.effectiveMs = 60_000
    ch.offlineElapsedMs = 120_000

    const result = settleIdleChannels(save, settleCtx(NOW + 60_000))
    // 关着的通道不产出（主线通道是开着的，与本条无关）
    expect(result.channels.find((c) => c.channel === 'skill')).toBeUndefined()
    expect(ch.effectiveMs).toBe(0)
    expect(ch.offlineElapsedMs).toBe(0)
  })

  it('心跳只计量、不发奖（铁律 #33）', () => {
    // ⚠ 心跳每 5 秒来一次，如果每次都发奖 ⇒ 玩家在线时结算面板会被刷爆，
    //   而且心跳会变成"结算入口"（服务端两套发奖路径）。
    const save = makeSave()
    const ch = save.idle.channels.main
    ch.target = { kind: 'main', stageId: 5 }
    const silverBefore = save.player.silver

    expect(measureIdleChannels(save, NOW + 10_000)).toBe(true)
    expect(save.player.silver).toBe(silverBefore)
    // 计量照常发生（10 秒离线）
    expect(ch.effectiveMs).toBe(10_000)
  })

  it('在线时段按 3 倍计入预算（在线租约由服务端发放）', () => {
    // ⚠ 在线租约 `save.idle.activeUntil` 是服务端给的未来凭证：
    //   租约内的时长按 ONLINE_MULTIPLIER 计，离线时长按离线曲线计。
    const save = makeSave()
    const ch = save.idle.channels.main
    ch.target = { kind: 'main', stageId: 5 }
    // 服务端发放的在线租约（心跳的动作层会续约，这里直接模拟租约已生效）
    save.idle.activeUntil = NOW + 60_000

    const result = settleIdleChannels(save, settleCtx(NOW + 10_000))
    // 10 秒在线 × 3 倍 = 30 秒预算 ⇒ 5 次
    expect(result.rolls).toBe(5)
    expect(ch.effectiveMs).toBe(0)
  })
})

// ─────────────────────────── 分批领取 == 一次领取 ───────────────────────────

describe('分批领取 == 一次领取', () => {
  it('同一目标、同一 seed：分 6 次领与一次领的产出总量一致', () => {
    // ⚠ 玩家最常见的操作是"每隔一会儿点一下领取"。
    //   如果分批领取会少发（每次都按整段曲线重新折算 / 余数被抹），
    //   玩家就会感觉"挂着不如不挂"。
    //
    // ⚠ 对比时**随机序列必须连续**：分批领取用的是**同一条**随机序列
    //   （存档里的 rng 计数器只前进不复现，铁律 #24），
    //   所以这里刻意共用一个 Rng 实例，而不是每段重新播种。
    const one = makeSave()
    one.idle.channels.main.target = { kind: 'main', stageId: 5 }
    const oneResult = settleIdleChannels(one, settleCtx(NOW + HOUR, 1234))

    const split = makeSave()
    split.idle.channels.main.target = { kind: 'main', stageId: 5 }
    const splitRng = new Rng(1234)
    const parts: RewardBundle[] = []
    for (let i = 1; i <= 6; i++) {
      const res = settleIdleChannels(split, { now: NOW + (HOUR / 6) * i, rng: splitRng })
      parts.push(...res.channels.map((c) => c.rewards))
    }

    expect(oneResult.rolls).toBe(600)
    const oneMerged = mergeAll(oneResult.channels.map((c) => c.rewards))
    const splitMerged = mergeAll(parts)
    expect(splitMerged.silver).toBe(oneMerged.silver)
    expect(splitMerged.items).toEqual(oneMerged.items)
    // 两边的总时长也一致（离线曲线是同一条，分段积分 == 一次积分）
    expect(one.idle.totalIdleSeconds).toBe(split.idle.totalIdleSeconds)
  })

  it('分批领取不会把同一段时间重复计算', () => {
    const save = makeSave()
    save.idle.channels.main.target = { kind: 'main', stageId: 5 }
    const first = settleIdleChannels(save, settleCtx(NOW + 60_000))
    expect(first.rolls).toBe(10)
    // 同一时刻再领一次 ⇒ 没有任何新时间可计量
    const second = settleIdleChannels(save, settleCtx(NOW + 60_000))
    expect(second.rolls).toBe(0)
    expect(second.channels).toHaveLength(0)
  })
})

// ─────────────────────────── 掉落口径 ───────────────────────────

describe('掉落口径：主线不再发遗物', () => {
  it('主线掷奖只产出银两 + 经验书，rewards.relics 不含遗物', () => {
    // ⚠ 历史 bug：遗物只放进 core 的旁路数组 `newRelics`，`rewards.relics` 从未被赋值，
    //   而表现层的 `applyRewards` 只读 `rewards` ⇒ 挂机/离线的遗物 100% 被丢弃。
    //   挂机改版 v11 把遗物移出掉落表，这条锁死"遗物不走挂机"这条新口径。
    const save = makeSave()
    save.idle.channels.main.target = { kind: 'main', stageId: 5 }
    const result = settleIdleChannels(save, settleCtx(NOW + HOUR))

    expect(result.rolls).toBe(600)
    for (const detail of result.channels) {
      expect(detail.rewards.relics ?? []).toEqual([])
      expect(detail.rewards.heroes ?? []).toEqual([])
    }
    const main = result.channels.find((c) => c.channel === 'main')!
    expect(main.rewards.silver).toBeGreaterThan(0)
    for (const id of Object.keys(main.rewards.items ?? {})) {
      expect(isExpBook(id as never), `主线掉落表混进了 ${id}`).toBe(true)
    }
  })

  it('单次掷奖（rollMainDrop）同样不带遗物', () => {
    const stage = STAGE_INDEX.get(5)!
    const rolled = rollMainDrop(stage, new Rng(3))
    expect(rolled.relics).toBeUndefined()
    expect(rolled.silver).toBeGreaterThanOrEqual(0)
  })

  it('副本掷奖只发该关卡的材料，不发银两 / 经验书', () => {
    // ⚠ 铁律 #26 的反面：掉落口径只有一份（`rewards`），
    //   副本材料绝不能混进主线的银两/经验书通道。
    const stage = dungeonStageById(SKILL_EARTH_EASY)!
    const rolled = rollDungeonDrop(stage, new Rng(3))
    expect(Object.keys(rolled.items ?? {})).toEqual(['skillMatEarth'])
    expect(rolled.silver).toBeUndefined()
    expect(rolled.relics).toBeUndefined()
    const count = rolled.items!.skillMatEarth!
    expect(count).toBeGreaterThanOrEqual(stage.drop.min)
    expect(count).toBeLessThanOrEqual(stage.drop.max)
  })

  it('通道掷奖按次数累计（rollChannelRewards）', () => {
    const save = makeSave()
    save.dungeons.cleared[SKILL_EARTH_EASY] = true
    const target = resolveChannelTarget(save, 'skill', {
      kind: 'skill',
      dungeonStageId: SKILL_EARTH_EASY,
    }) as ResolvedChannelTarget
    const stage = dungeonStageById(SKILL_EARTH_EASY)!
    const rolled = rollChannelRewards(target, 10, new Rng(9))
    const total = rolled.items!.skillMatEarth!
    expect(total).toBeGreaterThanOrEqual(10 * stage.drop.min)
    expect(total).toBeLessThanOrEqual(10 * stage.drop.max)
  })
})

// ─────────────────────────── 起始资源（回归护栏） ───────────────────────────

describe('新号起始资源', () => {
  it('起始银两 / 结晶与配置一致（挂机改版没动钱包口径）', () => {
    // ⚠ 铁律 #5：数值只在 economy.ts 一处定义；这里只是防止"两处各写一份"。
    const save = createNewSave(NOW, 1)
    expect(save.player.silver).toBe(START_RESOURCES.silver)
    expect(save.player.crystals).toBe(START_RESOURCES.crystals)
  })

  it('经验书 id 仍是那两个（掉落表与经验口径共用一份登记）', () => {
    expect(EXP_BOOK.small.id).toBe('expBookSmall')
    expect(EXP_BOOK.large.id).toBe('expBookLarge')
  })
})
