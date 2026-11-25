/**
 * 挂机与离线结算（§5.7 · **挂机改版 v11 + 遗物副本 v12**）。
 *
 * ## 四通道并行 + 已通关直挂
 *
 * - **主线 / 技能副本 / 强化副本 / 遗物副本各自一条独立通道**，
 *   各自计量同一段墙钟时间、各自记账，产出互不干扰（玩家可同时挂四条）。
 * - **挂机不再跑战斗**：通道目标必须是「已通关」的内容，
 *   结算时按掉落表**逐次掷奖**直接入库 ⇒ 永不卡关、不会战败、不会空转。
 * - 主线推进改为**纯手动挑战**（`campaign.challenge`）；
 *   副本同样要手动挑战通关才可挂机（`dungeon.challenge`）。
 * - **遗物通道**（存档 v12）产出遗物实例，并受**每日额度**约束
 *   （`RELIC_DROP.DAILY_CAP`）——遗物是零成本产出，没有额度就是印钞机。
 *
 * ## 离线收益曲线（⚠ 数值一律读 `IDLE` 配置，此处只描述**结构**）
 *
 *   t ≤ FULL_EFFICIENCY_HOURS → 100%
 *   满效率 < t ≤ CAP_HOURS     → 线性衰减 100% → TAIL_RATE
 *   t > CAP_HOURS              → 封顶（按 CAP_HOURS 的平均尾部效率结算）
 *
 * ⚠ 实施修正（roadmap P1-2 难度曲线重标定）：满效率由 8h 收窄到 1h、封顶由 12h 收到 3h。
 *   原值下「一天的挂机预算」是整个游戏内容量的 4~5 倍 ⇒ 新号首日顶格、经济贬值。
 *
 * 在线效率恒定为离线的 3 倍（IDLE.ONLINE_MULTIPLIER）。
 */
import type {
  IdleChannelKind,
  IdleChannelState,
  IdleChannelTarget,
  RewardBundle,
  SaveData,
  StageDef,
} from '../model/types.ts'
import { IDLE_CHANNEL_KINDS } from '../model/types.ts'
import { IDLE, DROP_TABLES, type DungeonDifficultyId } from '../config/economy.ts'
import { STAGE_INDEX } from '../config/stages.ts'
import {
  DUNGEON_INDEX,
  DUNGEON_STAGE_INDEX,
  dungeonStageById,
  type DungeonStageDef,
} from '../config/dungeons.ts'
import { Rng } from '../rng.ts'
import { emptyOverflow, type InventoryOverflowResult } from './inventory.ts'
import { recordRelicOutput, relicQuotaLeft, rollRelicDrop } from './relic.ts'

/** 四条通道的固定顺序（遍历顺序 = 界面展示顺序 = 锚点表顺序） */
export { IDLE_CHANNEL_KINDS }

/**
 * 离线效率（0..1）：把真实时长折算成"满效率等价时长"。
 */
export function computeOfflineEfficiency(seconds: number): number {
  const hours = Math.max(0, seconds) / 3600
  const { FULL_EFFICIENCY_HOURS, CAP_HOURS, TAIL_RATE } = IDLE
  if (hours <= FULL_EFFICIENCY_HOURS) return hours
  if (hours >= CAP_HOURS) {
    const tailHours = CAP_HOURS - FULL_EFFICIENCY_HOURS
    const tailAvg = (1 + TAIL_RATE) / 2
    return FULL_EFFICIENCY_HOURS + tailHours * tailAvg
  }
  const tailHours = hours - FULL_EFFICIENCY_HOURS
  const rateAtEnd = 1 - (1 - TAIL_RATE) * tailHours / (CAP_HOURS - FULL_EFFICIENCY_HOURS)
  const tailAvg = (1 + rateAtEnd) / 2
  return FULL_EFFICIENCY_HOURS + tailHours * tailAvg
}

/** 折算后的有效挂机时长（秒） */
export function offlineEffectiveSeconds(seconds: number): number {
  return computeOfflineEfficiency(seconds) * 3600
}

