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
  BattleContext,
  BattleResult,
  Element,
  IdleChannelKind,
  IdleChannelState,
  IdleChannelTarget,
  LadderRoundResult,
  Rarity,
  RelicInstance,
  RewardBundle,
  SaveData,
  TeamPreset,
} from '../model/types.ts'
import { GAME_ERROR_CODES, type GameErrorCode } from '../config/game-errors.ts'
import {
  DAILY,
  LEVEL,
  REDEEM_CODES,
  BATTLE,
  IDLE,
  RELIC,
  RELIC_ACQUIRE,
  LEGACY_CONVERSION,
  EXP_BOOK,
  type RelicStoneTierId,
} from '../config/economy.ts'
import {
  EXP_BOOK_ITEM_EXP,
  ITEM_BY_ELEMENT,
  RELIC_STONE_ITEM_BY_TIER,
  isExpBook,
  itemName,
  type ItemId,
} from '../config/items.ts'
import {
  DUNGEON_INDEX,
  dungeonStageById,
  findDungeonVariant,
} from '../config/dungeons.ts'
import { dungeonStageUnlocked, dungeonUnlocked, runDungeonLevel } from './dungeons.ts'
import { grantFirstClearCrystals } from './first-clear.ts'
import { STAGE_INDEX } from '../config/stages.ts'
import { getEnemy } from '../config/enemies.ts'
import { relicIdsByRarity } from '../config/relics.ts'
import { runBattle } from './battle.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { getPool } from '../config/pools.ts'
import { arenaWeekIndex, dayIndex } from '../time.ts'
import { formatNumber } from '../utils/format.ts'
import { Rng } from '../rng.ts'
import {
  applyExp,
  applyFeedBooks,
  applyRealmBreak,
  applySkillUp,
  applyStarUp,
  atRealmGate,
  createHeroState,
  previewFeed,
  realmBreakCost,
  skillLevelCap,
  skillUpCost,
  starUpCost,
  type FeedBooksResult,
} from './growth.ts'
import {
  applyRelicUpgrade,
  decomposeValue,
  generateRelic,
  nextRelicUid,
  relicCostDelta,
  relicUpgradeCost,
  type RelicStoneCosts,
  RELIC_DEFS,
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
import {
  IDLE_CHANNEL_KINDS,
  measureIdleChannels,
  mergeRewardBundles,
  resolveChannelTarget,
  rollMainDrop,
  settleIdleChannels,
  type ChannelSettlement,
} from './idle.ts'
import { advanceTasks, rollTasks, taskRewardBundle, taskView } from './tasks.ts'
import {
  emptyOverflow,
  enforceInventoryCap,
  equippedRelicIds,
  type InventoryOverflowResult,
} from './inventory.ts'
import {
  arenaSnapshotHash,
  resolveArenaMatch,
  resolveArenaRewards,
  type ArenaReward,
} from './arena.ts'
import {
  buildLadderSquads,
  resolveLadderRound,
  resolveLadderRewards,
  resolveReturnReward,
  rollLadderPeriods,
  validateSquad,
  type SeasonSettlement,
} from './ladder.ts'
import { LADDER } from '../config/economy.ts'
import { performRebirth, previewRebirth, type RebirthPreview } from './rebirth.ts'
import { buildArenaSnapshot, buildHeroRuntime, buildTeam, buildPveContext } from './derive.ts'
import { validateImportedSave } from '../save/import-validation.ts'
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
  | { type: 'idle.tick' }
  | { type: 'idle.heartbeat' }
  | { type: 'idle.claimOffline' }
  | {
      type: 'idle.setChannel'
      /** 通道种类：主线 / 技能副本 / 强化副本 */
      channel: IdleChannelKind
      /** 主线通道：省略或 null = 跟随最新通关关卡 */
      stageId?: number | null
      /** 技能 / 强化通道：副本关卡 id（`dgn_<变体>_<难度>`） */
      dungeonStageId?: string
      /** 关闭通道（仅 skill / enhance 可关） */
      disabled?: boolean
    }
  | { type: 'campaign.challenge'; stageId?: number }
  | { type: 'dungeon.challenge'; stageId: string }
  | { type: 'relic.acquire' }
  | { type: 'settings.update'; speed?: number; sfx?: boolean; skipAnim?: boolean }
  | { type: 'hero.feedExp'; heroId: string; amount: number }
  | { type: 'hero.feedBooks'; heroId: string; bookId: ItemId; count: number }
  | { type: 'hero.breakRealm'; heroId: string }
  | { type: 'hero.upgradeSkill'; heroId: string; index: number }
  | { type: 'hero.upgradeStar'; heroId: string }
  | { type: 'relic.upgrade'; uid: string }
  | { type: 'relic.decompose'; uid: string }
  | { type: 'relic.lock'; uid: string; locked: boolean }
  | { type: 'relic.decomposeBatch'; uids: string[] }
  | { type: 'relic.upgradeBatch'; uids: string[]; targetLevel?: number }
  | { type: 'relic.decomposeByFilter'; rarity?: Rarity; maxLevel?: number; setId?: string; includeEquipped?: boolean }
  | { type: 'relic.equip'; heroId: string; slot: number; relicId: string | null }
  | { type: 'relic.autoEquip'; heroId: string }
  | { type: 'team.setSlot'; index: number; heroId: string | null }
  | { type: 'team.savePreset'; name: string }
  | { type: 'team.applyPreset'; presetId: string }
  | { type: 'team.removePreset'; presetId: string }
  | { type: 'rebirth.do' }
  | { type: 'arena.settle' }
  | { type: 'arena.ladderSaveSquads'; squads: (string | null)[][] }
  | { type: 'arena.ladderChallenge' }
  | { type: 'arena.ladderClaimReturn' }
  | { type: 'daily.signIn' }
  | { type: 'daily.claimTask'; taskId: string }
  | { type: 'code.redeem'; code: string }
  | { type: 'legacy.allocateMaterials'; skillElement: Element; relicTier: RelicStoneTierId }
  | { type: 'save.create' }
  | { type: 'save.reset' }
  | { type: 'save.import'; payload: string; legacy?: boolean }

export type GameActionType = GameAction['type']

// ─────────────────────────── 动作结果 ───────────────────────────

export interface PullActionResult {
  /** 本次抽到的完整名册（含重复），按抽出顺序 */
  items: { heroId: string; rarity: Rarity; isNew: boolean }[]
  /** 重复转化的**同名碎片**（英灵 id → 数量） */
  shards: Record<string, number>
  /** 新获得英灵 id 列表 */
  newHeroes: string[]
  /** 本次实际扣的圣杯结晶 */
  crystalsUsed: number
  /** 新手保底是否触发 */
  guaranteedTriggered: boolean
  /** 本次是否消耗掉新手保底资格 */
  newbieUsedConsumed: boolean
}

/**
 * **挂机领取结果**（三通道并行，挂机改版 v11）。
 */
export interface IdleActionResult {
  /** 三通道明细（只含本次有产出的通道） */
  channels: ChannelSettlement[]
  /** 本次结算总次数 */
  rolls: number
}

/**
 * **挂机通道设置结果**。
 */
export interface IdleChannelResult {
  /** 被设置的通道 */
  channel: IdleChannelKind
  /** 通道的新状态（`null` = 通道关闭） */
  target: IdleChannelTarget | null
  /** 切换前按**旧目标**结清的明细（无产出时为空数组） */
  settled: ChannelSettlement[]
}

/**
 * **主线手动挑战**的结果（挂机改版 v11：主线推进改为纯手动挑战）。
 */
export interface CampaignChallengeResult {
  stageId: number
  win: boolean
  /** 是否为首通（首次通关） */
  firstClear: boolean
  /** 本次胜利奖励，战败时为空 */
  rewards: RewardBundle
  /**
   * 战斗回放（**不进幂等日志**）。
   *
   * ⚠ 服务端在落库前把它挪到响应的 `replay` 字段：
   *   `BattleResult.log` 上限 1500 条，存进 24 小时幂等日志 = 每天几十 MB。
   */
  battle?: BattleResult
}

/**
 * **副本手动挑战**的结果。
 */
export interface DungeonChallengeResult {
  /** 副本关卡 id */
  stageId: string
  win: boolean
  /** 本次是否首次通关（并已记入 dungeons.cleared） */
  firstClear: boolean
  rewards: RewardBundle
  /** 战斗回放（**不进幂等日志**，同 `CampaignChallengeResult.battle`） */
  battle?: BattleResult
}

/**
 * **遗物祈愿**的结果（遗物的独立获取入口，§1.3 / U3）。
 */
export interface RelicAcquireResult {
  /** 遗物定义 id */
  relicId: string
  /** 遗物实例 uid */
  uid: string
  /** 消耗的银两 */
  silver: number
}

/**
 * 喂经验书的结果。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：玩家经验池退役 → 经验改由
 *   「经验书 → 直接进英灵」产出（设计稿 §2）。
 *
 * ⚠ **口径只有一份**：定义在 `core/systems/growth.ts`（真正算出这些数的地方），
 *   这里**转出**而不是再写一遍——两处各写一份必然对不上（铁律 #4）。
 */
export type { FeedBooksResult } from './growth.ts'

/** 旧动作 `hero.feedExp` 的结果形状（动作保留但恒定失败，见 `CLIENT_OUTDATED`） */
export interface FeedExpResult {
  /** 实际投入的经验 */
  applied: number
  levelsGained: number
  blockedByRealm: boolean
}

export interface RelicUpgradeResult {
  uid: string
  level: number
  /** 花费：银两 + 按档位拆分的强化石 */
  cost: { silver: number; stones: RelicStoneCosts }
}

export interface DecomposeResult {
  uid: string
  /** ⚠ 分解**只返银两**（设计稿 §2），不再返强化石 */
  silver: number
}

/** 批量分解结果 */
export interface DecomposeBatchResult {
  /** 实际分解件数 */
  decomposed: number
  /** 返还银两 */
  silver: number
  /** 因锁定而跳过的 uid（锁定件不会被分解，只会被跳过） */
  skipped: string[]
  /** 因已装备而被卸下的件数 */
  unequipped: number
}

/** 批量强化结果 */
export interface UpgradeBatchResult {
  /** 实际强化的件数 */
  upgraded: number
  /** 消耗银两 */
  silver: number
  /** 消耗强化石（按档位拆分） */
  stones: RelicStoneCosts
  /** 每件强化后的等级 */
  levels: { uid: string; level: number }[]
}

export interface ArenaSettleResult {
  match: ArenaMatch
  reward: ArenaReward
}

/** 三队天梯 · 一轮挑战的结果 */
export interface LadderChallengeResult extends LadderRoundResult {
  /** 本次触发的赛季结算（跨了多个赛季就逐个返回） */
  settlements: SeasonSettlement[]
}

/** 三队天梯 · 回流奖励领取结果 */
export interface LadderReturnResult {
  /** 养成材料（走 `rewards` 入库，铁律 #26） */
  rewards: RewardBundle
  /** 竞技勋章（竞技专属资源，直接记在 `arena.medals`） */
  medals: number
  /** 本次回流的离线天数 */
  days: number
}

export interface ActionResultMap {
  'gacha.pull': PullActionResult
  'idle.tick': IdleActionResult
  'idle.heartbeat': true
  'idle.claimOffline': IdleActionResult
  'idle.setChannel': IdleChannelResult
  'campaign.challenge': CampaignChallengeResult
  'dungeon.challenge': DungeonChallengeResult
  'relic.acquire': RelicAcquireResult
  'settings.update': true
  'hero.feedExp': FeedExpResult
  'hero.feedBooks': FeedBooksResult
  'hero.breakRealm': { levelsGained: number }
  'hero.upgradeSkill': { level: number }
  'hero.upgradeStar': { star: number }
  'relic.upgrade': RelicUpgradeResult
  'relic.decompose': DecomposeResult
  'relic.lock': { uid: string; locked: boolean }
  'relic.decomposeBatch': DecomposeBatchResult
  'relic.upgradeBatch': UpgradeBatchResult
  'relic.decomposeByFilter': DecomposeBatchResult
  'relic.equip': true
  'relic.autoEquip': RelicAdvice
  'team.setSlot': true
  'team.savePreset': TeamPreset
  'team.applyPreset': true
  'team.removePreset': true
  'rebirth.do': RebirthPreview
  'arena.settle': ArenaSettleResult
  'arena.ladderSaveSquads': true
  'arena.ladderChallenge': LadderChallengeResult
  'arena.ladderClaimReturn': LadderReturnResult
  'daily.signIn': RewardBundle
  'daily.claimTask': RewardBundle
  'code.redeem': RewardBundle
  'legacy.allocateMaterials': { items: Partial<Record<ItemId, number>> }
  'save.create': true
  'save.reset': true
  'save.import': true
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

/**
 * ⚠ **成功的结果永不为 `null`**。
 *
 * 「无数据」的动作（装备 / 编队 / 预设 / 重置 / 导入等）一律返回 `true`，
 * 而不是 `null`——否则调用方无法区分「成功了但没数据」与「失败了」：
 * 服务端权威后，客户端靠返回值判断成败（失败时存档没变、界面要提示）。
 */

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
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：
 *   - 钱包只留银两 / 圣杯结晶；
 *   - 堆叠道具走 `rewards.items` → `save.items`（**顶层**，不放 `player`）；
 *   - 同名碎片走 `rewards.shards` → `player.shards`（按英灵分堆）；
 *   - 经验池 / 印记 / 抽卡券 / 术式结晶 / 遗物强化石**全部退役**。
 *
 * @returns 库存溢出处理结果（没有溢出时是空结果）
 */
export function applyRewardBundle(
  save: SaveData,
  rewards: RewardBundle,
  rng: Rng,
  now: number,
): InventoryOverflowResult {
  const p = save.player
  if (rewards.silver) p.silver += rewards.silver
  if (rewards.crystals) p.crystals += rewards.crystals
  if (rewards.items) {
    for (const [id, n] of Object.entries(rewards.items)) {
      const key = id as ItemId
      save.items[key] = (save.items[key] ?? 0) + n
    }
  }
  if (rewards.shards) {
    for (const [id, n] of Object.entries(rewards.shards)) {
      p.shards[id] = (p.shards[id] ?? 0) + n
    }
  }
  if (rewards.relics) {
    for (const defId of rewards.relics) {
      // uid 由**存档内**计数器派生 → 唯一且可复现（不用随机后缀，避免大档碰撞）
      save.relics.push(generateRelic(defId, rng, 1, nextRelicUid(save)))
    }
    // 库存上限：溢出的最没用遗物自动分解，折算进银两。
    // 锁定件 / 已装备件永不自动分解（宁可突破上限也不销毁玩家标记过的东西）。
    return enforceInventoryCap(save)
  }
  if (rewards.heroes) {
    for (const heroId of rewards.heroes) {
      grantHero(save, heroId, now)
    }
  }
  return emptyOverflow()
}

/**
 * 奖励包**通用聚合**（结算明细用）。
 *
 * ⚠ **唯一一份口径在 `core/systems/idle.ts`**（铁律 #4：两处各写一套必然对不上），
 *   这里**转出**而不是再写一遍。
 */
export { mergeRewardBundles } from './idle.ts'

/** 负载内的 uid 去重（重复提交的第一层防护） */
function dedupeUids(uids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const uid of uids) {
    if (seen.has(uid)) continue
    seen.add(uid)
    out.push(uid)
  }
  return out
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
  const payment = resolvePayment(count, save.player.crystals)
  if (!payment) {
    const required = pullCost(count)
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `余额不足（圣杯结晶 ${save.player.crystals}/${required.crystals}），无法召唤`,
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
        `余额不足（圣杯结晶 ${err.owned.crystals}/${err.required.crystals}），无法召唤`,
      )
    }
    throw err
  }

  // ── 校验通过，开始修改存档 ──
  save.player.crystals -= outcome.crystalsUsed
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
      // 重复 → **只给同名碎片**（合规：重复不直接提升强度；设计稿 §2）
      save.player.shards[r.heroId] = (save.player.shards[r.heroId] ?? 0) + r.shards
    }
  }
  save.stats.totalPulls += count
  // 任务计数：召唤次数（每日任务与周目标同时推进）
  save.daily = advanceTasks(save.daily, 'pull', count, ctx.now)

  const summary = summarizePull(outcome)
  return ok<PullActionResult>(
    {
      items: outcome.results.map((r) => ({
        heroId: r.heroId,
        rarity: r.rarity,
        isNew: r.isNew,
      })),
      shards: summary.shards,
      newHeroes: summary.newHeroes,
      crystalsUsed: outcome.crystalsUsed,
      guaranteedTriggered: outcome.guaranteedTriggered,
      newbieUsedConsumed: outcome.newbieUsedConsumed,
    },
    undefined,
  )
}

