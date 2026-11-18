/**
 * 对局样本与公平性判据的单测（Phase 11 决策闸门配套）。
 *
 * 守的是**判据本身**：阈值改了、汇总算错了、样本口径与真实链路对不上，
 * 都必须在这里失败——否则闸门会拿着一份算错的结论做决策。
 */
import { describe, expect, it } from 'vitest'
import {
  evaluatePvpFairness,
  powerGap,
  sampleFromArenaMatch,
  summarizeSamples,
  PVP_SAMPLE_THRESHOLDS,
  type PvpMatchSample,
} from '../../src/core/systems/pvp-sample.ts'
import {
  buildArenaLoadout,
  buildArenaUnits,
  resolveArenaMatch,
  arenaContext,
} from '../../src/core/systems/arena.ts'
import { computePower } from '../../src/core/systems/stats.ts'

const CTX = arenaContext(1)

function loadout(ids: string[]) {
  return buildArenaLoadout({
    slots: ids,
    heroes: {},
    relicSetsByHero: {},
    runes: [],
    arenaLevel: 0,
  })
}

function sidePower(l: ReturnType<typeof loadout>): number {
  return buildArenaUnits(l, 'ally', CTX).reduce((sum, u) => sum + computePower(u.stats), 0)
}

function sample(over: Partial<PvpMatchSample> = {}): PvpMatchSample {
  return {
    challengeId: 'c1',
    group: 'g',
    attackerWin: true,
    initiativeSide: 'ally',
    rounds: 10,
    attackerSurvivorRatio: 0.5,
    defenderSurvivorRatio: 0.25,
    attackerPower: 1000,
    defenderPower: 1000,
    ...over,
  }
}

/** 造一批样本：n 场，前 winCount 场进攻方获胜 */
function batch(n: number, winCount: number, over: Partial<PvpMatchSample> = {}): PvpMatchSample[] {
  return Array.from({ length: n }, (_, i) =>
    sample({ challengeId: `c${i}`, attackerWin: i < winCount, ...over }),
  )
}

describe('样本汇总', () => {
  it('空批次返回全零，不抛异常', () => {
    const s = summarizeSamples([])
    expect(s.count).toBe(0)
    expect(s.attackerWinRate).toBe(0)
    expect(s.maxPowerGap).toBe(0)
  })

  it('胜率、平均回合、战力差按样本算', () => {
    const s = summarizeSamples(batch(10, 6))
    expect(s.count).toBe(10)
    expect(s.attackerWinRate).toBeCloseTo(0.6, 10)
    expect(s.avgRounds).toBeCloseTo(10, 10)
    expect(s.maxPowerGap).toBe(0)
  })

  it('战力差按 |a-b| / max(a,b) 算', () => {
    expect(powerGap(1000, 1000)).toBe(0)
    expect(powerGap(1100, 1000)).toBeCloseTo(100 / 1100, 10)
    expect(powerGap(1000, 1100)).toBeCloseTo(100 / 1100, 10)
    expect(powerGap(0, 0)).toBe(0)
  })

  it('最大战力差取样本里的最大值，不是平均值', () => {
    const samples = [
      sample({ attackerPower: 1000, defenderPower: 1000 }),
      sample({ attackerPower: 2000, defenderPower: 1000 }),
      sample({ attackerPower: 1100, defenderPower: 1000 }),
    ]
    const s = summarizeSamples(samples)
    expect(s.maxPowerGap).toBeCloseTo(0.5, 10)
    expect(s.avgPowerGap).toBeCloseTo((0 + 0.5 + 100 / 1100) / 3, 10)
  })

  it('先手 / 后手胜率按本场先手方统计（不是按进攻方）', () => {
    // 先手是 ally 且进攻方赢 → 先手方赢；先手是 enemy 且进攻方输 → 先手方赢
    const samples = [
      sample({ attackerWin: true, initiativeSide: 'ally' }),
      sample({ attackerWin: false, initiativeSide: 'enemy' }),
      sample({ attackerWin: true, initiativeSide: 'enemy' }),
      sample({ attackerWin: false, initiativeSide: 'ally' }),
    ]
    const s = summarizeSamples(samples)
    expect(s.firstMoveWinRate).toBeCloseTo(0.5, 10)
    expect(s.secondMoveWinRate).toBeCloseTo(0.5, 10)
    expect(s.attackerWinRate).toBeCloseTo(0.5, 10)
  })
})