/** 满效率上限：CAP_HOURS（现 3 小时）封顶，超出部分不再产出 */
export const OFFLINE_CAP_SECONDS = IDLE.CAP_HOURS * 3600

/** 单次掷奖的毫秒数（挂机节奏单位） */
export const ROLL_MS = IDLE.SECONDS_PER_ROLL * 1000

// ─────────────────────────── 通道目标 ───────────────────────────

/**
 * **已解析的通道目标**（结算时的唯一事实）。
 *
 * ⚠ 目标**必须已通关**——这是「挂机永不卡关」的根本保证。
 */
export interface ResolvedChannelTarget {
  kind: IdleChannelKind
  /** 目标显示名（主线取关卡名，副本取副本关卡名） */
  name: string
  /** 主线：关卡 id（跟随模式下取当前已通关的最高关） */
  stageId: number | null
  /** 副本：副本关卡 id */
  dungeonStageId: string | null
  /** 主线：掉落表 id */
  dropTableId: string | null
  /** 副本：每胜产量（遗物副本为 `null`——遗物是实例，不是堆叠物） */
  drop: { itemId: string; min: number; max: number } | null
  /** 遗物通道：候选遗物池（遗物定义 id）；其余通道为 `null` */
  relicPool: readonly string[] | null
  /** 遗物通道：难度档（决定稀有度权重与件数）；其余通道为 `null` */
  difficulty: DungeonDifficultyId | null
}

/**
 * 解析通道目标。
 *
 * - **主线跟随模式**（`stageId = null`）：取 `campaign.clearedStage`。
 *   首胜前（`clearedStage = 0`）没有可挂的目标 ⇒ 返回 `null`（不计收益）。
 * - **主线指定模式**：必须**已通关**（`stageId ≤ clearedStage`）且是合法关卡。
 * - **副本**：必须属于该通道种类，且**已记录通关**（`dungeons.cleared`）。
 *
 * @returns 解析失败返回 `null`（通道停止计量与产出）
 */
export function resolveChannelTarget(
  save: SaveData,
  kind: IdleChannelKind,
  target: IdleChannelTarget | null,
): ResolvedChannelTarget | null {
  if (!target) return null

  if (target.kind === 'main') {
    if (kind !== 'main') return null
    const stageId = target.stageId ?? save.campaign.clearedStage
    // 首胜前没有可挂的目标
    if (!Number.isSafeInteger(stageId) || stageId <= 0) return null
    const stage = STAGE_INDEX.get(stageId)
    if (!stage) return null
    // 指定模式：只接受**已通关**的关卡（跟随模式天然满足）
    if (target.stageId !== null && target.stageId > save.campaign.clearedStage) return null
    return {
      kind: 'main',
      name: stage.name,
      stageId,
      dungeonStageId: null,
      dropTableId: stage.dropTableId,
      drop: null,
      relicPool: null,
      difficulty: null,
    }
  }

  if (target.kind === 'skill') {
    if (kind !== 'skill') return null
    return resolveDungeonTarget(save, kind, target.dungeonStageId)
  }

  // ⚠ 遗物通道（存档 v12）：**第四个**副本通道。
  //   ⚠ 这里不能写成 `if (kind !== 'enhance') return null`——
  //   那会让遗物通道的目标**静默解析失败**（通道被清空、玩家以为没挂上）。
  if (target.kind === 'relic') {
    if (kind !== 'relic') return null
    return resolveDungeonTarget(save, kind, target.dungeonStageId)
  }

  if (kind !== 'enhance') return null
  return resolveDungeonTarget(save, kind, target.dungeonStageId)
}

