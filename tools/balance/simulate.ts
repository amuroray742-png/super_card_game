/**
 * 数值模拟（Phase 10 / §18）。
 *
 * 输出两张对比图的数据：
 *   1. 关卡难度曲线（310 关的战力门槛）
 *   2. 养成曲线（不同投入下的编队战力）
 *
 * 两者交叉点 = 卡关点，是数值调参的核心依据。
 */
import { STAGES } from '../../src/core/config/stages.ts'
import { STAGE } from '../../src/core/config/economy.ts'
import { computePower, resolveStats } from '../../src/core/systems/stats.ts'
import { getHeroPassiveMods } from '../../src/core/systems/growth.ts'
import { getHeroSetMods } from '../../src/core/systems/relic.ts'
import { getTeamPower, getBondMods } from '../../src/core/systems/team.ts'
import { generateRelic } from '../../src/core/systems/relic.ts'
import { Rng } from '../../src/core/rng.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
// 加载遗物 / 敌人配置（内部会注册到各自索引）
import '../../src/core/config/relics.ts'
import '../../src/core/config/enemies.ts'
import type { HeroRuntime, HeroState } from '../../src/core/model/types.ts'

/** 构造一支指定投入水平的队伍 */
function buildTeam(
  level: number,
  star: number,
  skillLevel: number,
  relicLevel: number,
  permBoost = 0,
): HeroRuntime[] {
  const rng = new Rng(20261110)
  const roster = HEROES.filter((h) => h.rarity === 'SSR').slice(0, 6)
  return roster.map((def) => {
    const state: HeroState = {
      id: def.id,
      level,
      exp: 0,
      star,
      skillLevels: [skillLevel, skillLevel, skillLevel],
      shards: 0,
      coreAwakened: star >= 4,
      obtainedAt: 0,
    }
    const setId = def.relicAffinity[0]
    const relics = Array.from({ length: 6 }, (_, i) => {
      const relicDef = `${setId}_${(i % 5) + 1}`
      return generateRelic(relicDef, rng, relicLevel)
    })
    return { def, state, relics }
  })
}

/** 某个养成投入下的编队战力 */
function powerAt(
  level: number,
  star: number,
  skillLevel: number,
  relicLevel: number,
  permBoost = 0,
): number {
  const team = buildTeam(level, star, skillLevel, relicLevel, permBoost)
  const progressMods =
    permBoost > 0
      ? (['atk', 'def', 'hp', 'spd'] as const).map((stat) => ({
          stat,
          kind: 'pct' as const,
          value: permBoost,
          zone: 'progress' as const,
        }))
      : []
  return getTeamPower(team, { mode: 'pve', teamMods: { progress: progressMods } })
}

function fmt(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return n.toFixed(0)
}

/** 找到玩家战力恰好能推进到的最高关卡 */
function stageForPower(power: number): number {
  let best = 0
  for (const stage of STAGES) {
    if (stage.powerRequired <= power) best = stage.id
    else break
  }
  return best
}

console.log('='.repeat(78))
console.log('《超级圣杯战争》数值模拟报告')
console.log('='.repeat(78))

// ── 1. 关卡难度曲线 ──
const totalSpan = STAGES[STAGES.length - 1].powerRequired / STAGES[0].powerRequired
console.log('\n【关卡难度曲线】共 %d 关，总跨度 %s 倍\n', STAGES.length, totalSpan.toExponential(2))

console.log('  关卡区间        战力门槛        章节倍率')
for (let chapter = 1; chapter <= STAGE.CHAPTERS; chapter++) {
  const first = STAGES.find((s) => s.chapter === chapter && s.index === 1)!
  const last = STAGES.find((s) => s.chapter === chapter && s.isBoss)!
  console.log(
    `  第${String(chapter).padStart(2)}章 1-${String(last.index).padStart(2)}   ` +
      `${fmt(first.powerRequired).padStart(8)} → ${fmt(last.powerRequired).padStart(8)}   ` +
      `×${STAGE.CHAPTER_GROWTH}`,
  )
}

// ── 2. 养成曲线 ──
console.log('\n【养成曲线】6 人编队战力（按投入水平）\n')

