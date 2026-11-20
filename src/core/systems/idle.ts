/**
 * 挂机与离线结算（§5.7）。
 *
 * 离线收益曲线（⚠ 数值一律读 `IDLE` 配置，此处只描述**结构**）：
 *   t ≤ FULL_EFFICIENCY_HOURS → 100%
 *   满效率 < t ≤ CAP_HOURS     → 线性衰减 100% → TAIL_RATE
 *   t > CAP_HOURS              → 封顶（按 CAP_HOURS 的平均尾部效率结算）
 *
 * ⚠ 实施修正（roadmap P1-2 难度曲线重标定）：满效率由 8h 收窄到 1h、封顶由 12h 收到 3h。
 *   原值下「一天的挂机预算」是整个游戏内容量的 4~5 倍 ⇒ 新号首日顶格、经济贬值。
 *
 * 在线效率恒定为离线的 3 倍（IDLE.ONLINE_MULTIPLIER）。
 * 收益通过**回放真实战斗**结算，而非按时长线性发放——
 * 这样不会出现"挂机 12 小时打不过却照样领满"的割裂感。
 */
import type { BattleContext, BattleUnit, HeroRuntime, RewardBundle, StageDef } from '../model/types.ts'
import { BATTLE, DROP_TABLES, IDLE, RELIC } from '../config/economy.ts'
import { getStage } from '../config/stages.ts'
import { Rng } from '../rng.ts'
import { runBattle } from './battle.ts'
import { getTeamPower } from './team.ts'
import { getRelicMods, generateRelic } from './relic.ts'
import { emptyOverflow, type InventoryOverflowResult } from './inventory.ts'

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

export interface IdleRunResult {
  battles: number
  rewards: RewardBundle
  /** 战斗中推进到的最高关卡 */
  /** 本次真正打赢的最高关卡；全败/零场为null。 */
  lastClearedStage: number | null
  /** 下次应挑战的关卡，与通关进度明确区分。 */
  nextTargetStage: number
  reachedStage: number
  /** 卡住的关卡（战力不足） */
  blockedAtStage: number | null
  /** 新获得的遗物实例 id */
  newRelics: string[]
}

/**
 * 回放一段挂机战斗。
 *
 * @param team       编队英灵
 * @param startStage 起始关卡
 * @param battles    模拟场次
 * @param seed       随机种子
 */
export function runIdle(
  team: HeroRuntime[],
  startStage: number,
  battles: number,
  seed: number,
  onRelicFound?: (relicId: string) => void,
  ctx: BattleContext = { mode: 'pve', seed },
  autoAdvance = true,
): IdleRunResult {
  const rng = new Rng(seed)
  const rewards: RewardBundle = {}
  const shards: Record<string, number> = {}
  const newRelics: string[] = []

  let stageId = startStage
  let blockedAt: number | null = null
  let done = 0
  let lastClearedStage: number | null = null
  const limit = team.length === 0 ? 0 : Math.min(Math.max(0, Math.floor(battles)), IDLE.MAX_REPLAY_BATTLES)

  for (let i = 0; i < limit; i++) {
    const stage = getStage(stageId)
    const result = runBattle({
      allies: team,
      enemies: stage.enemyIds.map((id) => ENEMY_LOOKUP(id)),
      enemyScale: stage.enemyScale,
      ctx: { ...ctx, mode: 'pve', seed: seed + i },
    })

    done++

    if (!result.win) {
      // 卡关：停留在当前关卡，不再推进
      blockedAt = stageId
      break
    }

    lastClearedStage = stageId
    const drop = rollRewards(stage, rng)
    mergeRewards(rewards, drop.rewards, shards)
    for (const relicId of drop.relics) {
      newRelics.push(relicId)
      onRelicFound?.(relicId)
    }

    // 自动推进到下一关（若战力足够）
    const nextStageId = stageId + 1
    if (autoAdvance && nextStageId <= 310) {
      const next = getStage(nextStageId)
      const power = getTeamPower(team, ctx)
      if (power >= next.powerRequired) {
        stageId = nextStageId
      }
    }
  }

  if (Object.keys(shards).length > 0) rewards.shards = shards

  return {
    battles: done,
    rewards,
    reachedStage: lastClearedStage ?? startStage,
    lastClearedStage,
    nextTargetStage: stageId,
    blockedAtStage: blockedAt,
    newRelics,
  }
}