/**
 * **结算三条挂机通道并把奖励入库**（动作层入口）。
 *
 * ⚠ 入库只认 `rewards`（铁律 #26）：`settleIdleChannels` 只**产出**奖励包，
 *   入库由本函数统一走 `applyRewardBundle`（唯一入口，铁律 #4）。
 * ⚠ 三条通道**各自独立**：一条通道的目标失效**不影响**另外两条；
 *   无有效目标的通道**只推进计量水位**，不产出（设计稿 §3.6）。
 */
/**
 * **结算三条挂机通道并把奖励入库**（动作层入口）。
 *
 * ⚠ 入库只认 `rewards`（铁律 #26）：`settleIdleChannels` 只**产出**奖励包，
 *   入库由本函数统一走 `applyRewardBundle`（唯一入口，铁律 #4）。
 * ⚠ 三条通道**各自独立**：一条通道的目标失效**不影响**另外两条；
 *   无有效目标的通道**只推进计量水位**，不产出（设计稿 §3.6）。
 *
 * @param options.only 只结算指定通道（切换通道时只结清那一条）
 */
export function settleIdleAndApply(
  save: SaveData,
  ctx: ActionContext,
  options: { only?: IdleChannelKind } = {},
): IdleActionResult {  const result = settleIdleChannels(save, ctx, { only: options.only })
  for (const detail of result.channels) {
    applyRewardBundle(save, detail.rewards, ctx.rng, ctx.now)
  }
  // 任务计数：**只累计主线挂机成功结算次数**（设计稿 §3.5）
  const mainRolls = result.channels
    .filter((c) => c.channel === 'main')
    .reduce((sum, c) => sum + c.rolls, 0)
  if (mainRolls > 0) {
    save.daily = advanceTasks(save.daily, 'battle', mainRolls, ctx.now)
  }
  return { channels: result.channels, rolls: result.rolls }
}

