/**
 * 动作层（**改变存档的编排**，纯函数，客户端与服务端共用）。
 *
 * 为什么要有这一层：
 * 服务端权威化后，**只有服务端**可以改变存档。但「余额够不够」「状态合不合法」
 * 「扣多少、给多少」这些规则**不能**在服务端另写一份——那会与 core 的数值口径
 * 分叉（铁律 #4 单一数据源）。所以把编排从表现层下沉到这里：
 *
 *   读存档 → 校验 → 调 core 纯函数 → 写回
 *
 * 服务端与客户端 import 的是**同一份** `src/core`，因此两边算出的结果必然一致。
 *
 * ── 调用约定 ────────────────────────────────────────────────────────
 * 1. **原地修改**：动作函数直接改传入的 `save`（与 core 既有风格一致，
 *    如 `equipRelic(save, …)`）。调用方负责提供可变的副本。
 * 2. **先校验后修改**：任何失败分支都必须在修改存档**之前**返回，
 *    保证「动作失败 → 存档一个字节都没变」（原子性：不会出现「扣了费却没出货」）。
 * 3. **失败不消耗随机数**：需要随机种子的动作必须先校验通过再取种子，
 *    否则失败会白白消耗掉一次序列（序列只应前进，不应倒退或重复）。
 * 4. **不碰存储 / 不读时钟 / 不用 Math.random()**：时间与随机源都由 `ctx` 注入。
 *
 * ── 铁律落点 ────────────────────────────────────────────────────────
 * - 余额校验先行、绝不产生负数（铁律 #10 / #22）
 * - 收益只经 `rewards` 这一份口径入库（铁律 #4 / #26）
 * - 「是否新获得」按逐张累积判定（铁律 #25）
 * - 遗物强化 / 分解的花费只读 `RELIC` 配置（铁律 #5）
 * - 竞技产出不回流 PVE 经济（合规红线）
 */
import type {
  ArenaMatch,
  ArenaLoadout,
  Rarity,
  RelicInstance,
  RewardBundle,
  SaveData,
  TeamPreset,
} from '../model/types.ts'
import { GAME_ERROR_CODES, type GameErrorCode } from '../config/game-errors.ts'
import { DAILY, LEVEL, REDEEM_CODES } from '../config/economy.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { getPool } from '../config/pools.ts'
import { dayIndex } from '../time.ts'
import { formatNumber } from '../utils/format.ts'
import { Rng } from '../rng.ts'
import {
  applyExp,
  applyRealmBreak,
  applySkillUp,
  applyStarUp,
  atRealmGate,
  createHeroState,
  realmBreakCost,
  skillLevelCap,
  skillUpCost,
  starUpCost,
} from './growth.ts'
import {
  applyRelicUpgrade,
  decomposeValue,
  generateRelic,
  relicUpgradeCost,
  RELIC_SETS,
} from './relic.ts'
import {
  RELIC_SLOT_COUNT,
  equipRelic,
  equippedOwnerMap,
  getEquippedRelics,
  unequipRelic,
} from './loadout.ts'
import { recommendRelicLoadout, type RelicAdvice } from './relic-advice.ts'
import {
  InsufficientFundsError,
  executePull,
  pullCost,
  resolvePayment,
  summarizePull,
} from './gacha.ts'
import { runIdle, settleOffline, type OfflineSettlementResult } from './idle.ts'
import {
  arenaSnapshotHash,
  resolveArenaMatch,
  resolveArenaRewards,
  type ArenaReward,
} from './arena.ts'
import { performRebirth, previewRebirth, type RebirthPreview } from './rebirth.ts'
import { buildArenaSnapshot, buildHeroRuntime, buildTeam } from './derive.ts'
import { importSave } from '../save/serialize.ts'
import { createNewSave, normalizeSave } from '../save/schema.ts'

// ─────────────────────────── 动作负载 ───────────────────────────

/**
 * 全部可改变存档的动作（判别联合）。
 *
 * ⚠ 这是**唯一一份**定义：服务端路由、客户端 store、错误码表都从这里取，
 *   不允许各写一套（铁律 #4）。
 */
