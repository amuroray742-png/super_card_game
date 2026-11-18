/**
 * 对局样本与公平性判据（Phase 11 决策闸门 · §6.9–§6.10 · §15.1）。
 *
 * ⚠ 为什么要有这个文件：
 *   Phase 11 排得靠后是**有意的**（plan.md §6.12）——PvP 的平衡需要**真实玩家数据**，
 *   而「决策闸门」要回答的问题是「证据够不够、能不能现在启动」。
 *   证据的形式是**一批对局样本**，所以「样本记什么字段、怎么判公平」必须**只有一份**：
 *   - 合成样本（`tools/balance/pvp-sample.ts`）跑出来的结论，
 *   - 与未来服务端结算时落库的真实样本，
 *   必须用**同一套定义与阈值**——否则两套口径会各写一套，结论对不上真实玩家。
 *
 * 本文件是纯逻辑：不 import 任何 DOM / 平台 API，不读时钟，不造随机。
 * 时间与随机都由调用方注入（铁律 #1）。
 */
import type { ArenaMatch } from '../model/types.ts'

// ─────────────────────────── 样本 ───────────────────────────

/**
 * 一场对局的样本记录。
 *
 * ⚠ 这是**采集口径的单一来源**：真实链路的落库表、合成样本的生成器
 *   都必须能填出这组字段。字段不够 → 判据算不出来；字段多了 → 会有第二套口径。
 */
export interface PvpMatchSample {
  /** 对局唯一 id（真实链路里 = `challengeId`） */
  challengeId: string
  /** 分组标签（如「镜像」「养成差 100 倍」「不同阵容」），用于分组统计 */
  group: string
  /** 进攻方（ally 侧）是否获胜 */
  attackerWin: boolean
  /**
   * 本场**先手方**。
   *
   * ⚠ 必须由 core 的对局结果给出（`BattleResult.initiativeSide`），
   *   表现层/工具**不得自行推断**「谁先手」——
   *   推断就会和战斗里的实际排序对不上，判据会拿着假数据下结论。
   */
  initiativeSide: 'ally' | 'enemy'
  /** 回合数 */
  rounds: number
  /** 进攻方存活单位占比（0~1） */
  attackerSurvivorRatio: number
  /** 防守方存活单位占比（0~1） */
  defenderSurvivorRatio: number
  /** 进攻方归一化总战力（竞技口径，`computePower` 之和） */
  attackerPower: number
  /** 防守方归一化总战力 */
  defenderPower: number
}

/**
 * 由 `ArenaMatch` 构造样本。
 *
 * @param match   core 产出的对局结果（服务端与合成模拟用的是**同一份**）
 * @param powers  双方归一化总战力（由调用方经 `computePower` 累加得到）
 * @param group   分组标签
 */
export function sampleFromArenaMatch(
  match: ArenaMatch,
  powers: { attacker: number; defender: number },
  group: string,
): PvpMatchSample {
  const roster = match.result.roster
  const alive = new Set(match.result.survivors)
  const count = (side: 'ally' | 'enemy') => {
    const units = roster.filter((u) => u.side === side)
    if (units.length === 0) return 0
    return units.filter((u) => alive.has(u.id)).length / units.length
  }
  return {
    challengeId: match.challengeId,
    group,
    attackerWin: match.result.win,
    initiativeSide: match.result.initiativeSide,
    rounds: match.result.rounds,
    attackerSurvivorRatio: count('ally'),
    defenderSurvivorRatio: count('enemy'),
    attackerPower: powers.attacker,
    defenderPower: powers.defender,
  }
}

// ─────────────────────────── 阈值 ───────────────────────────

/**
 * 公平性判据阈值。
 *
 * ⚠ 集中在这里，不散落到工具、文档、测试三处——
 *   散落就会出现「工具判过、测试判不过、文档写的又是第三个数」。
 *
 * ⚠ 这几个阈值是**本项目提出的提案**，plan.md §15.1 只给了「养成隔离 < 15%」，
 *   其余（胜率偏差 / 先手偏差 / 样本量）是按「镜像对局应当五五开」反推的工程口径，
 *   真实玩家样本到位后要按真实分布复核。
 */