export interface OfflineSettlementResult {
  elapsedSeconds: number
  cappedSeconds: number
  efficiency: number
  battles: number
  rewards: RewardBundle
  blockedAtStage: number | null
  /** 本次真正打赢的最高关卡；全败/零场为null。 */
  lastClearedStage: number | null
  /** 下次应挑战的关卡，与通关进度明确区分。 */
  nextTargetStage: number
  reachedStage: number
  newRelics: string[]
  /**
   * 库存溢出处理结果（仓库超过上限时自动分解了最没用的遗物）。
   *
   * ⚠ **可见**：玩家必须看见「仓库满了，有 N 件被自动分解」，
   *   否则「掉落被悄悄吞掉」会被当成 bug。
   */
  overflow: InventoryOverflowResult
  /**
   * 副本结算明细（**只在挂机去向是副本时出现**）。
   *
   * ⚠ 副本战败要**直接给出「降一档难度」的建议**
   *   （设计稿「副本失败给出可刷的低难度选择」）。
   */
  dungeon?: {
    /** 产出的道具 id */
    itemId: string
    /** 战败发生在第几场（1 起） */
    blockedAtBattle: number | null
    /** 建议降到的难度（已最低时为 null） */
    suggestDifficulty: string | null
  }
}

/**
 * 离线结算。
 *
 * @param elapsedSeconds 距上次 tick 的秒数
 */
export function settleOffline(
  team: HeroRuntime[],
  currentStage: number,
  elapsedSeconds: number,
  seed: number,
  ctx: BattleContext = { mode: 'pve', seed },
  autoAdvance = true,
): OfflineSettlementResult {
  const capped = Math.min(Math.max(0, elapsedSeconds), OFFLINE_CAP_SECONDS)
  const effective = offlineEffectiveSeconds(capped)
  const rawBattles = Math.floor(effective / BATTLE.SECONDS_PER_BATTLE)
  const battles = Math.min(rawBattles, IDLE.MAX_REPLAY_BATTLES)

  if (battles <= 0 || team.length === 0) {
    return {
      elapsedSeconds,
      cappedSeconds: capped,
      efficiency: computeOfflineEfficiency(elapsedSeconds) / Math.max(1, elapsedSeconds / 3600),
      battles: 0,
      rewards: {},
      blockedAtStage: null,
      reachedStage: currentStage,
      lastClearedStage: null,
      nextTargetStage: currentStage,
      newRelics: [],
      overflow: emptyOverflow(),
    }
  }

  const run = runIdle(team, currentStage, battles, seed, undefined, ctx, autoAdvance)

  return {
    elapsedSeconds,
    cappedSeconds: capped,
    efficiency: computeOfflineEfficiency(elapsedSeconds) / Math.max(1, elapsedSeconds / 3600),
    battles: run.battles,
    rewards: run.rewards,
    blockedAtStage: run.blockedAtStage,
    reachedStage: run.reachedStage,
    lastClearedStage: run.lastClearedStage,
    nextTargetStage: run.nextTargetStage,
    newRelics: run.newRelics,
    overflow: emptyOverflow(),
  }
}


// ─────────────────────────── 掉落 ───────────────────────────

interface RollResult {
  rewards: RewardBundle
  relics: string[]
}

/**
 * 按关卡掉落表结算一次战斗的收益。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：经验池退役 → 掉落**经验书**；
 *   术式结晶 / 遗物强化石 / 英灵印记退役 → 不再投放。
 *   掉落表里每一类道具**各自独立**掷一次概率（见 `economy.ts` 的 `ItemDrop`）。
 */