/**
 * **一键领取**（`idle.tick` / `idle.claimOffline` 共用同一入口）。
 *
 * ⚠ 挂机**不跑战斗**：结算按掉落表逐次掷奖，三条通道各自独立。
 * ⚠ 领取次数由服务端按各通道的可用预算决定，客户端**不能**创造时间。
 */
function actionIdleTick(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'idle.tick' }>,
  ctx: ActionContext,
): ActionOutcome<IdleActionResult> {
  const result = settleIdleAndApply(save, ctx)
  return ok<IdleActionResult>({ channels: result.channels, rolls: result.rolls })
}

/** 离线领取与在线领取共用同一个入口、同一份账本、同一套限额。 */
function actionIdleClaimOffline(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'idle.claimOffline' }>,
  ctx: ActionContext,
): ActionOutcome<IdleActionResult> {
  const result = settleIdleAndApply(save, ctx)
  return ok<IdleActionResult>({ channels: result.channels, rolls: result.rolls })
}

/** 两个目标是否等价（用于「相同目标直接返回」） */
function sameChannelTarget(a: IdleChannelTarget | null, b: IdleChannelTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'main' && b.kind === 'main') return a.stageId === b.stageId
  if (a.kind === 'skill' && b.kind === 'skill') return a.dungeonStageId === b.dungeonStageId
  if (a.kind === 'enhance' && b.kind === 'enhance') return a.dungeonStageId === b.dungeonStageId
  return false
}

/**
 * **设置挂机通道**（主线 / 技能副本 / 强化副本）。
 *
 * ⚠ **三通道各自独立**：设置某一条通道**不影响**另外两条的时间账本。
 * ⚠ **切换或关闭前结清旧目标**（铁律 #49）：先按旧目标把完整次数结清，
 *   再换新目标；剩余不足一次的余数结转（不清零）——否则「切一次通道就多刷几场」。
 * ⚠ **目标必须已通关**：挂机只挂已通关内容，永不卡关。
 * ⚠ **相同目标直接返回**（无操作，不报错）。
 */
function actionIdleSetChannel(
  save: SaveData,
  payload: Extract<GameAction, { type: 'idle.setChannel' }>,
  ctx: ActionContext,
): ActionOutcome<IdleChannelResult> {
  const kind = payload.channel
  if (!IDLE_CHANNEL_KINDS.includes(kind)) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '挂机通道不存在')
  }
  const ch = save.idle.channels[kind]

  // ── 先校验目标（失败时存档一个字节未变） ──
  let next: IdleChannelTarget | null = null
  if (payload.disabled) {
    if (kind === 'main') {
      return fail(GAME_ERROR_CODES.NOT_FOUND, '主线通道不能关闭')
    }
    next = null
  } else if (kind === 'main') {
    const stageId = payload.stageId ?? null
    if (stageId !== null) {
      if (!Number.isSafeInteger(stageId) || !STAGE_INDEX.has(stageId)) {
        return fail(GAME_ERROR_CODES.NOT_FOUND, '关卡不存在')
      }
      // 只接受**已通关**的关卡
      if (stageId > save.campaign.clearedStage) {
        return fail(GAME_ERROR_CODES.NOT_FOUND, '只能挂已通关的关卡')
      }
    }
    next = { kind: 'main', stageId }
  } else {
    const id = payload.dungeonStageId
    if (!id) return fail(GAME_ERROR_CODES.NOT_FOUND, '副本关卡不存在')
    const stage = dungeonStageById(id)
    if (!stage) return fail(GAME_ERROR_CODES.NOT_FOUND, '副本关卡不存在')
    const variant = DUNGEON_INDEX.get(stage.variantId)
    if (!variant || variant.kind !== kind) {
      return fail(GAME_ERROR_CODES.NOT_FOUND, '副本关卡与通道不匹配')
    }
    // 副本必须**已通关**才可挂机
    if (save.dungeons.cleared[stage.id] !== true) {
      return fail(GAME_ERROR_CODES.NOT_FOUND, '该副本关卡尚未通关')
    }
    next = { kind, dungeonStageId: id } as IdleChannelTarget
  }

  // 相同目标 → 无操作
  if (sameChannelTarget(ch.target, next)) {
    return ok<IdleChannelResult>({ channel: kind, target: next, settled: [] }, '挂机通道未变化')
  }

  // ── 结清旧目标（只结清这一条通道） ──
  const settled = settleIdleAndApply(save, ctx, { only: kind }).channels

  // ── 换目标 / 开关 ──
  const wasOpen = ch.target !== null
  ch.target = next
  if (next === null) {
    // 关闭：结清后清掉剩余预算与离线累计，重新打开从开启时刻起算
    ch.effectiveMs = 0
    ch.offlineElapsedMs = 0
    ch.pendingOfflineMs = 0
    ch.measuredAt = ctx.now
  } else if (!wasOpen) {
    // 开启：从开启时刻起算
    ch.effectiveMs = 0
    ch.offlineElapsedMs = 0
    ch.pendingOfflineMs = 0
    ch.measuredAt = ctx.now
  } else {
    // 换目标：保留不足一次的余数，水位不得回退
    ch.effectiveMs = ch.effectiveMs % (IDLE.SECONDS_PER_ROLL * 1000)
  }

  const label = next === null ? '已关闭' : '挂机通道已更新'
  return ok<IdleChannelResult>({ channel: kind, target: next, settled }, label)
}

/**
 * **手动挑战主线关卡**（挂机改版 v11：主线推进改为纯手动挑战）。
 *
 * ⚠ **先校验后修改**：关卡必须合法且 **≤ 已通关 + 1**（不能跳关）。
 * ⚠ 每次胜利发一次**基础掉落**；首胜追加**经验书保底**与**首通结晶**。
 * ⚠ 首胜推进 `campaign.clearedStage`；主线通道若处于「跟随」模式，
 *   **推进前先按旧目标结清完整次数**（否则旧目标那段时间的收益会被吞掉）。
 * ⚠ **战败只返回挑战结果**，奖励包为空，通关记录保持原值。
 */
