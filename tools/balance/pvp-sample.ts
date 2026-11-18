/**
 * 对局样本采集器（roadmap P2-3 · Phase 11 决策闸门配套）。
 *
 * ⚠ 为什么要有这个脚本：
 *   Phase 11 的启动需要**证据**，而证据是「一批对局样本」。
 *   本脚本用**合成对手**跑真实战斗，产出样本并按 core 的判据判定：
 *   1. **E1 养成隔离（镜像）**：PVE 数值养成差 100 倍的两个账号 → 归一化后战力差、
 *      进攻方胜率偏差、先手偏差；
 *   2. **E2 跨阵容（描述性）**：不同定位配比的阵容互打 → 胜率矩阵与策略宽度；
 *   3. **E3 策略宽度（描述性）**：同一队伍的两种养成档 → 归一化后差多少。
 *
 * ⚠ 合成样本**不能**替代真实玩家样本做「是否启动 Phase 11」的最终决策
 *   （见 roadmap P2-3 的对局样本采集方案）。它的作用是：
 *   验证判据管线本身可用 + 在零真实玩家成本下挖出结构性偏差。
 *
 * 用法：
 *   `npm run balance:pvp`                    → 报告
 *   `npm run balance:pvp -- --json <path>`  → 写机读基线
 */
import {
  arenaContext,
  buildArenaLoadout,
  buildArenaUnits,
  resolveArenaMatch,
} from '../../src/core/systems/arena.ts'
import {
  evaluatePvpFairness,
  powerGap,
  sampleFromArenaMatch,
  summarizeSamples,
  PVP_SAMPLE_THRESHOLDS,
  type PvpMatchSample,
} from '../../src/core/systems/pvp-sample.ts'
import { computePower, resolveStats } from '../../src/core/systems/stats.ts'
import { HERO_INDEX } from '../../src/core/config/heroes/index.ts'
import { getBondMods } from '../../src/core/systems/team.ts'
import { ARENA_TEMPLATES } from '../../src/core/config/economy.ts'
import type { ArenaLoadout, HeroState, HeroRuntime } from '../../src/core/model/types.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 每组实验跑多少场（低于 PVP_SAMPLE_THRESHOLDS.MIN_SAMPLES 的结论不可用于决策） */
const TRIALS = 240

/** 基础种子（固定 → 可复现；不引入任何随机源） */
const BASE_SEED = 20261118

/** 两支固定阵容（各 6 人，覆盖全部 5 个定位） */
const TEAM_A = ['xiangyu', 'hanxin', 'zhugeliang', 'libai', 'sunwu', 'jeannedarc'] as const
const TEAM_B = ['zuchongzhi', 'alexander', 'napoleon', 'caesar', 'hannibal', 'archimedes'] as const

/**
 * 一份「账号」的竞技侧形象。
 *
 * ⚠ `buildArenaLoadout` 只读**星级**与**技能等级**——
 *   等级、经验、遗物强化等级、永久加成**根本进不来**（§6.8 的隔离在类型层面就断了）。
 *   这就是 E1 能成立的原因：两个账号可以差 100 倍养成，却拿到**逐字节相同**的竞技快照。
 */
interface Account {
  /** 竞技快照 */
  loadout: ArenaLoadout
  /** 该账号在 PVE 口径下的队伍战力（用来证明「养成差 100 倍」这件事确实存在） */
  pvePower: number
  /** 该账号在**竞技口径**下的队伍总战力（归一化后） */
  arenaPower: number
}

/** 构造一个账号：level / relicLevel 只影响 PVE 侧，star / skill 影响竞技侧 */
function makeAccount(
  ids: readonly string[],
  opts: { level: number; star: number; skill: number; relicLevel: number },
): Account {
  const heroes: Record<string, HeroState> = {}
  const runtimes: HeroRuntime[] = []

  ids.forEach((id, slot) => {
    const def = HERO_INDEX.get(id)
    if (!def) throw new Error(`未知英灵：${id}`)
    const state: HeroState = {
      id,
      level: opts.level,
      exp: 0,
      star: opts.star,
      skillLevels: [opts.skill, opts.skill, opts.skill],
      shards: 0,
      coreAwakened: opts.star >= 4,
      obtainedAt: 0,
    }
    heroes[id] = state
    runtimes.push({ def, state, relics: [], slot })
  })

  // 竞技快照：套装按「每人 2 件」给，模拟中期玩家的常规配置
  const relicSetsByHero: Record<string, (string | null)[]> = {}
  for (const id of ids) {
    const def = HERO_INDEX.get(id)!
    const sets: (string | null)[] = [null, null, null, null, null, null]
    sets[0] = def.relicAffinity[0]
    if (def.relicAffinity[1]) sets[1] = def.relicAffinity[1]
    relicSetsByHero[id] = sets
  }

  const loadout = buildArenaLoadout({
    slots: [...ids],
    heroes,
    relicSetsByHero,
    runes: [],
    arenaLevel: 0,
  })

  // 双方羁绊各自独立计算（与 arena.ts 的对局结算同口径：
  // 这里用同一批 runtime 算出该阵容自己的羁绊，再喂进竞技上下文）
  const bond = getBondMods(runtimes)

  // PVE 口径战力（仅用于「证明养成差 100 倍」，不进竞技结算）
  const pvePower = runtimes.reduce((sum, hero) => {
    const stats = resolveStats(hero, { mode: 'pve', seed: 1, teamMods: { bond } })
    return sum + computePower(stats)
  }, 0)

  // 竞技口径战力（归一化后的真实战力；竞技分支不读等级 / 遗物强化 / 永久加成）
  const arenaPower = buildArenaUnits(loadout, 'ally', {
    ...arenaContext(BASE_SEED),
    teamMods: { bond },
  }).reduce((sum, unit) => sum + computePower(unit.stats), 0)

  return { loadout, pvePower, arenaPower }
}

