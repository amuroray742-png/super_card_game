/**
 * 抽卡执行（§7）。
 *
 * 随机部分完全由 `gachaRates.drawRarity` 决定——与概率公示同源（合规硬要求）。
 * 本模块只负责：选人、判重、转化、扣费、记账。
 */
import type { HeroState, PoolDef, Rarity } from '../model/types.ts'
import { GACHA } from '../config/economy.ts'
import { getPool, groupByRarity, resolvePoolHeroIds } from '../config/pools.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { Rng } from '../rng.ts'
import { computeEffectiveRates, drawRarity, shouldReplaceForNewbie, type PityState } from './gachaRates.ts'

export interface PullResult {
  heroId: string
  rarity: Rarity
  /** 是否首次获得 */
  isNew: boolean
  /**
   * 重复转化所得**同名碎片**（升星用）。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：重复卡**只**给同名碎片，
   *   且**全稀有度适用**（设计稿 §2「某英灵的同名卡碎片｜抽到该英灵的重复卡，
   *   N、R、SR、SSR 均适用｜只给该英灵升星」）。
   *   印记与「N 卡重复给银两」两条旧路径同时退役。
   */
  shards: number
  /** 是否触发大保底 */
  pityTriggered: boolean
}

export interface PullOutcome {
  results: PullResult[]
  pity: PityState
  crystalsUsed: number
  /** 新手池保底是否触发 */
  guaranteedTriggered: boolean
  /** 本次抽卡是否消耗掉了新手保底资格 */
  newbieUsedConsumed: boolean
}

export interface PullContext {
  pity: PityState
  owned: Record<string, HeroState>
  crystals: number
  /**
   * 新手保底是否已被使用。
   *
   * ⚠ 原实现把新手保底挂在「是否已拥有指定 SSR」上——玩家若在**别的卡池**
   * 先抽到该角色（常驻池 SSR 基础率 0.60%，完全可能），
   * 新手福利就会永久失效。
   * 方案 §7.3 第 3 条的语义是「新手期**首次** 10 连保底 1 个 SSR」，
   * 因此资格应按「是否已使用过」判定，而非「是否拥有该角色」。
   */
  newbieUsed?: boolean
}

function availableRarities(byRarity: Record<Rarity, string[]>): Rarity[] {
  return (['SSR', 'SR', 'R', 'N'] as const).filter((rarity) => byRarity[rarity].length > 0)
}

/** 优先使用新手池指定的英灵。其他卡池使用该池的 SSR。 */
function newbieGuaranteeTarget(byRarity: Record<Rarity, string[]>, newbieUsed: boolean): string | undefined {
  if (newbieUsed) return undefined
  const preferredHeroId = getPool('newbie').guaranteedHeroId
  return preferredHeroId && byRarity.SSR.includes(preferredHeroId) ? preferredHeroId : byRarity.SSR[0]
}

/** 当前卡池和玩家保底资格对应的公示。 */
export function ratesForPool(pool: PoolDef, pity: PityState, newbieUsed: boolean) {
  const byRarity = groupByRarity(resolvePoolHeroIds(pool))
  return computeEffectiveRates(pity, availableRarities(byRarity), newbieGuaranteeTarget(byRarity, newbieUsed) !== undefined)
}

/**
 * 抽卡费用（**逐抽计价**）
 *
 * 口径（§7.5）：**圣杯结晶是唯一抽卡货币**。
 * - 每一抽 300 结晶；单抽与十连**同一个单价**。
 * - 十连 = 10 抽 → 3000 结晶。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：抽卡券已随钱包收敛退役，
 *   扣费口径里**不再有券**（设计稿 §2「沿用每抽 300、十连 3,000」）。
 */
export function pullCost(count: 1 | 10): { crystals: number } {
  const pulls = pullCount(count)
  return {
    crystals: GACHA.COST_SINGLE * pulls,
  }
}

/** 抽卡次数 → 实际抽数（单抽 1 抽，十连 `GACHA.TEN_PULL_COUNT` 抽） */
function pullCount(count: 1 | 10): number {
  return count === GACHA.TEN_PULL_COUNT ? GACHA.TEN_PULL_COUNT : 1
}

/**
 * 抽卡货币不足。
 *
 * ⚠ 刻意**不用** TypeScript 参数属性（`constructor(readonly required: …)`）：
 *   参数属性不可擦除，Node 的原生 TS 类型擦除（`node file.ts`）会报
 *   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。服务端要 import core（AGENTS.md 铁律 #28），
 *   所以 core 里所有类都必须写成「显式字段 + 构造体内赋值」。
 */
export class InsufficientFundsError extends Error {
  readonly required: { crystals: number }
  readonly owned: { crystals: number }

  constructor(required: { crystals: number }, owned: { crystals: number }) {
    super('抽卡货币不足')
    this.name = 'InsufficientFundsError'
    this.required = required
    this.owned = owned
  }
}

/**
 * 结算一次抽卡的**实际扣费**（逐抽计价）。
 *
 * 每一抽 300 圣杯结晶；结晶不够本次抽数 → 余额不足，返回 `null`。
 *
 * ⚠ 旧实现无论余额多少都照扣，结晶可被扣成负数，等于取消抽卡总闸门。
 *
 * @returns 实际扣费明细；余额不足时返回 null（调用方必须拒绝本次抽卡）
 */
