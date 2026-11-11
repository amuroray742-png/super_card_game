/**
 * 抽卡概率（§7.2 / §7.3）—— 概率公示与抽卡执行的**唯一数据源**。
 *
 * 合规硬要求：公示表与实际抽卡必须调用同一套函数，不得复制定义。
 * 因此：
 * - `drawRarity()` 是唯一的抽卡实现
 * - `computeEffectiveRates()` 用**同一个 drawRarity** 做蒙特卡洛模拟，
 *   得到的综合概率即为公示值——公示与实际行为在构造上无法不一致。
 */
import type { Rarity } from '../model/types.ts'
import { BASE_RATES, GACHA, RARITY_RANK } from '../config/economy.ts'
import { Rng } from '../rng.ts'

export interface PityState {
  /** 距离上次 SSR 的抽数（0..89），跨卡池继承 */
  pitySSR: number
  /** 距离上次 SR 及以上的抽数（用于十连保底显示） */
  pity10: number
}

export interface DrawOptions {
  /** 是否处于十连批次中 */
  isTenPull?: boolean
  /** 当前批次是否已经出过 SR 及以上 */
  batchHasSRPlus?: boolean
  /** 批次内序号（0..9） */
  batchIndex?: number
  /**
   * 当前卡池**实际收录**的稀有度集合。
   *
   * 纪元池只收录 SSR/SR，而基础概率表有四档。若不做处理，
   * 抽到 R/N 时会取不到英灵（抛错），且公示的 70% N 概率与实际不符（合规问题）。
   * 因此池内不存在的稀有度，其概率**并入池内存在的最低稀有度**：
   *   纪元池 → SSR 0.60% / SR 99.40%
   */
  availableRarities?: readonly Rarity[]
}

/** 稀有度从高到低的顺序 */
const RARITY_ORDER: readonly Rarity[] = ['SSR', 'SR', 'R', 'N']

/** 稀有度从低到高的顺序（用于找「池内最低档」） */
const RARITY_ASC: readonly Rarity[] = ['N', 'R', 'SR', 'SSR']

/**
 * 把全局概率表投影到卡池实际收录的稀有度上。
 *
 * 池内不存在的稀有度，其概率并入**池内存在的最低稀有度**（例如纪元池的
 * R + N 概率全部并入 SR）。投影后概率和仍为 1，公示与抽卡共用此函数，
 * 因此「公示 = 实际」在构造上成立。
 */
export function projectToPool(
  probs: Record<Rarity, number>,
  available: readonly Rarity[] | undefined,
): Record<Rarity, number> {
  if (!available || available.length === 0 || available.length >= 4) return probs
  const allowed = new Set(available)
  const out: Record<Rarity, number> = { SSR: 0, SR: 0, R: 0, N: 0 }
  // 池内实际存在的**最低**稀有度（按 N < R < SR < SSR 取第一个存在的）
  let lowest: Rarity | null = null
  for (const r of RARITY_ASC) {
    if (allowed.has(r)) {
      lowest = r
      break
    }
  }
  if (!lowest) return probs
  for (const r of RARITY_ORDER) {
    if (allowed.has(r)) out[r] += probs[r]
    else out[lowest] += probs[r]
  }
  return out
}

export interface DrawResult {
  rarity: Rarity
  state: PityState
}

/**
 * 软保底：第 71 抽起 SSR 概率线性提升，第 90 抽必出。
 *
 * @param pitySSR 距离上次 SSR 的抽数（抽之前的值）
 * @returns 该次抽中 SSR 的概率（0..1）
 */
export function ssrRateAt(pitySSR: number): number {
  const base = BASE_RATES.SSR / 100
  const start = GACHA.SOFT_PITY_START - 1 // 70 → 第 71 抽开始爬坡
  const denom = GACHA.PITY_SSR_MAX - start // 20
  const t = (pitySSR - start + 1) / denom
  if (t <= 0) return base
  if (t >= 1) return 1
  return base + t * (1 - base)
}

/** 保底剩余抽数（展示用） */
export function pityRemaining(pitySSR: number): number {
  return Math.max(0, GACHA.PITY_SSR_MAX - pitySSR)
}

/**
 * 各稀有度的抽取概率 —— 抽卡执行的唯一概率定义。
 * `drawRarity` 与概率公示的动态规划**共用此函数**，因此公示与实现不可能不一致。
 */