export type GameAction =
  | { type: 'gacha.pull'; poolId: string; count: 1 | 10 }
  | { type: 'idle.tick'; battles: number }
  | { type: 'idle.claimOffline' }
  | { type: 'hero.feedExp'; heroId: string; amount: number }
  | { type: 'hero.breakRealm'; heroId: string }
  | { type: 'hero.upgradeSkill'; heroId: string; index: number }
  | { type: 'hero.upgradeStar'; heroId: string }
  | { type: 'relic.upgrade'; uid: string }
  | { type: 'relic.decompose'; uid: string }
  | { type: 'relic.equip'; heroId: string; slot: number; relicId: string | null }
  | { type: 'relic.autoEquip'; heroId: string }
  | { type: 'team.setSlot'; index: number; heroId: string | null }
  | { type: 'team.savePreset'; name: string }
  | { type: 'team.applyPreset'; presetId: string }
  | { type: 'team.removePreset'; presetId: string }
  | { type: 'rebirth.do' }
  | { type: 'arena.settle' }
  | { type: 'daily.signIn' }
  | { type: 'code.redeem'; code: string }
  | { type: 'save.create' }
  | { type: 'save.reset' }
  | { type: 'save.import'; payload: string }

export type GameActionType = GameAction['type']

// ─────────────────────────── 动作结果 ───────────────────────────

export interface PullActionResult {
  /** 本次抽到的完整名册（含重复），按抽出顺序 */
  items: { heroId: string; rarity: Rarity; isNew: boolean }[]
  /** 重复转化的印记总数 */
  emblems: number
  /** 重复转化的同名碎片总数 */
  shards: number
  /** 重复转化的银两 */
  silver: number
  /** 新获得英灵 id 列表 */
  newHeroes: string[]
  /** 本次实际扣的圣杯结晶 */
  crystalsUsed: number
  /** 本次实际扣的抽卡券 */
  ticketsUsed: number
  /** 新手保底是否触发 */
  guaranteedTriggered: boolean
  /** 本次是否消耗掉新手保底资格 */
  newbieUsedConsumed: boolean
}

export interface IdleActionResult {
  battles: number
  rewards: RewardBundle
  reachedStage: number
  blockedAtStage: number | null
}

export interface FeedExpResult {
  /** 实际投入的经验 */
  applied: number
  levelsGained: number
  blockedByRealm: boolean
}

export interface RelicUpgradeResult {
  uid: string
  level: number
  cost: { silver: number; stones: number }
}

export interface DecomposeResult {
  uid: string
  silver: number
  stones: number
}

export interface ArenaSettleResult {
  match: ArenaMatch
  reward: ArenaReward
}

export interface ActionResultMap {
  'gacha.pull': PullActionResult
  'idle.tick': IdleActionResult
  'idle.claimOffline': OfflineSettlementResult | null
  'hero.feedExp': FeedExpResult
  'hero.breakRealm': { levelsGained: number }
  'hero.upgradeSkill': { level: number }
  'hero.upgradeStar': { star: number }
  'relic.upgrade': RelicUpgradeResult
  'relic.decompose': DecomposeResult
  'relic.equip': null
  'relic.autoEquip': RelicAdvice
  'team.setSlot': null
  'team.savePreset': TeamPreset
  'team.applyPreset': null
  'team.removePreset': null
  'rebirth.do': RebirthPreview
  'arena.settle': ArenaSettleResult
  'daily.signIn': RewardBundle
  'code.redeem': RewardBundle
  'save.create': null
  'save.reset': null
  'save.import': null
}

// ─────────────────────────── 调用上下文 ───────────────────────────

export interface ActionContext {
  /** 当前时间（毫秒）——由调用方注入，core 不读 Date.now() */
  now: number
  /** 随机序列——种子与计数器随存档落库，只前进不复现（铁律 #24） */
  rng: Rng
  /** 新存档种子来源（仅 `save.reset` 用）——服务端用密码学随机源提供 */
  randomSeed: () => number
}

export type ActionOutcome<T = unknown> =
  | { ok: true; result: T; message?: string; messageKind?: 'info' | 'ok' | 'warn' }
  | {
      ok: false
      code: GameErrorCode
      message: string
      /** true = 不弹提示（原先就是静默返回的分支） */
      silent?: boolean
      detail?: Record<string, unknown>
    }

// ─────────────────────────── 内部工具 ───────────────────────────

function fail(code: GameErrorCode, message: string, silent = false): ActionOutcome<never> {
  return { ok: false, code, message, silent }
}

function silentFail(code: GameErrorCode): ActionOutcome<never> {
  return { ok: false, code, message: '', silent: true }
}

function ok<T>(result: T, message?: string, messageKind: 'info' | 'ok' | 'warn' = 'ok'): ActionOutcome<T> {
  return { ok: true, result, message, messageKind }
}

