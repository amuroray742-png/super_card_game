/**
 * 投放回收表（Phase 10 / §10.4 · §5.8）。
 *
 * 回答两个问题：
 *   1. **产出速度 vs 消耗速度**：每一章的产出，能不能撑住该章的标准养成推进？
 *   2. **存量视角**：主线 310 关首通投放 ÷ 满养成消耗（参考口径，不是闸门）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：**维度整体换了一遍**——
 *   - 经验不再是独立资源 → 改成「**经验书折算的经验总量**」；
 *   - 术式结晶（单一通用材料）→ **五行技能材料**（按英灵五行分列）；
 *   - 遗物强化石（单一通用材料）→ **三档强化石**（按档位分列）；
 *   - 英灵印记退役（升星改扣同名碎片、境界突破改扣银两）→ 新增 **同名碎片** 一维，
 *     境界突破的**银两**并入银两消耗侧；
 *   - 材料的产出源从主线挪到**副本**（主线只掉经验书与银两），
 *     所以材料投放单独成表（【副本材料投放】）。
 *
 * ⚠ **实施修正（roadmap P1-2 难度曲线重标定）**：
 *   旧口径只有第 2 个问题，而且是**存量**比——在挂机游戏里必然失真：
 *   经验的产出主体是**挂机刷取**（每天上千次掷奖），主线 310 次首通只是零头
 *   （实测 4384万 vs 满养成 26.5亿 = 0.02×）。存量口径把零头当成全部产出，
 *   结论必然是「缺口」，而玩家实际并不缺经验。
 *   §5.8 原文就是「产出速度 vs 消耗速度」，本表改为**速度**口径出表，
 *   存量段保留但降级为参考（不再是闸门）。
 *
 * 基准口径：
 *   - 消耗侧（速度）= **标准养成曲线**在该章的消耗：等级 → 星级 / 技能 / 遗物强化，
 *     曲线取 `tools/balance/reference-build.ts`（与难度标定同一把尺，铁律 #4）。
 *   - 产出侧（速度）= 真实挂机回放的奖励包（含主线首通掉落）+ 日常任务 / 周目标，
 *     数据源 `artifacts/baselines/recalibrate.json`（`npm run balance:recalibrate` 产出）。
 *   - 消耗侧（存量）= 1 个英灵满养成（Lv240 / 6★ / 技能满级 / 6 件遗物满强化）
 *     × 6 人编队；经验消耗按英雄计，其余按编队总量计。
 *   - 投放侧（存量）= 主线 310 关全通（含每章 BOSS）的掉落总和，取区间期望值。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  DROP_TABLES,
  LEVEL,
  REALMS,
  SKILL,
  RELIC,
  RELIC_DROP,
  STAR,
  STAGE,
  IDLE,
  DAILY,
  LADDER,
  LADDER_RETURN_REWARDS,
  DUNGEON_DIFFICULTIES,
  DUNGEON_DIFFICULTY_ORDER,
  DUNGEON_DROPS,
  EXP_BOOK,
  GACHA,
  type DungeonDifficultyId,
} from '../../src/core/config/economy.ts'
import { STAGES } from '../../src/core/config/stages.ts'
import { totalExpToReach, starUpCost, expToNext } from '../../src/core/systems/growth.ts'
import { relicTotalCost, relicDropRates, RELIC_SETS } from '../../src/core/systems/relic.ts'
import { referenceGearAt, referenceTeam } from './reference-build.ts'
import { relicExpectedPieces } from './dungeon-loop.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { DAILY_TASKS, WEEKLY_TASKS, type TaskReward } from '../../src/core/config/tasks.ts'
import {
  EXP_BOOK_ITEM_EXP,
  ITEM_BY_ELEMENT,
  type ItemId,
} from '../../src/core/config/items.ts'
import {
  DUNGEON_INDEX,
  DUNGEON_VARIANTS,
  DUNGEON_VARIANT_ORDER,
} from '../../src/core/config/dungeons.ts'
import { resourceName } from '../../src/core/config/resources.ts'
import { computeOfflineEfficiency } from '../../src/core/systems/idle.ts'
import {
  categoryTotal,
  itemsToExp,
  itemName,
} from './item-flow.ts'

// ─────────────────────────── 资源口径（唯一一份） ───────────────────────────
//
// ⚠ 经验书 → 经验的折算与材料分类汇总走 `tools/balance/item-flow.ts`
//   （与 `newplayer.ts` / `recalibrate.ts` 同一把尺，铁律 #4）。

/** 任务奖励 → 折算经验（`TaskReward` 现在只有 `expBooks`） */
function taskRewardExp(rewards: TaskReward): number {
  const books = rewards.expBooks
  if (!books) return 0
  let exp = 0
  if (books.small) exp += books.small * (EXP_BOOK_ITEM_EXP[EXP_BOOK.small.id] ?? 0)
  if (books.large) exp += books.large * (EXP_BOOK_ITEM_EXP[EXP_BOOK.large.id] ?? 0)
  return exp
}

/** 道具表里某个分类的合计（`skillMat` / `relicStone` / `expBook`） */
function sumOfCategory(items: Record<string, number>, category: string): number {
  return categoryTotal(items as Partial<Record<ItemId, number>>, category as 'skillMat')
}

/** 五行技能材料的道具 id 列表（按 `ITEM_BY_ELEMENT` 的口径，不硬编码） */
const SKILL_MAT_IDS: ItemId[] = Object.values(ITEM_BY_ELEMENT)
/** 三档强化石的道具 id 列表（按 `RELIC.STONE_TIERS` 的口径） */
const RELIC_STONE_IDS: ItemId[] = RELIC.STONE_TIERS.map((tier) => tier.id as ItemId)

interface Expected {
  silver: number
  /** 堆叠道具（道具 id → 数量） */
  items: Record<string, number>
  /** 经验（经验书折算） */
  exp: number
  /** 遗物掉落按稀有度计 */
  relics: Record<string, number>
}

function mid([lo, hi]: readonly [number, number]): number {
  return (lo + hi) / 2
}

function emptyExpected(): Expected {
  return {
    silver: 0,
    items: {},
    exp: 0,
    relics: { N: 0, R: 0, SR: 0, SSR: 0 },
  }
}

/** 单张掉落表的期望产出 */
function expectedOfTable(tableKey: string): Expected {
  const t = DROP_TABLES[tableKey]
  const out = emptyExpected()
  out.silver = mid(t.silver)
  // ⚠ 堆叠道具：各自独立掷概率（概率 × 数量中值 = 期望产量），口径同 `systems/idle.ts`
  for (const drop of t.items) {
    const count = (drop.min + drop.max) / 2
    out.items[drop.id] = (out.items[drop.id] ?? 0) + (drop.chance / 100) * count
  }
  out.exp = itemsToExp(out.items as Partial<Record<ItemId, number>>)
  // ⚠ **遗物副本 v12**：掉落表里**没有**遗物——遗物只从**遗物副本**产出。
  //   它的供给单独核算（见 `relicSupplyFromDungeon`）——
  //   遗物既不在主线掉落表里，就不能在这里按掉落概率统计。
  return out
}