export function rarityProbabilities(
  state: PityState,
  options: DrawOptions = {},
): Record<Rarity, number> {
  const ssrProb = ssrRateAt(state.pitySSR)
  const remaining = 1 - ssrProb

  // 非 SSR 部分按基础比例分配
  const baseRest = BASE_RATES.SR + BASE_RATES.R + BASE_RATES.N
  const srProb = remaining * (BASE_RATES.SR / baseRest)
  const rProb = remaining * (BASE_RATES.R / baseRest)
  const nProb = remaining * (BASE_RATES.N / baseRest)

  const needFloor =
    options.isTenPull === true &&
    options.batchHasSRPlus !== true &&
    options.batchIndex === 9

  const raw: Record<Rarity, number> =
    needFloor
      ? (() => {
          // 十连保底：批次内未出过 SR+ 时，最后一抽强制 SR 及以上
          const ssrWithinFloor = ssrProb >= 1 ? 1 : ssrProb / (ssrProb + srProb)
          return { SSR: ssrWithinFloor, SR: 1 - ssrWithinFloor, R: 0, N: 0 }
        })()
      : { SSR: ssrProb, SR: srProb, R: rProb, N: nProb }

  // 投影到卡池实际收录的稀有度（纪元池只有 SSR/SR 时，R/N 概率并入 SR）
  return projectToPool(raw, options.availableRarities)
}

/**
 * 单次抽取的稀有度判定 —— 唯一的抽卡随机实现。
 */
export function drawRarity(rng: Rng, state: PityState, options: DrawOptions = {}): DrawResult {
  const probs = rarityProbabilities(state, options)
  const order: Rarity[] = ['SSR', 'SR', 'R', 'N']
  const roll = rng.next()
  let acc = 0
  let rarity: Rarity = 'N'
  for (const r of order) {
    acc += probs[r]
    if (roll < acc) {
      rarity = r
      break
    }
  }
  return { rarity, state: applyPity(state, rarity, options) }
}

/**
 * 保底计数更新。
 * - 抽中 SSR：计数归零
 * - 十连批次中抽中 SR：SSR 计数 +2（§7.3 补偿规则）
 * - 其他：SSR 计数 +1
 */
export function applyPity(state: PityState, rarity: Rarity, options: DrawOptions = {}): PityState {
  if (rarity === 'SSR') {
    return { pitySSR: 0, pity10: 0 }
  }
  const ssrStep = rarity === 'SR' && options.isTenPull ? 2 : 1
  const nextSSR = Math.min(GACHA.PITY_SSR_MAX, state.pitySSR + ssrStep)
  if (rarity === 'SR') {
    return { pitySSR: nextSSR, pity10: 0 }
  }
  return { pitySSR: nextSSR, pity10: state.pity10 + 1 }
}

// ─────────────────────────── 概率公示 ───────────────────────────

export interface RateRow {
  rarity: Rarity
  /** 该池内的基础概率（百分比，两位小数）；池内不存在的稀有度为 0 */
  baseRate: number
  /** 当前保底状态下的下一抽实际概率（百分比） */
  singleEffective: number
  /** 十连内至少出现 1 次该稀有度或更高的概率（百分比，精确 DP） */
  tenPullEffective: number
  /** 该稀有度是否被当前卡池收录 */
  inPool: boolean
}

export interface RatesSnapshot {
  rows: RateRow[]
  /** 距离必出 SSR 还差多少抽 */
  pityRemaining: number
  /** 保底上限 */
  pityMax: number
  /** 软保底起点 */
  softPityStart: number
  /** 综合概率的计算方式：精确动态规划（非蒙特卡洛，无公示噪声） */
  computation: 'exact-dp'
}

/**
 * 十连内"至少出现 1 次该稀有度或更高"的**精确**概率。
 *
 * 用动态规划穷举状态空间（pitySSR × 批次内是否已出 SR+ × 是否已出现各稀有度），
 * 与 `rarityProbabilities` 同源 —— 公示值是真实概率，无模拟噪声。
 */
