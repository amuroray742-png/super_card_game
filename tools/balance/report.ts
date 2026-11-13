/**
 * 投放回收表（Phase 10 / §10.4）。
 *
 * 回答一个问题：**主线推关能养出多少个满养成英灵？**
 *
 * 基准口径：
 *   - 消耗侧 = 1 个英灵满养成（Lv240 / 6★ / 技能满级 / 6 件遗物满强化）
 *     × 6 人编队；经验消耗按英雄计，其余按编队总量计。
 *   - 投放侧 = 主线 310 关全通（含每章 BOSS）的掉落总和，取区间期望值。
 *
 * 输出：
 *   1. 逐章投放明细
 *   2. 满养成消耗明细
 *   3. 投放 / 消耗 = 回收倍数（>1 说明主线养得起，<1 说明需要额外来源）
 */
import { DROP_TABLES, LEVEL, SKILL, RELIC, STAR, STAGE } from '../../src/core/config/economy.ts'
import { STAGES } from '../../src/core/config/stages.ts'
import { totalExpToReach, starUpCost } from '../../src/core/systems/growth.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'

interface Expected {
  silver: number
  exp: number
  skillStones: number
  relicStones: number
  emblems: number
  /** 遗物掉落按稀有度计 */
  relics: Record<string, number>
}

function mid([lo, hi]: readonly [number, number]): number {
  return (lo + hi) / 2
}

function emptyExpected(): Expected {
  return {
    silver: 0,
    exp: 0,
    skillStones: 0,
    relicStones: 0,
    emblems: 0,
    relics: { N: 0, R: 0, SR: 0, SSR: 0 },
  }
}

/** 单张掉落表的期望产出（含遗物稀有度分布） */
function expectedOfTable(tableKey: string): Expected {
  const t = DROP_TABLES[tableKey]
  const out = emptyExpected()
  out.silver = mid(t.silver)
  out.exp = mid(t.exp)
  out.skillStones = mid(t.skillStones)
  out.relicStones = mid(t.relicStones)
  out.emblems = mid(t.emblems)
  const totalWeight = t.relicDrop.reduce((a, d) => a + d.weight, 0)
  for (const d of t.relicDrop) {
    out.relics[d.rarity] += d.weight / totalWeight
  }
  return out
}

function addInto(target: Expected, src: Expected, times: number): void {
  target.silver += src.silver * times
  target.exp += src.exp * times
  target.skillStones += src.skillStones * times
  target.relicStones += src.relicStones * times
  target.emblems += src.emblems * times
  for (const k of Object.keys(target.relics)) {
    target.relics[k] += src.relics[k] * times
  }
}

// ─────────────────────────── 1. 逐章投放 ───────────────────────────

const perChapter: Expected[] = []
for (let chapter = 1; chapter <= STAGE.CHAPTERS; chapter++) {
  const acc = emptyExpected()
  const normal = expectedOfTable(`stage_${chapter}`)
  const boss = expectedOfTable(`boss_${chapter}`)
  addInto(acc, normal, STAGE.STAGES_PER_CHAPTER)
  addInto(acc, boss, 1)
  perChapter.push(acc)
}

const mainline: Expected = emptyExpected()
for (const acc of perChapter) addInto(mainline, acc, 1)

// ─────────────────────────── 2. 满养成消耗 ───────────────────────────

const TEAM_SIZE = 6
const RELIC_SLOTS = 6

/** 单个英灵升到满级所需经验 */
const expPerHero = totalExpToReach(LEVEL.MAX)

/** 单个英灵 1★ → 6★ 所需同名碎片与印记 */
let shardsPerHero = 0
let emblemsPerHero = 0
for (let star = STAR.MIN; star < STAR.MAX; star++) {
  const cost = starUpCost(star)
  if (!cost) continue
  shardsPerHero += cost.shards
  emblemsPerHero += cost.emblems
}

/** 单个英灵 3 个技能升满（1 → 20 级） */
const skillLevelsPerHero = SKILL.MAX_LEVEL - SKILL.MIN_LEVEL
const skillStonesPerHero = skillLevelsPerHero * SKILL.SKILL_STONES_PER_LEVEL
const skillSilverPerHero = skillLevelsPerHero * SKILL.SILVER_PER_LEVEL

/** 单件遗物 1 → 60 级 */
const relicLevelsPerRelic = RELIC.MAX_LEVEL - RELIC.MIN_LEVEL
const relicStonesPerRelic = relicLevelsPerRelic * RELIC.STONES_PER_LEVEL
const relicSilverPerRelic = relicLevelsPerRelic * RELIC.SILVER_PER_LEVEL

const relicsInTeam = TEAM_SIZE * RELIC_SLOTS

const cost = {
  exp: expPerHero * TEAM_SIZE,
  silver: skillSilverPerHero * TEAM_SIZE + relicSilverPerRelic * relicsInTeam,
  skillStones: skillStonesPerHero * TEAM_SIZE,
  relicStones: relicStonesPerRelic * relicsInTeam,
  emblems: emblemsPerHero * TEAM_SIZE,
}