/** 副本通道的目标解析（技能 / 强化 / 遗物共用） */
function resolveDungeonTarget(
  save: SaveData,
  kind: IdleChannelKind,
  dungeonStageId: string,
): ResolvedChannelTarget | null {
  const stage = dungeonStageById(dungeonStageId)
  if (!stage) return null
  const variant = DUNGEON_INDEX.get(stage.variantId)
  if (!variant || variant.kind !== kind) return null
  // 副本必须**已通关**才可挂机
  if (save.dungeons.cleared[stage.id] !== true) return null
  const isRelic = kind === 'relic'
  return {
    kind,
    name: stage.name,
    stageId: null,
    dungeonStageId: stage.id,
    dropTableId: null,
    // ⚠ 遗物副本的 `drop` 为 `null`（遗物是实例，不是堆叠物）
    drop: stage.drop
      ? { itemId: stage.drop.itemId, min: stage.drop.min, max: stage.drop.max }
      : null,
    relicPool: isRelic ? stage.relicPool : null,
    difficulty: isRelic ? stage.difficulty : null,
  }
}

// ─────────────────────────── 掷奖 ───────────────────────────

/**
 * 按关卡掉落表**掷一次**奖励（主线口径）。
 *
 * ⚠ **实施修正（挂机改版 v11）**：主线掉落表**移除遗物掉落**——
 *   遗物改走独立获取入口（§1.3），挂机与手动挑战都不再发遗物。
 *
 * ⚠ 每类道具**各自独立**掷一次概率（见 `economy.ts` 的 `ItemDrop`）。
 */
export function rollMainDrop(stage: StageDef, rng: Rng): RewardBundle {
  const table = DROP_TABLES[stage.dropTableId]
  const rewards: RewardBundle = {}
  if (!table) return rewards

  rewards.silver = rng.int(table.silver[0], table.silver[1])

  if (table.items.length > 0) {
    const items: Record<string, number> = {}
    for (const drop of table.items) {
      if (rng.next() * 100 >= drop.chance) continue
      const count = rng.int(drop.min, drop.max)
      if (count <= 0) continue
      items[drop.id] = (items[drop.id] ?? 0) + count
    }
    if (Object.keys(items).length > 0) {
      rewards.items = items as RewardBundle['items']
    }
  }
  return rewards
}

/**
 * 按副本关卡产量**掷一次**奖励（必掉，落在 `min ~ max` 区间）。
 *
 * ⚠ 副本掉落**只发所选材料**：不发银两 / 经验书 / 遗物 / 首通结晶。
 * ⚠ 遗物副本的 `drop` 为 `null`（遗物是实例）⇒ 这里**直接返回空包**，
 *   遗物走 `rollRelicChannelRewards`。
 */
export function rollDungeonDrop(
  stage: DungeonStageDef,
  rng: Rng,
): RewardBundle {
  if (!stage.drop) return {}
  const count = rng.int(stage.drop.min, stage.drop.max)
  if (count <= 0) return {}
  return { items: { [stage.drop.itemId]: count } as RewardBundle['items'] }
}

/**
 * 一次通道掷奖的**结果**。
 *
 * ⚠ `rolls` 是**实际掷出的次数**（可能小于请求次数：遗物通道额度不足时会提前收手）。
 */
export interface ChannelRollOutcome {
  /** 本次产出（唯一入库口径） */
  rewards: RewardBundle
  /** 遗物保底计数（仅遗物通道有值；其余通道原样回传） */
  pity: number
  /** 实际掷奖次数 */
  rolls: number
}

/**
 * **遗物通道的逐次掷奖**（每日额度感知）。
 *
 * ⚠ **额度按「件」计**（`RELIC_DROP.DAILY_CAP`），不是按「次」——
 *   hard 档一次掷奖可能出 2~3 件 ⇒ 只能**逐次掷、逐件扣**，
 *   最后一次用 `maxRelics` 裁剪，裁到 0 件就收手（剩下的预算不扣）。
 *
 * ⚠ **额度用满 ≠ 目标失效**：目标不清空，玩家第二天照常领取。
 */