/** 英灵显示名（拿不到就退回通用文案） */
function heroName(heroId: string): string {
  return HERO_INDEX.get(heroId)?.name ?? '英灵'
}

/**
 * 收益入库（**唯一入口**，铁律 #4 / #26）。
 *
 * ⚠ 所有可入库资源都走这里，表现层与客户端**不得**另写一份入库逻辑。
 *   遗物清单只认 `rewards.relics`（core 的 `rollRewards` 已经把它填好了）。
 */
export function applyRewardBundle(
  save: SaveData,
  rewards: RewardBundle,
  rng: Rng,
  now: number,
): void {
  const p = save.player
  if (rewards.silver) p.silver += rewards.silver
  if (rewards.exp) p.exp += rewards.exp
  if (rewards.emblems) p.emblems += rewards.emblems
  if (rewards.crystals) p.crystals += rewards.crystals
  if (rewards.tickets) p.tickets += rewards.tickets
  if (rewards.skillStones) p.skillStones += rewards.skillStones
  if (rewards.relicStones) p.relicStones += rewards.relicStones
  if (rewards.shards) {
    for (const [id, n] of Object.entries(rewards.shards)) {
      p.shards[id] = (p.shards[id] ?? 0) + n
    }
  }
  if (rewards.relics) {
    for (const defId of rewards.relics) {
      save.relics.push(generateRelic(defId, rng, 1))
    }
  }
  if (rewards.heroes) {
    for (const heroId of rewards.heroes) {
      grantHero(save, heroId, now)
    }
  }
}

/** 获得一名英灵（已拥有则跳过） */
export function grantHero(save: SaveData, heroId: string, now: number): boolean {
  if (save.heroes[heroId]) return false
  if (!HERO_INDEX.get(heroId)) return false
  save.heroes[heroId] = createHeroState(heroId, now)
  return true
}

/**
 * 遗物一键推荐的**预览**（纯计算，不改存档）。
 *
 * 客户端用它显示「战力 +N」按钮；服务端执行 `relic.autoEquip` 时用同一份算法，
 * 两边不会算出不同的推荐（铁律 #2）。
 */
export function computeRelicAdvice(save: SaveData, heroId: string): RelicAdvice | null {
  const rt = buildHeroRuntime(save, heroId)
  if (!rt) return null
  const current = getEquippedRelics(save, heroId)
  const owners = equippedOwnerMap(save)
  // 候选池不包含装备在**其他英灵**身上的遗物（不抢占别人的装备）
  const candidates = save.relics.filter((r) => {
    const owner = owners.get(r.uid)
    return owner === undefined || owner === heroId
  })
  return recommendRelicLoadout({ ...rt, relics: current }, candidates, current)
}

// ─────────────────────────── 各动作实现 ───────────────────────────

/** 抽卡 */
function actionPull(
  save: SaveData,
  payload: Extract<GameAction, { type: 'gacha.pull' }>,
  ctx: ActionContext,
): ActionOutcome<PullActionResult> {
  let pool
  try {
    pool = getPool(payload.poolId)
  } catch {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '卡池不存在')
  }
  const count = payload.count === 10 ? 10 : 1

  // ⚠ 先校验余额再取种子：失败不消耗随机序列（否则会白白跳过一次序列）
  const payment = resolvePayment(count, save.player.crystals, save.player.tickets)
  if (!payment) {
    const required = pullCost(count)
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `余额不足（结晶 ${save.player.crystals}/${required.crystals}、抽卡券 ${save.player.tickets}/${required.tickets}），无法召唤`,
    )
  }

  const seed = ctx.rng.nextSeed()
  let outcome
  try {
    outcome = executePull(
      {
        pity: { pitySSR: save.gacha.pitySSR, pity10: save.gacha.pity10 },
        owned: save.heroes,
        crystals: save.player.crystals,
        tickets: save.player.tickets,
        newbieUsed: save.gacha.newbieUsed,
      },
      pool,
      count,
      seed,
    )
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return fail(
        GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
        `余额不足（结晶 ${err.owned.crystals}/${err.required.crystals}、抽卡券 ${err.owned.tickets}/${err.required.tickets}），无法召唤`,
      )
    }
    throw err
  }

  // ── 校验通过，开始修改存档 ──
  save.player.crystals -= outcome.crystalsUsed
  save.player.tickets -= outcome.ticketsUsed
  save.gacha.pitySSR = outcome.pity.pitySSR
  save.gacha.pity10 = outcome.pity.pity10
  if (outcome.newbieUsedConsumed) {
    save.gacha.newbieUsed = true
  }

  for (const r of outcome.results) {
    save.gacha.history.push({
      poolId: payload.poolId,
      heroId: r.heroId,
      rarity: r.rarity,
      isNew: r.isNew,
      at: ctx.now,
    })
    if (r.isNew) {
      grantHero(save, r.heroId, ctx.now)
    } else {
      // 重复 → 通用英灵印记 + 同名碎片 + 银两（合规：重复不直接提升强度）
      save.player.emblems += r.emblems
      save.player.shards[r.heroId] = (save.player.shards[r.heroId] ?? 0) + r.shards
      save.player.silver += r.silver
    }
  }
  save.stats.totalPulls += count

  const summary = summarizePull(outcome)
  return ok<PullActionResult>(
    {
      items: outcome.results.map((r) => ({
        heroId: r.heroId,
        rarity: r.rarity,
        isNew: r.isNew,
      })),
      emblems: summary.emblems,
      shards: summary.shards,
      silver: summary.silver,
      newHeroes: summary.newHeroes,
      crystalsUsed: outcome.crystalsUsed,
      ticketsUsed: outcome.ticketsUsed,
      guaranteedTriggered: outcome.guaranteedTriggered,
      newbieUsedConsumed: outcome.newbieUsedConsumed,
    },
    undefined,
  )
}