// ─────────────────────────── 3. 输出 ───────────────────────────

function fmt(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return Math.round(n).toLocaleString('en-US')
}

function ratio(a: number, b: number): string {
  if (b <= 0) return '—'
  const r = a / b
  return `${r.toFixed(2)}×`
}

console.log('='.repeat(84))
console.log('《超级圣杯战争》投放回收表')
console.log('='.repeat(84))

console.log('\n【逐章投放期望】\n')
console.log('  章节        银两        经验      术式结晶   遗物石    印记    遗物掉落(N/R/SR/SSR)')
console.log('  ' + '-'.repeat(82))
for (let i = 0; i < perChapter.length; i++) {
  const a = perChapter[i]
  console.log(
    `  第${String(i + 1).padStart(2)}章  ` +
      `${fmt(a.silver).padStart(10)} ${fmt(a.exp).padStart(10)} ` +
      `${fmt(a.skillStones).padStart(10)} ${fmt(a.relicStones).padStart(9)} ` +
      `${fmt(a.emblems).padStart(7)}   ` +
      `${a.relics.N.toFixed(1)}/${a.relics.R.toFixed(1)}/${a.relics.SR.toFixed(1)}/${a.relics.SSR.toFixed(1)}`,
  )
}
console.log('  ' + '-'.repeat(82))
console.log(
  `  主线合计  ` +
    `${fmt(mainline.silver).padStart(10)} ${fmt(mainline.exp).padStart(10)} ` +
    `${fmt(mainline.skillStones).padStart(10)} ${fmt(mainline.relicStones).padStart(9)} ` +
    `${fmt(mainline.emblems).padStart(7)}   ` +
    `${mainline.relics.N.toFixed(1)}/${mainline.relics.R.toFixed(1)}/${mainline.relics.SR.toFixed(1)}/${mainline.relics.SSR.toFixed(1)}`,
)

console.log('\n【满养成消耗】基准 = 6 人编队（Lv240 / 6★ / 技能满级 / 6 件遗物满强化）\n')
console.log(`  经验        ${fmt(cost.exp).padStart(12)}   （单人 ${fmt(expPerHero)} × ${TEAM_SIZE}）`)
console.log(`  银两        ${fmt(cost.silver).padStart(12)}   （技能 ${fmt(skillSilverPerHero * TEAM_SIZE)} + 遗物 ${fmt(relicSilverPerRelic * relicsInTeam)}）`)
console.log(`  术式结晶    ${fmt(cost.skillStones).padStart(12)}   （单人 ${skillStonesPerHero} × ${TEAM_SIZE}）`)
console.log(`  遗物强化石  ${fmt(cost.relicStones).padStart(12)}   （单件 ${relicStonesPerRelic} × ${relicsInTeam} 件）`)
console.log(`  英灵印记    ${fmt(cost.emblems).padStart(12)}   （单人 ${emblemsPerHero} × ${TEAM_SIZE}）`)

console.log('\n【回收倍数】主线 310 关投放 ÷ 满养成消耗\n')
console.log('  资源            投放          消耗        回收倍数   判定')
console.log('  ' + '-'.repeat(66))
const rows: Array<[string, number, number]> = [
  ['经验', mainline.exp, cost.exp],
  ['银两', mainline.silver, cost.silver],
  ['术式结晶', mainline.skillStones, cost.skillStones],
  ['遗物强化石', mainline.relicStones, cost.relicStones],
  ['英灵印记', mainline.emblems, cost.emblems],
]
for (const [name, supply, need] of rows) {
  const r = need > 0 ? supply / need : Infinity
  const ok = r >= 1
  console.log(
    `  ${name.padEnd(12)} ${fmt(supply).padStart(10)} ${fmt(need).padStart(12)} ` +
      `${ratio(supply, need).padStart(10)}   ${ok ? '✓' : '✗ 缺口'}`,
  )
}

const relicSupply = Object.values(mainline.relics).reduce((a, b) => a + b, 0)
console.log(
  `  ${'遗物本体'.padEnd(12)} ${relicSupply.toFixed(0).padStart(10)} ${String(relicsInTeam).padStart(12)} ` +
    `${ratio(relicSupply, relicsInTeam).padStart(10)}   ${relicSupply >= relicsInTeam ? '✓' : '✗ 缺口'}`,
)

console.log(
  `\n  注：遗物本体掉落含 N/R/SR/SSR 全稀有度，实际可用性需按 SSR 占比折算` +
    `（主线 SSR 遗物约 ${mainline.relics.SSR.toFixed(0)} 件）。`,
)

console.log('\n【英灵阵容参考】SSR / SR / R / N 数量')
const counts = HEROES.reduce<Record<string, number>>((acc, h) => {
  acc[h.rarity] = (acc[h.rarity] ?? 0) + 1
  return acc
}, {})
console.log(
  `  SSR ${counts.SSR ?? 0} · SR ${counts.SR ?? 0} · R ${counts.R ?? 0} · N ${counts.N ?? 0} · 合计 ${HEROES.length}`,
)

console.log('\n' + '='.repeat(84))
