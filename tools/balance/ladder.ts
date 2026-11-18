/**
 * 三队天梯标定（§9.1 / roadmap P2-2）。
 *
 * ⚠ 为什么要有这个脚本：`npm run balance`（tools/balance/simulate.ts）比的是
 *   **战力数字**，不跑战斗；`balance:battle` 跑的是**主线关卡**，
 *   不是天梯梯队。三队天梯的敌方缩放是**独立的一条曲线**，
 *   不标定就会变成「数字好看、实战打不动」。
 *
 * 本脚本做三件事：
 * 1. **逐层逐梯队的实战通关率**：用「该层预期养成水平」的参考队伍真跑战斗；
 * 2. **三队养成成本对照**：同一支队伍连打三关（省钱打法）
 *    vs 三支不同队伍（标准打法），给出通关率差；
 * 3. **推进节奏**：按段位门槛与每周得分，推出到达各段位需要多少周。
 *
 * 用法：
 *   `npm run balance:ladder`                → 报告当前锚点的实战通关率
 *   `npm run balance:ladder -- --calibrate` → 二分标定锚点并打印建议值
 */
import { simulateWinRate } from '../../src/core/systems/battle.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { generateRelic, makeRelicUid } from '../../src/core/systems/relic.ts'
import { Rng } from '../../src/core/rng.ts'
import { LADDER, TIERS } from '../../src/core/config/economy.ts'
import { LADDER_TIERS } from '../../src/core/config/ladder.ts'
import { ladderPointsFor } from '../../src/core/systems/ladder.ts'
import type { HeroRuntime, HeroState } from '../../src/core/model/types.ts'
import { preferredSlotForRole } from '../../src/core/systems/team.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
// 加载遗物配置（内部会注册到遗物索引）
import '../../src/core/config/relics.ts'

/** 每个梯队位跑多少场 */
const TRIALS = 120
/** 标定（二分）时每格跑多少场——标定要快，最终报告再跑多 */
const CALIBRATION_TRIALS = 40

/**
 * 三个梯队的目标通关率。
 *
 * 梯队 1 接近稳过（新手也能拿到第一档分），
 * 梯队 3 是真门槛（「三队全胜」才配拿登顶奖励）。
 */
const TARGET_RATES = [0.9, 0.65, 0.4]

/** 模拟用的遗物 uid 计数器（不入存档，但同批内必须唯一） */
let relicSeq = 0

/**
 * 参考队伍的养成档位。
 *
 * 与 `LADDER.REFERENCE_LEVELS`（梯队层 → 预期等级）一一对应：
 * 等级越高，星级 / 技能 / 遗物强化也越高（与主线投放曲线同向）。
 */
interface Investment {
  level: number
  star: number
  skill: number
  relic: number
}

const INVESTMENTS: Investment[] = [
  { level: 10, star: 2, skill: 5, relic: 10 },
  { level: 31, star: 2, skill: 5, relic: 10 },
  { level: 62, star: 3, skill: 10, relic: 25 },
  { level: 78, star: 3, skill: 10, relic: 25 },
  { level: 108, star: 4, skill: 15, relic: 40 },
  { level: 133, star: 4, skill: 15, relic: 40 },
  { level: 164, star: 5, skill: 18, relic: 50 },
  { level: 193, star: 5, skill: 18, relic: 50 },
]

/**
 * 三套**均衡阵容**（各 6 人，覆盖全部 5 个定位）。
 *
 * ⚠ 为什么固定阵容：12 名 SSR 的强度并不均匀（定位 / 五行 / 羁绊都不同），
 *   随便切一段会得到强弱差很大的队伍——同一档投入下通关率能从 3% 跳到 100%，
 *   标定结果全是阵容噪声。固定阵容后，唯一变量只剩**投入水平**。
 *
 * 三套阵容的定位覆盖一致 → 「三支不同队伍 vs 同一支队伍」的差值
 * 反映的是**阵容多样性**的边际收益，而不是投入差异。
 */
const REFERENCE_TEAMS: readonly string[][] = [
  ['xiangyu', 'alexander', 'hanxin', 'zhugeliang', 'archimedes', 'jeannedarc'],
  ['libai', 'hannibal', 'caesar', 'zhugeliang', 'zuchongzhi', 'jeannedarc'],
  ['xiangyu', 'napoleon', 'sunwu', 'zhugeliang', 'archimedes', 'jeannedarc'],
]