/** 推进挂机 */
function actionIdleTick(
  save: SaveData,
  payload: Extract<GameAction, { type: 'idle.tick' }>,
  ctx: ActionContext,
): ActionOutcome<IdleActionResult> {
  const team = buildTeam(save)
  if (team.length === 0) {
    return fail(GAME_ERROR_CODES.TEAM_EMPTY, '请先在阵位中编队')
  }
  const battles = Math.max(1, Math.floor(payload.battles))

  const seed = ctx.rng.nextSeed()
  const run = runIdle(team, save.idle.currentStage, battles, seed)

  applyRewardBundle(save, run.rewards, ctx.rng, ctx.now)

  save.idle.currentStage = run.blockedAtStage !== null ? run.blockedAtStage : run.reachedStage
  save.campaign.clearedStage = Math.max(save.campaign.clearedStage, run.reachedStage)
  save.idle.totalIdleSeconds += battles * 6
  save.lastTickAt = ctx.now

  return ok<IdleActionResult>({
    battles: run.battles,
    rewards: run.rewards,
    reachedStage: run.reachedStage,
    blockedAtStage: run.blockedAtStage,
  })
}

/** 离线结算 */
function actionIdleClaimOffline(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'idle.claimOffline' }>,
  ctx: ActionContext,
): ActionOutcome<OfflineSettlementResult | null> {
  const team = buildTeam(save)
  if (team.length === 0) {
    return fail(GAME_ERROR_CODES.TEAM_EMPTY, '请先在阵位中编队')
  }
  const elapsed = Math.max(0, Math.floor((ctx.now - save.lastTickAt) / 1000))
  if (elapsed < 60) {
    return ok<null>(null)
  }
  const seed = ctx.rng.nextSeed()
  const result = settleOffline(team, save.idle.currentStage, elapsed, seed)
  applyRewardBundle(save, result.rewards, ctx.rng, ctx.now)
  save.lastTickAt = ctx.now
  return ok<OfflineSettlementResult>(result)
}

/** 喂经验 */
function actionFeedExp(
  save: SaveData,
  payload: Extract<GameAction, { type: 'hero.feedExp' }>,
  ctx: ActionContext,
): ActionOutcome<FeedExpResult> {
  const state = save.heroes[payload.heroId]
  if (!state) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  const need = Math.max(0, Math.floor(payload.amount))
  if (need <= 0) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  if (state.level >= LEVEL.MAX) {
    return fail(GAME_ERROR_CODES.MAX_LEVEL, '该英灵已达最高等级')
  }
  const p = save.player
  // 先判余额再扣费：余额不足直接拒绝，不允许出现负数资源（铁律 #10）
  if (p.exp < need) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `经验不足（${formatNumber(p.exp)} / ${formatNumber(need)}）`,
    )
  }

  p.exp -= need
  const res = applyExp(state, need)

  const name = heroName(payload.heroId)
  const message =
    res.levelsGained > 0
      ? `${name} 提升了 ${res.levelsGained} 级`
      : res.blockedByRealm
        ? `${name} 已达境界门槛，需突破境界才能继续升级`
        : `已投入 ${formatNumber(need)} 经验`
  return ok<FeedExpResult>(
    { applied: need, levelsGained: res.levelsGained, blockedByRealm: res.blockedByRealm },
    message,
  )
}

