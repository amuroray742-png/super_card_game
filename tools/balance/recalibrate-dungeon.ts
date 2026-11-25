/**
 * **副本 42 关的难度标定**（挂机改版 v11 + 遗物副本 v12 · 设计稿 §3.2.1 ④ / §5.2）。
 *
 * ## 为什么要有这个脚本
 *
 * 副本从「取材主线波次」变成 **独立关卡**之后，每关都多出两个**标定值**：
 * `enemyScale`（敌方属性缩放）与 `powerRequired`（战力门槛）。
 * 这两个值**手填不得**（铁律 #41）：
 *
 * - 手填的缩放锚点会和「英灵 / 成长 / 掉落」数值脱钩——
 *   改完任何一处数值，副本难度就悄悄偏了，而且**没人会发现**
 *   （`npm run balance` 只比战力数字，看不出机制空转）。
 * - 手填的门槛会直接决定「玩家能不能挂这一关」——
 *   门槛定高了，那一档副本对所有人永久关闭；定低了，玩家一路秒怪，材料产量失去意义。
 *
 * 本脚本把标定流程变成**可复现**的一条命令：
 *
 * 1. **设计阶梯**：`DUNGEON.DESIGN_LEVELS[42]` 给出每关对应的**参考养成档**
 *    （外生常数，不是模拟涌现出来的——拿涌现值当输入会形成坏不动点）。
 * 2. **标定锚点**：`referenceTeam(designLevel)` 对该关二分「能稳过(≥90%)的最大缩放」，
 *    取其**一半**（留战斗容错）→ `SCALE_ANCHORS`；
 *    同时记下该档参考队伍的**战力** → `POWER_ANCHORS`。
 * 3. **单调性核对**：**难度段之间**（简易 → 普通 → 困难）严格递增；
 *    同段内的 14 关因敌人组合不同，**允许互相波动**（与主线「章内允许波动、
 *    章首严格递增」同构）。
 * 4. **写回** `core/config/economy.ts` 的 `DUNGEON` 常量块。
 *
 * ⚠ 时间与随机源全部注入（铁律 #1），本脚本不读真实时钟、不用 `Math.random()`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { DUNGEON } from '../../src/core/config/economy.ts'
import { STAGE } from '../../src/core/config/economy.ts'
import {
  DUNGEON_STAGES,
  DUNGEON_VARIANT_ORDER,
  dungeonStagesOfVariant,
  type DungeonStageDef,
} from '../../src/core/config/dungeons.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { simulateWinRate } from '../../src/core/systems/battle.ts'
import { getTeamPower } from '../../src/core/systems/team.ts'
import type { HeroRuntime } from '../../src/core/model/types.ts'
import { referenceTeam } from './reference-build.ts'

// ─────────────────────────── 命令行 ───────────────────────────

const { values } = parseArgs({
  options: {
    /** 每关的试验场数 */
    trials: { type: 'string', default: '40' },
    /** 二分迭代上限 */
    bisect: { type: 'string', default: '18' },
    /** 只看结果，不写回 `economy.ts` */
    dry: { type: 'boolean', default: false },
  },
})

const TRIALS = Math.max(10, Number(values.trials) || 40)
const BISECT = Math.max(6, Number(values.bisect) || 18)

// ─────────────────────────── 标定 ───────────────────────────

/** 该关的敌方配置（敌人 + 缩放） */
function stageEnemies(stage: DungeonStageDef, scale: number) {
  return stage.enemyIds
    .map((id) => getEnemy(id))
    .filter((e): e is NonNullable<typeof e> => e !== null)
}

/** 在给定缩放下，该关的实测通关率 */
function winRateAt(stage: DungeonStageDef, scale: number, heroes: HeroRuntime[]): number {
  const enemies = stageEnemies(stage, scale)
  if (enemies.length === 0) return 0
  const r = simulateWinRate(
    { allies: heroes, enemies, enemyScale: scale, ctx: { mode: 'pve' } },
    TRIALS,
  )
  return r.winRate
}

/**
 * 二分「通关率 ≥ 90% 的最大缩放」。
 *
 * ⚠ 上界必须够大：BOSS 机制（召唤 / 护盾 / 狂暴）会让难度非线性，
 *   所以上界取 1e6 而不是章内跨度的倍数。
 */
function maxWinnableScale(stage: DungeonStageDef, heroes: HeroRuntime[]): number {
  let lo = 0.01
  let hi = 1e6
  for (let i = 0; i < BISECT; i++) {
    const mid = Math.sqrt(lo * hi)
    if (winRateAt(stage, mid, heroes) >= 0.9) lo = mid
    else hi = mid
  }
  return lo
}

interface CalibrationDetail {
  stageId: string
  variantId: string
  difficulty: string
  /** 设计等级（外生输入） */
  designLevel: number
  /** 该档参考队伍的战力 */
  power: number
  /** 稳过上限缩放 */
  maxScale: number
  /** 目标缩放（稳过上限的一半） */
  anchor: number
}