function rollRelicChannelRewards(
  target: ResolvedChannelTarget,
  rolls: number,
  rng: Rng,
  pity: number,
  maxRelics: number,
): ChannelRollOutcome {
  const rewards: RewardBundle = {}
  if (!target.relicPool || target.relicPool.length === 0 || !target.difficulty) {
    return { rewards, pity, rolls: 0 }
  }
  let curPity = pity
  let produced = 0
  let used = 0
  for (let i = 0; i < rolls; i++) {
    const remaining = maxRelics - produced
    if (remaining <= 0) break
    const rolled = rollRelicDrop(target.relicPool, target.difficulty, rng, curPity, remaining)
    if (rolled.defIds.length === 0) break
    curPity = rolled.pity
    produced += rolled.defIds.length
    used += 1
    rewards.relics = [...(rewards.relics ?? []), ...rolled.defIds]
  }
  return { rewards, pity: curPity, rolls: used }
}

/**
 * 通道的**逐次掷奖**（挂机不跑战斗，这里只按掉落表掷骰）。
 *
 * @param rolls 掷奖次数
 * @param options 遗物通道专用：`pity` = 保底计数，`maxRelics` = 剩余额度（件）
 */
export function rollChannelRewards(
  target: ResolvedChannelTarget,
  rolls: number,
  rng: Rng,
  options: { pity?: number; maxRelics?: number } = {},
): ChannelRollOutcome {
  if (target.kind === 'relic') {
    return rollRelicChannelRewards(
      target,
      rolls,
      rng,
      options.pity ?? 0,
      options.maxRelics ?? Number.POSITIVE_INFINITY,
    )
  }
  const rewards: RewardBundle = {}
  for (let i = 0; i < rolls; i++) {
    const one =
      target.kind === 'main'
        ? rollMainDrop(STAGE_INDEX.get(target.stageId!)!, rng)
        : rollDungeonDrop(DUNGEON_STAGE_INDEX.get(target.dungeonStageId!)!, rng)
    mergeRewardBundles(rewards, one)
  }
  return { rewards, pity: options.pity ?? 0, rolls }
}

/**
 * 奖励包**通用聚合**（**唯一一份口径**，铁律 #4 / #26）。
 *
 * ⚠ 遍历奖励包本身，新增资源类型自动出现在明细里——
 *   旧实现硬编码键数组 `['silver','exp','skillStones',…]`，
 *   新增的 `items`（经验书 / 五行材料 / 强化石）根本不会出现在结算面板里。
 */
export function mergeRewardBundles(target: RewardBundle, source: RewardBundle): RewardBundle {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (key === 'relics' || key === 'heroes') {
      const list = value as string[]
      if (list.length === 0) continue
      const bucket = (target[key] as string[] | undefined) ?? []
      bucket.push(...list)
      target[key as 'relics' | 'heroes'] = bucket
      continue
    }
    if (key === 'shards') {
      const bucket = { ...(target.shards ?? {}) }
      for (const [k, v] of Object.entries(value as Record<string, number>)) {
        bucket[k] = (bucket[k] ?? 0) + v
      }
      target.shards = bucket
      continue
    }
    if (key === 'items') {
      const bucket = { ...(target.items ?? {}) }
      for (const [k, v] of Object.entries(value as Record<string, number>)) {
        bucket[k as keyof typeof bucket] = (bucket[k as keyof typeof bucket] ?? 0) + v
      }
      target.items = bucket
      continue
    }
    const num = value as number
    target[key as 'silver' | 'crystals'] = ((target[key as 'silver' | 'crystals'] as number | undefined) ?? 0) + num
  }
  return target
}

// ─────────────────────────── 计量与结算 ───────────────────────────

/** 结算所需的最小上下文（时间与随机都由调用方注入，铁律 #1） */
export interface IdleSettleContext {
  /** 当前时间（毫秒） */
  now: number
  /**
   * 全局权威随机序列（抽卡 / 战斗用）。
   *
   * ⚠ **挂机掷奖不用它**——挂机走**每条通道各自的持久化序列**
   *   （`save.rng.channels[kind]`，挂机改版 v11 · 设计稿 §3.3）。
   *   保留这个字段是为了动作层的统一上下文形状。
   */
  rng: Rng
}