/** 构造一支指定投入水平的队伍（阵型与玩家实际摆法一致） */
function buildTeam(inv: Investment, variant = 0): HeroRuntime[] {
  const ids = REFERENCE_TEAMS[variant % REFERENCE_TEAMS.length]
  const rng = new Rng(20261110)
  const roster = ids.map((id) => HEROES.find((h) => h.id === id)!).filter(Boolean)
  const front = roster.filter((h) => preferredSlotForRole(h.role) === 'front')
  const back = roster.filter((h) => preferredSlotForRole(h.role) === 'back')
  const frontLine = [...front, ...back].slice(0, 3)
  const backLine = [...back, ...front].filter((h) => !frontLine.includes(h)).slice(0, 3)

  return [...frontLine, ...backLine].map((def, slot) => {
    const state: HeroState = {
      id: def.id,
      level: inv.level,
      exp: 0,
      star: inv.star,
      skillLevels: [inv.skill, inv.skill, inv.skill],
      shards: 0,
      coreAwakened: inv.star >= 4,
      obtainedAt: 0,
    }
    const setId = def.relicAffinity[0]
    const relics = Array.from({ length: 6 }, (_, i) => {
      relicSeq += 1
      return generateRelic(`${setId}_${(i % 5) + 1}`, rng, inv.relic, makeRelicUid(relicSeq))
    })
    return { def, state, relics, slot }
  })
}

/** 某层某梯队在给定缩放下的通关率 */
function winRate(
  team: HeroRuntime[],
  tierIndex: number,
  squadIndex: number,
  scale: number,
  trials: number,
): number {
  const def = LADDER_TIERS[tierIndex].squads[squadIndex]
  const enemies = def.enemyIds.map((id) => getEnemy(id))
  return simulateWinRate(
    { allies: team, enemies, enemyScale: scale, ctx: { mode: 'pve' } },
    trials,
  ).winRate
}