function actionCampaignChallenge(
  save: SaveData,
  payload: Extract<GameAction, { type: 'campaign.challenge' }>,
  ctx: ActionContext,
): ActionOutcome<CampaignChallengeResult> {
  const cleared = save.campaign.clearedStage
  const stageId = payload.stageId ?? cleared + 1
  if (!Number.isSafeInteger(stageId) || !STAGE_INDEX.has(stageId)) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '关卡不存在')
  }
  // 不能跳关：只能挑战「下一关」或已通关的关卡
  if (stageId > cleared + 1) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '关卡不存在')
  }
  const team = buildTeam(save)
  if (team.length === 0) return fail(GAME_ERROR_CODES.TEAM_EMPTY, '请先在阵位中编队')

  const stage = STAGE_INDEX.get(stageId)!
  const seed = ctx.rng.nextSeed()
  const pve = buildPveContext(save)
  const enemies = stage.enemyIds
    .map((id) => getEnemy(id))
    .filter((e): e is NonNullable<typeof e> => e !== null)
  if (enemies.length === 0) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '关卡配置异常')
  }
  const battle = runBattle({
    allies: team,
    enemies,
    enemyScale: stage.enemyScale,
    ctx: { ...pve, mode: 'pve', seed },
  })

  const win = battle.win
  const firstClear = win && stageId > cleared
  const rewards: RewardBundle = {}

  if (win) {
    // ① 基础掉落（与挂机同一张表、同一套掷奖口径）
    mergeRewardBundles(rewards, rollMainDrop(stage, ctx.rng))
    // ② 首通保底：没掷到经验书就补一本小经验书，保证三种首通奖励到账
    if (firstClear && !hasExpBook(rewards)) {
      rewards.items = { ...(rewards.items ?? {}), [EXP_BOOK.small.id]: 1 }
    }
    // ③ 首通推进前，**先按旧目标结清主线通道**（跟随模式不能吞掉旧目标的收益）
    if (firstClear) {
      settleIdleAndApply(save, ctx, { only: 'main' })
      save.campaign.clearedStage = stageId
    }
    // ④ 首通结晶（账号级，每关只发一次）
    //    ⚠ `grantFirstClearCrystals` **只记水位不入账**（铁律 #26），
    //    结晶一律进 `rewards` 由 `applyRewardBundle` 入库 —— 两条路径只能有一条。
    if (firstClear) {
      const crystals = grantFirstClearCrystals(save)
      if (crystals > 0) rewards.crystals = (rewards.crystals ?? 0) + crystals
    }
    applyRewardBundle(save, rewards, ctx.rng, ctx.now)
  }

  return ok<CampaignChallengeResult>({ stageId, win, firstClear, rewards, battle })
}

/** 奖励包里是否已经有经验书 */
function hasExpBook(rewards: RewardBundle): boolean {
  if (!rewards.items) return false
  return Object.keys(rewards.items).some((id) => isExpBook(id as ItemId))
}

/**
 * **手动挑战副本关卡**（挂机改版 v11）。
 *
 * ⚠ 副本是**独立关卡**：`(变体 × 难度) = 1 关`，打赢一次即通关。
 * ⚠ 每次胜利发一份对应材料；首胜登记通关并**解锁该关的挂机设置**。
 * ⚠ 副本**不写 `campaign`**（进度与主线分开记账）。
 */
function actionDungeonChallenge(
  save: SaveData,
  payload: Extract<GameAction, { type: 'dungeon.challenge' }>,
  ctx: ActionContext,
): ActionOutcome<DungeonChallengeResult> {
  const stage = dungeonStageById(payload.stageId)
  if (!stage) return fail(GAME_ERROR_CODES.NOT_FOUND, '副本关卡不存在')
  const unlock = dungeonStageUnlocked(save, stage)
  if (!unlock.unlocked) {
    return fail(GAME_ERROR_CODES.MATERIAL_UNLOCKED, unlock.reason)
  }
  const team = buildTeam(save)
  if (team.length === 0) return fail(GAME_ERROR_CODES.TEAM_EMPTY, '请先在阵位中编队')

  const seed = ctx.rng.nextSeed()
  const { win, battle } = runDungeonLevel(save, stage.id, seed, buildPveContext(save))

  const firstClear = win && save.dungeons.cleared[stage.id] !== true
  const rewards: RewardBundle = {}
  if (win) {
    const count = ctx.rng.int(stage.drop.min, stage.drop.max)
    if (count > 0) {
      rewards.items = { [stage.drop.itemId]: count } as RewardBundle['items']
    }
    if (firstClear) save.dungeons.cleared[stage.id] = true
    applyRewardBundle(save, rewards, ctx.rng, ctx.now)
  }

  return ok<DungeonChallengeResult>({
    stageId: stage.id,
    win,
    firstClear,
    rewards,
    battle: battle ?? undefined,
  })
}

/** 遗物稀有度档（祈愿抽签用；权重来自 `RELIC_ACQUIRE`） */
const RELIC_RARITY_ENTRIES: readonly { rarity: Rarity }[] = [
  { rarity: 'N' },
  { rarity: 'R' },
  { rarity: 'SR' },
  { rarity: 'SSR' },
]

/**
 * **遗物祈愿**（遗物的**独立获取入口**，§1.3 / U3）。
 *
 * ⚠ 遗物不再由挂机 / 手动挑战产出——三条通道与手动挑战的奖励范围是
 *   「经验书 / 银两 / 圣杯结晶 / 副本材料」（设计稿 §3.1）。
 *   遗物走这个**独立入口**，保证「首件遗物在初阶强化副本解锁前可达」。
 *
 * ⚠ 扣费前先校验余额（铁律 #10 / #22）：不足直接拒绝，不产生负数。
 */
function actionRelicAcquire(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'relic.acquire' }>,
  ctx: ActionContext,
): ActionOutcome<RelicAcquireResult> {
  const cost = RELIC_ACQUIRE.SILVER_COST
  if (save.player.silver < cost) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `银两不足（${save.player.silver}/${cost}），无法祈愿遗物`,
    )
  }
  // ⚠ 先校验通过再取种子（失败不消耗随机序列）
  const defId = rollRelicDefId(ctx.rng)
  if (!defId) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '遗物配置异常')
  }
  save.player.silver -= cost
  const uid = nextRelicUid(save)
  save.relics.push(generateRelic(defId, ctx.rng, RELIC.MIN_LEVEL, uid))
  enforceInventoryCap(save)
  return ok<RelicAcquireResult>(
    { relicId: defId, uid, silver: cost },
    '祈愿成功',
  )
}

/** 按稀有度权重抽一件遗物定义 id（权重来自 `RELIC_ACQUIRE`，唯一出处） */
function rollRelicDefId(rng: Rng): string | null {
  const weights = RELIC_ACQUIRE.RARITY_WEIGHTS
  const entries = RELIC_RARITY_ENTRIES
  const total = entries.reduce((sum, e) => sum + (weights[e.rarity] ?? 0), 0)
  if (total <= 0) return null
  let roll = rng.next() * total
  for (const entry of entries) {
    roll -= weights[entry.rarity] ?? 0
    if (roll < 0) {
      const pool = relicIdsByRarity(entry.rarity)
      if (pool.length === 0) continue
      return rng.pick(pool)
    }
  }
  return null
}

/**
 * 更新播放设置（倍速 / 音效 / 跳过演出）。
 *
 * 这些设置存在存档里，服务端权威后同样要经服务端落库，
 * 否则下一次响应会把本地改动覆盖掉。
 */
function actionSettingsUpdate(
  save: SaveData,
  payload: Extract<GameAction, { type: 'settings.update' }>,
  _ctx: ActionContext,
): ActionOutcome<true> {
  const s = save.settings
  if (payload.speed !== undefined) {
    const speeds: readonly number[] = BATTLE.SPEED_OPTIONS
    if (!speeds.includes(payload.speed)) {
      return fail(GAME_ERROR_CODES.NOT_FOUND, '倍速档位不合法')
    }
    s.speed = payload.speed
  }
  if (payload.sfx !== undefined) s.sfx = payload.sfx
  if (payload.skipAnim !== undefined) s.skipAnim = payload.skipAnim
  return ok<true>(true)
}

/**
 * 旧动作 `hero.feedExp` —— **已退役**。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：玩家经验池退役，喂经验改为
 *   「扣经验书 → 直接进英灵」（`hero.feedBooks`）。
 *   本动作**保留在联合类型里**是为了让旧客户端得到一个**明确**的拒绝，
 *   而不是静默失败——静默失败会让玩家以为「经验不足」。
 *
 *   错误码 `CLIENT_OUTDATED`，文案「客户端版本过旧，请刷新页面」。
 */
function actionFeedExp(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'hero.feedExp' }>,
  _ctx: ActionContext,
): ActionOutcome<FeedExpResult> {
  void save
  return fail(GAME_ERROR_CODES.CLIENT_OUTDATED, '客户端版本过旧，请刷新页面')
}

/**
 * 喂经验书（**新的唯一喂经验入口**）。
 *
 * 契约（铁律 #22「资源 → 进度必须闭合」）：
 *   ① 扣的是**经验书**（`save.items`），不是银两、不是经验池；
 *   ② 扣费前先校验余额 → 不足直接拒绝，**不产生负数、不吞书**；
 *   ③ 书换来的经验**真的能被消耗掉**——`applyExp` 里境界门槛仍是硬上限，
 *      门槛上积压的经验存着，突破后立即兑现。
 */