/**
 * 取一条通道**自己的**随机序列（挂机改版 v11）。
 *
 * ⚠ 状态住在 `save.rng.channels[kind]`（私有随机块，随存档落盘）——
 *   计数器必须落盘，否则刷新页面就回到序列开头（铁律 #24）。
 *
 * ⚠ 缺字段时按根种子补一条（畸形存档兜底），保证不会退化成「所有人同一条序列」。
 */
function channelRngOf(save: SaveData, kind: IdleChannelKind): Rng {
  const state = save.rng.channels?.[kind]
  if (!state) return new Rng(0x9e3779b9)
  return Rng.fromSnapshot(state.seed, state.counter)
}

/**
 * **单条通道的一次结算明细**。
 */
export interface ChannelSettlement {
  channel: IdleChannelKind
  /** 目标显示名（由关卡登记表提供） */
  targetName: string
  /** 实际结算次数 */
  rolls: number
  /** 本次产出（**唯一入库口径**） */
  rewards: RewardBundle
  /** 本次结算覆盖的实际离线时长（秒） */
  elapsedSeconds: number
}

/**
 * **离线结算结果**（四通道明细）。
 *
 * ⚠ 只含**本次有产出**的通道；无产出的通道不出现（界面据此分段展示）。
 */
export interface OfflineSettlementResult {
  /** 四通道明细（只含本次有产出的通道） */
  channels: ChannelSettlement[]
  /** 本次结算总次数 */
  rolls: number
  /** 本次覆盖的最长实际离线时长（秒）——离线弹窗的阈值判定用 */
  elapsedSeconds: number
  /** 库存溢出处理结果（仓库超限时自动分解） */
  overflow: InventoryOverflowResult
}

export interface SettleOptions {
  /** 单通道结算次数上限（默认 `IDLE.MAX_ROLLS_PER_SETTLEMENT`） */
  maxRolls?: number
  /** 是否发奖（心跳只计量、不发奖 ⇒ `false`） */
  payout?: boolean
  /** 只结算这一条通道（切换通道时只结清那一条） */
  only?: IdleChannelKind
}

/**
 * 计量**单条通道**的时间预算（原地改存档）。
 *
 * ⚠ 只计量、不发奖。
 *
 * @param active 通道是否**有有效目标**（无目标 = 不计收益）
 * @returns 本次累计的离线时长（毫秒）；时钟回退时返回 0 且水位不动
 */
function measureChannel(
  save: SaveData,
  ch: IdleChannelState,
  now: number,
  active: boolean,
): number {
  const from = ch.measuredAt
  // ⚠ 时钟回退：本次不计量、不产出，水位保持原值
  if (now < from) return 0
  const elapsedMs = now - from
  ch.measuredAt = now

  if (!active) {
    // 未启用 / 目标失效：不计收益，离线曲线从此刻重新起算
    ch.offlineElapsedMs = 0
    ch.effectiveMs = 0
    return 0
  }
  if (elapsedMs <= 0) return 0

  const leaseUntil = save.idle.activeUntil ?? from
  const onlineMs = Math.max(0, Math.min(now, leaseUntil) - from)
  const offlineMs = elapsedMs - onlineMs
  // ⚠ 只有真的在线（onlineMs > 0）时才重置连续离线起点
  const oldOffline = onlineMs > 0 ? 0 : ch.offlineElapsedMs
  const effectiveOffline =
    (offlineEffectiveSeconds((oldOffline + offlineMs) / 1000) -
      offlineEffectiveSeconds(oldOffline / 1000)) * 1000
  ch.offlineElapsedMs = oldOffline + offlineMs
  ch.pendingOfflineMs += offlineMs
  const capMs = IDLE.CAP_HOURS * 3600 * 1000
  ch.effectiveMs = Math.min(
    capMs,
    ch.effectiveMs + onlineMs * IDLE.ONLINE_MULTIPLIER + effectiveOffline,
  )
  return offlineMs
}