export const PVP_SAMPLE_THRESHOLDS = {
  /**
   * 归一化后战力差上限（§15.1「养成隔离」：< 15%）。
   * 口径：`|a - b| / max(a, b)`。
   */
  NORMALIZED_POWER_GAP: 0.15,
  /**
   * 胜率偏差上限（单侧，百分点）。
   * 口径：`|attackerWinRate - 0.5|`。
   */
  WIN_RATE_BIAS: 0.05,
  /**
   * 先手偏差上限（百分点）。
   * 口径：`|先手方胜率 - 后手方胜率|`。
   */
  FIRST_MOVE_BIAS: 0.05,
  /**
   * 样本量下限：低于此数量给出的胜率**不可用于决策**（仅可用于发现明显 bug）。
   */
  MIN_SAMPLES: 200,
} as const

// ─────────────────────────── 统计 ───────────────────────────

/** 一批样本的汇总 */
export interface PvpSampleSummary {
  /** 样本数 */
  count: number
  /** 进攻方胜率（0~1） */
  attackerWinRate: number
  /** 先手方胜率（0~1） */
  firstMoveWinRate: number
  /** 后手方胜率（0~1） */
  secondMoveWinRate: number
  /** 平均回合数 */
  avgRounds: number
  /** 双方归一化战力差的最大值（0~1） */
  maxPowerGap: number
  /** 双方归一化战力差的平均值（0~1） */
  avgPowerGap: number
  /** 进攻方平均存活占比 */
  avgAttackerSurvivorRatio: number
  /** 防守方平均存活占比 */
  avgDefenderSurvivorRatio: number
}

/**
 * 汇总一批样本。
 *
 * ⚠ 先手 / 后手胜率必须**按本场的先手方**统计，不能按「进攻方」统计：
 *   进攻方只是攻守位置，先手方是**这场的实际先手**——
 *   竞技模式按对局种子掷签决定（§6.9 双方对称），两者不是一回事。
 */
export function summarizeSamples(samples: readonly PvpMatchSample[]): PvpSampleSummary {
  const count = samples.length
  if (count === 0) {
    return {
      count: 0,
      attackerWinRate: 0,
      firstMoveWinRate: 0,
      secondMoveWinRate: 0,
      avgRounds: 0,
      maxPowerGap: 0,
      avgPowerGap: 0,
      avgAttackerSurvivorRatio: 0,
      avgDefenderSurvivorRatio: 0,
    }
  }
  let wins = 0
  let firstWins = 0
  let rounds = 0
  let gapSum = 0
  let gapMax = 0
  let survA = 0
  let survD = 0
  for (const s of samples) {
    if (s.attackerWin) wins++
    // 先手方是 ally 时，进攻方获胜 = 先手方获胜；先手方是 enemy 时相反
    const firstSideWon = s.initiativeSide === 'ally' ? s.attackerWin : !s.attackerWin
    if (firstSideWon) firstWins++
    rounds += s.rounds
    const gap = powerGap(s.attackerPower, s.defenderPower)
    gapSum += gap
    if (gap > gapMax) gapMax = gap
    survA += s.attackerSurvivorRatio
    survD += s.defenderSurvivorRatio
  }
  const firstMoveWinRate = firstWins / count
  return {
    count,
    attackerWinRate: wins / count,
    firstMoveWinRate,
    secondMoveWinRate: 1 - firstMoveWinRate,
    avgRounds: rounds / count,
    maxPowerGap: gapMax,
    avgPowerGap: gapSum / count,
    avgAttackerSurvivorRatio: survA / count,
    avgDefenderSurvivorRatio: survD / count,
  }
}

/** 归一化战力差：`|a - b| / max(a, b)`（a 或 b 为 0 时返回 0） */
export function powerGap(a: number, b: number): number {
  const hi = Math.max(a, b)
  if (hi <= 0) return 0
  return Math.abs(a - b) / hi
}

// ─────────────────────────── 判据 ───────────────────────────

/** 单条判据的判定结果 */
export interface PvpCheck {
  /** 判据 id */
  id: string
  /** 判据名 */
  label: string
  /** 实测值 */
  value: number
  /** 阈值 */
  threshold: number
  /** 判定方向 */
  comparison: '<=' | '>='
  /** 是否通过 */
  passed: boolean
  /** 判定说明（给人看的，必须能定位到问题） */
  detail: string
}