function actionFeedBooks(
  save: SaveData,
  payload: Extract<GameAction, { type: 'hero.feedBooks' }>,
  _ctx: ActionContext,
): ActionOutcome<FeedBooksResult> {
  const state = save.heroes[payload.heroId]
  if (!state) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  if (!isExpBook(payload.bookId)) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '该道具不是经验书')
  }
  const count = Math.floor(payload.count)
  if (!Number.isSafeInteger(count) || count <= 0) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '数量必须是正整数')
  }
  if (state.level >= LEVEL.MAX) {
    return fail(GAME_ERROR_CODES.MAX_LEVEL, '该英灵已达最高等级')
  }
  const owned = save.items[payload.bookId] ?? 0
  if (owned < count) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `${itemName(payload.bookId)}不足（${formatNumber(owned)} / ${formatNumber(count)}）`,
    )
  }

  // ── 校验通过，开始修改存档 ──
  const bookExp = EXP_BOOK_ITEM_EXP[payload.bookId] ?? 0
  const preview = previewFeed(state, bookExp, count)
  save.items[payload.bookId] = owned - count
  const res = applyFeedBooks(state, bookExp, count)

  const name = heroName(payload.heroId)
  const message =
    res.levelsGained > 0
      ? `${name} 提升了 ${res.levelsGained} 级`
      : res.blockedByRealm
        ? `${name} 已达境界门槛，需突破境界才能继续升级`
        : `已投入 ${formatNumber(res.applied)} 经验`
  return ok<FeedBooksResult>(
    {
      applied: res.applied,
      booksUsed: res.booksUsed,
      expRemaining: res.expRemaining,
      levelsGained: res.levelsGained,
      blockedByRealm: res.blockedByRealm,
    },
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
  // ⚠ **实施修正（资源/背包版本 v10）**：突破改扣**银两**（印记已退役）
  if (p.silver < cost.silver) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `银两不足（${formatNumber(p.silver)} / ${formatNumber(cost.silver)}）`,
    )
  }

  p.silver -= cost.silver
  if (!applyRealmBreak(state)) {
    // 兜底：状态不允许突破时把银两还回去
    p.silver += cost.silver
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
  const element = HERO_INDEX.get(payload.heroId)?.element
  if (!element) return silentFail(GAME_ERROR_CODES.NOT_FOUND)

  // 先判上限（受境界门槛约束），再判资源。
  // ⚠ 顺序反了会让技能已满级的玩家看到「资源不足」——那是误导。
  if (current >= skillLevelCap(state.level)) {
    return fail(GAME_ERROR_CODES.SKILL_CAP, '当前等级无法继续提升')
  }
  const cost = skillUpCost(current, element)
  if (!cost) {
    return fail(GAME_ERROR_CODES.SKILL_CAP, '当前等级无法继续提升')
  }
  // ⚠ **实施修正（资源/背包版本 v10）**：扣的是**该英灵五行对应的技能材料**
  //   （金 → 金系技能材料 …），不再是单一的术式结晶。
  const owned = save.items[cost.materialId] ?? 0
  if (owned < cost.material || save.player.silver < cost.silver) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `${itemName(cost.materialId)}或银两不足（${itemName(cost.materialId)} ${formatNumber(owned)}/${formatNumber(cost.material)}、银两 ${formatNumber(save.player.silver)}/${formatNumber(cost.silver)}）`,
    )
  }
  if (!applySkillUp(state, payload.index)) {
    return fail(GAME_ERROR_CODES.SKILL_CAP, '当前等级无法继续提升')
  }
  save.items[cost.materialId] = owned - cost.material
  save.player.silver -= cost.silver
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
  // ⚠ **实施修正（资源/背包版本 v10）**：升星**只扣同名碎片**（印记已退役）
  const shards = save.player.shards[payload.heroId] ?? 0
  if (shards < cost.shards) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `同名碎片不足（${formatNumber(shards)} / ${formatNumber(cost.shards)}）`,
    )
  }
  save.player.shards[payload.heroId] = shards - cost.shards
  applyStarUp(state)
  return ok<{ star: number }>({ star: state.star }, '星级已提升')
}

/** 遗物强化 */
function actionRelicUpgrade(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.upgrade' }>,
  ctx: ActionContext,
): ActionOutcome<RelicUpgradeResult> {
  const relic = save.relics.find((r) => r.uid === payload.uid)
  if (!relic) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  const cost = relicUpgradeCost(relic.level)
  if (!cost) {
    return fail(GAME_ERROR_CODES.MAX_RELIC_LEVEL, '已达最高强化等级')
  }
  // ⚠ **实施修正（资源/背包版本 v10）**：强化石分三档，扣的是**目标等级所属档**。
  const short = stoneShortfall(save, cost.stones)
  if (save.player.silver < cost.silver || short) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `银两或强化石不足（${short ? short.message : ''}${short ? '、' : ''}银两 ${formatNumber(save.player.silver)}/${formatNumber(cost.silver)}）`,
    )
  }
  save.player.silver -= cost.silver
  payStones(save, cost.stones)
  applyRelicUpgrade(relic)
  // 任务计数：遗物强化件数
  save.daily = advanceTasks(save.daily, 'relicUpgrade', 1, ctx.now)
  return ok<RelicUpgradeResult>({ uid: relic.uid, level: relic.level, cost })
}

/**
 * 强化石缺口检查（按档位）。
 *
 * @returns null = 够用；否则返回可展示的缺口说明
 */
function stoneShortfall(
  save: SaveData,
  stones: RelicStoneCosts,
): { message: string } | null {
  for (const [id, need] of Object.entries(stones)) {
    const owned = save.items[id as ItemId] ?? 0
    if (owned < (need ?? 0)) {
      return { message: `${itemName(id as ItemId)} ${formatNumber(owned)}/${formatNumber(need ?? 0)}` }
    }
  }
  return null
}

/** 扣强化石（按档位） */
function payStones(save: SaveData, stones: RelicStoneCosts): void {
  for (const [id, need] of Object.entries(stones)) {
    const key = id as ItemId
    save.items[key] = (save.items[key] ?? 0) - (need ?? 0)
  }
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
  // ⚠ **实施修正（资源/背包版本 v10）**：分解**只返银两**
  const value = decomposeValue(relic)
  save.player.silver += value.silver
  save.relics.splice(idx, 1)
  for (const key of Object.keys(save.equipped)) {
    if (save.equipped[key].relicId === payload.uid) delete save.equipped[key]
  }
  return ok<DecomposeResult>(
    { uid: payload.uid, silver: value.silver },
    '已分解遗物',
  )
}

/**
 * 锁定 / 解锁遗物。
 *
 * ⚠ 此前 `RelicInstance.locked` 恒为 false，**没有任何动作能置位**，
 *   但分解动作已按锁定拒绝 → 那条分支不可达。
 *   锁定的语义：**永不被自动分解**（库存溢出时也受保护）。
 */
function actionRelicLock(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.lock' }>,
  _ctx: ActionContext,
): ActionOutcome<{ uid: string; locked: boolean }> {
  const relic = save.relics.find((r) => r.uid === payload.uid)
  if (!relic) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  relic.locked = payload.locked
  return ok<{ uid: string; locked: boolean }>(
    { uid: relic.uid, locked: relic.locked },
    relic.locked ? '遗物已锁定，不会被自动分解' : '遗物已解锁',
  )
}

/**
 * 批量分解。
 *
 * ⚠ 动作层契约：**先校验后修改** —— 任一前置条件不满足就整批拒绝，
 *   存档一个字节都不变。
 *
 * 规则：
 *   ① 负载内重复 uid 只处理一次（重复提交的第一层防护）；
 *   ② **锁定件跳过**并回报（不是整批失败 —— 一把锁不该卡住整批操作）；
 *   ③ 已装备的先卸下再分解，并回报卸下了几件；
 *   ④ 遗物不存在 → 整批拒绝（说明这次请求已经过期）。
 */
