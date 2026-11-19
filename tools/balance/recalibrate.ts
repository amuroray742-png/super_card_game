/**
 * 难度曲线重标定工具（§6.5 流程的程序化实现）。
 *
 * ⚠ 为什么要有这个脚本：
 *   `STAGE.SCALE_ANCHORS` / `STAGE.POWER_ANCHORS` 是**标定值**——英灵 / 成长 / 掉落
 *   数值一变，它们就跟真实难度脱钩（§6.5 的「已知限制」第 2 条）。
 *   历史上它们是手填的：改完数值只能靠人肉推，没有一条可复现的路径。
 *
 * 本脚本把 §6.5 的标定流程变成**可复现**的一条命令，分三步：
 *
 *   1. **设计阶梯**：玩家在第 N 章 BOSS 处的**目标等级** L(N) = N × 每章级数
 *      （每章级数 = LEVEL.MAX / CHAPTERS = 24）。
 *      这是**设计常数**，不是模拟的产物——它是「难度曲线对齐养成速度」这句话的落点：
 *      章内难度跨度 IN_CHAPTER_SPAN × BOSS_MULTIPLIER = 1.03^24 = 2.03，
 *      正好是玩家走完一章（24 级 × 每级 ×1.03）涨的战力。
 *   2. **标定锚点**：拿**参考队伍**（tools/balance/reference-build.ts）在设计阶梯
 *      那一档的养成，对该章 BOSS 二分「能稳过(≥90%)的最大敌方缩放」，
 *      取其一半（留战斗容错）→ 除以章内总跨度 → 该章首关的缩放锚点；
 *      同时记下该档参考队伍的**战力** → 该章 BOSS 的挂机放行门槛。
 *   3. **节奏验证**：用真实战斗（`idle.tick` → `runIdle`）+ 真实动作层（`applyAction`）
 *      模拟玩家从新号往前推，检查**涌现出来的**等级阶梯是否与设计阶梯吻合。
 *      阶梯对不上 ⇒ 是**投放节奏**（经验 / 挂机预算）出了问题，该改经济参数，
 *      而不是改锚点——改锚点去迁就一个跑偏的节奏只会把曲线推歪。
 *
 * ⚠ 时间与随机源全部注入（铁律 #1），本脚本不读真实时钟、不用 Math.random()。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { createNewSave } from '../../src/core/save/schema.ts'
import { Rng } from '../../src/core/rng.ts'
import { applyAction, syncRngState, type ActionContext } from '../../src/core/systems/actions.ts'
import { buildPveContext, buildTeam } from '../../src/core/systems/derive.ts'
import { getTeamPower } from '../../src/core/systems/team.ts'
import { atRealmGate, expToNext, realmBreakCost, skillLevelCap } from '../../src/core/systems/growth.ts'
import { relicUpgradeCost } from '../../src/core/systems/relic.ts'
import { simulateWinRate } from '../../src/core/systems/battle.ts'
import { computeOfflineEfficiency } from '../../src/core/systems/idle.ts'
import { computePower } from '../../src/core/systems/stats.ts'
import { STAGES, stageEnemyScaleFor, stagePowerRequiredFor } from '../../src/core/config/stages.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { HERO_INDEX } from '../../src/core/config/heroes/index.ts'
import { POOL_NEWBIE } from '../../src/core/config/pools.ts'
import { referenceTeam } from './reference-build.ts'
import { judgeRecycle } from './recycle-verdict.ts'
import {
  BATTLE,
  IDLE,
  LEVEL,
  REALMS,
  RELIC,
  SKILL,
  STAGE,
  START_RESOURCES,
} from '../../src/core/config/economy.ts'
import type {
  HeroDef,
  HeroRuntime,
  HeroState,
  Rarity,
  RelicInstance,
  SaveData,
} from '../../src/core/model/types.ts'

// ─────────────────────────── 命令行 ───────────────────────────

const { values } = parseArgs({
  options: {
    /** 节奏验证：模拟多少天 */
    days: { type: 'string', default: '40' },
    /** BOSS 标定的试验场数 */
    trials: { type: 'string', default: '40' },
    /** 二分迭代上限 */
    bisect: { type: 'string', default: '18' },
    /** 每天离线时长（小时）——基线口径 = 24（每天上线领一次奖） */
    offlineHours: { type: 'string', default: '24' },
    /** 每天在线时长（小时）——0 = 纯离线基线；>0 = 活跃玩家 */
    onlineHours: { type: 'string', default: '0' },
    /** 机读结果输出路径 */
    out: { type: 'string', default: 'artifacts/baselines/recalibrate.json' },
    /** 只看报告，不落盘 */
    dry: { type: 'boolean', default: false },
  },
})

const DAYS = Math.max(1, Number(values.days) || 40)
const TRIALS = Math.max(10, Number(values.trials) || 40)
const BISECT = Math.max(6, Number(values.bisect) || 18)
const OFFLINE_HOURS = Math.max(0, Number(values.offlineHours) || 0)
const ONLINE_HOURS = Math.max(0, Number(values.onlineHours) || 0)
const OUT_PATH = values.out ? resolve(process.cwd(), values.out) : ''

const HOUR_MS = 3_600_000
const BASE_NOW = Date.UTC(2026, 0, 5, 4, 0, 0)
const SEED = 20260105
/**
 * 每个「挂机日」的场次。
 *
 * ⚠ 口径必须走 core 的**离线效率曲线**（`computeOfflineEfficiency`），
 *   不能拿「满效率小时数 × 场次/小时」糊弄：
 *   真实玩家每天上线的收益是 f(离线时长)，不是 f(FULL_EFFICIENCY_HOURS)——
 *   尾部衰减与 CAP_HOURS 封顶都在 f 里（铁律 #1：口径必须复用 core）。
 */
const BATTLES_PER_DAY = Math.floor(
  (computeOfflineEfficiency(OFFLINE_HOURS * 3600) * 3600) / BATTLE.SECONDS_PER_BATTLE,
)