/** 境界突破 */
function actionBreakRealm(
  save: SaveData,
  payload: Extract<GameAction, { type: 'hero.breakRealm' }>,
  ctx: ActionContext,
): ActionOutcome<{ levelsGained: number }> {
  const state = save.heroes[payload.heroId]
  if (!state) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  const cost = realmBreakCost(state.level)
  if (!cost) {
    return fail(GAME_ERROR_CODES.MAX_REALM, '已达最高境界')
  }
  if (!atRealmGate(state.level)) {
    return fail(GAME_ERROR_CODES.REALM_GATE, '尚未达到境界门槛')
  }
  const p = save.player
  if (p.emblems < cost.emblems) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `英灵印记不足（${formatNumber(p.emblems)} / ${cost.emblems}）`,
    )
  }

  p.emblems -= cost.emblems
  if (!applyRealmBreak(state)) {
    // 兜底：状态不允许突破时把印记还回去
    p.emblems += cost.emblems
    return fail(GAME_ERROR_CODES.REALM_GATE, '当前无法突破境界')
  }
  // 突破前已投入但卡在门槛上的经验，立刻兑现成等级
  const res = applyExp(state, 0)

  const name = heroName(payload.heroId)
  const message =
    res.levelsGained > 0
      ? `${name} 突破境界，提升 ${res.levelsGained} 级`
      : `${name} 已突破境界`
  return ok<{ levelsGained: number }>({ levelsGained: res.levelsGained }, message)
}

/** 技能升级 */
function actionUpgradeSkill(
  save: SaveData,
  payload: Extract<GameAction, { type: 'hero.upgradeSkill' }>,
  _ctx: ActionContext,
): ActionOutcome<{ level: number }> {
  const state = save.heroes[payload.heroId]
  if (!state) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  const current = state.skillLevels[payload.index] ?? 0

  // 先判上限（受境界门槛约束），再判资源。
  // ⚠ 顺序反了会让技能已满级的玩家看到「资源不足」——那是误导。
  if (current >= skillLevelCap(state.level)) {
    return fail(GAME_ERROR_CODES.SKILL_CAP, '当前等级无法继续提升')
  }
  const cost = skillUpCost(current)
  if (!cost) {
    return fail(GAME_ERROR_CODES.SKILL_CAP, '当前等级无法继续提升')
  }
  const p = save.player
  // ⚠ 扣的是**术式结晶**（skillStones），不是圣杯结晶（crystals）。
  if (p.skillStones < cost.skillStones || p.silver < cost.silver) {
    return fail(GAME_ERROR_CODES.INSUFFICIENT_FUNDS, '资源不足')
  }
  if (!applySkillUp(state, payload.index)) {
    return fail(GAME_ERROR_CODES.SKILL_CAP, '当前等级无法继续提升')
  }
  p.skillStones -= cost.skillStones
  p.silver -= cost.silver
  return ok<{ level: number }>({ level: state.skillLevels[payload.index] ?? current }, '技能等级已提升')
}

/** 升星 */
function actionUpgradeStar(
  save: SaveData,
  payload: Extract<GameAction, { type: 'hero.upgradeStar' }>,
  _ctx: ActionContext,
): ActionOutcome<{ star: number }> {
  const state = save.heroes[payload.heroId]
  if (!state) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  const cost = starUpCost(state.star)
  if (!cost) {
    return fail(GAME_ERROR_CODES.MAX_STAR, '已达最高星级')
  }
  const shards = save.player.shards[payload.heroId] ?? 0
  if (shards < cost.shards || save.player.emblems < cost.emblems) {
    return fail(GAME_ERROR_CODES.INSUFFICIENT_FUNDS, '碎片或印记不足')
  }
  save.player.shards[payload.heroId] = shards - cost.shards
  save.player.emblems -= cost.emblems
  applyStarUp(state)
  return ok<{ star: number }>({ star: state.star }, '星级已提升')
}

/** 遗物强化 */
function actionRelicUpgrade(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.upgrade' }>,
  _ctx: ActionContext,
): ActionOutcome<RelicUpgradeResult> {
  const relic = save.relics.find((r) => r.uid === payload.uid)
  if (!relic) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  const cost = relicUpgradeCost(relic.level)
  if (!cost) {
    return fail(GAME_ERROR_CODES.MAX_RELIC_LEVEL, '已达最高强化等级')
  }
  if (save.player.silver < cost.silver || save.player.relicStones < cost.stones) {
    return fail(GAME_ERROR_CODES.INSUFFICIENT_FUNDS, '银两或强化石不足')
  }
  save.player.silver -= cost.silver
  save.player.relicStones -= cost.stones
  applyRelicUpgrade(relic)
  return ok<RelicUpgradeResult>({ uid: relic.uid, level: relic.level, cost })
}

