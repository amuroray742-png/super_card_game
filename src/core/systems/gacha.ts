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
import { drawRarity, type PityState } from './gachaRates.ts'

export interface PullResult {
  heroId: string
  rarity: Rarity
  /** 是否首次获得 */
  isNew: boolean
  /** 重复转化所得印记 */
  emblems: number
  /** 重复转化所得同名碎片 */
  shards: number
  /** 重复转化所得银两 */
  silver: number
  /** 是否触发大保底 */
  pityTriggered: boolean
}

export interface PullOutcome {
  results: PullResult[]
  pity: PityState
  crystalsUsed: number
  ticketsUsed: number
  /** 新手池保底是否触发 */
  guaranteedTriggered: boolean
  /** 本次抽卡是否消耗掉了新手保底资格 */
  newbieUsedConsumed: boolean
}

export interface PullContext {
  pity: PityState
  owned: Record<string, HeroState>
  crystals: number
  tickets: number
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

/**
 * 抽卡费用
 *
 * 口径（§7.5：圣杯结晶为主抽卡货币，抽卡券为免费补充）：
 * - 十连：圣杯结晶 3000，**不收抽卡券**。
 * - 单抽：圣杯结晶 300 **或** 抽卡券 1（二选一，实际扣哪一项由 `resolvePayment` 决定）。
 */
export function pullCost(count: number): { crystals: number; tickets: number } {
  if (count === 10) return { crystals: GACHA.COST_TEN, tickets: 0 }
  return { crystals: GACHA.COST_SINGLE, tickets: GACHA.TICKET_PER_PULL }
}

/** 抽卡货币不足 */
export class InsufficientFundsError extends Error {
  constructor(
    readonly required: { crystals: number; tickets: number },
    readonly owned: { crystals: number; tickets: number },
  ) {
    super('抽卡货币不足')
    this.name = 'InsufficientFundsError'
  }
}

/**
 * 结算一次抽卡的**实际扣费**。
 *
 * - 十连：只收圣杯结晶，余额不足返回 null。
 * - 单抽：优先圣杯结晶（主货币 / 抽卡总闸门），结晶不足时自动改用抽卡券。
 *
 * ⚠ 旧实现无论余额多少都照扣，结晶可被扣成负数，等于取消抽卡总闸门。
 *
 * @returns 实际扣费明细；余额不足时返回 null（调用方必须拒绝本次抽卡）
 */
export function resolvePayment(
  count: number,
  crystals: number,
  tickets: number,
): { crystals: number; tickets: number } | null {
  const cost = pullCost(count)
  if (cost.tickets === 0) {
    return crystals >= cost.crystals ? { crystals: cost.crystals, tickets: 0 } : null
  }
  if (crystals >= cost.crystals) return { crystals: cost.crystals, tickets: 0 }
  if (tickets >= cost.tickets) return { crystals: 0, tickets: cost.tickets }
  return null
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
  const payment = resolvePayment(count, ctx.crystals, ctx.tickets)
  if (!payment) {
    throw new InsufficientFundsError(pullCost(count), {
      crystals: ctx.crystals,
      tickets: ctx.tickets,
    })
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
  const availableRarities = (['SSR', 'SR', 'R', 'N'] as const).filter((r) => (byRarity[r]?.length ?? 0) > 0)

  /**
   * 新手保底（方案 §7.3 第 3 条：「新手期首次 10 连保底 1 个 SSR」）。
   *
   * 资格按「是否已使用过」判定（`ctx.newbieUsed`），而非「是否已拥有该角色」——
   * 后者会导致玩家在别的池先抽到该角色后福利永久失效。
   *
   * 保底目标：优先新手池指定的 SSR；若该角色不在当前池内，
   * 退化为当前池内的任一 SSR（纪元池也含 SSR，故仍然成立）。
   */
  const newbiePool = getPool('newbie')
  const preferredHeroId = newbiePool.guaranteedHeroId
  const guaranteeTarget =
    preferredHeroId && byRarity.SSR?.includes(preferredHeroId)
      ? preferredHeroId
      : byRarity.SSR?.[0]
  const needGuarantee = ctx.newbieUsed !== true && count === 10 && guaranteeTarget !== undefined

  /**
   * 新手资格在**首次十连**时即消耗，无论该十连是否自然抽到 SSR。
   *
   * ⚠ 若只在「保底替换真正发生」时才消耗资格，玩家就能靠十连自然出货 SSR
   * 来把资格一直留到下一次十连，等于反复享受「十连必出 SSR」。
   * 资格与「本次是否触发替换」是两件事，必须分开判定。
   */
  const newbieUsedConsumed = needGuarantee

  let batchHasSRPlus = false

  for (let i = 0; i < count; i++) {
    const draw = drawRarity(rng, pity, {
      isTenPull: count === 10,
      batchHasSRPlus,
      batchIndex: i,
      availableRarities,
    })

    // 十连内抽到 SSR → 大保底计数归零（§7.3）
    pity = draw.rarity === 'SSR' ? { pitySSR: 0, pity10: 0 } : draw.state

    if (rarityRank(draw.rarity) >= 2) batchHasSRPlus = true

    let heroId = pickHero(rng, byRarity[draw.rarity])
    let rarity = draw.rarity

    // 新手保底：批次内最后一个位置替换为指定 SSR
    if (
      needGuarantee &&
      i === count - 1 &&
      !results.some((r) => r.rarity === 'SSR')
    ) {
      heroId = guaranteeTarget!
      rarity = HERO_INDEX.get(heroId)?.rarity ?? 'SSR'
      guaranteedTriggered = true
      pity = { pitySSR: 0, pity10: 0 }
    }

    const isNew = !ctx.owned[heroId]

    let emblems = 0
    let shards = 0
    let silver = 0

    if (!isNew) {
      emblems = GACHA.DUPLICATE_EMBLEM[rarity]
      if (rarity === 'SSR') {
        shards = GACHA.DUPLICATE_SSR_SHARDS
      } else if (rarity === 'N') {
        silver = GACHA.DUPLICATE_N_SILVER
      }
    }

    results.push({
      heroId,
      rarity,
      isNew,
      emblems,
      shards,
      silver,
      pityTriggered:
        rarity === 'SSR' && ctx.pity.pitySSR > 0 && ctx.pity.pitySSR >= GACHA.SOFT_PITY_START - 1,
    })
  }

  return {
    results,
    pity,
    crystalsUsed: payment.crystals,
    ticketsUsed: payment.tickets,
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
/** 计算抽卡后应写入的资源变化 */
export function summarizePull(outcome: PullOutcome) {
  let emblems = 0
  let shards = 0
  let silver = 0
  const newHeroes: string[] = []
  for (const r of outcome.results) {
    emblems += r.emblems
    shards += r.shards
    silver += r.silver
    if (r.isNew) newHeroes.push(r.heroId)
  }
  return { emblems, shards, silver, newHeroes }
}