/**
 * **遗物本体的供给**（存档 v12：遗物**只**来自遗物副本）。
 *
 * ⚠ 遗物**不再从掉落表出**，也不再「花银两祈愿」⇒ 供给与银两收入**脱钩**：
 *   供给 = **每日额度 × 天数**（挂机通道）+ **手动挑战场次 × 每场件数**。
 *
 * ⚠ 这条口径必须与游戏一致（铁律 #4）：
 *   - 每日额度取 `RELIC_DROP.DAILY_CAP`（防通胀闸门）；
 *   - 每场件数取 `RELIC_DROP.COUNT`；
 *   - 稀有度分布取 `relicDropRates()`（**公示 = 实际**的唯一一份口径），
 *     **不在工具里另写一份权重表**。
 *
 * ⚠ 「手动挑战场次」与「天数」都是**模拟口径**的输入：
 *   天数用工具已有的模拟天数（节奏基线的 `chapterDays` 之和），
 *   手动场次用模拟里玩家每天的手动遗物副本挑战数（基线的 `relicRunsPerDay`）。
 *   ⚠ 禁止用 `Date.now()` 推「今天第几天」——那会让同一份报告两次跑出两个数。
 */
function relicSupplyFromDungeon(
  days: number,
  manualRunsPerDay: number,
  difficulty: DungeonDifficultyId,
): {
  count: number
  byRarity: Record<string, number>
} {
  // ① 挂机通道：每日额度（件/天）× 天数
  const idleCount = days * RELIC_DROP.DAILY_CAP
  // ② 手动挑战：每场期望件数（`RELIC_DROP.COUNT` 的中值）× 场次
  //    ⚠ 手动挑战**不受**每日额度约束（主动行为，逐场结算）。
  const perRun = (RELIC_DROP.COUNT[difficulty].min + RELIC_DROP.COUNT[difficulty].max) / 2
  const manualCount = days * manualRunsPerDay * perRun
  const count = idleCount + manualCount
  // ③ 稀有度分布：取 core 的公示口径（`relicDropRates`）
  const byRarity: Record<string, number> = {}
  for (const rate of relicDropRates(difficulty)) {
    byRarity[rate.rarity] = count * rate.percent
  }
  return { count, byRarity }
}

function addInto(target: Expected, src: Expected, times: number): void {
  target.silver += src.silver * times
  for (const [id, count] of Object.entries(src.items)) {
    target.items[id] = (target.items[id] ?? 0) + count * times
  }
  target.exp += src.exp * times
  for (const k of Object.keys(target.relics)) {
    target.relics[k] += src.relics[k] * times
  }
}

interface PaceBaseline {
  scaleAnchors: number[]
  chapterDays: number[]
  /**
   * 模拟里玩家**每天手动挑战遗物副本的场次**（存档 v12 起遗物只来自副本）。
   *
   * ⚠ 旧基线里的同名键 `relicsPerDay` 是「每天祈愿遗物件数」——
   *   祈愿已下线，量纲一致（件/天 ≈ 场/天），读的时候兼容一下，
   *   但**新写的基线用 `relicRunsPerDay`**（口径写在 `recalibrate.ts` 里）。
   */
  relicRunsPerDay?: number
  /** @deprecated 旧基线键（每天祈愿遗物件数）；见 `relicRunsPerDay` */
  relicsPerDay?: number
  velocity: Array<{ chapter: number; days: number; produced: PaceFlow; spent: PaceFlow }>
}

const PACE_PATH = resolve(process.cwd(), 'artifacts/baselines/recalibrate.json')

function readPaceBaseline(): PaceBaseline | null {
  if (!existsSync(PACE_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(PACE_PATH, 'utf8')) as PaceBaseline
    return Array.isArray(parsed.velocity) && parsed.velocity.length > 0 ? parsed : null
  } catch {
    return null
  }
}

/**
 * 基线里的锚点是否与当前配置一致（不一致 ⇒ 基线过期，数字不可用）。
 */
function paceIsFresh(baseline: PaceBaseline): boolean {
  if (!Array.isArray(baseline.scaleAnchors)) return false
  if (baseline.scaleAnchors.length !== STAGE.SCALE_ANCHORS.length) return false
  return baseline.scaleAnchors.every(
    (v, i) => Math.abs(v - STAGE.SCALE_ANCHORS[i]) <= Math.max(1e-3, STAGE.SCALE_ANCHORS[i] * 1e-3),
  )
}

/**
 * 基线的**维度**是否与当前模型一致。
 *
 * ⚠ v9 → v10 换了资源维度（exp / silver / skillMats / relicStones / shards），
 *   旧基线读出来全是 undefined —— 必须认出来并提示重跑，而不是打出一排 NaN。
 */
const PACE_FLOW_KEYS = ['silver', 'exp', 'skillMats', 'relicStones', 'shards'] as const

