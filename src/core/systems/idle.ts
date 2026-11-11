/**
 * 挂机与离线结算（§5.7）。
 *
 * 离线收益曲线：
 *   t ≤ 8h   → 100%
 *   8h < t ≤ 12h → 线性衰减 100% → 60%
 *   t > 12h  → 0（封顶 12h）
 *
 * 在线效率恒定为离线的 3 倍（IDLE.ONLINE_MULTIPLIER）。
 * 收益通过**回放真实战斗**结算，而非按时长线性发放——
 * 这样不会出现"挂机 12 小时打不过却照样领满"的割裂感。
 */
import type { BattleUnit, HeroRuntime, RewardBundle, StageDef } from '../model/types.ts'
import { BATTLE, DROP_TABLES, IDLE } from '../config/economy.ts'
import { getStage } from '../config/stages.ts'
import { Rng } from '../rng.ts'
import { runBattle } from './battle.ts'
import { getTeamPower } from './team.ts'
import { getRelicMods, generateRelic } from './relic.ts'

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
  const tailAvg = (1 + TAIL_RATE) / 2
  return FULL_EFFICIENCY_HOURS + tailHours * tailAvg
}

/** 折算后的有效挂机时长（秒） */
export function offlineEffectiveSeconds(seconds: number): number {
  return computeOfflineEfficiency(seconds) * 3600
}

/** 满效率上限：12 小时封顶，超出部分不再产出 */
export const OFFLINE_CAP_SECONDS = IDLE.CAP_HOURS * 3600

/** 模拟战斗场次上限（防止长离线卡顿） */
const MAX_SIM_BATTLES = 400

export interface IdleRunResult {
  battles: number
  rewards: RewardBundle
  /** 战斗中推进到的最高关卡 */
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
): IdleRunResult {
  const rng = new Rng(seed)
  const rewards: RewardBundle = {}
  const shards: Record<string, number> = {}
  const newRelics: string[] = []

  let stageId = startStage
  let blockedAt: number | null = null
  let done = 0

  for (let i = 0; i < battles; i++) {
    const stage = getStage(stageId)
    const result = runBattle({
      allies: team,
      enemies: stage.enemyIds.map((id) => ENEMY_LOOKUP(id)),
      enemyScale: stage.enemyScale,
      ctx: { mode: 'pve', seed: seed + i },
    })

    done++

    if (!result.win) {
      // 卡关：停留在当前关卡，不再推进
      blockedAt = stageId
      break
    }

    const drop = rollRewards(stage, rng)
    mergeRewards(rewards, drop.rewards, shards)
    for (const relicId of drop.relics) {
      newRelics.push(relicId)
      onRelicFound?.(relicId)
    }

    // 自动推进到下一关（若战力足够）
    const nextStageId = stageId + 1
    if (nextStageId <= 310) {
      const next = getStage(nextStageId)
      const power = getTeamPower(team, { mode: 'pve' })
      if (power >= next.powerRequired) {
        stageId = nextStageId
      }
    }
  }

  if (Object.keys(shards).length > 0) rewards.shards = shards

  return {
    battles: done,
    rewards,
    reachedStage: stageId,
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
  reachedStage: number
  newRelics: string[]
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
      newRelics: [],
    }
  }

  const run = runIdle(team, currentStage, battles, seed)
  const remainingRatio = rawBattles > battles ? rawBattles / battles : 1

  return {
    elapsedSeconds,
    cappedSeconds: capped,
    efficiency: computeOfflineEfficiency(elapsedSeconds) / Math.max(1, elapsedSeconds / 3600),
    battles: run.battles,
    rewards: scaleRewards(run.rewards, remainingRatio),
    blockedAtStage: run.blockedAtStage,
    reachedStage: run.reachedStage,
    newRelics: run.newRelics,
  }
}

/** 按倍率放大奖励（用于超出模拟上限的部分外推） */
function scaleRewards(rewards: RewardBundle, ratio: number): RewardBundle {
  const out: RewardBundle = { ...rewards }
  if (out.silver !== undefined) out.silver = Math.floor(out.silver * ratio)
  if (out.exp !== undefined) out.exp = Math.floor(out.exp * ratio)
  if (out.skillStones !== undefined) out.skillStones = Math.floor(out.skillStones * ratio)
  if (out.relicStones !== undefined) out.relicStones = Math.floor(out.relicStones * ratio)
  if (out.emblems !== undefined) out.emblems = Math.floor(out.emblems * ratio)
  return out
}

// ─────────────────────────── 掉落 ───────────────────────────

interface RollResult {
  rewards: RewardBundle
  relics: string[]
}

/** 按关卡掉落表结算一次战斗的收益 */
export function rollRewards(stage: StageDef, rng: Rng): RollResult {
  const table = DROP_TABLES[stage.dropTableId]
  const rewards: RewardBundle = {}
  const relics: string[] = []

  if (!table) return { rewards, relics }

  rewards.silver = rng.int(table.silver[0], table.silver[1])
  rewards.exp = rng.int(table.exp[0], table.exp[1])
  rewards.skillStones = rng.int(table.skillStones[0], table.skillStones[1])
  rewards.relicStones = rng.int(table.relicStones[0], table.relicStones[1])

  const emblemRange = table.emblems
  if (emblemRange[1] > 0) {
    rewards.emblems = rng.int(emblemRange[0], emblemRange[1])
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

  return { rewards, relics }
}

function mergeRewards(target: RewardBundle, source: RewardBundle, shards: Record<string, number>) {
  target.silver = (target.silver ?? 0) + (source.silver ?? 0)
  target.exp = (target.exp ?? 0) + (source.exp ?? 0)
  target.skillStones = (target.skillStones ?? 0) + (source.skillStones ?? 0)
  target.relicStones = (target.relicStones ?? 0) + (source.relicStones ?? 0)
  target.emblems = (target.emblems ?? 0) + (source.emblems ?? 0)
  if (source.shards) {
    for (const [k, v] of Object.entries(source.shards)) shards[k] = (shards[k] ?? 0) + v
  }
}

/** 生成一件遗物实例（用于掉落） */
export function rollRelicInstance(relicId: string, rng: Rng) {
  return generateRelic(relicId, rng)
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