/** 二分：找「通关率落在目标附近」的敌方缩放 */
function searchScale(
  team: HeroRuntime[],
  tierIndex: number,
  squadIndex: number,
  target: number,
): number {
  let lo = 0.05
  let hi = 500000
  for (let i = 0; i < 18; i++) {
    const mid = Math.sqrt(lo * hi)
    const rate = winRate(team, tierIndex, squadIndex, mid, CALIBRATION_TRIALS)
    if (rate > target) lo = mid
    else hi = mid
  }
  return Math.round(Math.sqrt(lo * hi) * 100) / 100
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

const calibrate = process.argv.includes('--calibrate')

console.log('='.repeat(84))
console.log('《超级圣杯战争》三队天梯标定（真实跑战斗，不比战力数字）')
console.log('='.repeat(84))

// ── 0. 标定锚点（可选） ──

let anchors: number[][] = LADDER.SCALE_ANCHORS.map((row) => [...row])

if (calibrate) {
  console.log(`\n【标定】逐梯队二分敌方缩放（目标通关率 ${TARGET_RATES.map(pct).join(' / ')}）\n`)
  const suggested: number[][] = []
  for (let t = 0; t < LADDER_TIERS.length; t++) {
    const inv = INVESTMENTS[t] ?? INVESTMENTS[INVESTMENTS.length - 1]
    const team = buildTeam(inv, 0)
    const row: number[] = []
    for (let s = 0; s < LADDER_TIERS[t].squads.length; s++) {
      row.push(searchScale(team, t, s, TARGET_RATES[s]))
    }
    suggested.push(row)
    console.log(
      `  层 ${String(t).padEnd(2)} 参考 L${String(inv.level).padEnd(4)}` +
        row.map((v, s) => `梯队${s + 1} ${String(v).padStart(9)}`).join(''),
    )
  }
  anchors = suggested
  console.log('\n  建议写入 economy.ts 的 LADDER.SCALE_ANCHORS：')
  console.log(
    '  [\n' + suggested.map((row) => `    [${row.join(', ')}],`).join('\n') + '\n  ]',
  )
}

// ── 1. 逐层逐梯队的实战通关率 ──

console.log('\n【逐层逐梯队实战通关率】每格 ' + TRIALS + ' 场')
console.log('  参考队伍 = 该层预期养成水平（等级/星级/技能/遗物强化见下）\n')
console.log('  层'.padEnd(10) + '参考养成'.padEnd(16) + '梯队1'.padEnd(12) + '梯队2'.padEnd(12) + '梯队3'.padEnd(12) + '缩放(梯队1)')

for (let t = 0; t < LADDER_TIERS.length; t++) {
  const inv = INVESTMENTS[t] ?? INVESTMENTS[INVESTMENTS.length - 1]
  const team = buildTeam(inv, 0)
  const cells: string[] = []
  for (let s = 0; s < LADDER_TIERS[t].squads.length; s++) {
    cells.push(pct(winRate(team, t, s, anchors[t][s], TRIALS)).padEnd(12))
  }
  const invest = `L${inv.level}/${inv.star}★`
  console.log(
    `  ${String(t).padEnd(8)}${invest.padEnd(16)}${cells.join('')}${anchors[t][0].toFixed(2)}`,
  )
}

// ── 2. 三队养成成本对照 ──
//
// 「省钱打法」= 三支队伍用同一批英灵（玩家只有 6 个主力时只能这么干）；
// 「标准打法」= 三支不同的队伍（要额外养 12 个英灵）。
// 两者在通关率上的差 = 「三队养成成本」的实际边际收益。

console.log('\n【三队养成成本对照】同一层内，三支队伍用同一批英灵 vs 三支不同队伍\n')
console.log('  层'.padEnd(10) + '省钱打法(同队 x3)'.padEnd(24) + '标准打法(不同队)'.padEnd(24) + '差值(平均通关率)')

for (let t = 0; t < LADDER_TIERS.length; t++) {
  const inv = INVESTMENTS[t] ?? INVESTMENTS[INVESTMENTS.length - 1]
  const same = buildTeam(inv, 0)
  const different = [buildTeam(inv, 0), buildTeam(inv, 1), buildTeam(inv, 2)]

  const avg = (teams: HeroRuntime[][]): number => {
    let sum = 0
    for (let s = 0; s < LADDER_TIERS[t].squads.length; s++) {
      sum += winRate(teams[s], t, s, anchors[t][s], TRIALS)
    }
    return sum / LADDER_TIERS[t].squads.length
  }

  const cheap = avg([same, same, same])
  const normal = avg(different)
  console.log(
    `  ${String(t).padEnd(8)}${pct(cheap).padEnd(24)}${pct(normal).padEnd(24)}` +
      `${((normal - cheap) * 100 >= 0 ? '+' : '')}${((normal - cheap) * 100).toFixed(1)} 个百分点`,
  )
}

// ── 3. 推进节奏 ──

console.log('\n【推进节奏】每周一轮，满编得分 ' + ladderPointsFor(3) + ' 分（3 队全胜）\n')
console.log('  段位'.padEnd(10) + '门槛分'.padEnd(14) + '满编周数'.padEnd(14) + '半程周数'.padEnd(14) + '赛季数(4 周)')
console.log('  ' + '-'.repeat(64))
const fullWeek = ladderPointsFor(3)
for (const tier of TIERS) {
  const full = Math.ceil(tier.min / fullWeek)
  const half = Math.ceil(tier.min / (fullWeek / 2))
  console.log(
    `  ${tier.name.padEnd(8)}${String(tier.min).padStart(8)}  ` +
      `${`${full} 周`.padEnd(14)}${`${half} 周`.padEnd(14)}${(full / LADDER.SEASON_WEEKS).toFixed(1)}`,
  )
}

const carryPct = Math.round(LADDER.SEASON_CARRY_PCT * 100)
console.log(
  '\n  注：满编周数按「每周都拿满」算；实际还要扣掉断更、卡关与赛季重置的保留比例'
  + `（${carryPct}%）。`,
)

// ── 4. 机读基线（可选） ──
//
// 把标定结果写成 JSON 存档到 `artifacts/baselines/ladder.json`：
// 验收时可以直接比对「标定值有没有被人手改过」。

const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : ''
if (jsonOut) {
  const payload = {
    generatedAt: new Date().toISOString(),
    trials: TRIALS,
    targetRates: TARGET_RATES,
    scaleAnchors: anchors,
    tiers: LADDER_TIERS.map((tier, i) => ({
      index: tier.index,
      name: tier.name,
      reference: INVESTMENTS[i] ?? null,
      winRates: LADDER_TIERS[i].squads.map((_, s) =>
        Math.round(winRate(buildTeam(INVESTMENTS[i] ?? INVESTMENTS[0], 0), i, s, anchors[i][s], TRIALS) * 1000) / 1000),
    })),
    progression: TIERS.map((tier) => ({
      tier: tier.name,
      minPoints: tier.min,
      fullWeeks: Math.ceil(tier.min / ladderPointsFor(3)),
    })),
    seasonWeeks: LADDER.SEASON_WEEKS,
    seasonCarryPct: LADDER.SEASON_CARRY_PCT,
    pointsPerSquad: LADDER.POINTS_PER_SQUAD,
    pointsClearBonus: LADDER.POINTS_CLEAR_BONUS,
  }
  const path = resolve(process.cwd(), jsonOut)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  console.log(`\n机读基线已保存：${path}`)
}

console.log('\n' + '='.repeat(84))