const profiles: Array<[number, number, number, number, number]> = [
  [1, 1, 1, 1, 0],
  [30, 2, 5, 10, 0],
  [60, 3, 10, 25, 0],
  [120, 4, 15, 40, 0.03],
  [180, 5, 18, 50, 0.09],
  [240, 6, 20, 60, 0.18],
  [240, 6, 20, 60, 0.6],
]

console.log('  等级  星级  技能  遗物强化  永久加成     战力         可推进至')
console.log('  ' + '-'.repeat(66))

for (const [level, star, skill, relic, boost] of profiles) {
  const power = powerAt(level, star, skill, relic, boost)
  const stage = stageForPower(power)
  console.log(
    `  ${String(level).padStart(4)}  ${String(star).padStart(4)}  ${String(skill).padStart(4)}  ` +
      `${String(relic).padStart(8)}  ${(boost * 100).toFixed(0).padStart(7)}%   ${fmt(power).padStart(10)}   第 ${stage} 关`,
  )
}

// ── 3. 卡点分析 ──
console.log('\n【卡点分析】各投入水平的卡关位置\n')
for (const [level, star, skill, relic, boost] of profiles) {
  const power = powerAt(level, star, skill, relic, boost)
  const stage = stageForPower(power)
  const next = STAGES.find((s) => s.id === stage + 1)
  const gap = next ? next.powerRequired / Math.max(1, power) : 1
  console.log(
    `  Lv${String(level).padStart(3)}/${star}★ → 卡在第 ${String(stage).padStart(3)} 关` +
      (next ? `，距第 ${next.id} 关还需 ×${gap.toFixed(2)} 战力` : '（已通关）'),
  )
}

// ── 4. 竞技平衡预校（§15.1 隔离阈值） ──
console.log('\n【竞技平衡预校】养成差距 → 归一化后战力差（阈值 15%）\n')

const naked = buildTeam(1, 1, 1, 1)
const maxed = buildTeam(240, 6, 20, 60)

const arenaProfile = {
  runeSlots: 3,
  passiveScale: 0.6,
  skillScale: 0.3,
  setScale: 0.7,
  bondScale: 0.6,
  templates: {
    猛将: { atk: 100, def: 50, hp: 1000, spd: 100, crit: 0.05, cdmg: 0.5 },
    统帅: { atk: 70, def: 60, hp: 1300, spd: 110, crit: 0.05, cdmg: 0.5 },
    谋士: { atk: 85, def: 45, hp: 950, spd: 130, crit: 0.05, cdmg: 0.5 },
    医者: { atk: 60, def: 50, hp: 1200, spd: 115, crit: 0.05, cdmg: 0.5 },
    器者: { atk: 90, def: 45, hp: 1000, spd: 120, crit: 0.05, cdmg: 0.5 },
  },
}

function arenaTeamPower(team: HeroRuntime[]): number {
  const bondMods = getBondMods(team)
  return team.reduce((acc, hero) => {
    const stats = resolveStats(
      hero,
      { mode: 'arena', arenaProfile, seed: 1, teamMods: { bond: bondMods } },
      { passives: getHeroPassiveMods(hero), setMods: getHeroSetMods(hero) },
    )
    return acc + computePower(stats)
  }, 0)
}

const pveNaked = getTeamPower(naked, { mode: 'pve' })
const pveMaxed = getTeamPower(maxed, { mode: 'pve' })
const arenaNaked = arenaTeamPower(naked)
const arenaMaxed = arenaTeamPower(maxed)

const pveRatio = pveMaxed / pveNaked
const arenaRatio = arenaMaxed / arenaNaked
const arenaDiffPct = Math.abs(arenaRatio - 1) * 100

console.log(`  PVE 模式：裸装 ${fmt(pveNaked)} → 满养成 ${fmt(pveMaxed)}（×${pveRatio.toFixed(1)}）`)
console.log(`  竞技模式：裸装 ${fmt(arenaNaked)} → 满养成 ${fmt(arenaMaxed)}（×${arenaRatio.toFixed(3)}）`)
console.log(`  归一化后战力差：${arenaDiffPct.toFixed(2)}%  ${arenaDiffPct < 15 ? '✓ 通过' : '✗ 超过 15% 阈值'}`)

console.log('\n' + '='.repeat(78))