/** 遗物分解 */
function actionDecomposeRelic(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.decompose' }>,
  _ctx: ActionContext,
): ActionOutcome<DecomposeResult> {
  const idx = save.relics.findIndex((r) => r.uid === payload.uid)
  if (idx < 0) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  const relic = save.relics[idx]
  if (relic.locked) {
    return fail(GAME_ERROR_CODES.RELIC_LOCKED, '遗物已锁定')
  }
  const value = decomposeValue(relic)
  save.player.silver += value.silver
  save.player.relicStones += value.stones
  save.relics.splice(idx, 1)
  for (const key of Object.keys(save.equipped)) {
    if (save.equipped[key].relicId === payload.uid) delete save.equipped[key]
  }
  return ok<DecomposeResult>(
    { uid: payload.uid, silver: value.silver, stones: value.stones },
    '已分解遗物',
  )
}

/** 装备 / 卸下遗物 */
function actionRelicEquip(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.equip' }>,
  _ctx: ActionContext,
): ActionOutcome<null> {
  if (!save.heroes[payload.heroId]) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  if (payload.slot < 0 || payload.slot >= RELIC_SLOT_COUNT) {
    return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  }
  if (payload.relicId === null) {
    unequipRelic(save, payload.heroId, payload.slot)
  } else {
    if (!save.relics.some((r) => r.uid === payload.relicId)) {
      return silentFail(GAME_ERROR_CODES.NOT_FOUND)
    }
    equipRelic(save, payload.heroId, payload.slot, payload.relicId)
  }
  return ok<null>(null)
}

/** 一键按推荐装备遗物 */
function actionAutoEquip(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.autoEquip' }>,
  _ctx: ActionContext,
): ActionOutcome<RelicAdvice> {
  const advice = computeRelicAdvice(save, payload.heroId)
  if (!advice) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  // 清掉该英灵现有装备，再按推荐铺回去
  for (let slot = 0; slot < RELIC_SLOT_COUNT; slot++) {
    unequipRelic(save, payload.heroId, slot)
  }
  advice.slots.forEach((relic, slot) => {
    if (relic) equipRelic(save, payload.heroId, slot, relic.uid)
  })
  const sets = Object.entries(advice.activeTiers)
    .filter(([, tier]) => tier > 0)
    .map(([setId, tier]) => `${RELIC_SETS.get(setId)?.name ?? setId} ${tier} 件`)
  const message = `已按推荐装备 · 战力 +${formatNumber(advice.gain)}${sets.length ? ' · ' + sets.join(' / ') : ''}`
  return ok<RelicAdvice>(advice, message)
}

/** 编队换人 */
function actionSetSlot(
  save: SaveData,
  payload: Extract<GameAction, { type: 'team.setSlot' }>,
  _ctx: ActionContext,
): ActionOutcome<null> {
  if (payload.index < 0 || payload.index >= save.team.slots.length) {
    return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  }
  if (payload.heroId !== null && !save.heroes[payload.heroId]) {
    return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  }
  const slots = save.team.slots
  if (payload.heroId) {
    const existing = slots.indexOf(payload.heroId)
    if (existing >= 0) slots[existing] = null
  }
  slots[payload.index] = payload.heroId
  return ok<null>(null)
}

/** 保存编队预设 */
function actionSavePreset(
  save: SaveData,
  payload: Extract<GameAction, { type: 'team.savePreset' }>,
  ctx: ActionContext,
): ActionOutcome<TeamPreset> {
  const name = payload.name.trim()
  if (!name) return fail(GAME_ERROR_CODES.NOT_FOUND, '预设名称不能为空')
  const preset: TeamPreset = {
    // 预设 id 用时间戳 + 序号，避免同毫秒保存两个预设撞 id
    id: `preset_${ctx.now}_${save.team.presets.length}`,
    name,
    slots: [...save.team.slots],
  }
  save.team.presets.push(preset)
  return ok<TeamPreset>(preset, '编队已保存')
}