function actionDecomposeRelicBatch(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.decomposeBatch' }>,
  _ctx: ActionContext,
): ActionOutcome<DecomposeBatchResult> {
  const uids = dedupeUids(payload.uids)
  if (uids.length === 0) return fail(GAME_ERROR_CODES.RELIC_BATCH_EMPTY, '没有选中遗物')
  if (uids.length > RELIC.BATCH_MAX) {
    return fail(GAME_ERROR_CODES.RELIC_BATCH_TOO_LARGE, `单次最多分解 ${RELIC.BATCH_MAX} 件`)
  }

  // ── 校验阶段（不改存档） ──
  const targets: RelicInstance[] = []
  const skipped: string[] = []
  for (const uid of uids) {
    const relic = save.relics.find((r) => r.uid === uid)
    if (!relic) return fail(GAME_ERROR_CODES.NOT_FOUND, '遗物不存在（可能已被分解）')
    if (relic.locked) {
      skipped.push(uid)
      continue
    }
    targets.push(relic)
  }
  if (targets.length === 0) {
    return ok<DecomposeBatchResult>(
      { decomposed: 0, silver: 0, skipped, unequipped: 0 },
      '选中的遗物都已锁定，未做任何改动',
    )
  }

  // ── 修改阶段 ──
  let unequipped = 0
  for (const relic of targets) {
    for (const key of Object.keys(save.equipped)) {
      if (save.equipped[key].relicId === relic.uid) {
        delete save.equipped[key]
        unequipped++
      }
    }
  }
  const removed = new Set(targets.map((r) => r.uid))
  let silver = 0
  for (const relic of targets) {
    const value = decomposeValue(relic)
    silver += value.silver
  }
  save.relics = save.relics.filter((r) => !removed.has(r.uid))
  // ⚠ 分解**只返银两**（设计稿 §2）——不返还强化石
  save.player.silver += silver

  return ok<DecomposeBatchResult>(
    { decomposed: targets.length, silver, skipped, unequipped },
    `已分解 ${targets.length} 件遗物`,
  )
}

/**
 * 一键分解（按筛选条件）。
 *
 * 默认只清理**最低等级**（1 级）的未锁定、未装备遗物 —— 一步到位的「清垃圾」。
 * 想清更多就在请求里显式给 `maxLevel`。
 */
function actionDecomposeRelicByFilter(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.decomposeByFilter' }>,
  _ctx: ActionContext,
): ActionOutcome<DecomposeBatchResult> {
  const maxLevel = payload.maxLevel ?? RELIC.MIN_LEVEL
  if (!Number.isSafeInteger(maxLevel) || maxLevel < RELIC.MIN_LEVEL || maxLevel > RELIC.MAX_LEVEL) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '强化等级不合法')
  }
  const equipped = equippedRelicIds(save)
  const candidates = save.relics.filter((relic) => {
    if (relic.locked) return false
    if (!payload.includeEquipped && equipped.has(relic.uid)) return false
    if (relic.level > maxLevel) return false
    if (payload.rarity) {
      if ((RELIC_DEFS.get(relic.defId)?.rarity ?? 'N') !== payload.rarity) return false
    }
    if (payload.setId) {
      if ((RELIC_DEFS.get(relic.defId)?.setId ?? '') !== payload.setId) return false
    }
    return true
  })

  if (candidates.length === 0) {
    return ok<DecomposeBatchResult>(
      { decomposed: 0, silver: 0, skipped: [], unequipped: 0 },
      '没有符合条件的遗物',
    )
  }
  // 复用批量分解的落库逻辑（同一份口径，不另写一套）
  const capped = candidates.slice(0, RELIC.BATCH_MAX)
  const outcome = actionDecomposeRelicBatch(
    save,
    { type: 'relic.decomposeBatch', uids: capped.map((r) => r.uid) },
    _ctx,
  )
  if (!outcome.ok) return outcome
  const result = outcome.result
  const extra = candidates.length - capped.length
  return ok<DecomposeBatchResult>(
    { ...result, skipped: [...result.skipped], decomposed: result.decomposed },
    extra > 0
      ? `已分解 ${result.decomposed} 件（还有 ${extra} 件超出单次上限，可再执行一次）`
      : `已分解 ${result.decomposed} 件遗物`,
  )
}

/**
 * 批量强化。
 *
 * 花费**先算清再扣**：总费用不够就整批拒绝，存档不变（铁律 #10 / #22）。
 */
function actionUpgradeRelicBatch(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.upgradeBatch' }>,
  ctx: ActionContext,
): ActionOutcome<UpgradeBatchResult> {
  const uids = dedupeUids(payload.uids)
  if (uids.length === 0) return fail(GAME_ERROR_CODES.RELIC_BATCH_EMPTY, '没有选中遗物')
  if (uids.length > RELIC.BATCH_MAX) {
    return fail(GAME_ERROR_CODES.RELIC_BATCH_TOO_LARGE, `单次最多强化 ${RELIC.BATCH_MAX} 件`)
  }
  const targetLevel = payload.targetLevel
  if (targetLevel !== undefined && (!Number.isSafeInteger(targetLevel) || targetLevel < RELIC.MIN_LEVEL || targetLevel > RELIC.MAX_LEVEL)) {
    return fail(GAME_ERROR_CODES.NOT_FOUND, '目标强化等级不合法')
  }

  // ── 校验阶段 ──
  const targets: { relic: RelicInstance; to: number }[] = []
  let silver = 0
  const stones: RelicStoneCosts = {}
  for (const uid of uids) {
    const relic = save.relics.find((r) => r.uid === uid)
    if (!relic) return fail(GAME_ERROR_CODES.NOT_FOUND, '遗物不存在')
    const to = targetLevel ?? relic.level + 1
    if (to > RELIC.MAX_LEVEL) {
      return fail(GAME_ERROR_CODES.MAX_RELIC_LEVEL, '已达最高强化等级')
    }
    if (to <= relic.level) {
      return fail(GAME_ERROR_CODES.NOT_FOUND, '目标强化等级不高于当前等级')
    }
    // ⚠ 批量强化按**累计投入之差**计费，不是「单级价格 × 级数」：
    //   强化价格随等级指数上升（铁律 #4：扣费口径只有一份，
    //   与玩家逐级点的账必须逐位对得上）。
    // ⚠ 强化石**按档位**差值计费（跨档时初阶 + 中阶各算各的）。
    const delta = relicCostDelta(relic.level, to)
    silver += delta.silver
    for (const [id, n] of Object.entries(delta.stones)) {
      const key = id as ItemId
      stones[key] = (stones[key] ?? 0) + (n ?? 0)
    }
    targets.push({ relic, to })
  }

  const short = stoneShortfall(save, stones)
  if (save.player.silver < silver || short) {
    return fail(
      GAME_ERROR_CODES.INSUFFICIENT_FUNDS,
      `银两或强化石不足（需要 银两 ${formatNumber(silver)}${short ? `、${short.message}` : ''}）`,
    )
  }

  // ── 修改阶段 ──
  save.player.silver -= silver
  payStones(save, stones)
  const levels: { uid: string; level: number }[] = []
  for (const { relic, to } of targets) {
    relic.level = to
    levels.push({ uid: relic.uid, level: relic.level })
  }
  // 任务计数：批量强化按**件数**计（强化 3 件 = 3 次）
  save.daily = advanceTasks(save.daily, 'relicUpgrade', targets.length, ctx.now)
  return ok<UpgradeBatchResult>(
    { upgraded: targets.length, silver, stones, levels },
    `已强化 ${targets.length} 件遗物`,
  )
}

/** 装备 / 卸下遗物 */
function actionRelicEquip(
  save: SaveData,
  payload: Extract<GameAction, { type: 'relic.equip' }>,
  _ctx: ActionContext,
): ActionOutcome<true> {
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
  return ok<true>(true)
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
): ActionOutcome<true> {
  if (payload.index < 0 || payload.index >= save.team.slots.length) {
    return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  }
  if (payload.heroId !== null && !save.heroes[payload.heroId]) {
    return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  }
  // ⚠ 挂机改版 v11：挂机**不跑战斗**，编队变化**不影响**已通关目标的挂机资格
  //   ⇒ 换人不需要结清挂机账本（旧实现里的「旧队积压转交新队」已随回放模型退场）。
  const slots = save.team.slots
  if (payload.heroId) {
    const existing = slots.indexOf(payload.heroId)
    if (existing >= 0) slots[existing] = null
  }
  slots[payload.index] = payload.heroId
  return ok<true>(true)
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
): ActionOutcome<true> {
  const preset = save.team.presets.find((p) => p.id === payload.presetId)
  if (!preset) return silentFail(GAME_ERROR_CODES.NOT_FOUND)
  // ⚠ 挂机改版 v11：编队不影响挂机产出（挂机不跑战斗），不需要结清账本。
  save.team.slots = [...preset.slots]
  return ok<true>(true)
}