export function resolvePayment(count: 1 | 10, crystals: number): { crystals: number } | null {
  const pulls = pullCount(count)
  const need = GACHA.COST_SINGLE * pulls
  if (crystals < need) return null
  return { crystals: need }
}

function rarityRank(rarity: Rarity): number {
  return rarity === 'SSR' ? 3 : rarity === 'SR' ? 2 : rarity === 'R' ? 1 : 0
}

/**
 * 执行一次抽卡（1 抽或十连）。
 *
 * @param ctx   当前保底与持有状态
 * @param pool  卡池
 * @param count 1 或 10
 * @param seed  随机种子
 */
export function executePull(
  ctx: PullContext,
  pool: PoolDef,
  count: 1 | 10,
  seed: number,
): PullOutcome {
  const rng = new Rng(seed)

  // 余额校验：不足则拒绝本次抽卡（绝不扣成负数）
  const payment = resolvePayment(count, ctx.crystals)
  if (!payment) {
    throw new InsufficientFundsError(pullCost(count), { crystals: ctx.crystals })
  }

  let pity: PityState = { ...ctx.pity }
  const results: PullResult[] = []
  let guaranteedTriggered = false

  const poolHeroIds = resolvePoolHeroIds(pool)
  const byRarity = groupByRarity(poolHeroIds)

  /**
   * 该池实际收录的稀有度。
   * 纪元池只收录 SSR/SR，而基础概率表有四档——必须把池外稀有度的概率
   * 并入池内最低档，否则抽到 R/N 时取不到英灵（抛错），
   * 且公示概率与实际不符（合规问题）。见 gachaRates.projectToPool。
   */
  const rarities = availableRarities(byRarity)
  const guaranteeTarget = count === GACHA.TEN_PULL_COUNT
    ? newbieGuaranteeTarget(byRarity, ctx.newbieUsed === true)
    : undefined

  /**
   * 新手资格在**首次十连**时即消耗，无论该十连是否自然抽到 SSR。
   *
   * ⚠ 若只在「保底替换真正发生」时才消耗资格，玩家就能靠十连自然出货 SSR
   * 来把资格一直留到下一次十连，等于反复享受「十连必出 SSR」。
   * 资格与「本次是否触发替换」是两件事，必须分开判定。
   */
  const newbieUsedConsumed = guaranteeTarget !== undefined

  let batchHasSRPlus = false

  /**
   * 本批次内已发放的英灵。
   *
   * 「是否新获得」必须按**逐张累积**的持有状态判定，而不是批次开始前的快照——
   * 否则同一批里抽到同一英灵两次时，两张都会被算成「新获得」：
   * 重复转化（印记 / 碎片 / 银两）少给一份，
   * 「新获得英灵」列表里同一个人还会出现两次（历史教训）。
   */
  const grantedInBatch = new Set<string>()

  for (let i = 0; i < count; i++) {
    const draw = drawRarity(rng, pity, {
      isTenPull: count === GACHA.TEN_PULL_COUNT,
      batchHasSRPlus,
      batchIndex: i,
      availableRarities: rarities,
    })

    // 十连内抽到 SSR → 大保底计数归零（§7.3）
    pity = draw.rarity === 'SSR' ? { pitySSR: 0, pity10: 0 } : draw.state

    if (rarityRank(draw.rarity) >= 2) batchHasSRPlus = true

    let heroId = pickHero(rng, byRarity[draw.rarity])
    let rarity = draw.rarity

    // 新手保底：批次内最后一个位置替换为指定 SSR
    if (guaranteeTarget && shouldReplaceForNewbie(newbieUsedConsumed, i, results.some((r) => r.rarity === 'SSR'))) {
      heroId = guaranteeTarget
      rarity = HERO_INDEX.get(heroId)?.rarity ?? 'SSR'
      guaranteedTriggered = true
      pity = { pitySSR: 0, pity10: 0 }
    }

    const isNew = !ctx.owned[heroId] && !grantedInBatch.has(heroId)
    if (isNew) grantedInBatch.add(heroId)

    let shards = 0

    if (!isNew) {
      // ⚠ **实施修正（资源/背包版本 v10）**：重复卡只给同名碎片，全稀有度适用。
      shards = GACHA.DUPLICATE_SHARDS[rarity]
    }

    results.push({
      heroId,
      rarity,
      isNew,
      shards,
      pityTriggered:
        rarity === 'SSR' && ctx.pity.pitySSR > 0 && ctx.pity.pitySSR >= GACHA.SOFT_PITY_START - 1,
    })
  }

  return {
    results,
    pity,
    crystalsUsed: payment.crystals,
    guaranteedTriggered,
    newbieUsedConsumed,
  }
}

/** 从同稀有度池中随机取一位 */
function pickHero(rng: Rng, pool: string[]): string {
  if (pool.length === 0) {
    throw new Error('卡池中没有对应稀有度的英灵')
  }
  return rng.pick(pool)
}
/**
 * 计算抽卡后应写入的资源变化。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：重复卡只给**同名碎片**
 *   （按英灵分堆 → `player.shards[heroId]`），不再有印记与银两。
 */
export function summarizePull(outcome: PullOutcome) {
  const shards: Record<string, number> = {}
  const newHeroes: string[] = []
  for (const r of outcome.results) {
    if (r.shards > 0) shards[r.heroId] = (shards[r.heroId] ?? 0) + r.shards
    if (r.isNew) newHeroes.push(r.heroId)
  }
  return { shards, newHeroes }
}
