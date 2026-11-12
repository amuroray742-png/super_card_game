/**
 * 实战战斗模拟（§5.8 / §6.5 的**战斗层**数值验证）。
 *
 * ⚠ 为什么要有这个脚本：`npm run balance`（tools/balance/simulate.ts）比的是
 *   **战力数字**（computePower vs powerRequired），不真的跑战斗。
 *   两者会脱节：战力模型说「满养成能到第 310 关」，
 *   但真实打起来可能第 200 关就卡住。
 *   历史教训：BOSS 召唤机制长期「配置齐全但从未触发」，
 *   战力模型完全看不出问题——只有真跑战斗才能发现。
 *
 * 本脚本做两件事：
 * 1. 逐章 BOSS 的**实战通关率**，并给出「召唤机制开 / 关」对照
 *    （对照 = 把 bossMechanic 去掉，等价于「召唤从未触发」的旧行为）
 * 2. 满养成队伍逐关扫描 → **实战卡关点**（真实能过的最后一关）
 */
import { simulateWinRate } from '../../src/core/systems/battle.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { STAGES, getStage } from '../../src/core/config/stages.ts'
import { getTeamPower, preferredSlotForRole } from '../../src/core/systems/team.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { generateRelic } from '../../src/core/systems/relic.ts'
import { Rng } from '../../src/core/rng.ts'
import type { EnemyDef, HeroRuntime, HeroState } from '../../src/core/model/types.ts'
// 加载遗物配置（内部会注册到遗物索引）
import '../../src/core/config/relics.ts'

/** 每个 BOSS 关跑多少场 */
const TRIALS = 120
/** 逐关扫描每关跑多少场 */
const SCAN_TRIALS = 20

/** 构造一支指定投入水平的队伍（阵型与玩家实际摆法一致） */
function buildTeam(level: number, star: number, skillLevel: number, relicLevel: number): HeroRuntime[] {
  const rng = new Rng(20261110)
  const roster = HEROES.filter((h) => h.rarity === 'SSR').slice(0, 6)
  const front = roster.filter((h) => preferredSlotForRole(h.role) === 'front')
  const back = roster.filter((h) => preferredSlotForRole(h.role) === 'back')
  const frontLine = [...front, ...back].slice(0, 3)
  const backLine = [...back, ...front].filter((h) => !frontLine.includes(h)).slice(0, 3)

  return [...frontLine, ...backLine].map((def, slot) => {
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
    const relics = Array.from({ length: 6 }, (_, i) =>
      generateRelic(`${setId}_${(i % 5) + 1}`, rng, relicLevel),
    )
    return { def, state, relics, slot }
  })
}

/** 战力模型认为这支队能推进到第几关 */
function stageForPower(power: number): number {
  let best = 0
  for (const stage of STAGES) {
    if (stage.powerRequired <= power) best = stage.id
    else break
  }
  return best
}

/** 去掉 BOSS 机制 = 等价于「机制从未触发」 */
function withoutMechanic(def: EnemyDef): EnemyDef {
  return { ...def, bossMechanic: undefined }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

const profiles: Array<[string, number, number, number, number]> = [
  ['L30/2★', 30, 2, 5, 10],
  ['L60/3★', 60, 3, 10, 25],
  ['L120/4★', 120, 4, 15, 40],
  ['L180/5★', 180, 5, 18, 50],
  ['L240/6★', 240, 6, 20, 60],
]

console.log('='.repeat(78))
console.log('《超级圣杯战争》实战战斗模拟（真实跑 battle，不比战力数字）')
console.log('='.repeat(78))

// ── 1. 逐章 BOSS 实战通关率 ──

console.log('\n【逐章 BOSS 实战通关率】每关 ' + TRIALS + ' 场')
console.log('  召唤开 = 机制生效；召唤关 = 去掉机制（等价于「召唤从未触发」的旧行为）\n')

const bossStages = STAGES.filter((s) => s.isBoss)
const teams = profiles.map(([label, level, star, skill, relic]) => ({
  label,
  heroes: buildTeam(level, star, skill, relic),
}))

console.log('  档位'.padEnd(11) + '战力可达'.padEnd(11) + 'BOSS 关'.padEnd(11) + '召唤开'.padEnd(16) + '召唤关')

for (const { label, heroes } of teams) {
  const power = getTeamPower(heroes, { mode: 'pve' })
  const reach = stageForPower(power)
  const reachChapter = STAGES.find((s) => s.id === reach)?.chapter ?? 0

  for (const stage of bossStages) {
    const boss = getEnemy(stage.enemyIds[0])
    const withSummon = simulateWinRate(
      { allies: heroes, enemies: [boss], enemyScale: stage.enemyScale, ctx: { mode: 'pve' } },
      TRIALS,
    )
    const withoutSummon = simulateWinRate(
      {
        allies: heroes,
        enemies: [withoutMechanic(boss)],
        enemyScale: stage.enemyScale,
        ctx: { mode: 'pve' },
      },
      TRIALS,
    )
    console.log(
      `  ${label.padEnd(9)}第${String(reachChapter).padStart(2)}章`.padEnd(24) +
        `第${String(stage.chapter).padStart(2)}章`.padEnd(13) +
        `${pct(withSummon.winRate).padEnd(14)}` +
        `${pct(withoutSummon.winRate)}`,
    )
  }
  console.log('')
}

// ── 2. 实战卡关点 ──

console.log(`【实战卡关点】满养成队伍逐关扫描（每关 ${SCAN_TRIALS} 场）`)
const maxed = buildTeam(240, 6, 20, 60)
let lastWin = 0
const bossRates: string[] = []
for (const stage of STAGES) {
  const enemies = stage.enemyIds.map((id) => getEnemy(id))
  const s = simulateWinRate(
    { allies: maxed, enemies, enemyScale: stage.enemyScale, ctx: { mode: 'pve' } },
    SCAN_TRIALS,
  )
  if (s.winRate >= 0.5) lastWin = stage.id
  if (stage.isBoss) bossRates.push(`第${stage.chapter}章 ${pct(s.winRate)}`)
}
const power = getTeamPower(maxed, { mode: 'pve' })
const modelReach = stageForPower(power)

console.log(`  战力模型认为满养成能到：第 ${modelReach} 关`)
console.log(`  实战能过的最后一关：  第 ${lastWin} 关`)
console.log(`  各章 BOSS 实战通关率：  ${bossRates.join('  ')}`)
if (lastWin < modelReach) {
  console.log(
    `\n  ⚠ 已知缺口：战力模型与实战脱节（模型 ${modelReach} 关 / 实战 ${lastWin} 关）。`,
  )
  console.log('    根因是敌方属性缩放曲线（stageEnemyScale）远快于养成成长曲线，')
  console.log('    与「满养成可通关末关」这条不变量脱节。修复需单独做数值调参提交。')
}

console.log('\n' + '='.repeat(78))