/** 章内总跨度（普通关铺开 × 章末 BOSS 倍率） */
const SPAN = STAGE.IN_CHAPTER_SPAN * STAGE.BOSS_MULTIPLIER
/** 每章的等级跨度：240 级 / 10 章 = 24 级 */
const LEVELS_PER_CHAPTER = LEVEL.MAX / STAGE.CHAPTERS
/** 每章关卡数（30 普通 + 1 BOSS） */
const STAGES_PER_CHAPTER = STAGE.STAGES_PER_CHAPTER + 1

/** 关卡号 → 章节 */
function chapterOfStage(stageId: number): number {
  return Math.min(STAGE.CHAPTERS, Math.max(1, Math.ceil(stageId / STAGES_PER_CHAPTER)))
}

/** 大数缩写（万 / 亿），表格用 */
function fmtFlow(n: number): string {
  const v = Math.round(n)
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万`
  return String(v)
}

/**
 * **设计阶梯**：玩家在第 N 章 BOSS 处的目标等级。
 *
 * ⚠ 这是**设计常数**，不是模拟的产物。
 *   章内难度跨度（SPAN = 2.03）就是按它定的：1.03^24 = 2.03，
 *   即「玩家走完一章涨的战力」与「章内难度涨幅」严格相等。
 */
const DESIGN_LADDER: number[] = Array.from(
  { length: STAGE.CHAPTERS },
  (_, i) => (i + 1) * LEVELS_PER_CHAPTER,
)

// ─────────────────────────── 标定 ───────────────────────────

/** 该章 BOSS 的敌方配置 */
function bossEnemy(chapter: number) {
  const stage = STAGES.find((s) => s.chapter === chapter && s.isBoss)!
  return getEnemy(stage.enemyIds[0])
}

/**
 * 该章 BOSS 敌人在 **scale = 1** 时的基础战力。
 *
 * ⚠ 这是「章边界不倒挂」下限的**关键**：敌方**基础属性本身跨章增长**
 *   （实测约 1.25×/章，§6.5 的「已知限制」第 1 条：BOSS 血量 2400 → 18000）。
 *   所以「难度」= 基础属性 × 缩放锚点，**只看锚点会高估难度增速**。
 */
function bossBasePower(chapter: number): number {
  return computePower(bossEnemy(chapter).baseStats)
}

/** 在给定缩放下，该章 BOSS 的实测通关率 */
function winRateAt(chapter: number, scale: number, heroes: HeroRuntime[]): number {
  const boss = bossEnemy(chapter)
  const r = simulateWinRate(
    { allies: heroes, enemies: [boss], enemyScale: scale, ctx: { mode: 'pve' } },
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
function maxWinnableScale(chapter: number, heroes: HeroRuntime[]): number {
  let lo = 0.01
  let hi = 1e6
  for (let i = 0; i < BISECT; i++) {
    const mid = Math.sqrt(lo * hi)
    if (winRateAt(chapter, mid, heroes) >= 0.9) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * 找到「刚好打得赢」的等级：参考队伍在该等级能以 ≥90% 通关该章 BOSS。
 *
 * ⚠ 这是**挂机放行门槛**的取值依据（§6.5：「门槛 = 玩家『刚能稳过该章 BOSS』时的战力，
 *   宁可略紧不可略松」）。取设计等级会得到 1.0× 的末关余量
 *   （门槛 = 满养成战力），违反「末关余量 ≥ 1.5×」的不变量。
 */
function minWinnableLevel(chapter: number, bossScale: number): number {
  // ⚠ 显式标 `number`：`LEVEL` 是 `as const`，`let hi = LEVEL.MAX` 会被推断成字面量类型 `240`，
  //   之后 `hi = mid`（number）就编译不过。
  let lo: number = LEVEL.MIN
  let hi: number = LEVEL.MAX
  // maxWinnableScale 随等级单调递增 ⇒ 二分「最小可行等级」
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const team = referenceTeam(mid)
    if (maxWinnableScale(chapter, team) >= bossScale) hi = mid
    else lo = mid + 1
  }
  return lo
}

interface CalibrationDetail {
  chapter: number
  level: number
  minLevel: number
  power: number
  maxScale: number
  anchor: number
}

/**
 * 标定一轮：按**设计阶梯**产出两个锚点表。
 *
 * ⚠ 与「用模拟涌现的阶梯标定」的本质区别：
 *   涌现阶梯会自我放大——BOSS 打得轻松 → 玩家提前进阶 → 下一章提前 →
 *   锚点一路被压低，最后收敛到「第 8 章就顶格、第 9~10 章永远打不过」
 *   的坏不动点（实测）。设计阶梯是外生的，标定因此**确定且可复现**。
 */
function calibrate(): {
  scales: number[]
  powers: number[]
  details: CalibrationDetail[]
} {
  const scales: number[] = []
  const powers: number[] = []
  const details: CalibrationDetail[] = []

  for (let chapter = 1; chapter <= STAGE.CHAPTERS; chapter++) {
    const level = DESIGN_LADDER[chapter - 1]
    const team = referenceTeam(level)
    const maxScale = maxWinnableScale(chapter, team)
    // §6.5：取「稳过上限」的一半作为目标缩放（BOSS 战不至于秒杀也不至于耗死）
    const anchor = maxScale / 2 / SPAN
    scales.push(anchor)
    details.push({ chapter, level, minLevel: 0, power: 0, maxScale, anchor })
  }

  // 强制单调：相邻章锚点比必须 ≥ 章内总跨度（章边界不倒挂）
  //
  // ⚠ **实施修正（roadmap P1-2）**：原规则是「锚点比 ≥ 章内总跨度」，
  //   它隐含假设「敌方基础属性不跨章增长」。实际基础属性约 1.25×/章，
  //   章内总跨度抬到 2.03 后字面执行会让难度增速 = 1.25 × 2.03 = 2.54×/章，
  //   而玩家每章只涨 1.03^24 = 2.03× 战力 ⇒ 难度永远跑在养成前面，
  //   标定被下限接管 → 曲线没有不动点（第 7 章后必卡死）。
  //   正确的下限要按「难度 = 基础属性 × 锚点」折算：
  //     anchor[c] ≥ anchor[c-1] × 章内总跨度 × (基础[c-1] / 基础[c])
  //   基础增速从 enemies.ts 实算，不另立常数（单一数据源）。
  const basePowers: number[] = []
  for (let c = 1; c <= STAGE.CHAPTERS; c++) basePowers.push(bossBasePower(c))
  for (let c = 1; c < scales.length; c++) {
    const baseRatio = basePowers[c - 1] / basePowers[c]
    const floor = scales[c - 1] * SPAN * baseRatio
    if (scales[c] < floor) scales[c] = floor
  }

  // 门槛同样必须单调递增
  for (let c = 1; c < powers.length; c++) {
    const floor = powers[c - 1] * STAGE.CHAPTER_GATE_GAP
    if (powers[c] < floor) powers[c] = Math.round(floor)
  }

  // ⚠ 门槛必须**在锚点定稿之后**才算：
  //   单调下限可能把某章锚点抬高（难度更陡），此时「刚好打得赢」的等级要重算——
  //   否则门槛会按旧锚点取值，实战打不赢 → 挂机推进到打不过的关卡 → 零收益卡死。
  for (let c = 0; c < STAGE.CHAPTERS; c++) {
    const chapter = c + 1
    const bossScale = scales[c] * SPAN
    const minLevel = minWinnableLevel(chapter, bossScale)
    const power = Math.round(getTeamPower(referenceTeam(minLevel), { mode: 'pve' }))
    powers[c] = power
    details[c].minLevel = minLevel
    details[c].power = power
  }

  // 门槛同样必须单调递增（下限修正后可能需要再抬一次）
  for (let c = 1; c < powers.length; c++) {
    const floor = powers[c - 1] * STAGE.CHAPTER_GATE_GAP
    if (powers[c] < floor) powers[c] = Math.round(floor)
  }

  return { scales, powers, details }
}

// ─────────────────────────── 队伍快照 ───────────────────────────

interface HeroSnapshot {
  id: string
  slot: number
  level: number
  star: number
  skillLevels: number[]
}

interface TeamSnapshot {
  heroes: HeroSnapshot[]
  /** heroId → 该英灵身上的遗物实例 */
  relicsByHero: Record<string, RelicInstance[]>
}

/** 快照当前上阵队伍（用于标定时还原「玩家当时的队伍」） */
function snapshotTeam(save: SaveData, heroIds: string[]): TeamSnapshot {
  const heroes: HeroSnapshot[] = []
  const relicsByHero: Record<string, RelicInstance[]> = {}
  for (const id of heroIds) {
    const state = save.heroes[id]
    if (!state) continue
    const slot = Object.entries(save.equipped).find(([, e]) => e.heroId === id)?.[0]
    heroes.push({
      id,
      slot: slot ? Number(slot) : heroes.length,
      level: state.level,
      star: state.star,
      skillLevels: [...state.skillLevels],
    })
    const owned: RelicInstance[] = []
    for (const equipped of Object.values(save.equipped)) {
      if (equipped.heroId !== id) continue
      const relic = save.relics.find((r) => r.uid === equipped.relicId)
      if (relic) owned.push(structuredClone(relic))
    }
    relicsByHero[id] = owned
  }
  return { heroes, relicsByHero }
}

// ─────────────────────────── 编队 ───────────────────────────

/** 新手池十连后按「1 SSR + 1 SR + 4 R」配额挑人 */
const START_QUOTA: Rarity[] = ['SSR', 'SR', 'R', 'R', 'R', 'R']

function pickTeam(pool: HeroDef[]): HeroDef[] {
  const order: Rarity[] = ['SSR', 'SR', 'R', 'N']
  const byRarity = new Map<Rarity, HeroDef[]>(order.map((r) => [r, []]))
  for (const def of pool) byRarity.get(def.rarity)?.push(def)
  for (const list of byRarity.values()) list.sort((a, b) => a.id.localeCompare(b.id))

  const picked: HeroDef[] = []
  const used = new Set<string>()
  for (const want of START_QUOTA) {
    for (let i = order.indexOf(want); i < order.length; i++) {
      const next = byRarity.get(order[i])?.find((h) => !used.has(h.id))
      if (!next) continue
      picked.push(next)
      used.add(next.id)
      break
    }
  }
  return picked
}

/**
 * 真实走一次新手池十连，然后按配额编队。
 *
 * ⚠ **十连的重复转化收益必须一并返回**：
 *   新手池十连必然出重复（实测 10 张里 8 张是新角色），重复按合规口径转成
 *   **银两 + 英灵印记 + 同名碎片**——那是**真实流入**，发生在第 1 章。
 *   漏记它会让第 1 章的「产出 ÷ 消耗」凭空少一块（实测少 1,000 银两），
 *   闸门会报一个**不存在的**卡手（银两 0.99906×）。
 */
function obtainStartTeam(
  save: SaveData,
  ctx: ActionContext,
): { teamIds: string[]; gachaFlow: ResourceFlow } {
  const pulled = applyAction(save, { type: 'gacha.pull', poolId: POOL_NEWBIE.id, count: 10 }, ctx)
  if (!pulled.ok) throw new Error(`新手十连失败：${pulled.message}`)

  const owned = Object.keys(save.heroes)
    .map((id) => HERO_INDEX.get(id))
    .filter((d): d is HeroDef => !!d)
  const team = pickTeam(owned)
  if (team.length === 0) throw new Error('存档里没有可用英灵')
  for (let slot = 0; slot < 6; slot++) {
    applyAction(save, { type: 'team.setSlot', index: slot, heroId: team[slot]?.id ?? null }, ctx)
  }
  const gachaFlow = emptyFlow()
  gachaFlow.silver = pulled.result.silver
  gachaFlow.emblems = pulled.result.emblems
  return { teamIds: team.map((h) => h.id), gachaFlow }
}

// ─────────────────────────── 养成策略 ───────────────────────────

/**
 * 一段时间内的资源收支（产出 / 消耗都是**真实动作结果**的累加，不是复算的规则）。
 */
interface ResourceFlow {
  silver: number
  exp: number
  skillStones: number
  relicStones: number
  emblems: number
  /** 遗物实例（只有产出侧有） */
  relics: number
}

function emptyFlow(): ResourceFlow {
  return { silver: 0, exp: 0, skillStones: 0, relicStones: 0, emblems: 0, relics: 0 }
}

function addFlow(target: ResourceFlow, src: ResourceFlow): void {
  target.silver += src.silver
  target.exp += src.exp
  target.skillStones += src.skillStones
  target.relicStones += src.relicStones
  target.emblems += src.emblems
  target.relics += src.relics
}

/**
 * 把资源按固定优先级花掉（与 newplayer.ts 的「理性玩家」模型一致）：
 *   ① 等级：喂给等级最低的上阵英灵；② 境界：卡门槛且印记够就突破；
 *   ③ 遗物强化：轮转升级；④ 技能升级：剩下的术式结晶。
 *
 * ⚠ 返回**实际消耗**：每个消耗量都取自动作结果（`FeedExpResult.applied` /
 *   `RelicUpgradeResult.cost` / 境界突破成本），不复算一遍扣费口径——
 *   复算就会和游戏实际扣的钱对不上（铁律 #4）。
 */
function spendGrowth(
  save: SaveData,
  ctx: ActionContext,
  teamIds: string[],
): { spent: ResourceFlow; maxAction: { silver: number; relicStones: number } } {
  const spent = emptyFlow()
  /**
   * 本次养成里**最贵的单次消费动作**。
   *
   * ⚠ 这是回收比容差的来源：淬炼段的一次强化要几十万银两，
   *   拿「基础 500」当粒度会把「差一步」误判成「缺一大截」。
   */
  const maxAction = { silver: 0, relicStones: 0 }
  let guard = 0
  while (save.player.exp > 0 && guard++ < 5000) {
    const states = teamIds.map((id) => save.heroes[id]).filter((s): s is NonNullable<typeof s> => !!s)
    if (states.length === 0) break
    const target = states.sort((a, b) => a.level - b.level || b.exp - a.exp)[0]

    if (atRealmGate(target.level)) {
      // 突破成本要在**突破前**取：突破后等级跨入新境界，成本就变了
      const breakCost = realmBreakCost(target.level)
      const broke = applyAction(save, { type: 'hero.breakRealm', heroId: target.id }, ctx)
      if (broke.ok) {
        spent.emblems += breakCost?.emblems ?? 0
        continue
      }
      const alt = states.filter((s) => !atRealmGate(s.level)).sort((a, b) => a.level - b.level)[0]
      if (!alt) break
      const amount = Math.min(save.player.exp, Math.max(1, expToNext(alt.level) - alt.exp))
      const fed = applyAction(save, { type: 'hero.feedExp', heroId: alt.id, amount }, ctx)
      if (!fed.ok) break
      spent.exp += fed.result.applied
      continue
    }

    const amount = Math.min(save.player.exp, Math.max(1, expToNext(target.level) - target.exp))
    const fed = applyAction(save, { type: 'hero.feedExp', heroId: target.id, amount }, ctx)
    if (!fed.ok) break
    spent.exp += fed.result.applied
  }

  const equipped = Object.values(save.equipped)
    .map((e) => save.relics.find((r) => r.uid === e.relicId))
    .filter((r): r is NonNullable<typeof r> => !!r)
  let relicGuard = 0
  // ⚠ 护栏按「满编 × 上限」给足：强化上限提到 200 之后，
  //   36 件遗物各推到上限需要 7000+ 次升级，原来的 3000 会中途截断
  //   （截断 = 模拟出来的消耗偏小，速度口径的回收比直接失真）。
  while (relicGuard++ < equipped.length * RELIC.MAX_LEVEL) {
    const candidates = equipped.filter((r) => r.level < RELIC.MAX_LEVEL).sort((a, b) => a.level - b.level)
    if (candidates.length === 0) break
    const relic = candidates[0]
    const cost = relicUpgradeCost(relic.level)
    if (!cost) break
    if (save.player.silver < cost.silver || save.player.relicStones < cost.stones) break
    const up = applyAction(save, { type: 'relic.upgrade', uid: relic.uid }, ctx)
    if (!up.ok) break
    spent.silver += up.result.cost.silver
    spent.relicStones += up.result.cost.stones
    maxAction.silver = Math.max(maxAction.silver, up.result.cost.silver)
    maxAction.relicStones = Math.max(maxAction.relicStones, up.result.cost.stones)
  }

  let skillGuard = 0
  while (skillGuard++ < 400) {
    let upgraded = false
    for (const heroId of teamIds) {
      const state = save.heroes[heroId]
      if (!state) continue
      for (let index = 0; index < state.skillLevels.length; index++) {
        if ((state.skillLevels[index] ?? 0) >= skillLevelCap(state.level)) continue
        if (save.player.skillStones < SKILL.SKILL_STONES_PER_LEVEL) continue
        if (save.player.silver < SKILL.SILVER_PER_LEVEL) continue
        const up = applyAction(save, { type: 'hero.upgradeSkill', heroId, index }, ctx)
        if (up.ok) {
          spent.skillStones += SKILL.SKILL_STONES_PER_LEVEL
          spent.silver += SKILL.SILVER_PER_LEVEL
          maxAction.silver = Math.max(maxAction.silver, SKILL.SILVER_PER_LEVEL)
          upgraded = true
          break
        }
      }
    }
    if (!upgraded) break
  }

  return { spent, maxAction }
}

// ─────────────────────────── 推进模拟（节奏验证） ───────────────────────────

interface DaySnapshot {
  day: number
  clearedStage: number
  chapter: number
  /** 当天**开打时**所处的章节（这一天实际在打的关卡属于哪一章） */
  chapterAtStart: number
  level: number
  power: number
  exp: number
  silver: number
  relics: number
  /** 已装备遗物的**平均强化等级**（参考养成曲线的实测依据） */
  relicLevel: number
  /** 当天实际回放的战斗场次 */
  battles: number
  /** 当天被卡住的关卡 */
  blockedAtStage: number | null
  /** 当天的产出（真实挂机回放的奖励包，含主线首通掉落） */
  produced: ResourceFlow
  /** 当天的养成消耗（真实动作结果累加） */
  spent: ResourceFlow
  /** 当天做过的**最贵的一次消费动作**（回收比容差的来源） */
  maxAction: { silver: number; relicStones: number }
}

interface SimulationResult {
  days: DaySnapshot[]
  /** 首次打通各章 BOSS 时的玩家等级（涌现阶梯） */
  ladder: number[]
  /** 首次打通各章 BOSS 是第几天 */
  ladderDays: number[]
  clearedAll: boolean
  finalDay: number
}

/**
 * 把新一轮锚点写进已构建的关卡表。
 *
 * ⚠ `STAGES` 是模块加载时构建一次的，锚点与推进模拟互相依赖
 *   （门槛决定推进、推进决定标定），标定迭代必须用**上一轮的锚点**重跑模拟。
 *   公式仍走 stages.ts 的同一份实现（铁律 #4），这里只改注入值。
 */
function applyAnchors(scales: readonly number[], powers: readonly number[]): void {
  for (const stage of STAGES) {
    stage.enemyScale = stageEnemyScaleFor(stage.chapter, stage.index, stage.isBoss, scales)
    stage.powerRequired = stagePowerRequiredFor(stage.chapter, stage.index, stage.isBoss, powers)
  }
}

/**
 * 模拟玩家从新号推进到通关。
 *
 * ⚠ 战力的门槛放行由 `idle.tick` 动作内部完成（core 真实逻辑），
 *   本脚本只负责「推进时间 → 触发动作 → 按固定优先级花资源」。
 * ⚠ 成长（喂经验 / 突破 / 强化）发生在**每天结束时**——真实玩家也是
 *   「上线喂一次 → 挂机一天 → 再上线喂一次」，所以当天的战斗用的是当天开打时的等级。
 */
function simulate(): SimulationResult {
  const save = createNewSave(BASE_NOW, SEED)
  const ctx: ActionContext = {
    now: BASE_NOW,
    rng: new Rng(SEED),
    randomSeed: () => SEED,
  }
  const { teamIds, gachaFlow } = obtainStartTeam(save, ctx)
  syncRngState(save, ctx.rng)

  const days: DaySnapshot[] = []
  const ladder: number[] = []
  const ladderDays: number[] = []
  const seenBoss = new Set<number>()
  let clearedAll = false
  let finalDay = 0

  for (let day = 1; day <= DAYS; day++) {
    // 当天开打时的队伍状态（成长只发生在每天结束时）
    const levelBefore = save.heroes[teamIds[0]]?.level ?? 1
    const powerBefore = getTeamPower(buildTeam(save), buildPveContext(save))
    // 当天**在打**的关卡属于哪一章（推进前的目标关卡）
    const chapterAtStart = chapterOfStage(save.campaign.clearedStage + 1)

    // ── 玩家上线：按真实客户端的行为序列走 ──
    //
    // ⚠ 这里**不能**直接改 `save.idle.measuredAt` / `activeUntil`：
    //   core 的离线计量是「累计时长」口径（`settleIdleLedger`）——
    //   累计的离线时长只有在玩家**活跃**（onlineMs > 0）时才归零，
    //   否则连续离线的累计时长会一路涨到 CAP_HOURS，之后的离线收益恒为 0。
    //   真实玩家每天都会上线，所以模拟也必须每天上线一次（铁律 #1：走真实动作层）。
    //
    // ① 登录后的第一跳：计量这一整段离线期（此时租约已过期 → 走离线曲线）
    ctx.now += OFFLINE_HOURS * HOUR_MS
    applyAction(save, { type: 'idle.heartbeat' }, ctx)
    // ② 第二跳（一个心跳间隔后）：租约已生效 → onlineMs > 0 → 离线累计归零
    ctx.now += IDLE.HEARTBEAT_INTERVAL_MS
    applyAction(save, { type: 'idle.heartbeat' }, ctx)
    // ③ 在线挂机（心跳 × N，按 ONLINE_MULTIPLIER 计量；基线口径为 0）
    const onlineBeats = Math.round(
      (ONLINE_HOURS * 3600) / (IDLE.HEARTBEAT_INTERVAL_MS / 1000),
    )
    for (let i = 0; i < onlineBeats; i++) {
      ctx.now += IDLE.HEARTBEAT_INTERVAL_MS
      applyAction(save, { type: 'idle.heartbeat' }, ctx)
    }
    // ④ 领奖：回放战斗（场次由服务端已累计的有效时长决定，客户端只是上限）
    const tick = applyAction(
      save,
      { type: 'idle.tick', battles: IDLE.MAX_REPLAY_BATTLES },
      ctx,
    )
    const idleResult = tick.ok ? tick.result : null

    // 当天的产出：直接取真实挂机回放的奖励包（主线首通掉落也在这里面）
    const produced = emptyFlow()
    const rewards = idleResult?.rewards
    if (rewards) {
      produced.silver += rewards.silver ?? 0
      produced.exp += rewards.exp ?? 0
      produced.skillStones += rewards.skillStones ?? 0
      produced.relicStones += rewards.relicStones ?? 0
      produced.emblems += rewards.emblems ?? 0
      produced.relics += rewards.relics?.length ?? 0
    }
    // ⚠ **新号启动资金 + 新手十连的重复转化计入第 1 章的产出**：
    //   `createNewSave` 给的新号启动资金（银两 5 万 / 术式结晶 30 / 强化石 30）
    //   是真实流入，只是发生在 t=0、不在挂机回包里；
    //   新手十连的重复转化（银两 / 英灵印记）同理——它们都发生在第 1 章。
    //   不计它们的话，第 1 章的「产出 ÷ 消耗」必然 <1（消耗把启动资金花掉了），
    //   闸门会报一个**不存在的**卡手（实测：漏记十连转化时银两 0.99906×，
    //   差额恰好是那 1,000 银两；补上后账是平的——余额 381 落在
    //   「不足 500 银两、无法继续强化」的区间内，与实际一致）。
    if (day === 1) {
      produced.silver += START_RESOURCES.silver + gachaFlow.silver
      produced.skillStones += START_RESOURCES.skillStones
      produced.relicStones += START_RESOURCES.relicStones
      produced.emblems += gachaFlow.emblems
    }

    // 首次打通第 N 章 BOSS → 记录玩家当时的等级
    for (const stage of STAGES) {
      if (!stage.isBoss) continue
      if (stage.id > save.campaign.clearedStage) break
      if (seenBoss.has(stage.chapter)) continue
      seenBoss.add(stage.chapter)
      ladder[stage.chapter - 1] = levelBefore
      ladderDays[stage.chapter - 1] = day
    }

    // 首日之后穿上遗物（与 newplayer.ts 同口径）
    if (day === 1) {
      for (const heroId of teamIds) applyAction(save, { type: 'relic.autoEquip', heroId }, ctx)
    }
    const { spent, maxAction } = spendGrowth(save, ctx, teamIds)
    syncRngState(save, ctx.rng)

    const state = save.heroes[teamIds[0]]
    const level = state?.level ?? 1
    const power = getTeamPower(buildTeam(save), buildPveContext(save))
    // 已装备遗物的平均强化等级：**参考养成曲线（reference-build）的实测依据**——
    // 标准曲线写什么，取决于理性玩家实际养到什么程度，不能拍脑袋。
    const equippedRelics = Object.values(save.equipped)
      .map((e) => save.relics.find((r) => r.uid === e.relicId))
      .filter((r): r is RelicInstance => !!r)
    const relicLevel = equippedRelics.length > 0
      ? equippedRelics.reduce((sum, r) => sum + r.level, 0) / equippedRelics.length
      : 0

    days.push({
      day,
      clearedStage: save.campaign.clearedStage,
      chapter: Math.min(STAGE.CHAPTERS, Math.ceil(save.campaign.clearedStage / 31)),
      chapterAtStart,
      level,
      power,
      exp: save.player.exp,
      silver: save.player.silver,
      relics: save.relics.length,
      relicLevel: Math.round(relicLevel * 10) / 10,
      battles: idleResult?.battles ?? 0,
      blockedAtStage: idleResult?.blockedAtStage ?? null,
      produced,
      spent,
      maxAction,
    })

    if (save.campaign.clearedStage >= STAGES.length) {
      clearedAll = true
      finalDay = day
      break
    }
    finalDay = day
  }

  return { days, ladder, ladderDays, clearedAll, finalDay }
}

// ─────────────────────────── 主流程 ───────────────────────────

console.log('='.repeat(78))
console.log('《超级圣杯战争》难度曲线重标定（§6.5 流程 · 设计阶梯 + 真实战斗标定）')
console.log('='.repeat(78))
console.log(
  `  挂机日 ${BATTLES_PER_DAY} 场（离线 ${OFFLINE_HOURS}h → 折算 ` +
    `${computeOfflineEfficiency(OFFLINE_HOURS * 3600).toFixed(2)}h 有效时长` +
    `${ONLINE_HOURS > 0 ? ` + 在线 ${ONLINE_HOURS}h` : ''}）· 节奏验证 ${DAYS} 天`,
)
console.log(
  `  每章 ${LEVELS_PER_CHAPTER} 级 · 章内总跨度 = ${STAGE.IN_CHAPTER_SPAN} × ` +
    `${STAGE.BOSS_MULTIPLIER} = ${SPAN.toFixed(3)}（= 1.03^${LEVELS_PER_CHAPTER}）`,
)
console.log('  标定：二分「通关率 ≥ 90% 的最大缩放」→ 取一半 → ÷ 章内总跨度')

const final = calibrate()
applyAnchors(final.scales, final.powers)

console.log('\n【逐章标定结果】（参考队伍 = 设计阶梯那一档）')
console.log('  章 | 设计等级 | 刚好打赢等级 | 门槛战力 | 稳过上限缩放 | 锚点')
for (const d of final.details) {
  console.log(
    `  ${String(d.chapter).padStart(2)} | ${String(d.level).padStart(8)} | ${String(d.minLevel).padStart(12)} | ` +
      `${Math.round(d.power).toString().padStart(10)} | ${d.maxScale.toFixed(1).padStart(13)} | ` +
      `${d.anchor.toFixed(4).padStart(8)}`,
  )
}

console.log('\n【SCALE_ANCHORS】（敌方缩放锚点）')
console.log(`  [${final.scales.map((v) => v.toFixed(2)).join(', ')}],`)
console.log('\n【POWER_ANCHORS】（每章 BOSS 战力门槛）')
console.log(`  [${final.powers.join(', ')},]`)
console.log('\n【设计阶梯】（每章 BOSS 的目标等级）')
console.log(`  [${DESIGN_LADDER.join(', ')},]`)
console.log('\n【刚好打赢阶梯】（挂机放行门槛对应的等级）')
console.log(`  [${final.details.map((d) => d.minLevel).join(', ')},]`)

// ── 节奏验证：真实推进模拟 ──
console.log('\n【节奏验证】真实推进模拟（真实战斗回放 + 真实动作层）\n')
const result = simulate()
const last = result.days[result.days.length - 1]
console.log(
  `  第 ${result.finalDay} 天到达第 ${last.clearedStage} 关` +
    `（${last.chapter} 章 · Lv${last.level} · 战力 ${Math.round(last.power)}）` +
    `${result.clearedAll ? ' · 已通关' : ' · 未通关'}`,
)
console.log('\n  章 | 设计等级 | 涌现等级 | 偏差 | 首次打通日')
for (let c = 1; c <= STAGE.CHAPTERS; c++) {
  const design = DESIGN_LADDER[c - 1]
  const actual = result.ladder[c - 1] ?? 0
  const diff = actual === 0 ? '—' : `${actual - design >= 0 ? '+' : ''}${actual - design}`
  console.log(
    `  ${String(c).padStart(2)} | ${String(design).padStart(8)} | ${String(actual).padStart(8)} | ` +
      `${String(diff).padStart(4)} | ${String(result.ladderDays[c - 1] ?? '-').padStart(8)}`,
  )
}

console.log('\n【推进曲线】')
console.log('  天 | 关卡 | 章 | 等级 | 战力 | 场次 | 卡关 | 经验池 | 银两 | 遗物 | 遗物等级')
for (const d of result.days) {
  console.log(
    `  ${String(d.day).padStart(2)} | ${String(d.clearedStage).padStart(4)} | ` +
      `${String(d.chapter).padStart(2)} | ${String(d.level).padStart(3)} | ` +
      `${Math.round(d.power).toString().padStart(9)} | ${String(d.battles).padStart(4)} | ` +
      `${String(d.blockedAtStage ?? '-').padStart(4)} | ` +
      `${Math.round(d.exp).toString().padStart(11)} | ` +
      `${Math.round(d.silver).toString().padStart(12)} | ${String(d.relics).padStart(4)} | ` +
      `${d.relicLevel.toString().padStart(6)}`,
  )
}

// ── 速度口径：产出速度 vs 消耗速度（§5.8）──
//
// ⚠ 为什么不能用「主线 310 关首通投放 ÷ 满养成消耗」的**存量**口径：
//   挂机游戏里经验的产出主体是**挂机刷取**（每天上千场），
//   主线 310 次首通只是零头（实测 4384万 vs 满养成 26.5亿 = 0.02×）。
//   存量口径把零头当成全部产出，结论必然是「缺口」，而玩家实际并不缺经验。
//   §5.8 原文就是「产出速度 vs 消耗速度」——这里按章聚合真实链路的收支。
//
// ⚠ 两侧都是**真实动作结果**：
//   产出 = `idle.tick` 返回的奖励包（含主线首通掉落）；
//   消耗 = 喂经验 / 境界突破 / 遗物强化 / 技能升级的动作回包累加。

interface ChapterVelocity {
  days: number
  produced: ResourceFlow
  spent: ResourceFlow
  /** 本章做过的最贵的一次消费动作（回收比容差的来源） */
  maxAction: { silver: number; relicStones: number }
}

const velocity: ChapterVelocity[] = Array.from({ length: STAGE.CHAPTERS }, () => ({
  days: 0,
  produced: emptyFlow(),
  spent: emptyFlow(),
  maxAction: { silver: 0, relicStones: 0 },
}))
for (const d of result.days) {
  const v = velocity[d.chapterAtStart - 1]
  v.days += 1
  addFlow(v.produced, d.produced)
  addFlow(v.spent, d.spent)
  v.maxAction.silver = Math.max(v.maxAction.silver, d.maxAction.silver)
  v.maxAction.relicStones = Math.max(v.maxAction.relicStones, d.maxAction.relicStones)
}

function ratioCell(supply: number, need: number): string {
  if (need <= 0) return '—'
  return `${(supply / need).toFixed(2)}×`
}

/** 资源键 → 展示名（表格顺序） */
const RESOURCE_ROWS = [
  { key: 'exp', label: '经验' },
  { key: 'silver', label: '银两' },
  { key: 'skillStones', label: '术式结晶' },
  { key: 'relicStones', label: '遗物强化石' },
  { key: 'emblems', label: '英灵印记' },
] as const

type ResourceKey = (typeof RESOURCE_ROWS)[number]['key']

/**
 * 每个资源「**一次最小消费动作**」的成本——回收比的**容差**。
 *
 * ⚠ 容差**不是**随手取的小 epsilon，而是游戏自己的**决策粒度**：
 *   产出与消耗都是离散动作（一次遗物强化 = 500 银两 + 2 石、一次喂经验 = 1,000 经验），
 *   所以「差一次动作」不是缺钱，而是**出口已饱和**——
 *   玩家的钱正好用来买了下一次升级，剩下的不够再买一次。
 *   回收阀门建好之后，逐章比值会**贴着 1.0 上下摆动**（实测银两 0.99995×），
 *   那正是「钱没有堆积」的签名，不是卡手。
 *   超过一步长才是真的卡手（玩家攒不够一次升级，只能干等产出）。
 *
 * ⚠ 遗物强化的**单价随进度变贵**（淬炼段指数上升），
 *   所以银两 / 强化石的粒度必须取**玩家在该章实际付过的最贵一次**，
 *   不能用基础价 500 / 2 ——否则会把「差一步」误判成「缺一大截」。
 */
const STATIC_STEP: Record<ResourceKey, number> = {
  exp: LEVEL.EXP_FEED_OPTIONS[0],
  silver: RELIC.SILVER_PER_LEVEL,
  skillStones: SKILL.SKILL_STONES_PER_LEVEL,
  relicStones: RELIC.STONES_PER_LEVEL,
  emblems: Math.min(
    ...REALMS.map((r) => r.breakCost?.emblems ?? Number.POSITIVE_INFINITY),
  ),
}

/** 该章该资源的「一次动作」粒度（取自本章实际发生过的最贵一次消费） */
function stepOf(key: ResourceKey, chapterMaxAction: { silver: number; relicStones: number }): number {
  if (key === 'silver') return Math.max(STATIC_STEP.silver, chapterMaxAction.silver)
  if (key === 'relicStones') return Math.max(STATIC_STEP.relicStones, chapterMaxAction.relicStones)
  return STATIC_STEP[key]
}

interface VelocityCell {
  produced: number
  spent: number
  ratio: number
  /** 本章净余额（正 = 盈余，负 = 欠账） */
  net: number
  /** 累计净余额（正 = 玩家至今仍有余额） */
  cumNet: number
  /** 该章该资源的「一次消费动作」粒度（容差） */
  step: number
  /** 本章只是「差一次动作」（出口饱和，不算卡手） */
  saturated: boolean
  /** 是否通过（玩家没有被资源卡住） */
  ok: boolean
  /** 不通过的原因 */
  reason: string
}

console.log('\n【速度口径】产出速度 vs 消耗速度（按章聚合 · 真实链路收支）\n')
console.log(
  '  章 | 天数 | 经验 产出/消耗        比 | 银两 产出/消耗        比 | ' +
    '术式结晶 比 | 强化石 比 | 印记 比',
)
console.log('  ' + '-'.repeat(104))

const cells: VelocityCell[][] = []
const cumNet: Record<ResourceKey, number> = {
  exp: 0,
  silver: 0,
  skillStones: 0,
  relicStones: 0,
  emblems: 0,
}
for (const v of velocity) {
  const chapterRow: VelocityCell[] = RESOURCE_ROWS.map(({ key }) => {
    const produced = v.produced[key]
    const spent = v.spent[key]
    const net = produced - spent
    cumNet[key] += net
    const step = stepOf(key, v.maxAction)
    // ⚠ 判定口径只有一份：`tools/balance/recycle-verdict.ts`
    //   （工具与单测共用，铁律 #4 / #29）。
    const verdict = judgeRecycle({ produced, spent, cumNet: cumNet[key], step })
    return {
      produced,
      spent,
      ratio: verdict.ratio,
      net,
      cumNet: cumNet[key],
      step,
      saturated: verdict.saturated,
      ok: verdict.ok,
      reason: verdict.reason,
    }
  })
  cells.push(chapterRow)

  const p = v.produced
  const s = v.spent
  console.log(
    `  ${String(cells.length).padStart(2)} | ${String(v.days).padStart(4)} | ` +
      `${fmtFlow(p.exp).padStart(9)}/${fmtFlow(s.exp).padEnd(9)} ${ratioCell(p.exp, s.exp).padStart(7)} | ` +
      `${fmtFlow(p.silver).padStart(9)}/${fmtFlow(s.silver).padEnd(9)} ${ratioCell(p.silver, s.silver).padStart(7)} | ` +
      `${ratioCell(p.skillStones, s.skillStones).padStart(10)} | ` +
      `${ratioCell(p.relicStones, s.relicStones).padStart(8)} | ` +
      `${ratioCell(p.emblems, s.emblems).padStart(7)}`,
  )
}

// ── 累计净额：玩家该资源「至今还剩多少」 ──
//
// ⚠ 逐章流量比会因**离散粒度**在 1.0 附近摆动，而**跨章结转**又让它失真：
//   某章产出略少于消耗，玩家完全可能靠上一章的结余撑过去（并没有卡住）。
//   真正判「卡手」的是**累计净额转负**——那一刻玩家是真的入不敷出了。
console.log('\n【累计净额】玩家该资源至今的余额（正 = 仍有余额；负 = 入不敷出）\n')
console.log('  章 | ' + RESOURCE_ROWS.map((r) => r.label.padStart(12)).join(' | '))
for (let c = 0; c < cells.length; c++) {
  console.log(
    `  ${String(c + 1).padStart(2)} | ` +
      cells[c]
        .map((cell, i) => {
          const text = fmtFlow(cell.cumNet)
          const mark = cell.cumNet < 0 ? '✗' : cell.saturated ? '○' : ' '
          return `${text}${mark}`.padStart(12)
        })
        .join(' | '),
  )
}
console.log('  （✗ 累计为负 = 入不敷出；○ 本章只差一次消费动作 = 出口饱和）')

const failures: string[] = []
const mins: Array<{ label: string; min: number }> = RESOURCE_ROWS.map((r) => ({
  label: r.label,
  min: Infinity,
}))
for (let c = 0; c < cells.length; c++) {
  for (let r = 0; r < RESOURCE_ROWS.length; r++) {
    const cell = cells[c][r]
    const { label } = RESOURCE_ROWS[r]
    mins[r].min = Math.min(mins[r].min, cell.ratio)
    if (!cell.ok) failures.push(`第 ${c + 1} 章 ${label}${cell.reason}`)
  }
}
console.log(
  '\n  逐章最小回收比：' +
    mins.map((m) => `${m.label} ${m.min === Infinity ? '—' : m.min.toFixed(2) + '×'}`).join(' · '),
)
console.log(
  '  判定：' +
    (failures.length === 0
      ? '✓ 全部章节通过（累计净额全程 ≥0，且逐章欠账不超过一次消费动作）'
      : `✗ ${failures.join('；')}`),
)

if (OUT_PATH && !values.dry) {
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date(BASE_NOW).toISOString(),
        battlesPerDay: BATTLES_PER_DAY,
        levelsPerChapter: LEVELS_PER_CHAPTER,
        inChapterSpan: STAGE.IN_CHAPTER_SPAN,
        bossMultiplier: STAGE.BOSS_MULTIPLIER,
        designLadder: DESIGN_LADDER,
        minWinnableLadder: final.details.map((d) => d.minLevel),
        scaleAnchors: final.scales,
        powerAnchors: final.powers,
        emergentLadder: result.ladder,
        emergentLadderDays: result.ladderDays,
        chapterDays: velocity.map((v) => v.days),
        velocity: velocity.map((v, i) => ({
          chapter: i + 1,
          days: v.days,
          produced: v.produced,
          spent: v.spent,
          /** 该章末的累计净额（正 = 玩家仍有余额；负 = 入不敷出） */
          cumNet: Object.fromEntries(
            RESOURCE_ROWS.map(({ key }, idx) => [key, cells[i][idx].cumNet]),
          ),
          /** 各资源的「一次最小消费动作」粒度（回收比的容差，按本章实际最贵一次计） */
          steps: Object.fromEntries(
            RESOURCE_ROWS.map(({ key }, idx) => [key, cells[i][idx].step]),
          ),
        })),
        daysToClear: result.finalDay,
        clearedAll: result.clearedAll,
        curve: result.days,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\n机读基线：${OUT_PATH}`)
}

console.log('\n' + '='.repeat(78))