/** 跑一组对局，返回样本 */
function runGroup(
  group: string,
  attacker: Account,
  defender: Account,
  trials: number,
  seedBase: number,
): PvpMatchSample[] {
  const samples: PvpMatchSample[] = []
  const powers = { attacker: attacker.arenaPower, defender: defender.arenaPower }

  for (let i = 0; i < trials; i++) {
    const seed = seedBase + i
    const match = resolveArenaMatch({
      challengeId: `${group}-${seed}`,
      attacker: attacker.loadout,
      defender: defender.loadout,
      attackerId: 'a',
      attackerName: 'A',
      defenderId: 'b',
      defenderName: 'B',
      seed,
    })
    samples.push(sampleFromArenaMatch(match, powers, group))
  }
  return samples
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}

function pp(v: number): string {
  return `${(v * 100).toFixed(2)}pp`
}

console.log('='.repeat(84))
console.log('《超级圣杯战争》对局样本采集（Phase 11 决策闸门 · 合成样本）')
console.log('='.repeat(84))

// ── E1 养成隔离（镜像对局）──
//
// 两个账号的 PVE 养成差 100 倍（等级 1 vs 240、遗物强化 1 vs 60），
// 但**竞技快照完全相同**（星级 / 技能 / 套装一致）——
// 归一化后双方战力必须**完全一致**（差距 0%），胜负必须五五开。

const low = makeAccount(TEAM_A, { level: 1, star: 3, skill: 10, relicLevel: 1 })
const high = makeAccount(TEAM_A, { level: 240, star: 3, skill: 10, relicLevel: 60 })

const e1Samples = runGroup('养成隔离', high, low, TRIALS, BASE_SEED)
const e1Verdict = evaluatePvpFairness(e1Samples)

const pveGap = powerGap(high.pvePower, low.pvePower)

console.log('\n【E1 养成隔离】同竞技快照，PVE 养成差 100 倍（镜像对局）\n')
console.log(`  PVE 口径战力：高养成 ${Math.round(high.pvePower)} / 低养成 ${Math.round(low.pvePower)}` +
  ` → 差 ${pct(pveGap)}（证明「养成差 100 倍」这件事确实存在）`)
console.log(`  竞技口径战力：差 ${pct(e1Verdict.summary.maxPowerGap)}` +
  `（阈值 ${pct(PVP_SAMPLE_THRESHOLDS.NORMALIZED_POWER_GAP)}）`)
console.log(`  进攻方胜率：${pct(e1Verdict.summary.attackerWinRate)}` +
  `（偏差 ${pp(Math.abs(e1Verdict.summary.attackerWinRate - 0.5))}` +
  `，阈值 ${pp(PVP_SAMPLE_THRESHOLDS.WIN_RATE_BIAS)}）`)
console.log(`  先手方胜率：${pct(e1Verdict.summary.firstMoveWinRate)}` +
  ` / 后手方 ${pct(e1Verdict.summary.secondMoveWinRate)}` +
  `（差 ${pp(Math.abs(e1Verdict.summary.firstMoveWinRate - e1Verdict.summary.secondMoveWinRate))}` +
  `，阈值 ${pp(PVP_SAMPLE_THRESHOLDS.FIRST_MOVE_BIAS)}）`)
console.log(`  平均回合：${e1Verdict.summary.avgRounds.toFixed(1)}`)

// ── E2 跨阵容（描述性）──
//
// 不同定位配比的阵容互打。**不判公平**：两队本来就不一样强，
// 拿「进攻方胜率偏差」去判会把「B 队更强」误报成「引擎不公平」。

const teamA = makeAccount(TEAM_A, { level: 120, star: 4, skill: 12, relicLevel: 30 })
const teamB = makeAccount(TEAM_B, { level: 120, star: 4, skill: 12, relicLevel: 30 })

const e2Forward = runGroup('跨阵容-A攻', teamA, teamB, TRIALS, BASE_SEED + 1000)
const e2Reverse = runGroup('跨阵容-B攻', teamB, teamA, TRIALS, BASE_SEED + 1000)
const e2Verdict = evaluatePvpFairness(e2Forward, { exclude: ['win-rate-bias'] })