/** 删除编队预设 */
function actionRemovePreset(
  save: SaveData,
  payload: Extract<GameAction, { type: 'team.removePreset' }>,
  _ctx: ActionContext,
): ActionOutcome<true> {
  save.team.presets = save.team.presets.filter((p) => p.id !== payload.presetId)
  return ok<true>(true)
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
  // 挂机改版 v11：重启后**三条通道**的计量水位与预算一并归零
  for (const kind of IDLE_CHANNEL_KINDS) {
    const ch = save.idle.channels[kind]
    ch.measuredAt = _ctx.now
    ch.effectiveMs = 0
    ch.offlineElapsedMs = 0
    ch.pendingOfflineMs = 0
  }
  save.idle.activeUntil = _ctx.now
  save.lastTickAt = _ctx.now
  return ok<RebirthPreview>(
    result,
    `圣杯重启完成 · 永久加成 ${Math.round(result.nextPermBoost * 100)}%`,
  )
}

/**
 * 竞技场结算（镜像试炼）。
 *
 * 对手沿用**镜像试炼**语义（对手 = 攻方自己的阵容快照），
 * 只把「生成 + 结算」整体搬到服务端，玩法不变。
 *
 * ⚠ 段位分归属：本动作**只写 `pvpPoints`**（归一化对战分），
 *   `tierPoints`（PVE 天梯段位分）由**三队天梯**独占。
 *   §9.2：9.1 衡量「养成强度」、9.2 衡量「战术水平」，两者不互相换算——
 *   两个模式各写同一个段位分，段位就变成两个模式混在一起的东西。
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
  // 对战分只归 PvP 口径；天梯段位分由 `arena.ladderChallenge` 写
  a.pvpPoints = (a.pvpPoints ?? 0) + (match.result.win ? 20 : 5)
  a.snapshotHash = arenaSnapshotHash(loadout)
  a.defenseLoadout = loadout

  const rewardWeek = arenaWeekIndex(ctx.now)
  if (a.rewardWeek !== rewardWeek) {
    a.rewardWeek = rewardWeek
    a.weeklyMedals = 0
    a.weeklyMaterials = 0
    a.weeklyTickets = 0
  }
  // ⚠ **实施修正（资源/背包版本 v10）**：竞技产出退场（设计稿 §3）
  //   —— 只承接段位分与称号，勋章 / 竞技材料 / 抽卡券全部停发。
  const { reward, weeklyMedals, weeklyMaterials } = resolveArenaRewards(
    match.result.win,
    a.weeklyMedals ?? 0,
    a.weeklyMaterials ?? 0,
  )
  a.medals = (a.medals ?? 0) + reward.medals
  a.arenaMaterials = (a.arenaMaterials ?? 0) + reward.arenaMaterials
  a.weeklyMedals = weeklyMedals
  a.weeklyMaterials = weeklyMaterials

  return ok<ArenaSettleResult>({ match, reward })
}

// ─────────────────────────── 三队天梯（PVE 长线挑战） ───────────────────────────

/**
 * 保存演武场阵容（3 队 × 6 槽）。
 *
 * ⚠ 先校验后修改：任一队不合法就整份拒绝，存档一字节未变。
 */
function actionLadderSaveSquads(
  save: SaveData,
  payload: Extract<GameAction, { type: 'arena.ladderSaveSquads' }>,
  _ctx: ActionContext,
): ActionOutcome<true> {
  const squads = payload.squads
  if (!Array.isArray(squads) || squads.length !== LADDER.SQUAD_COUNT) {
    return fail(GAME_ERROR_CODES.LADDER_INVALID_LINEUP, `阵容不合法：需要 ${LADDER.SQUAD_COUNT} 支队伍`)
  }
  for (const row of squads) {
    const err = validateSquad(save, row)
    if (err) return fail(GAME_ERROR_CODES.LADDER_INVALID_LINEUP, `阵容不合法：${err}`)
  }
  save.arena.ladder.squads = squads.map((row) => [...row])
  return ok(true, '演武场阵容已保存')
}

/**
 * 发起一轮天梯挑战（3 队 × 3 梯队）。
 *
 * ⚠ **每周一轮**（北京时间周一零点切换）：本周已结算过就拒绝。
 * ⚠ **PVE 完整数值**（§9.1）：本模式走 `resolveStats(mode:'pve')`，
 *   等级 / 遗物强化 / 羁绊 / 永久加成全部生效。
 * ⚠ **产出隔离**（§6.11）：只发竞技勋章与竞技材料，不回流 PVE 经济。
 */
function actionLadderChallenge(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'arena.ladderChallenge' }>,
  ctx: ActionContext,
): ActionOutcome<LadderChallengeResult> {
  const ladder = save.arena.ladder
  const week = arenaWeekIndex(ctx.now)

  // ① 先校验（失败即原子：此刻存档一个字节都没变）
  if (ladder.lastSettledWeek === week) {
    return fail(GAME_ERROR_CODES.LADDER_ALREADY_SETTLED, '本周的天梯已经挑战过了')
  }
  const squads = buildLadderSquads(save)
  if (squads.every((s) => s.length === 0)) {
    return fail(GAME_ERROR_CODES.LADDER_NO_SQUAD, '请先在演武场编队')
  }

  // ② 周期滚动（赛季结算 / 回流判定）——校验通过之后才改存档
  const rolled = rollLadderPeriods(save, ctx.now)

  // ③ 跑战斗（随机序列只在校验通过后消耗）
  const round = resolveLadderRound(save, () => ctx.rng.nextSeed())

  // ④ 入账
  save.arena.tierPoints = (save.arena.tierPoints ?? 0) + round.points
  ladder.seasonPoints = (ladder.seasonPoints ?? 0) + round.points
  ladder.lastSettledWeek = week

  const { reward, weeklyMedals, weeklyMaterials } = resolveLadderRewards(
    round.wins,
    save.arena.weeklyMedals ?? 0,
    save.arena.weeklyMaterials ?? 0,
  )
  save.arena.weeklyMedals = weeklyMedals
  save.arena.weeklyMaterials = weeklyMaterials
  save.arena.medals = (save.arena.medals ?? 0) + reward.medals
  save.arena.arenaMaterials = (save.arena.arenaMaterials ?? 0) + reward.arenaMaterials
  round.reward = reward

  const settlementNote = rolled.settlements.length
    ? ` · 赛季 ${rolled.settlements[rolled.settlements.length - 1].season} 已结算`
    : ''
  return ok<LadderChallengeResult>(
    { ...round, settlements: rolled.settlements },
    `天梯挑战结束 · ${round.wins}/3 胜 · 段位分 +${round.points} · 勋章 +${reward.medals}${settlementNote}`,
  )
}

/**
 * 领取回流奖励。
 *
 * ⚠ 回流奖励属于**留存经济**（不是竞技产出）：
 *   - 养成材料走 `rewards` 入库（铁律 #26）；
 *   - 竞技勋章是竞技专属资源，直接记在 `arena.medals`；
 *   - **不含**圣杯结晶 / 抽卡券 → 不冲击抽卡间隔（与铁律 #38 同一把尺）。
 */
function actionLadderClaimReturn(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'arena.ladderClaimReturn' }>,
  ctx: ActionContext,
): ActionOutcome<LadderReturnResult> {
  const ladder = save.arena.ladder
  if (!ladder.returnPending) {
    return fail(GAME_ERROR_CODES.RETURN_NOT_AVAILABLE, '当前没有可领取的回流奖励')
  }
  const days = ladder.returnDays ?? 0
  const reward = resolveReturnReward(days)
  if (!reward) {
    return fail(GAME_ERROR_CODES.RETURN_NOT_AVAILABLE, '当前没有可领取的回流奖励')
  }

  // 入库（先改再清标记，失败即原子：这一步不会失败）
  // ⚠ **实施修正（资源/背包版本 v10）**：回流奖励改发**通用经验书**（`items`），
  //   竞技勋章停发（`medals` 恒为 0）。
  const rewards: RewardBundle = { items: reward.items as RewardBundle['items'] }
  applyRewardBundle(save, rewards, ctx.rng, ctx.now)
  save.arena.medals = (save.arena.medals ?? 0) + reward.medals
  ladder.returnPending = false
  ladder.returnDays = 0
  ladder.lastReturnAt = ctx.now

  return ok<LadderReturnResult>(
    {
      rewards,
      medals: reward.medals,
      days,
    },
    `回流奖励已领取（离线 ${days} 天）`,
  )
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

  // 入库（先改再清标记，失败即原子：这一步不会失败）
  const rewards: RewardBundle = {
    crystals: reward.crystals,
    silver: reward.silver,
    items: reward.items,
  }
  applyRewardBundle(save, rewards, ctx.rng, ctx.now)

  d.signInStreak = index + 1
  d.lastSignInDay = today
  // 任务计数：签到次数
  save.daily = advanceTasks(save.daily, 'signIn', 1, ctx.now)
  return ok<RewardBundle>(rewards, '签到成功')
}