/** 应用编队预设 */
function actionApplyPreset(
  save: SaveData,
  payload: Extract<GameAction, { type: 'team.applyPreset' }>,
  _ctx: ActionContext,
): ActionOutcome<null> {
  const preset = save.team.presets.find((p) => p.id === payload.presetId)
  if (!preset) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  save.team.slots = [...preset.slots]
  return ok<null>(null)
}

/** 删除编队预设 */
function actionRemovePreset(
  save: SaveData,
  payload: Extract<GameAction, { type: 'team.removePreset' }>,
  _ctx: ActionContext,
): ActionOutcome<null> {
  save.team.presets = save.team.presets.filter((p) => p.id !== payload.presetId)
  return ok<null>(null)
}

/** 圣杯重启 */
function actionRebirth(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'rebirth.do' }>,
  _ctx: ActionContext,
): ActionOutcome<RebirthPreview> {
  const preview = previewRebirth(save)
  if (!preview.eligible) {
    return fail(GAME_ERROR_CODES.REBIRTH_LOCKED, preview.reason || '暂不可重启')
  }
  const result = performRebirth(save)
  return ok<RebirthPreview>(
    result,
    `圣杯重启完成 · 永久加成 ${Math.round(result.nextPermBoost * 100)}%`,
  )
}

/**
 * 竞技场结算。
 *
 * 对手沿用**镜像试炼**语义（对手 = 攻方自己的阵容快照），
 * 只把「生成 + 结算」整体搬到服务端，玩法不变。
 */
function actionArenaSettle(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'arena.settle' }>,
  ctx: ActionContext,
): ActionOutcome<ArenaSettleResult> {
  const team = buildTeam(save)
  if (team.length === 0) {
    return fail(GAME_ERROR_CODES.TEAM_EMPTY, '请先在阵位中编队')
  }
  const loadout: ArenaLoadout = buildArenaSnapshot(save)
  const seed = ctx.rng.nextSeed()
  const match = resolveArenaMatch({
    challengeId: 'daily_1',
    attacker: loadout,
    defender: loadout,
    attackerId: 'me',
    attackerName: '我',
    defenderId: 'foe',
    defenderName: '试炼对手',
    seed,
  })

  const a = save.arena
  a.tierPoints = Math.max(0, (a.tierPoints ?? 0) + match.pointsDelta)
  a.pvpPoints = (a.pvpPoints ?? 0) + (match.result.win ? 20 : 5)
  a.snapshotHash = arenaSnapshotHash(loadout)
  a.defenseLoadout = loadout

  const { reward, weeklyMedals, weeklyTickets } = resolveArenaRewards(
    match.result.win,
    a.weeklyMedals ?? 0,
    a.weeklyTickets ?? 0,
  )
  a.medals = (a.medals ?? 0) + reward.medals
  a.weeklyMedals = weeklyMedals
  a.weeklyTickets = weeklyTickets
  // 兑换券进入玩家背包（竞技专属产出，不回流 PVE 经济）
  if (reward.tickets) save.player.tickets += reward.tickets

  return ok<ArenaSettleResult>({ match, reward })
}

/** 每日签到 */
function actionSignIn(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'daily.signIn' }>,
  ctx: ActionContext,
): ActionOutcome<RewardBundle> {
  const d = save.daily
  const today = dayIndex(ctx.now)
  if (d.lastSignInDay === today) {
    return fail(GAME_ERROR_CODES.ALREADY_SIGNED, '今天已经签到过了')
  }
  // 断签（上次签到不是昨天）则从第一天重新开始
  const continued = d.lastSignInDay === today - 1
  const index = continued ? d.signInStreak % DAILY.SIGN_IN_CYCLE : 0
  const reward = DAILY.SIGN_IN_REWARDS[index]

  const p = save.player
  if (reward.crystals) p.crystals += reward.crystals
  if (reward.silver) p.silver += reward.silver
  if (reward.tickets) p.tickets += reward.tickets
  if (reward.skillStones) p.skillStones += reward.skillStones
  if (reward.relicStones) p.relicStones += reward.relicStones

  d.signInStreak = index + 1
  d.lastSignInDay = today
  return ok<RewardBundle>({ ...reward }, '签到成功')
}