/** 公平性判定总表 */
export interface PvpFairnessVerdict {
  /** 样本汇总 */
  summary: PvpSampleSummary
  /** 逐条判据 */
  checks: PvpCheck[]
  /** 是否全部通过 */
  passed: boolean
}

/**
 * 判定一批样本是否满足「竞技公平性」的硬指标。
 *
 * @param samples  待判定的样本
 * @param options  `exclude` 列出**不参与本次判定**的判据 id。
 *                 跨阵容实验里「进攻方胜率偏差」没有意义（两队本来就不一样强），
 *                 这时必须显式排除——否则会把「B 队更强」误报成「引擎不公平」。
 */
export function evaluatePvpFairness(
  samples: readonly PvpMatchSample[],
  options: { exclude?: readonly string[] } = {},
): PvpFairnessVerdict {
  const summary = summarizeSamples(samples)
  const excluded = new Set(options.exclude ?? [])
  const checks: PvpCheck[] = []

  if (!excluded.has('sample-size')) {
    checks.push({
      id: 'sample-size',
      label: '样本量',
      value: summary.count,
      threshold: PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES,
      comparison: '>=',
      passed: summary.count >= PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES,
      detail:
        summary.count >= PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES
          ? `样本量 ${summary.count}，达到决策所需下限`
          : `样本量仅 ${summary.count}，低于 ${PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES}，胜率类结论不可用于决策`,
    })
  }

  if (!excluded.has('normalized-power-gap')) {
    checks.push({
      id: 'normalized-power-gap',
      label: '归一化后战力差',
      value: summary.maxPowerGap,
      threshold: PVP_SAMPLE_THRESHOLDS.NORMALIZED_POWER_GAP,
      comparison: '<=',
      passed: summary.maxPowerGap <= PVP_SAMPLE_THRESHOLDS.NORMALIZED_POWER_GAP,
      detail:
        summary.maxPowerGap <= PVP_SAMPLE_THRESHOLDS.NORMALIZED_POWER_GAP
          ? `最大战力差 ${(summary.maxPowerGap * 100).toFixed(2)}%，在 ${(PVP_SAMPLE_THRESHOLDS.NORMALIZED_POWER_GAP * 100).toFixed(0)}% 隔离阈值内`
          : `最大战力差 ${(summary.maxPowerGap * 100).toFixed(2)}%，超出 ${(PVP_SAMPLE_THRESHOLDS.NORMALIZED_POWER_GAP * 100).toFixed(0)}% 隔离阈值`,
    })
  }

  if (!excluded.has('win-rate-bias')) {
    const winRateGap = Math.abs(summary.attackerWinRate - 0.5)
    checks.push({
      id: 'win-rate-bias',
      label: '进攻方胜率偏差',
      value: winRateGap,
      threshold: PVP_SAMPLE_THRESHOLDS.WIN_RATE_BIAS,
      comparison: '<=',
      passed: winRateGap <= PVP_SAMPLE_THRESHOLDS.WIN_RATE_BIAS,
      detail:
        `进攻方胜率 ${(summary.attackerWinRate * 100).toFixed(2)}%，偏差 ${(winRateGap * 100).toFixed(2)}pp`,
    })
  }

  if (!excluded.has('first-move-bias')) {
    const bias = Math.abs(summary.firstMoveWinRate - summary.secondMoveWinRate)
    checks.push({
      id: 'first-move-bias',
      label: '先手偏差',
      value: bias,
      threshold: PVP_SAMPLE_THRESHOLDS.FIRST_MOVE_BIAS,
      comparison: '<=',
      passed: bias <= PVP_SAMPLE_THRESHOLDS.FIRST_MOVE_BIAS,
      detail:
        `先手方胜率 ${(summary.firstMoveWinRate * 100).toFixed(2)}%，` +
        `后手方胜率 ${(summary.secondMoveWinRate * 100).toFixed(2)}%，` +
        `差 ${(bias * 100).toFixed(2)}pp`,
    })
  }

  return {
    summary,
    checks,
    passed: checks.every((c) => c.passed),
  }
}