describe('样本口径（与真实链路同源）', () => {
  it('由 ArenaMatch 推出样本，先手方取自 core 的对局结果', () => {
    const l = loadout(['xiangyu', 'hanxin', 'zhugeliang'])
    const match = resolveArenaMatch({
      challengeId: 'm1',
      attacker: l,
      defender: l,
      attackerId: 'a',
      attackerName: 'A',
      defenderId: 'b',
      defenderName: 'B',
      seed: 7,
    })
    const power = sidePower(l)
    const s = sampleFromArenaMatch(match, { attacker: power, defender: power }, '镜像')
    expect(s.challengeId).toBe('m1')
    expect(s.group).toBe('镜像')
    expect(s.attackerWin).toBe(match.result.win)
    expect(s.rounds).toBe(match.result.rounds)
    expect(s.initiativeSide).toBe(match.result.initiativeSide)
    expect(s.attackerPower).toBe(power)
  })

  it('core 的对局结果一定带先手方', () => {
    const l = loadout(['xiangyu'])
    const match = resolveArenaMatch({
      challengeId: 'm2',
      attacker: l,
      defender: l,
      attackerId: 'a',
      attackerName: 'A',
      defenderId: 'b',
      defenderName: 'B',
      seed: 11,
    })
    expect(['ally', 'enemy']).toContain(match.result.initiativeSide)
  })
})

describe('公平性判据', () => {
  it('样本量不足 → 判为不通过（结论不可用于决策）', () => {
    const verdict = evaluatePvpFairness(batch(10, 5))
    const check = verdict.checks.find((c) => c.id === 'sample-size')!
    expect(check.passed).toBe(false)
    expect(verdict.passed).toBe(false)
  })

  it('样本量达标且各项达标 → 全部通过', () => {
    const verdict = evaluatePvpFairness(batch(PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES, 100))
    expect(verdict.checks.find((c) => c.id === 'sample-size')!.passed).toBe(true)
    expect(verdict.passed).toBe(true)
  })

  it('归一化战力差超阈值 → 判为不通过', () => {
    const samples = batch(PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES, 100, {
      attackerPower: 2000,
      defenderPower: 1000,
    })
    const verdict = evaluatePvpFairness(samples)
    const check = verdict.checks.find((c) => c.id === 'normalized-power-gap')!
    expect(check.value).toBeCloseTo(0.5, 10)
    expect(check.passed).toBe(false)
    expect(verdict.passed).toBe(false)
  })

  it('胜率偏差超阈值 → 判为不通过', () => {
    // 60% 胜率 → 偏差 10pp > 5pp
    const samples = batch(PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES, Math.round(PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES * 0.6))
    const verdict = evaluatePvpFairness(samples)
    const check = verdict.checks.find((c) => c.id === 'win-rate-bias')!
    expect(check.passed).toBe(false)
  })

  it('先手偏差超阈值 → 判为不通过', () => {
    // 先手方赢 8 成 → 偏差 60pp
    const samples = Array.from({ length: PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES }, (_, i) =>
      sample({
        attackerWin: i < PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES * 0.8,
        initiativeSide: 'ally',
      }),
    )
    const verdict = evaluatePvpFairness(samples)
    const check = verdict.checks.find((c) => c.id === 'first-move-bias')!
    expect(check.value).toBeCloseTo(0.6, 10)
    expect(check.passed).toBe(false)
  })

  it('exclude 的判据不参与判定（跨阵容实验用）', () => {
    const samples = batch(PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES, Math.round(PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES * 0.9))
    const verdict = evaluatePvpFairness(samples, { exclude: ['win-rate-bias', 'first-move-bias'] })
    expect(verdict.checks.find((c) => c.id === 'win-rate-bias')).toBeUndefined()
    expect(verdict.checks.find((c) => c.id === 'first-move-bias')).toBeUndefined()
    expect(verdict.passed).toBe(true)
  })

  it('阈值只在一处定义，判据引用同一份', () => {
    expect(PVP_SAMPLE_THRESHOLDS.NORMALIZED_POWER_GAP).toBe(0.15)
    expect(PVP_SAMPLE_THRESHOLDS.WIN_RATE_BIAS).toBe(0.05)
    expect(PVP_SAMPLE_THRESHOLDS.FIRST_MOVE_BIAS).toBe(0.05)
    expect(PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES).toBe(200)
  })
})