export function rollRewards(stage: StageDef, rng: Rng): RollResult {
  const table = DROP_TABLES[stage.dropTableId]
  const rewards: RewardBundle = {}
  const relics: string[] = []

  if (!table) return { rewards, relics }

  rewards.silver = rng.int(table.silver[0], table.silver[1])

  // 堆叠道具：各自独立掷概率（概率 × 数量 = 期望产量）
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

  // 遗物掉落：按稀有度权重抽取
  const totalWeight = table.relicDrop.reduce((s, r) => s + r.weight, 0)
  let roll = rng.next() * totalWeight
  let chosen = table.relicDrop[0]
  for (const entry of table.relicDrop) {
    roll -= entry.weight
    if (roll < 0) {
      chosen = entry
      break
    }
  }
  const pool = RELIC_POOL_BY_RARITY[chosen.rarity]
  if (pool.length > 0) {
    relics.push(rng.pick(pool))
  }

  // 遗物清单**同时**放进 rewards：表现层只认 `rewards` 这一份口径（铁律 #4）。
  //
  // ⚠ 历史 bug：遗物只留在 core 的独立数组 `relics` 里，`rewards.relics` 从未被赋值，
  //   而表现层的 `applyRewards` **只读 `rewards`** → 挂机 / 离线结算产出的遗物
  //   100% 被丢弃，玩家一个遗物都拿不到（整条遗物养成线是死的）。
  //   `newRelics` 保留给表现层做「本次获得提示」，但**入库只认 rewards.relics**。
  if (relics.length > 0) rewards.relics = [...relics]

  return { rewards, relics }
}

function mergeRewards(target: RewardBundle, source: RewardBundle, shards: Record<string, number>) {
  target.silver = (target.silver ?? 0) + (source.silver ?? 0)
  target.crystals = (target.crystals ?? 0) + (source.crystals ?? 0)
  if (source.items) {
    const bucket = { ...(target.items ?? {}) }
    for (const [k, v] of Object.entries(source.items)) {
      bucket[k as keyof typeof bucket] = (bucket[k as keyof typeof bucket] ?? 0) + v
    }
    target.items = bucket
  }
  if (source.shards) {
    for (const [k, v] of Object.entries(source.shards)) shards[k] = (shards[k] ?? 0) + v
  }
  // 遗物：合并进 rewards（多场战斗的遗物清单必须累加，否则只剩最后一场的）
  if (source.relics && source.relics.length > 0) {
    target.relics = [...(target.relics ?? []), ...source.relics]
  }
}

/** 生成一件遗物实例（uid 由调用方给出——存档内的遗物用 `nextRelicUid(save)`） */
export function rollRelicInstance(relicId: string, rng: Rng, uid: string) {
  return generateRelic(relicId, rng, RELIC.MIN_LEVEL, uid)
}

// ─────────────────────────── 内部索引 ───────────────────────────

import { ENEMIES } from '../config/enemies.ts'
import { RELICS } from '../config/relics.ts'

const ENEMY_MAP = new Map(ENEMIES.map((e) => [e.id, e]))
function ENEMY_LOOKUP(id: string) {
  const enemy = ENEMY_MAP.get(id)
  if (!enemy) throw new Error(`未知敌人：${id}`)
  return enemy
}

const RELIC_POOL_BY_RARITY: Record<string, string[]> = {
  SSR: RELICS.filter((r) => r.rarity === 'SSR').map((r) => r.id),
  SR: RELICS.filter((r) => r.rarity === 'SR').map((r) => r.id),
  R: RELICS.filter((r) => r.rarity === 'R').map((r) => r.id),
  N: RELICS.filter((r) => r.rarity === 'N').map((r) => r.id),
}

export { getRelicMods }
export type { BattleUnit }