const aWin = summarizeSamples(e2Forward).attackerWinRate
const bWin = summarizeSamples(e2Reverse).attackerWinRate

console.log('\n【E2 跨阵容】A 阵容 vs B 阵容（描述性 · 不判公平）\n')
console.log(`  双方归一化战力：A ${Math.round(teamA.arenaPower)} / B ${Math.round(teamB.arenaPower)}` +
  ` → 差 ${pct(powerGap(teamA.arenaPower, teamB.arenaPower))}`)
console.log(`  A 进攻时 A 的胜率：${pct(aWin)}`)
console.log(`  B 进攻时 B 的胜率：${pct(bWin)}`)
console.log(`  平均回合：${summarizeSamples([...e2Forward, ...e2Reverse]).avgRounds.toFixed(1)}`)
console.log('  注：归一化战力几乎相同、胜率却悬殊 → 战力公式**不预测胜负**（技能与羁绊的权重远大于数值）')

// ── E3 策略宽度（描述性）──
//
// 同一支队伍、两种养成档（星级 / 技能不同）→ 归一化后差多少。
// 这是 §6.8 **有意保留**的「策略广度」：养成投入在竞技里换来的不是数值，
// 而是可选的被动 / 技能 / 套装。所以这里只报数，不判公平。

const rookie = makeAccount(TEAM_A, { level: 1, star: 1, skill: 1, relicLevel: 1 })
const veteran = makeAccount(TEAM_A, { level: 240, star: 5, skill: 18, relicLevel: 60 })
const e3Samples = runGroup('策略宽度', veteran, rookie, TRIALS, BASE_SEED + 2000)
const e3Summary = summarizeSamples(e3Samples)

console.log('\n【E3 策略宽度】同一队伍 1★1技能 vs 5★18技能（描述性）\n')
console.log(`  归一化战力：${Math.round(veteran.arenaPower)} vs ${Math.round(rookie.arenaPower)}` +
  ` → 差 ${pct(powerGap(veteran.arenaPower, rookie.arenaPower))}`)
console.log(`  满养成方进攻胜率：${pct(e3Summary.attackerWinRate)}`)
console.log('  注：这部分差距来自被动 ×0.6 / 技能 +30% / 套装 ×0.7 / 羁绊 ×0.6 的封顶策略修正，')
console.log('      是设计基线 §6.8 明确要保留的「策略广度」，不是数值泄漏')

// ── 判据总表 ──

console.log('\n【判据总表】\n')
for (const [title, verdict] of [['E1 养成隔离', e1Verdict], ['E2 跨阵容', e2Verdict]] as const) {
  console.log(`  ${title}：${verdict.passed ? '通过' : '未通过'}`)
  for (const check of verdict.checks) {
    const mark = check.passed ? '✓' : '✗'
    const cmp = check.comparison === '<=' ? '≤' : '≥'
    console.log(`    ${mark} ${check.label}：实测 ${check.value.toFixed(4)}（要求 ${cmp} ${check.threshold}）`)
    console.log(`      ${check.detail}`)
  }
}

console.log('\n  注：以上为**合成样本**结论，只用于验证判据管线与发现结构性偏差；')
console.log('      「是否启动 Phase 11」必须等真实玩家样本（见 roadmap P2-3 的对局样本采集方案）。')

// ── 机读基线（可选） ──

const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : ''
if (jsonOut) {
  const payload = {
    generatedAt: new Date().toISOString(),
    trials: TRIALS,
    thresholds: PVP_SAMPLE_THRESHOLDS,
    arenaTemplates: ARENA_TEMPLATES,
    e1: {
      pvePowerHigh: Math.round(high.pvePower),
      pvePowerLow: Math.round(low.pvePower),
      pveGap,
      arenaMaxGap: e1Verdict.summary.maxPowerGap,
      attackerWinRate: e1Verdict.summary.attackerWinRate,
      firstMoveWinRate: e1Verdict.summary.firstMoveWinRate,
      secondMoveWinRate: e1Verdict.summary.secondMoveWinRate,
      avgRounds: e1Verdict.summary.avgRounds,
      checks: e1Verdict.checks,
      passed: e1Verdict.passed,
    },
    e2: {
      arenaPowerA: Math.round(teamA.arenaPower),
      arenaPowerB: Math.round(teamB.arenaPower),
      aWinRateWhenAttacking: aWin,
      bWinRateWhenAttacking: bWin,
      powerGap: powerGap(teamA.arenaPower, teamB.arenaPower),
    },
    e3: {
      arenaPowerVeteran: Math.round(veteran.arenaPower),
      arenaPowerRookie: Math.round(rookie.arenaPower),
      powerGap: powerGap(veteran.arenaPower, rookie.arenaPower),
      veteranWinRate: e3Summary.attackerWinRate,
    },
  }
  const path = resolve(process.cwd(), jsonOut)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  console.log(`\n机读基线已保存：${path}`)
}

console.log('\n' + '='.repeat(84))