export function computeTenPullOutcomes(
  start: PityState,
  availableRarities?: readonly Rarity[],
): {
  ssr: number
  srPlus: number
  rPlus: number
  n: number
} {
  interface DpState {
    pitySSR: number
    batchHasSRPlus: boolean
    hasSSR: boolean
    /** 已出现过 SSR 或 SR */
    hasSRPlus: boolean
    /** 已出现过 SSR / SR / R */
    hasRPlus: boolean
    hasN: boolean
    prob: number
  }

  let states: DpState[] = [
    {
      pitySSR: start.pitySSR,
      batchHasSRPlus: false,
      hasSSR: false,
      hasSRPlus: false,
      hasRPlus: false,
      hasN: false,
      prob: 1,
    },
  ]

  for (let position = 0; position < 10; position++) {
    const next: DpState[] = []
    for (const s of states) {
      const state: PityState = { pitySSR: s.pitySSR, pity10: 0 }
      const probs = rarityProbabilities(state, {
        isTenPull: true,
        batchHasSRPlus: s.batchHasSRPlus,
        batchIndex: position,
        availableRarities,
      })
      for (const rarity of ['SSR', 'SR', 'R', 'N'] as Rarity[]) {
        const p = probs[rarity]
        if (p <= 0) continue
        const after = applyPity(state, rarity, { isTenPull: true })
        next.push({
          pitySSR: after.pitySSR,
          batchHasSRPlus: s.batchHasSRPlus || rarity === 'SSR' || rarity === 'SR',
          hasSSR: s.hasSSR || rarity === 'SSR',
          hasSRPlus: s.hasSRPlus || rarity === 'SSR' || rarity === 'SR',
          hasRPlus: s.hasRPlus || rarity === 'SSR' || rarity === 'SR' || rarity === 'R',
          hasN: s.hasN || rarity === 'N',
          prob: s.prob * p,
        })
      }
    }
    states = next
  }

  // 终态按"该稀有度或更高至少出现 1 次"统计（各行独立，不互斥）
  const hit = { ssr: 0, srPlus: 0, rPlus: 0, n: 0 }
  for (const s of states) {
    if (s.hasSSR) hit.ssr += s.prob
    if (s.hasSRPlus) hit.srPlus += s.prob
    if (s.hasRPlus) hit.rPlus += s.prob
    if (s.hasN) hit.n += s.prob
  }
  return hit
}

const SIM_TRIALS = 20000

/**
 * 计算概率公示表。
 *
 * 综合概率由 `rarityProbabilities` + `applyPity`（与实际抽卡完全同源）
 * 经动态规划**精确**求得 —— 公示值即真实概率，构造上无法与实现不一致。
 *
 * @param availableRarities 当前卡池实际收录的稀有度；传入后公示值即为**该池**的真实概率。
 */
export function computeEffectiveRates(
  state: PityState = { pitySSR: 0, pity10: 0 },
  availableRarities?: readonly Rarity[],
): RatesSnapshot {
  const outcomes = computeTenPullOutcomes(state, availableRarities)

  // 下一抽的实际概率（由当前保底状态 + 卡池收录范围直接推导）
  const singleProbs = rarityProbabilities(state, { availableRarities })

  // 该池的基础概率（保底未启动时的池内概率），与单抽实际概率同源
  const baseProbs = projectToPool(
    {
      SSR: BASE_RATES.SSR / 100,
      SR: BASE_RATES.SR / 100,
      R: BASE_RATES.R / 100,
      N: BASE_RATES.N / 100,
    },
    availableRarities,
  )

  const inPool = (rarity: Rarity): boolean =>
    !availableRarities || availableRarities.length === 0 || availableRarities.includes(rarity)

  const rows: RateRow[] = (['SSR', 'SR', 'R', 'N'] as Rarity[]).map((rarity) => {
    return {
      rarity,
      baseRate: round2(baseProbs[rarity] * 100),
      singleEffective: round2(singleProbs[rarity] * 100),
      tenPullEffective: 0,
      inPool: inPool(rarity),
    }
  })

  // 十连综合概率（至少 1 次该稀有度或更高），精确值
  rows[0].tenPullEffective = round2(outcomes.ssr * 100)
  rows[1].tenPullEffective = round2(outcomes.srPlus * 100)
  rows[2].tenPullEffective = round2(outcomes.rPlus * 100)
  rows[3].tenPullEffective = round2(outcomes.n * 100)

  return {
    rows,
    pityRemaining: pityRemaining(state.pitySSR),
    pityMax: GACHA.PITY_SSR_MAX,
    softPityStart: GACHA.SOFT_PITY_START,
    computation: 'exact-dp',
  }
}

/** 保留两位小数（合规要求：概率精确到小数点后两位） */
export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** 展示用百分比字符串（固定两位小数） */
export function formatRate(v: number): string {
  return `${v.toFixed(2)}%`
}