function paceHasCurrentShape(baseline: PaceBaseline): boolean {
  const row = baseline.velocity[0]
  if (!row) return false
  const produced = row.produced as unknown as Record<string, unknown> | undefined
  if (!produced || typeof produced !== 'object') return false
  return PACE_FLOW_KEYS.every((key) => typeof produced[key] === 'number')
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

/** 单个英灵 1★ → 6★ 所需同名碎片 */
let shardsPerHero = 0
for (let star = STAR.MIN; star < STAR.MAX; star++) {
  const cost = starUpCost(star)
  if (!cost) continue
  shardsPerHero += cost.shards
}

/**
 * 单个英灵三次境界突破（凡阶 → 名阶 → 圣阶 → 神阶）所需**银两**。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：突破消耗品从「英灵印记」改为**银两**
 *   （印记已随钱包收敛退役）——所以这部分银两并入银两消耗侧，
 *   印记这一维整个消失，由**同名碎片**接手升星。
 */
let breakSilverPerHero = 0
for (const realm of REALMS) {
  if (!realm.breakCost) continue
  breakSilverPerHero += realm.breakCost.silver
}

/** 单个英灵 3 个技能升满（1 → 20 级） */
const skillLevelsPerHero = SKILL.MAX_LEVEL - SKILL.MIN_LEVEL
const skillMaterialPerHero = skillLevelsPerHero * SKILL.MATERIAL_PER_LEVEL
const skillSilverPerHero = skillLevelsPerHero * SKILL.SILVER_PER_LEVEL

/**
 * 五行技能材料的消耗：**按参考队伍的五行构成**分列。
 *
 * ⚠ 口径唯一：`tools/balance/reference-build.ts` 的参考队伍
 *   （= 难度标定用的那支队伍），元素分布也从它取，不另立一份名单。
 */
const referenceRoster = referenceTeam(LEVEL.MAX)
const skillMatPerElement: Record<string, number> = {}
for (const member of referenceRoster) {
  const id = ITEM_BY_ELEMENT[member.def.element]
  skillMatPerElement[id] = (skillMatPerElement[id] ?? 0) + skillMaterialPerHero
}

/** 单件遗物 1 → RELIC.MAX_LEVEL 的累计投入（银两 + 三档强化石） */
const relicMaxCost = relicTotalCost(RELIC.MAX_LEVEL)
const relicSilverTotal = relicMaxCost.silver * RELIC_SLOTS * TEAM_SIZE
const relicStonesTotal: Record<string, number> = {}
for (const [id, count] of Object.entries(relicMaxCost.stones)) {
  relicStonesTotal[id] = (count ?? 0) * RELIC_SLOTS * TEAM_SIZE
}

const relicsInTeam = TEAM_SIZE * RELIC_SLOTS

const cost = {
  exp: expPerHero * TEAM_SIZE,
  silver: skillSilverPerHero * TEAM_SIZE + relicSilverTotal + breakSilverPerHero * TEAM_SIZE,
  /** 五行技能材料（道具 id → 数量） */
  skillMats: skillMatPerElement,
  /** 三档强化石（道具 id → 数量） */
  relicStones: relicStonesTotal,
  /** 同名英灵碎片 */
  shards: shardsPerHero * TEAM_SIZE,
}

/** 一次升星消耗的同名碎片（= `STAR.SHARDS_PER_STAR`） */
const shardsPerStar = STAR.SHARDS_PER_STAR

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

console.log('\n【逐章投放期望】（主线 310 关）\n')
console.log(
  '  章节        银两        经验    五行技能材料   三档强化石',
)
console.log('  ' + '-'.repeat(62))
/**
 * ⚠ **遗物那一列没有了**（存档 v12）：遗物不再从掉落表出，也不再「花银两祈愿」，
 *   它的供给与**章节银两无关**（只取决于「天数 × 每日额度」+「手动挑战场次」）。
 *   ⇒ 逐章表里放一个「按银两折算」的列就是**误导**（会让人以为遗物产出跟着章节走）。
 *   遗物的供给口径见下面的【遗物副本投放】。
 */
for (let i = 0; i < perChapter.length; i++) {
  const a = perChapter[i]
  console.log(
    `  第${String(i + 1).padStart(2)}章  ` +
      `${fmt(a.silver).padStart(10)} ${fmt(a.exp).padStart(10)} ` +
      `${fmt(sumOfCategory(a.items, 'skillMat')).padStart(12)} ` +
      `${fmt(sumOfCategory(a.items, 'relicStone')).padStart(10)}`,
  )
}
console.log('  ' + '-'.repeat(62))
console.log(
  `  主线合计  ` +
    `${fmt(mainline.silver).padStart(10)} ${fmt(mainline.exp).padStart(10)} ` +
    `${fmt(sumOfCategory(mainline.items, 'skillMat')).padStart(12)} ` +
    `${fmt(sumOfCategory(mainline.items, 'relicStone')).padStart(10)}`,
)
console.log(
  '\n  注：主线**只掉经验书与银两**——五行技能材料与三档强化石是**副本专属产出**'
    + '（设计稿 §3），所以上面两列恒为 0；材料的投放见下表。\n'
    + '  遗物**不再从掉落表出**（遗物副本 v12）：遗物**只**来自**遗物副本**，'
    + '供给与主线银两脱钩，口径见【遗物副本投放】。',
)

// ─────────────────────────── 3.5 副本材料投放 ───────────────────────────
//
// ⚠ 为什么单独成表：材料的供给源是**副本**，不是主线关卡。
//   「投放 ÷ 消耗」在主线上算不出材料那一行（分子恒为 0），
//   所以这里换成两个同样可核对的数：
//     · 每胜产量（难度倍率 × 基准产量）→ 一次副本能换几次养成动作；
//     · 养满 6 人编队需要刷多少场副本。

console.log('\n【副本材料投放】（材料的唯一来源）\n')
console.log(
  '  副本'.padEnd(18) + '产出道具'.padEnd(14) + '简易/胜'.padStart(9) +
    '普通/胜'.padStart(9) + '困难/胜'.padStart(9) +
    '满养成消耗'.padStart(12) + '养满需刷'.padStart(12),
)
console.log('  ' + '-'.repeat(88))
for (const variant of DUNGEON_VARIANTS) {
  // ⚠ **遗物副本不在本表**（存档 v12）：遗物是**实例**，产出形状与堆叠材料不同
  //   （没有「每胜产量 × 难度倍率」这回事），它单列一张表（见下）。
  if (variant.kind === 'relic') continue
  if (!variant.itemId) continue
  const base = DUNGEON_DROPS[variant.itemId] ?? { min: 1, max: 1 }
  const midBase = (base.min + base.max) / 2
  const byDifficulty = DUNGEON_DIFFICULTIES.map((d) => midBase * d.dropMul)
  const need =
    variant.kind === 'skill'
      ? (cost.skillMats[variant.itemId] ?? 0)
      : (cost.relicStones[variant.itemId] ?? 0)
  const normalYield = byDifficulty[1] ?? midBase
  console.log(
    `  ${variant.name.padEnd(16)}${itemName(variant.itemId).padEnd(12)}` +
      byDifficulty.map((v) => fmt(v).padStart(7)).join('  ') +
      `${fmt(need).padStart(12)}` +
      (need > 0 ? `${fmt(need / normalYield).padStart(10)} 场` : `${'—'.padStart(13)}`),
  )
}
console.log(
  '\n  注：每胜产量 = 基准产量区间中值 × 难度倍率（`DUNGEON_DROPS` × `DUNGEON_DIFFICULTIES`）；'
    + '\n      「养满需刷」= 满养成消耗 ÷ 普通难度每胜产量（难度取「普通」是因为它是默认档）；'
    + '\n      消耗为「—」= 参考队伍里没有该五行的英灵 / 该档石根本用不到（材料用不到 ⇒ 不用刷）。',
)

// ─────────────────────────── 3.6 遗物副本投放 ───────────────────────────
//
// ⚠ 遗物是**实例**（不是堆叠物）⇒ 供给口径与材料完全不同：
//   · 挂机通道：受**每日额度**约束（`RELIC_DROP.DAILY_CAP`，防通胀闸门）；
//   · 手动挑战：不受额度约束（逐场结算，耗时换产出）；
//   · 稀有度分布：取 core 的**公示口径** `relicDropRates()`（公示 = 实际）。
//
// ⚠ **变体遍历走 `DUNGEON_VARIANT_ORDER`**（铁律 #3：禁止硬编码变体 id 列表）——
//   顺序表也是锚点表的顺序，两处必须一致。
console.log('\n【遗物副本投放】（遗物本体的唯一来源 · 存档 v12）\n')
console.log(
  '  副本'.padEnd(18) + '套装'.padEnd(24) + '解锁线'.padStart(8) +
    '简易/胜'.padStart(9) + '普通/胜'.padStart(9) + '困难/胜'.padStart(9),
)
console.log('  ' + '-'.repeat(77))
for (const variantId of DUNGEON_VARIANT_ORDER) {
  const variant = DUNGEON_INDEX.get(variantId)
  if (!variant || variant.kind !== 'relic') continue
  const setNames = (variant.relicSetIds ?? [])
    .map((setId) => RELIC_SETS.get(setId)?.name ?? setId)
    .join(' + ')
  const unlock = RELIC_DROP.UNLOCK_STAGE[variant.id] ?? 0
  const pieces = DUNGEON_DIFFICULTIES.map(
    (d) => (RELIC_DROP.COUNT[d.id].min + RELIC_DROP.COUNT[d.id].max) / 2,
  )
  console.log(
    `  ${variant.name.padEnd(16)}${setNames.padEnd(22)}` +
      `${String(unlock).padStart(8)}` +
      // ⚠ 件数是**区间中值**（普通档 1~2 ⇒ 1.5）⇒ 保留一位小数，别用整数格式化
      pieces.map((v) => v.toFixed(1).padStart(7)).join('  '),
  )
}
console.log(
  `  每日挂机额度：${RELIC_DROP.DAILY_CAP} 件/天（防通胀闸门；手动挑战不受限）`,
)
console.log(
  `  SSR 保底：连续 ${RELIC_DROP.PITY_SSR} 件未出 SSR ⇒ 第 ${RELIC_DROP.PITY_SSR + 1} 件必出 SSR（按件计）`,
)
for (const difficulty of DUNGEON_DIFFICULTIES) {
  const rates = relicDropRates(difficulty.id)
  console.log(
    `  稀有度（${difficulty.name}档 · 公示口径）：` +
      rates.map((r) => `${r.rarity} ${(r.percent * 100).toFixed(2)}%`).join(' · '),
  )
}

console.log('\n【满养成消耗】基准 = 6 人编队（Lv240 / 6★ / 技能满级 / 6 件遗物满强化）\n')
console.log(`  经验        ${fmt(cost.exp).padStart(12)}   （单人 ${fmt(expPerHero)} × ${TEAM_SIZE}）`)
console.log(
  `  银两        ${fmt(cost.silver).padStart(12)}   （技能 ${fmt(skillSilverPerHero * TEAM_SIZE)}` +
    ` + 遗物 ${fmt(relicSilverTotal)} + 境界突破 ${fmt(breakSilverPerHero * TEAM_SIZE)}）`,
)
console.log(
  `  同名碎片    ${fmt(cost.shards).padStart(12)}   （单人 ${shardsPerHero} × ${TEAM_SIZE} = 1★→6★ 共 ${STAR.MAX - STAR.MIN} 颗）`,
)
console.log('  五行技能材料（按参考队伍的五行构成分列）：')
for (const id of SKILL_MAT_IDS) {
  const need = cost.skillMats[id] ?? 0
  const heroes = referenceRoster.filter((m) => ITEM_BY_ELEMENT[m.def.element] === id).length
  console.log(
    `    ${itemName(id).padEnd(12)}${fmt(need).padStart(10)}   ` +
      `（参考队伍 ${heroes} 名该五行英灵 × 单人 ${skillMaterialPerHero}）`,
  )
}
console.log('  三档强化石（遗物 Lv1 → Lv' + RELIC.MAX_LEVEL + ' 的逐档累计）：')
for (const id of RELIC_STONE_IDS) {
  const need = cost.relicStones[id] ?? 0
  console.log(`    ${itemName(id).padEnd(12)}${fmt(need).padStart(10)}   （单件 ${fmt(relicMaxCost.stones[id] ?? 0)} × ${relicsInTeam} 件）`)
}

console.log('\n【存量视角 · 参考口径】主线 310 关首通投放 ÷ 满养成消耗\n')
console.log(
  '  ⚠ 这一段是**存量**比（打完主线累计能养出多少满养成），不是健康度闸门——\n' +
    '    挂机游戏里经验的产出主体是每天上千次挂机掷奖，主线首通只是零头，\n' +
    '    所以这一段的「经验 0.02×」不代表玩家缺经验。闸门看下面的【速度口径】。\n' +
    '  ⚠ 银两那一行看着极小，是因为「遗物满强化」取的是**护栏上限 Lv200**：\n' +
    '    淬炼段价格按 1.1^级 指数上升，满级累计投入是天文数字，而玩家 40 天主线\n' +
    '    只推到 Lv150~170（护栏本意就是「碰不到」）。标准曲线口径见【速度口径】。\n',
)
console.log('  资源            投放          消耗        回收倍数   判定')
console.log('  ' + '-'.repeat(66))
const rows: Array<[string, number, number]> = [
  ['经验', mainline.exp, cost.exp],
  [resourceName('silver'), mainline.silver, cost.silver],
]
for (const [name, supply, need] of rows) {
  const r = need > 0 ? supply / need : Infinity
  const ok = r >= 1
  console.log(
    `  ${name.padEnd(12)} ${fmt(supply).padStart(10)} ${fmt(need).padStart(12)} ` +
      `${ratio(supply, need).padStart(10)}   ${ok ? '✓' : '· 低于 1（见速度口径）'}`,
  )
}

/**
 * 遗物本体供给（**遗物副本口径**：存档 v12 起遗物只来自遗物副本）。
 *
 * ⚠ 分子不再是「主线银两收入能换几件」——遗物与银两**脱钩**了：
 *   供给 = **每日额度 × 天数**（挂机通道）+ **手动挑战场次 × 每场件数**。
 *
 * ⚠ 「天数」用工具已有的**模拟天数**（节奏基线的 `chapterDays` 之和）；
 *   没有基线时退回**首周 7 天**（本表下面「加上首周日常投放」那一节用的就是它）。
 *   ⚠ 绝不用 `Date.now()` 推「今天第几天」——同一份报告两次跑会出两个数。
 */
const paceBaseline = readPaceBaseline()
const simulatedDays = paceBaseline
  ? paceBaseline.chapterDays.reduce((sum, d) => sum + d, 0)
  : DAILY.SIGN_IN_CYCLE
/** 每天手动挑战遗物副本的场次（模拟口径；来自基线，没有基线时按 0 场算） */
const manualRelicRunsPerDay =
  paceBaseline?.relicRunsPerDay ?? paceBaseline?.relicsPerDay ?? 0
/** 手动挑战按**普通档**计（难度顺序表的第 2 项；三档的稀有度权重相同） */
const relicReferenceDifficulty: DungeonDifficultyId = DUNGEON_DIFFICULTY_ORDER[1]

const relicSupplyDetail = relicSupplyFromDungeon(
  simulatedDays,
  manualRelicRunsPerDay,
  relicReferenceDifficulty,
)
const relicSupply = relicSupplyDetail.count
console.log(
  `  ${'遗物本体'.padEnd(12)} ${relicSupply.toFixed(0).padStart(10)} ${String(relicsInTeam).padStart(12)} ` +
    `${ratio(relicSupply, relicsInTeam).padStart(10)}   ${relicSupply >= relicsInTeam ? '✓' : '· 低于 1（见速度口径）'}`,
)

console.log(
  `\n  注：遗物本体来自**遗物副本**（存档 v12）：供给 = 每日额度 ${RELIC_DROP.DAILY_CAP} 件/天 × ${simulatedDays} 天`
    + ` + 手动挑战 ${manualRelicRunsPerDay} 场/天 × 每场件数。`
    + `实际可用性需按稀有度折算（可得的 SSR 遗物约 ${(relicSupplyDetail.byRarity.SSR ?? 0).toFixed(0)} 件）。`,
)
if (!paceBaseline) {
  console.log(
    '  ⚠ 缺少节奏基线 artifacts/baselines/recalibrate.json —— 天数按首周 7 天计，'
      + '手动场次按 0 场计（先跑 `npm run balance:recalibrate` 重采）。',
  )
}

// ── 非主线产出的三个维度：供给源不在主线，单独给「单次供给 vs 单次消耗」 ──
//
// ⚠ 五行技能材料 / 三档强化石的供给在**副本**，同名碎片的供给在**抽卡重复转化**，
//   都不在「主线 310 关首通」里——硬塞进上面的存量表会得到误导性的 0.00×。

console.log('\n【非主线产出维度】单次供给 ÷ 单次养成消耗\n')
console.log('  维度'.padEnd(22) + '供给来源'.padEnd(26) + '单次供给'.padStart(12) + '单次消耗'.padStart(10) + '倍数'.padStart(9))
console.log('  ' + '-'.repeat(82))
const normalMul = DUNGEON_DIFFICULTIES.find((d) => d.id === 'normal')?.dropMul ?? 1
for (const id of SKILL_MAT_IDS) {
  const base = DUNGEON_DROPS[id]
  if (!base) continue
  const yieldPer = ((base.min + base.max) / 2) * normalMul
  console.log(
    `  ${itemName(id).padEnd(20)}` +
      `${'技能副本（普通难度）'.padEnd(24)}` +
      `${fmt(yieldPer).padStart(10)} 个${String(SKILL.MATERIAL_PER_LEVEL).padStart(8)} 个` +
      `${ratio(yieldPer, SKILL.MATERIAL_PER_LEVEL).padStart(9)}`,
  )
}
for (const id of RELIC_STONE_IDS) {
  const base = DUNGEON_DROPS[id]
  if (!base) continue
  const yieldPer = ((base.min + base.max) / 2) * normalMul
  console.log(
    `  ${itemName(id).padEnd(20)}` +
      `${'强化副本（普通难度）'.padEnd(24)}` +
      `${fmt(yieldPer).padStart(10)} 个${String(RELIC.STONES_PER_LEVEL).padStart(8)} 个` +
      `${ratio(yieldPer, RELIC.STONES_PER_LEVEL).padStart(9)}`,
  )
}
for (const rarity of ['SSR', 'SR', 'R', 'N'] as const) {
  const per = GACHA.DUPLICATE_SHARDS[rarity]
  console.log(
    `  ${`同名碎片（${rarity} 重复）`.padEnd(20)}` +
      `${'抽卡重复转化'.padEnd(24)}` +
      `${fmt(per).padStart(10)} 个${String(shardsPerStar).padStart(8)} 个` +
      `${ratio(per, shardsPerStar).padStart(9)}`,
  )
}
{
  // ⚠ **遗物本体**（存档 v12）：供给源 = 遗物副本（不是祈愿）。
  //   「单次消耗」= 填满**一个遗物槽位**（1 件）——
  //   遗物是实例，件数就是消耗单位（不能像材料那样折算成「几次养成动作」的倍数）。
  const piecesPerWin = relicExpectedPieces(relicReferenceDifficulty)
  console.log(
    `  ${'遗物本体（实例）'.padEnd(20)}` +
      `${'遗物副本（普通难度）'.padEnd(24)}` +
      `${piecesPerWin.toFixed(1).padStart(10)} 件${'1'.padStart(8)} 件` +
      `${ratio(piecesPerWin, 1).padStart(9)}`,
  )
}
console.log(
  '\n  注：技能材料 / 强化石的「单次消耗」= 升 1 级技能 / 强化 1 级遗物（标准段）；'
    + '\n      同名碎片的「单次消耗」= 升 1 星；遗物的「单次消耗」= 填 1 个槽位。'
    + '倍数 = 一场副本（或一次重复抽卡）能换几次养成动作。',
)

console.log('\n【英灵阵容参考】SSR / SR / R / N 数量')
const counts = HEROES.reduce<Record<string, number>>((acc, h) => {
  acc[h.rarity] = (acc[h.rarity] ?? 0) + 1
  return acc
}, {})
console.log(
  `  SSR ${counts.SSR ?? 0} · SR ${counts.SR ?? 0} · R ${counts.R ?? 0} · N ${counts.N ?? 0} · 合计 ${HEROES.length}`,
)

// ─────────────────────────── 4. 日常投放（签到 + 任务） ───────────────────────────
//
// roadmap P2-1 的验收要求：任务奖励「没有冲击抽卡间隔、养成资源回收或竞技产出隔离」。
// 这里把日常投放摊开算，三条红线各自对应一个**可核对的数字**：
//
//   1. 抽卡间隔：日常投放里的圣杯结晶**只有签到**有，任务奖励为 0；
//   2. 养成回收：任务日投放 ≤ 每日挂机经验产出的 1/3（见 validate-config 的同一把尺）；
//   3. 竞技隔离：任务奖励不含任何竞技资源（竞技勋章 / 竞技材料 / 竞技兑换券）。
//
// ⚠ **实施修正（资源/背包版本 v10）**：任务 / 周目标改发**通用经验书**
//   （折算成经验计入）；术式结晶 / 遗物强化石退役，抽卡券退役。

interface DailySupply {
  /** 折算经验（经验书 → 经验） */
  exp: number
  silver: number
  crystals: number
}

const zeroSupply = (): DailySupply => ({ exp: 0, silver: 0, crystals: 0 })

/** 签到：一轮 7 天的奖励总和 */
const signInSupply = zeroSupply()
for (const reward of DAILY.SIGN_IN_REWARDS) {
  signInSupply.exp += itemsToExp(reward.items)
  signInSupply.silver += reward.silver ?? 0
  signInSupply.crystals += reward.crystals ?? 0
}

/** 每日任务：全部领完的量 */
const dailyTaskSupply = zeroSupply()
for (const task of DAILY_TASKS) {
  dailyTaskSupply.exp += taskRewardExp(task.rewards)
}

/** 周目标：一周的量（摊到每天 = ÷7） */
const weeklyTaskSupply = zeroSupply()
for (const task of WEEKLY_TASKS) {
  weeklyTaskSupply.exp += taskRewardExp(task.rewards)
}

/** 每小时挂机产出（第 1 章期望 × 每小时掷奖次数）——任务预算的分母 */
const rollsPerHour = Math.round(3600 / IDLE.SECONDS_PER_ROLL)
const stage1 = DROP_TABLES.stage_1
/** 第 1 章每次掷奖的期望经验（经验书折算） */
const stage1ExpPerRoll = (() => {
  let exp = 0
  for (const drop of stage1.items) {
    const bookExp = EXP_BOOK_ITEM_EXP[drop.id]
    if (!bookExp) continue
    exp += (drop.chance / 100) * ((drop.min + drop.max) / 2) * bookExp
  }
  return exp
})()
const hourlyIncomeExp = stage1ExpPerRoll * rollsPerHour
/**
 * 每日挂机经验产出 = core 的离线效率曲线 f(24h) × 次数/小时 × 每次期望经验。
 *
 * ⚠ **口径与 `tools/validate-config.ts` 同一把尺**：任务是「每天」的流量，
 *   分母用「一天」的挂机产出（照搬旧的「一小时」会把尺度差一个数量级）。
 */
const dailyIdleExp = computeOfflineEfficiency(24 * 3600) * hourlyIncomeExp

const taskPerDay = {
  exp: dailyTaskSupply.exp + weeklyTaskSupply.exp / 7,
}

console.log('\n【日常投放】签到 + 每日任务 + 周目标（任务表：core/config/tasks.ts）\n')
console.log(
  '  来源'.padEnd(18) + '经验'.padStart(12) + resourceName('silver').padStart(12) +
    resourceName('crystals').padStart(12),
)
console.log('  ' + '-'.repeat(56))
console.log(
  `  ${'签到（7 天一轮）'.padEnd(16)}${fmt(signInSupply.exp).padStart(12)}` +
    `${fmt(signInSupply.silver).padStart(12)}${fmt(signInSupply.crystals).padStart(12)}`,
)
console.log(
  `  ${'每日任务（全领）'.padEnd(16)}${fmt(dailyTaskSupply.exp).padStart(12)}` +
    `${fmt(0).padStart(12)}${fmt(0).padStart(12)}`,
)
console.log(
  `  ${'周目标（一周）'.padEnd(16)}${fmt(weeklyTaskSupply.exp).padStart(12)}` +
    `${fmt(0).padStart(12)}${fmt(0).padStart(12)}`,
)
console.log(
  `  ${'任务日投放'.padEnd(16)}${fmt(taskPerDay.exp).padStart(12)}` +
    `${fmt(0).padStart(12)}${fmt(0).padStart(12)}`,
)
console.log(
  `\n  每小时挂机产出（第 1 章 × ${rollsPerHour} 次）：经验 ${fmt(hourlyIncomeExp)}`
    + `（每次 ${stage1ExpPerRoll.toFixed(0)}）`,
)
console.log(
  `  每日挂机经验产出（core 的离线效率曲线 f(24h)）：${fmt(dailyIdleExp)}`,
)
console.log(
  `  任务日投放占比（分母是**每日**的挂机经验产出，与 validate-config 同一把尺）：`
    + `${((taskPerDay.exp / dailyIdleExp) * 100).toFixed(2)}%`,
)
console.log(
  '  红线核对：任务奖励里的圣杯结晶 = 0（抽卡节奏仍只由签到决定）；'
    + '竞技资源 = 0（竞技产出隔离不变）；副本材料 = 0（副本专属产出不被日常稀释）',
)

console.log('\n【加上首周（7 天）日常投放后的回收倍数】\n')
console.log('  资源            主线投放   日常投放    满养成消耗   回收倍数(前)   回收倍数(后)')
console.log('  ' + '-'.repeat(72))
const dailyRows: Array<[string, number, number, number]> = [
  ['经验', mainline.exp, taskPerDay.exp * 7, cost.exp],
]
for (const [name, supply, daily, need] of dailyRows) {
  console.log(
    `  ${name.padEnd(12)} ${fmt(supply).padStart(10)} ${fmt(daily).padStart(9)} ${fmt(need).padStart(12)}` +
      ` ${ratio(supply, need).padStart(12)} ${ratio(supply + daily, need).padStart(13)}`,
  )
}
console.log(
  '\n  注：日常投放按**首周 7 天**计（主线投放是一次性的，日常投放每天都有）；'
    + '天数为 D 时，「回收倍数(后)」随 D 线性上升。',
)

// ─────────────────────────── 5. 速度口径（§5.8 · 闸门口径）───────────────────────────
//
// ⚠ 为什么要改口径：旧表只有「主线 310 关首通投放 ÷ 满养成消耗」的**存量**比。
//   挂机游戏里经验的产出主体是**挂机刷取**（每天上千次掷奖），主线首通只是零头，
//   存量口径把零头当全部产出 → 结论必然是「缺口」，而玩家实际并不缺经验。
//   §5.8 原文就是「产出速度 vs 消耗速度」，本节按速度口径出表。
//
//   · 产出速度 = 真实挂机回放的奖励包（含主线首通掉落）+ 日常任务 / 周目标 / 签到
//       —— 数据源 artifacts/baselines/recalibrate.json（`npm run balance:recalibrate` 产出）
//   · 消耗速度 = **标准养成曲线**在该章的消耗（等级 → 星级 / 技能 / 遗物强化）
//       —— 曲线取 tools/balance/reference-build.ts（与难度标定同一把尺，铁律 #4）
//   · 回收比 = 产出速度 ÷ 消耗速度，≥1 ⇒ 该章产出足以支撑标准养成推进

interface PaceFlow {
  silver: number
  /** 经验（经验书折算） */
  exp: number
  /** 五行技能材料合计 */
  skillMats: number
  /** 三档强化石合计 */
  relicStones: number
  /** 同名英灵碎片 */
  shards: number
  relics: number
}

interface StandardCost {
  exp: number
  silver: number
  /** 五行技能材料合计 */
  skillMats: number
  /** 三档强化石合计 */
  relicStones: number
  /** 同名英灵碎片 */
  shards: number
}

/** 每个英灵的技能数（createHeroState 建 3 条） */
const SKILL_COUNT = 3

/**
 * 标准养成曲线在某段等级区间内的消耗（6 人编队）。
 *
 * ⚠ 消耗全部由**配置**推出（`expToNext` / `referenceGearAt` / `starUpCost` /
 *   `REALMS[].breakCost`），不在这里复算任何扣费口径（铁律 #4）。
 */
function standardCost(fromLevel: number, toLevel: number): StandardCost {
  let exp = 0
  for (let l = fromLevel; l < toLevel; l++) exp += expToNext(l)
  exp *= TEAM_SIZE

  const [starFrom, skillFrom, relicFrom] = referenceGearAt(fromLevel)
  const [starTo, skillTo, relicTo] = referenceGearAt(toLevel)

  // 升星：只扣同名碎片
  const shards = Math.max(0, starTo - starFrom) * (starUpCost(starFrom)?.shards ?? 0) * TEAM_SIZE
  // 境界突破：改扣**银两**（等级跨过该境界起点的那一章计入）
  let breakSilver = 0
  for (const realm of REALMS) {
    if (!realm.breakCost) continue
    if (realm.minLevel > fromLevel && realm.minLevel <= toLevel) {
      breakSilver += realm.breakCost.silver * TEAM_SIZE
    }
  }

  const skillLevels = Math.max(0, skillTo - skillFrom)

  // ⚠ 遗物强化成本随等级指数上升 ⇒ 标准消耗必须走 core 的**累计投入**，
  //   不能写「单级价格 × 级数」（铁律 #4：扣费口径只有一份）。
  const relicCost = relicTotalCost(relicTo)
  const relicCostFrom = relicTotalCost(relicFrom)
  let relicStones = 0
  for (const id of RELIC_STONE_IDS) {
    relicStones += ((relicCost.stones[id] ?? 0) - (relicCostFrom.stones[id] ?? 0)) * RELIC_SLOTS * TEAM_SIZE
  }

  return {
    exp,
    silver:
      skillLevels * SKILL_COUNT * SKILL.SILVER_PER_LEVEL * TEAM_SIZE +
      (relicCost.silver - relicCostFrom.silver) * RELIC_SLOTS * TEAM_SIZE +
      breakSilver,
    skillMats: skillLevels * SKILL_COUNT * SKILL.MATERIAL_PER_LEVEL * TEAM_SIZE,
    relicStones,
    shards,
  }
}

/** 设计阶梯：每章 BOSS 的目标等级（= LEVEL.MAX / CHAPTERS × 章序） */
const LEVELS_PER_CHAPTER = LEVEL.MAX / STAGE.CHAPTERS
const designLevel = (chapter: number): number => chapter * LEVELS_PER_CHAPTER

/** 日常日均投放（签到摊到每天 + 任务日投放） */
const dailySupply = {
  exp: taskPerDay.exp + signInSupply.exp / DAILY.SIGN_IN_CYCLE,
  silver: signInSupply.silver / DAILY.SIGN_IN_CYCLE,
}

console.log('\n【速度口径】产出速度 vs 消耗速度（§5.8 · 逐章 · 闸门口径）\n')
console.log(
  '  产出 = 真实挂机回放的奖励包（含主线首通掉落）+ 日常投放；消耗 = 标准养成曲线在该章的消耗。\n' +
    '  数据源：artifacts/baselines/recalibrate.json（npm run balance:recalibrate 产出）\n',
)

const pace = readPaceBaseline()
if (!pace) {
  console.log('  ⚠ 缺少节奏基线 artifacts/baselines/recalibrate.json —— 先跑 `npm run balance:recalibrate`。\n')
} else if (!paceHasCurrentShape(pace)) {
  console.log(
    '  ⚠ 节奏基线的**资源维度已过期**（还是资源/背包版本 v10 之前的口径：'
      + 'exp / skillStones / relicStones / emblems）—— 先跑 `npm run balance:recalibrate` 重采。\n',
  )
} else if (!paceIsFresh(pace)) {
  console.log(
    '  ⚠ 节奏基线**已过期**（锚点与当前配置不一致）—— 先跑 `npm run balance:recalibrate` 重采。\n',
  )
} else {
  console.log(
    '  章 | 天数 | 经验 产出/消耗        比 | 银两 产出/消耗        比 | ' +
      '技能材料 比 | 强化石 比 | 碎片 比',
  )
  console.log('  ' + '-'.repeat(104))
  /**
   * 速度口径的**闸门维度**：只有「产出源是主线挂机」的维度才进闸门。
   *
   * ⚠ 五行技能材料 / 三档强化石 → 产出源是**副本**；
   *   同名碎片 → 产出源是**抽卡重复转化**（主线一条都不掉）。
   *   这三维在「主线挂机回放 vs 标准养成曲线」的口径里**没有分子**，
   *   打 0.00× 会被误读成「断供」，所以判成「不在口径内」：
   *   副本产量见【副本材料投放】，碎片的产出口径见【非主线产出维度】。
   */
  const PACE_GATE_KEYS = new Set<string>(['exp', 'silver'])

  const mins: Array<{ name: string; value: number; scoped: boolean }> = [
    { name: '经验', value: Infinity, scoped: PACE_GATE_KEYS.has('exp') },
    { name: '银两', value: Infinity, scoped: PACE_GATE_KEYS.has('silver') },
    { name: '五行技能材料', value: Infinity, scoped: PACE_GATE_KEYS.has('skillMats') },
    { name: '三档强化石', value: Infinity, scoped: PACE_GATE_KEYS.has('relicStones') },
    { name: '同名碎片', value: Infinity, scoped: PACE_GATE_KEYS.has('shards') },
  ]
  // 实际花费（模拟里理性玩家真正扣掉的量）与标准曲线的对比
  const actualTight: Array<{ chapter: number; name: string; ratio: number }> = []
  for (const row of pace.velocity) {
    const c = row.chapter
    const days = row.days
    const produced = row.produced
    const cost = standardCost(Math.max(LEVEL.MIN, designLevel(c - 1)), designLevel(c))
    const supply = {
      silver: produced.silver,
      exp: produced.exp + dailySupply.exp * days,
      skillMats: produced.skillMats,
      relicStones: produced.relicStones,
      shards: produced.shards,
    }
    // ⚠ 消耗为 0 ⇒ **没有分母**（比值无意义），打印「—」且不参与闸门；
    //   本章一天都没待过（没推到这一章）⇒ **没有数据**，同样打印「—」——
    //   「没去过」不等于「产出为 0」，把它算成 0.00× 会凭空报一个不存在的卡手；
    //   不在口径内的维度（材料 / 碎片）⇒ 同样打印「—」，不参与闸门。
    const cell = (value: number, need: number, scoped: boolean): string =>
      days <= 0 || need <= 0 || !scoped ? '—' : ratio(value, need)
    const pairs: Array<[string, number, number, boolean]> = [
      ['经验', supply.exp, cost.exp, mins[0].scoped],
      ['银两', supply.silver, cost.silver, mins[1].scoped],
      ['五行技能材料', supply.skillMats, cost.skillMats, mins[2].scoped],
      ['三档强化石', supply.relicStones, cost.relicStones, mins[3].scoped],
      ['同名碎片', supply.shards, cost.shards, mins[4].scoped],
    ]
    pairs.forEach(([, value, need, scoped], i) => {
      if (days <= 0 || need <= 0 || !scoped) return
      mins[i].value = Math.min(mins[i].value, value / need)
    })
    // 实际花费（贪心强化）比标准曲线激进 ⇒ 记下最紧的一处
    const actual = row.spent
    const actualPairs: Array<[string, number, number]> = [
      ['经验', actual.exp, cost.exp],
      ['银两', actual.silver, cost.silver],
      ['五行技能材料', actual.skillMats, cost.skillMats],
      ['三档强化石', actual.relicStones, cost.relicStones],
      ['同名碎片', actual.shards, cost.shards],
    ]
    for (const [name, spent, need] of actualPairs) {
      if (need <= 0) continue
      const r = spent / need
      if (r > 1) actualTight.push({ chapter: c, name, ratio: r })
    }
    console.log(
      `  ${String(c).padStart(2)} | ${String(days).padStart(4)} | ` +
        `${fmt(supply.exp).padStart(9)}/${fmt(cost.exp).padEnd(9)} ${cell(supply.exp, cost.exp, mins[0].scoped).padStart(7)} | ` +
        `${fmt(supply.silver).padStart(9)}/${fmt(cost.silver).padEnd(9)} ${cell(supply.silver, cost.silver, mins[1].scoped).padStart(7)} | ` +
        `${cell(supply.skillMats, cost.skillMats, mins[2].scoped).padStart(10)} | ` +
        `${cell(supply.relicStones, cost.relicStones, mins[3].scoped).padStart(8)} | ` +
        `${cell(supply.shards, cost.shards, mins[4].scoped).padStart(7)}`,
    )
  }
  console.log(
    '\n  逐章最小回收比：' +
      mins
        .map((m) => `${m.name} ${!m.scoped ? '（不在口径内）' : m.value === Infinity ? '—' : m.value.toFixed(2) + '×'}`)
        .join(' · '),
  )
  const scopedMins = mins.filter((m) => m.scoped)
  const healthy = scopedMins.every((m) => m.value >= 1)
  console.log(
    '  判定：' +
      (healthy
        ? '✓ 全部 ≥1（产出速度跟得上标准养成的消耗速度）'
        : '✗ 存在 <1 的章（该章资源不足以支撑标准养成推进）'),
  )
  if (actualTight.length > 0) {
    actualTight.sort((a, b) => b.ratio - a.ratio)
    const worst = actualTight[0]
    console.log(
      `\n  旁注：模拟里的「理性玩家」实际花费比标准曲线更激进（贪心强化遗物），` +
        `最紧的是第 ${worst.chapter} 章 ${worst.name}（实际花到标准曲线的 ${worst.ratio.toFixed(2)}×）——` +
        `该章资源偏紧，玩家要晚几天才能把遗物推到标准档，不是卡关。`,
    )
  }
  const outOfScopeNames = mins.filter((m) => !m.scoped).map((m) => m.name)
  if (outOfScopeNames.length > 0) {
    console.log(
      `\n  注：${outOfScopeNames.join(' / ')} 的产出源**不在主线挂机**`
        + '（材料来自**副本**，同名碎片来自**抽卡重复转化**）——'
        + '这三维在「主线挂机 vs 标准养成曲线」的口径里没有分子，不参与闸门；'
        + '副本产量见【副本材料投放】，碎片口径见【非主线产出维度】。',
    )
  }
  const noData = pace.velocity.filter((row) => row.days <= 0).map((row) => row.chapter)
  if (noData.length > 0) {
    console.log(
      `  注：第 ${noData.join(' / ')} 章在本次基线里**一天都没待过**`
        + '（模拟没推到那一章）——比值按「—」处理，不参与闸门。',
    )
  }
}

// ─────────────────────────── 6. 回流投放（P2-2） ───────────────────────────
//
// roadmap P2-2 的验收要求：回流奖励不能冲击抽卡间隔与养成资源回收。
// 回流是**低频事件**（每 30 天最多一次），所以按「日均」摊开算，
// 再用与日常任务**同一把尺**（日投放 ≤ 每日挂机经验产出的 1/3）比。

const returnTop = LADDER_RETURN_REWARDS[0]
const returnDailyExp = itemsToExp(returnTop.items) / LADDER.RETURN_COOLDOWN_DAYS

console.log('\n【回流投放】三队天梯 · 回流奖励（roadmap P2-2）\n')
console.log('  档位'.padEnd(14) + '离线天数'.padEnd(12) + '经验'.padStart(14) + '竞技勋章'.padStart(12))
console.log('  ' + '-'.repeat(54))
for (const spec of LADDER_RETURN_REWARDS) {
  console.log(
    `  ${`${spec.minDays} 天以上`.padEnd(12)}${String(spec.minDays).padStart(8)}  ` +
      `${fmt(itemsToExp(spec.items)).padStart(12)} ${String(spec.medals).padStart(10)}`,
  )
}
console.log(
  `\n  每日挂机经验产出（第 1 章 × ${rollsPerHour} 次 × 离线效率曲线）：`
    + ` ${fmt(dailyIdleExp)}`,
)
console.log(
  `  回流日均投放（按 ${LADDER.RETURN_COOLDOWN_DAYS} 天冷却摊）：`
    + ` 经验 ${fmt(returnDailyExp)}`,
)
console.log(
  `  回流日均占比（分母是**每日**的挂机经验产出，与日常任务同一把尺）：`
    + `${((returnDailyExp / dailyIdleExp) * 100).toFixed(2)}%`,
)
console.log(
  '  红线核对：回流奖励里的圣杯结晶 = 0（不冲击抽卡间隔）；'
    + '竞技勋章已停发；副本材料 = 0（副本专属产出）',
)

console.log('\n' + '='.repeat(84))