/**
 * **结算四条挂机通道**（挂机改版 v11 + 遗物副本 v12 的核心入口）。
 *
 * 流程（设计稿 §3.6）：
 *   ① 解析目标 → ② 计量预算 → ③ 掷奖入库 → ④ 生成回执
 *
 * ⚠ 四条通道**各自独立**：一条通道的目标失效**不影响**另外三条。
 * ⚠ 时钟回退时**跳过该通道**，水位保持原值（不重发）。
 * ⚠ 无完整次数时**不发奖、不耗随机**。
 */
export function settleIdleChannels(
  save: SaveData,
  ctx: IdleSettleContext,
  options: SettleOptions = {},
): OfflineSettlementResult {
  const maxRolls = options.maxRolls ?? IDLE.MAX_ROLLS_PER_SETTLEMENT
  const payout = options.payout ?? true

  const channels: ChannelSettlement[] = []
  let totalRolls = 0
  let maxOfflineSeconds = 0

  for (const kind of IDLE_CHANNEL_KINDS) {
    if (options.only && kind !== options.only) continue
    const ch = save.idle.channels[kind]
    const target = resolveChannelTarget(save, kind, ch.target)
    const offlineMs = measureChannel(save, ch, ctx.now, target !== null)
    if (!target) {
      // 失效目标：副本目标清空（主线跟随模式保留，等首胜后自然生效）
      if (kind !== 'main' && ch.target !== null) ch.target = null
      continue
    }
    if (!payout) continue

    const budgetRolls = Math.min(rollsFromEffectiveMs(ch.effectiveMs), maxRolls)
    if (budgetRolls <= 0) continue

    // ⚠ **遗物通道的每日额度**（防通胀闸门，铁律 #59）。
    //   遗物是**零成本**产出，而仓库溢出会自动分解折算成银两
    //   ⇒ 没有额度，挂机遗物通道就是印钞机。
    //
    //   ⚠ 额度按「件」计 ⇒ 掷奖次数只能取 `min(预算次数, 剩余额度)`：
    //     每次掷奖至少出 1 件，所以剩余额度就是次数的**上界**。
    //   ⚠ **额度用满 ≠ 目标失效**：这里**不能**清空 `ch.target`
    //     （否则玩家每天都要重设一次挂机目标）。
    const quotaLeft = kind === 'relic' ? relicQuotaLeft(save, ctx.now) : Number.POSITIVE_INFINITY
    const rolls = kind === 'relic' ? Math.min(budgetRolls, quotaLeft) : budgetRolls
    if (rolls <= 0) continue

    // ⚠ **挂机改版 v11**：掷奖走**这条通道自己的随机序列**（不是全局序列）——
    //   开 / 关另一条通道不会改变本通道的掉落，
    //   「分批领取 == 一次领取」在每条通道各自成立（设计稿 §3.3 / §3.6）。
    const chanRng = channelRngOf(save, kind)
    const pityBefore =
      kind === 'relic' && target.dungeonStageId ? (save.relicPity[target.dungeonStageId] ?? 0) : 0
    const outcome = rollChannelRewards(target, rolls, chanRng, {
      pity: pityBefore,
      maxRelics: quotaLeft,
    })
    save.rng.channels[kind] = chanRng.snapshot()
    const usedRolls = outcome.rolls
    if (usedRolls <= 0) continue
    // 同一事务扣除本次消耗的预算
    // ⚠ 遗物通道可能因额度不足**少掷**几次 ⇒ 只扣实际掷出的那几次，
    //   剩下的预算留给明天（额度跨日重置后继续领）。
    ch.effectiveMs = Math.max(0, ch.effectiveMs - usedRolls * ROLL_MS)

    // ⚠ 遗物通道：保底计数与每日额度**同事务落盘**
    //   （刷新页面 / 换设备都不能重置，否则保底与额度形同虚设）。
    if (kind === 'relic' && target.dungeonStageId) {
      save.relicPity[target.dungeonStageId] = outcome.pity
      recordRelicOutput(save, ctx.now, outcome.rewards.relics?.length ?? 0)
    }

    const elapsedSeconds = ch.pendingOfflineMs / 1000
    ch.pendingOfflineMs = 0

    channels.push({
      channel: kind,
      targetName: target.name,
      rolls: usedRolls,
      rewards: outcome.rewards,
      elapsedSeconds,
    })
    totalRolls += usedRolls
    if (elapsedSeconds > maxOfflineSeconds) maxOfflineSeconds = elapsedSeconds
  }

  if (totalRolls > 0) {
    save.idle.totalIdleSeconds += totalRolls * IDLE.SECONDS_PER_ROLL
  }

  return {
    channels,
    rolls: totalRolls,
    elapsedSeconds: maxOfflineSeconds,
    overflow: emptyOverflow(),
  }
}