/** 兑换一次性兑换码 */
function actionRedeemCode(
  save: SaveData,
  payload: Extract<GameAction, { type: 'code.redeem' }>,
  _ctx: ActionContext,
): ActionOutcome<RewardBundle> {
  const key = payload.code.trim().toUpperCase()
  if (!key) return fail(GAME_ERROR_CODES.CODE_INVALID, '兑换码无效')
  if (save.codes.includes(key)) {
    return fail(GAME_ERROR_CODES.CODE_USED, '该兑换码已使用')
  }
  const def = REDEEM_CODES[key]
  if (!def) {
    return fail(GAME_ERROR_CODES.CODE_INVALID, '兑换码无效')
  }
  const p = save.player
  if (def.crystals) p.crystals += def.crystals
  if (def.tickets) p.tickets += def.tickets
  if (def.emblems) p.emblems += def.emblems
  if (def.silver) p.silver += def.silver
  save.codes.push(key)
  return ok<RewardBundle>({ ...def }, '兑换成功')
}

/**
 * 建立新存档（**服务端权威**）。
 *
 * 种子由 `ctx.randomSeed()` 提供——服务端用密码学随机源给，
 * 客户端**不得**构造固定序列（铁律 #24：常量种子会让所有玩家抽到同一串）。
 */
function actionCreate(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'save.create' }>,
  ctx: ActionContext,
): ActionOutcome<null> {
  const fresh = createNewSave(ctx.now, ctx.randomSeed())
  Object.assign(save, fresh)
  return ok<null>(null, '已创建新存档')
}

/** 重置进度：玩家主动覆盖，允许强行写入 */
function actionReset(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'save.reset' }>,
  ctx: ActionContext,
): ActionOutcome<null> {
  // 重置 → 换一条全新的随机序列（否则旧档的抽卡位置会被继承）
  const fresh = createNewSave(ctx.now, ctx.randomSeed())
  Object.assign(save, fresh)
  return ok<null>(null, '进度已重置', 'warn')
}

/** 导入存档（玩家主动覆盖） */
function actionImport(
  save: SaveData,
  payload: Extract<GameAction, { type: 'save.import' }>,
  _ctx: ActionContext,
): ActionOutcome<null> {
  let imported
  try {
    imported = normalizeSave(importSave(payload.payload))
  } catch {
    return fail(GAME_ERROR_CODES.IMPORT_INVALID, '存档数据无效')
  }
  Object.assign(save, imported)
  return ok<null>(null, '存档已导入')
}

// ─────────────────────────── 分发 ───────────────────────────

/** 单个动作的处理函数签名 */
export type ActionHandler<K extends GameActionType> = (
  save: SaveData,
  action: Extract<GameAction, { type: K }>,
  ctx: ActionContext,
) => ActionOutcome<ActionResultMap[K]>

/**
 * 动作 → 处理函数的映射表。
 *
 * 用映射表而不是 switch：类型可以精确到「某个动作 ↔ 它的结果类型」，
 * 少一层 `as` 强转，新增动作也不会漏掉某个分支（漏了就编译不过）。
 */
const HANDLERS: { [K in GameActionType]: ActionHandler<K> } = {
  'gacha.pull': actionPull,
  'idle.tick': actionIdleTick,
  'idle.claimOffline': actionIdleClaimOffline,
  'hero.feedExp': actionFeedExp,
  'hero.breakRealm': actionBreakRealm,
  'hero.upgradeSkill': actionUpgradeSkill,
  'hero.upgradeStar': actionUpgradeStar,
  'relic.upgrade': actionRelicUpgrade,
  'relic.decompose': actionDecomposeRelic,
  'relic.equip': actionRelicEquip,
  'relic.autoEquip': actionAutoEquip,
  'team.setSlot': actionSetSlot,
  'team.savePreset': actionSavePreset,
  'team.applyPreset': actionApplyPreset,
  'team.removePreset': actionRemovePreset,
  'rebirth.do': actionRebirth,
  'arena.settle': actionArenaSettle,
  'daily.signIn': actionSignIn,
  'code.redeem': actionRedeemCode,
  'save.create': actionCreate,
  'save.reset': actionReset,
  'save.import': actionImport,
}

/**
 * 执行一个动作。
 *
 * 动作失败时**存档不变**（先校验后修改），调用方可安全地「失败即丢弃」。
 */
export function applyAction<T extends GameActionType>(
  save: SaveData,
  action: Extract<GameAction, { type: T }>,
  ctx: ActionContext,
): ActionOutcome<ActionResultMap[T]> {
  const handler = HANDLERS[action.type]
  return handler(save, action, ctx)
}

/** 把随机数计数器写回存档（持久化时调用，保证序列只前进不复现） */
export function syncRngState(save: SaveData, rng: Rng): void {
  const snap = rng.snapshot()
  save.rng.seed = snap.seed
  save.rng.counter = snap.counter
}