/**
 * 标定一轮：按**设计阶梯**产出两张锚点表。
 *
 * ⚠ 与「用模拟涌现的阶梯标定」的本质区别：涌现阶梯会自我放大——
 *   打得轻松 → 玩家提前进阶 → 下一关提前 → 锚点一路被压低，
 *   最后收敛到坏不动点。设计阶梯是外生的，标定因此**确定且可复现**。
 */
function calibrate(): {
  scales: number[]
  powers: number[]
  details: CalibrationDetail[]
} {
  const scales: number[] = []
  const powers: number[] = []
  const details: CalibrationDetail[] = []

  for (let i = 0; i < DUNGEON_STAGES.length; i++) {
    const stage = DUNGEON_STAGES[i]
    const designLevel = DUNGEON.DESIGN_LEVELS[i]
    const team = referenceTeam(designLevel)
    const maxScale = maxWinnableScale(stage, team)
    // 与主线同款：取「稳过上限」的一半作为目标缩放（不至于秒杀也不至于耗死）
    const anchor = maxScale / 2
    const power = Math.round(getTeamPower(team, { mode: 'pve' }))
    scales.push(anchor)
    powers.push(power)
    details.push({
      stageId: stage.id,
      variantId: stage.variantId,
      difficulty: stage.difficulty,
      designLevel,
      power,
      maxScale,
      anchor,
    })
  }

  // ── 段间单调：简易 < 普通 < 困难 ──
  //
  // ⚠ 同段内的 8 关**允许波动**（敌人组合不同），
  //   但难度段之间必须严格递增——否则「困难关比简易关还好打」，
  //   玩家会一路留在低难度（材料产量与门槛设计全部失效）。
  for (const variantId of DUNGEON_VARIANT_ORDER) {
    const stages = dungeonStagesOfVariant(variantId)
    for (let i = 1; i < stages.length; i++) {
      const prevIndex = DUNGEON_STAGES.indexOf(stages[i - 1])
      const curIndex = DUNGEON_STAGES.indexOf(stages[i])
      if (scales[curIndex] <= scales[prevIndex]) {
        scales[curIndex] = scales[prevIndex] * 1.05
      }
      if (powers[curIndex] <= powers[prevIndex]) {
        powers[curIndex] = Math.round(powers[prevIndex] * 1.05)
      }
    }
  }

  return { scales, powers, details }
}

/** 把新一轮锚点写进已构建的关卡表（`DUNGEON_STAGES` 是模块加载时构建一次的） */
function applyAnchors(scales: readonly number[], powers: readonly number[]): void {
  DUNGEON_STAGES.forEach((stage, i) => {
    stage.enemyScale = scales[i]
    stage.powerRequired = powers[i]
  })
}

/**
 * 把标定结果写回 `core/config/economy.ts` 的 `DUNGEON` 常量块。
 *
 * ⚠⚠ **为什么必须限定在 `DUNGEON` 块内**（踩过的坑）：
 *   `economy.ts` 里有**两组**同名锚点——主线的 `STAGE.SCALE_ANCHORS` /
 *   `STAGE.POWER_ANCHORS` 与副本的 `DUNGEON.SCALE_ANCHORS` / `DUNGEON.POWER_ANCHORS`。
 *   直接用 `/SCALE_ANCHORS: \[…\]/` 全局替换会**先命中主线那组**，
 *   于是「副本标定」把**主线**的难度锚点冲掉了——主线难度整体错位，
 *   而 `npm run balance` 只比战力数字，**看不出**锚点被换过。
 *   ⇒ 写回必须**先定位 `export const DUNGEON = {`**，只在那一段里替换。
 */
function writeBack(scales: readonly number[], powers: readonly number[]): void {
  const path = resolve(process.cwd(), 'src/core/config/economy.ts')
  const text = readFileSync(path, 'utf8')

  const formatScales = (values: readonly number[]) => {
    const lines: string[] = []
    // ⚠ **按难度段换行**（每行 = 一个变体段），不是固定 8 个：
    //   42 个值按 8 换行会排成 8/8/8/8/8/2，**不再对齐 14 变体的段界**，
    //   锚点表会被误读（与「主线锚点被副本标定冲掉」同类的事故风险）。
    const perLine = DUNGEON_VARIANT_ORDER.length
    for (let i = 0; i < values.length; i += perLine) {
      lines.push('    ' + values.slice(i, i + perLine).map((v) => Number(v.toFixed(4))).join(', ') + ',')
    }
    return lines.join('\n')
  }
  const formatPowers = (values: readonly number[]) => {
    const lines: string[] = []
    const perLine = DUNGEON_VARIANT_ORDER.length
    for (let i = 0; i < values.length; i += perLine) {
      lines.push('    ' + values.slice(i, i + perLine).map((v) => Math.round(v)).join(', ') + ',')
    }
    return lines.join('\n')
  }

  // ① 只取 `DUNGEON` 常量块（到下一个顶层 `export const` 为止）
  const blockStart = text.indexOf('export const DUNGEON = {')
  if (blockStart < 0) throw new Error('economy.ts 里找不到 DUNGEON 常量块')
  const blockEnd = text.indexOf('\nexport ', blockStart + 1)
  const block = text.slice(blockStart, blockEnd < 0 ? text.length : blockEnd)

  // ② 在**块内**替换两个锚点数组
  let next = block.replace(
    /SCALE_ANCHORS: \[[\s\S]*?\n  \],/,
    `SCALE_ANCHORS: [\n${formatScales(scales)}\n  ],`,
  )
  next = next.replace(
    /POWER_ANCHORS: \[[\s\S]*?\n  \],/,
    `POWER_ANCHORS: [\n${formatPowers(powers)}\n  ],`,
  )
  if (next === block) throw new Error('DUNGEON 常量块里没找到锚点数组，写回中止')

  // ③ 拼回去
  writeFileSync(path, text.slice(0, blockStart) + next + text.slice(blockEnd < 0 ? text.length : blockEnd), 'utf8')
}