/**
 * 领取任务奖励（roadmap P2-1）。
 *
 * ## 契约
 *
 * - **先校验后修改**：任务不存在 / 未完成 / 本周期已领过 → 直接失败，存档一字节未变；
 * - **周期滚动先于校验**：跨日 / 跨周后进度与领取状态都要先归位，
 *   否则「昨天没领的每日任务」会在今天被重复领取；
 * - **奖励只经 `rewards` 入库**（铁律 #26）：走 `applyRewardBundle`，
 *   不自己往 `player` 上加数字；
 * - **服务端权威**：进度存在存档里 → 换设备看到同一份进度，
 *   重复领取由服务端拒绝（客户端传新 actionId 也领不到第二次）。
 */
function actionClaimTask(
  save: SaveData,
  payload: Extract<GameAction, { type: 'daily.claimTask' }>,
  ctx: ActionContext,
): ActionOutcome<RewardBundle> {
  const view = taskView(save.daily, ctx.now, payload.taskId)
  if (!view) return fail(GAME_ERROR_CODES.TASK_NOT_FOUND, '任务不存在')
  if (view.claimed) {
    return fail(GAME_ERROR_CODES.TASK_ALREADY_CLAIMED, '该任务的奖励已经领取过了')
  }
  if (!view.completed) {
    return fail(
      GAME_ERROR_CODES.TASK_NOT_COMPLETED,
      `任务还没完成（${view.progress} / ${view.def.target}）`,
    )
  }

  // ── 校验通过，开始修改存档 ──
  const rewards = taskRewardBundle(view.def.rewards)
  applyRewardBundle(save, rewards, ctx.rng, ctx.now)
  // 写回滚动 + 领取记录（跨日 / 跨周的归位也在这里落库）
  const next = rollTasks(save.daily, ctx.now)
  save.daily = { ...next, taskClaimed: [...next.taskClaimed, view.def.id] }
  return ok<RewardBundle>(rewards, '任务奖励已领取')
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
  const rewards: RewardBundle = {
    crystals: def.crystals,
    silver: def.silver,
    items: def.items,
  }
  applyRewardBundle(save, rewards, _ctx.rng, _ctx.now)
  save.codes.push(key)
  return ok<RewardBundle>(rewards, '兑换成功')
}

/**
 * 旧档一次性分配权益（v9 → v10 迁移产物）。
 *
 * ⚠ 术式结晶 / 遗物强化石**不自动折算**：玩家自己选一个五行 / 一个石档
 *   （实现文档 §2「避免强塞无用材料或按件数放大高阶价值」）。
 *
 * 契约：
 *   - **一次性**：已分配过 → `LEGACY_ALREADY_ALLOCATED`；
 *   - 两额都为 0 → 没有可分配的东西，直接拒绝；
 *   - 分配后立即核销（`allocated = true`），原额清零。
 */
function actionAllocateMaterials(
  save: SaveData,
  payload: Extract<GameAction, { type: 'legacy.allocateMaterials' }>,
  ctx: ActionContext,
): ActionOutcome<{ items: Partial<Record<ItemId, number>> }> {
  const legacy = save.legacy
  if (legacy.allocated) {
    return fail(GAME_ERROR_CODES.LEGACY_ALREADY_ALLOCATED, '旧档权益已经分配过了')
  }
  if (legacy.skillStones <= 0 && legacy.relicStones <= 0) {
    return fail(GAME_ERROR_CODES.LEGACY_ALREADY_ALLOCATED, '当前没有可分配的旧档权益')
  }
  const tier = RELIC.STONE_TIERS.find((t) => t.id === payload.relicTier)
  if (!tier) return fail(GAME_ERROR_CODES.NOT_FOUND, '强化石档位不存在')

  const items: Partial<Record<ItemId, number>> = {}
  if (legacy.skillStones > 0) {
    const materialId = ITEM_BY_ELEMENT[payload.skillElement]
    const count = Math.floor(legacy.skillStones * LEGACY_CONVERSION.skillStoneToMaterial)
    if (count > 0) items[materialId] = count
    legacy.skillStones = 0
  }
  if (legacy.relicStones > 0) {
    const stoneId = RELIC_STONE_ITEM_BY_TIER[tier.id]
    const count = Math.floor(legacy.relicStones * LEGACY_CONVERSION.relicStoneToMaterial)
    if (count > 0) items[stoneId] = (items[stoneId] ?? 0) + count
    legacy.relicStones = 0
  }
  legacy.allocated = true

  applyRewardBundle(save, { items }, ctx.rng, ctx.now)
  return ok<{ items: Partial<Record<ItemId, number>> }>({ items }, '旧档材料已分配')
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
): ActionOutcome<true> {
  const fresh = createNewSave(ctx.now, ctx.randomSeed())
  Object.assign(save, fresh)
  return ok<true>(true, '已创建新存档')
}

/** 重置进度：玩家主动覆盖，允许强行写入 */
function actionReset(
  save: SaveData,
  _payload: Extract<GameAction, { type: 'save.reset' }>,
  ctx: ActionContext,
): ActionOutcome<true> {
  // 重置 → 换一条全新的随机序列（否则旧档的抽卡位置会被继承）
  const fresh = createNewSave(ctx.now, ctx.randomSeed())
  Object.assign(save, fresh)
  return ok<true>(true, '进度已重置', 'warn')
}

/** 导入存档（玩家主动覆盖） */
function actionImport(
  save: SaveData,
  payload: Extract<GameAction, { type: 'save.import' }>,
  ctx: ActionContext,
): ActionOutcome<true> {
  let imported
  try {
    imported = validateImportedSave(payload.payload, ctx.now, ctx.randomSeed)
  } catch {
    return fail(GAME_ERROR_CODES.IMPORT_INVALID, '存档数据无效')
  }
  Object.assign(save, imported)
  // 导入路径重置挂机账本：三条通道从导入时刻起算，不继承导入前的离线收益
  for (const kind of IDLE_CHANNEL_KINDS) {
    const ch = save.idle.channels[kind]
    ch.measuredAt = ctx.now
    ch.effectiveMs = 0
    ch.offlineElapsedMs = 0
    ch.pendingOfflineMs = 0
  }
  save.idle.activeUntil = ctx.now
  save.lastTickAt = ctx.now
  return ok<true>(true, '存档已导入')
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
  'idle.heartbeat': (save, _payload, ctx) => {
    // ⚠ 心跳是「轻量心跳」：**只计量、不发奖**；计量结束后才续租。
    //   计量是纯数值运算，成本与单条通道同量级（铁律 #33）。
    const measurable = measureIdleChannels(save, ctx.now)
    if (measurable) {
      save.idle.activeUntil = ctx.now + IDLE.ACTIVE_LEASE_MS
    }
    return ok(true)
  },
  'idle.claimOffline': actionIdleClaimOffline,
  'idle.setChannel': actionIdleSetChannel,
  'campaign.challenge': actionCampaignChallenge,
  'dungeon.challenge': actionDungeonChallenge,
  'relic.acquire': actionRelicAcquire,
  'settings.update': actionSettingsUpdate,
  'hero.feedExp': actionFeedExp,
  'hero.feedBooks': actionFeedBooks,
  'hero.breakRealm': actionBreakRealm,
  'hero.upgradeSkill': actionUpgradeSkill,
  'hero.upgradeStar': actionUpgradeStar,
  'relic.upgrade': actionRelicUpgrade,
  'relic.decompose': actionDecomposeRelic,
  'relic.lock': actionRelicLock,
  'relic.decomposeBatch': actionDecomposeRelicBatch,
  'relic.upgradeBatch': actionUpgradeRelicBatch,
  'relic.decomposeByFilter': actionDecomposeRelicByFilter,
  'relic.equip': actionRelicEquip,
  'relic.autoEquip': actionAutoEquip,
  'team.setSlot': actionSetSlot,
  'team.savePreset': actionSavePreset,
  'team.applyPreset': actionApplyPreset,
  'team.removePreset': actionRemovePreset,
  'rebirth.do': actionRebirth,
  'arena.settle': actionArenaSettle,
  'arena.ladderSaveSquads': actionLadderSaveSquads,
  'arena.ladderChallenge': actionLadderChallenge,
  'arena.ladderClaimReturn': actionLadderClaimReturn,
  'daily.signIn': actionSignIn,
  'daily.claimTask': actionClaimTask,
  'code.redeem': actionRedeemCode,
  'legacy.allocateMaterials': actionAllocateMaterials,
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