/**
 * **只计量、不发奖**（心跳用；铁律 #33：心跳保持轻量）。
 *
 * ⚠ 心跳只续租约、不发奖 ⇒ 计量结束后才续租。
 *
 * @returns 是否所有通道都可正常计量（**false** = 有通道时钟回退，不能续租）
 */
export function measureIdleChannels(save: SaveData, now: number): boolean {
  let measurable = true
  for (const kind of IDLE_CHANNEL_KINDS) {
    const ch = save.idle.channels[kind]
    if (now < ch.measuredAt) {
      // 时钟回退：本通道本次不计量，水位保持原值
      measurable = false
      continue
    }
    const target = resolveChannelTarget(save, kind, ch.target)
    measureChannel(save, ch, now, target !== null)
  }
  return measurable
}

/**
 * 有效毫秒 → 可结算次数（**展示与结算的唯一一份换算**，铁律 #4）。
 *
 * ⚠ 两处必须调用**同一个函数**：结算发多少，界面就得写多少。
 *   差一个 `+0.000001` 的浮点余数 ⇒ 界面写「0 次」、点下去发 1 次
 *   （玩家看到 0 却拿到东西，第一反应是「这按钮坏了」）。
 */
export function rollsFromEffectiveMs(effectiveMs: number): number {
  if (!Number.isFinite(effectiveMs) || effectiveMs <= 0) return 0
  return Math.floor((effectiveMs + 0.000001) / ROLL_MS)
}

/**
 * 某条通道当前**可结算的次数**（界面显示用；与结算口径同一份换算）。
 */
export function idleChannelRolls(ch: IdleChannelState): number {
  return rollsFromEffectiveMs(ch.effectiveMs)
}

/**
 * 四条通道的**待结算次数**（服务端账本口径）。
 *
 * ⚠ 界面显示的「可结算 N 次」**必须取这里**（服务端真相），
 *   **不能**读客户端镜像里的 `effectiveMs`：
 *   客户端镜像只在服务端回包时刷新，而服务端**回包前必先结算**
 *   ⇒ 镜像里的余额恒是「不足一次」的余数（< `IDLE.SECONDS_PER_ROLL`）
 *   ⇒ 界面永远显示「0 次」，而点下去服务端照发（数字自相矛盾）。
 *
 *   服务端的真相只有两处能拿到：**心跳回执**（实时）与**结算回执**（结算后）。
 *
 * ⚠ **遗物通道还要受每日额度约束**：`N = min(预算次数, 剩余额度)`。
 *   额度按「件」计、每次掷奖至少出 1 件 ⇒ 剩余额度就是次数的**上界**，
 *   所以这里写的 N **绝不超过**实发次数（铁律 #62：界面只能少写，不能多写）。
 */
export function idlePendingRolls(save: SaveData, now: number): Record<IdleChannelKind, number> {
  const out = {} as Record<IdleChannelKind, number>
  const quotaLeft = relicQuotaLeft(save, now)
  for (const kind of IDLE_CHANNEL_KINDS) {
    const rolls = idleChannelRolls(save.idle.channels[kind])
    out[kind] = kind === 'relic' ? Math.min(rolls, quotaLeft) : rolls
  }
  return out
}

/**
 * 某条通道的**有效预算剩余毫秒**（界面显示用）。
 */
export function idleChannelRemainingMs(ch: IdleChannelState): number {
  return Math.max(0, ch.effectiveMs)
}