// ─────────────────────────── 主流程 ───────────────────────────

console.log('='.repeat(78))
console.log('《超级圣杯战争》副本关卡难度标定（挂机改版 v11 · 设计阶梯 + 真实战斗标定）')
console.log('='.repeat(78))
console.log(`  副本关卡 ${DUNGEON_STAGES.length} 关 · 每关试验 ${TRIALS} 场 · 二分 ${BISECT} 轮`)
console.log('  标定：二分「通关率 ≥ 90% 的最大缩放」→ 取一半')

const final = calibrate()
applyAnchors(final.scales, final.powers)

console.log('\n【逐关标定结果】（参考队伍 = 设计阶梯那一档）')
console.log('  关卡 | 变体 | 难度 | 设计等级 | 门槛战力 | 稳过上限缩放 | 目标缩放')
for (const d of final.details) {
  console.log(
    `  ${d.stageId.padEnd(22)} | ${d.variantId.padEnd(12)} | ${d.difficulty.padEnd(6)} | ` +
      `${String(d.designLevel).padStart(8)} | ${String(d.power).padStart(10)} | ` +
      `${d.maxScale.toFixed(1).padStart(13)} | ${d.anchor.toFixed(4).padStart(9)}`,
  )
}

console.log('\n【SCALE_ANCHORS】（敌方缩放锚点）')
console.log(`  [${final.scales.map((v) => v.toFixed(4)).join(', ')}],`)
console.log('\n【POWER_ANCHORS】（战力门槛）')
console.log(`  [${final.powers.map((v) => Math.round(v)).join(', ')},]`)

// ── 副本 vs 主线门槛对照表 ──
//
// ⚠ 为什么要有这张表：副本与主线是**两条独立的难度线**，
//   光看各自的绝对数字没法判断「相对难度」是否合理。
//   对照口径 = 同一个**设计档**（难度段对齐主线某章的目标等级）：
//     · 简易段 ↔ 主线第 1 章（设计等级 Lv24）
//     · 普通段 ↔ 主线第 4 章（设计等级 Lv96）
//     · 困难段 ↔ 主线第 8 章（设计等级 Lv192）
//   副本门槛**高于**同档主线门槛是正常的（副本要单独挑战、掉材料）；
//   但如果低得离谱，说明副本比主线主线段还简单 ⇒ 玩家会全程刷副本。
console.log('\n【副本 vs 主线门槛对照表】（同设计档比较）')
console.log('  难度段 | 对照主线章 | 主线门槛 | 副本门槛区间 | 相对（副本最低 ÷ 主线）')
const MAINLINE_CHAPTER_OF_SEGMENT: Record<string, number> = { easy: 1, normal: 4, hard: 8 }
for (const difficulty of ['easy', 'normal', 'hard'] as const) {
  const chapter = MAINLINE_CHAPTER_OF_SEGMENT[difficulty]
  const mainlineGate = STAGE.POWER_ANCHORS[chapter - 1]
  const rows = DUNGEON_STAGES.filter((s) => s.difficulty === difficulty)
  const gates = rows.map((s) => final.powers[DUNGEON_STAGES.indexOf(s)])
  const min = Math.min(...gates)
  const max = Math.max(...gates)
  console.log(
    `  ${difficulty.padEnd(8)} | 第 ${chapter} 章`.padEnd(26) +
      `| ${String(Math.round(mainlineGate)).padStart(10)} | ` +
      `${String(Math.round(min)).padStart(9)} ~ ${String(Math.round(max)).padEnd(9)} | ` +
      `${(min / mainlineGate).toFixed(2)}×`,
  )
}

if (!values.dry) {
  writeBack(final.scales, final.powers)
  console.log('\n  已写回 src/core/config/economy.ts 的 DUNGEON 常量块。')
} else {
  console.log('\n  --dry：未写回 economy.ts。')
}
