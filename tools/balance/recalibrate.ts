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
import { atRealmGate, realmBreakCost, skillLevelCap } from '../../src/core/systems/growth.ts'
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
import { feedBooks, itemsToExp, materialTotals, storedExp } from './item-flow.ts'
import {
  applyChannels,
  bestRelicDungeonStage,
  challengeDungeonStage,
  decideChannels,
  targetPlanName,
  teamSkillLevel,
} from './dungeon-loop.ts'
import { ITEM_BY_ELEMENT, type ItemId } from '../../src/core/config/items.ts'
import {
  EXP_BOOK,
  IDLE,
  LEVEL,
  RELIC,
  SKILL,
  STAGE,
  STAR,
  START_ITEMS,
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
    /**
     * 每天**手动挑战**主线关卡数上限（挂机改版 v11）。
     *
     * ⚠ 挂机不再跑战斗 ⇒ 主线推进**只能**靠手动挑战 ⇒ 曲线的推进速度
     *   由这个值决定。默认 8：310 关 / 40 天 ≈ 7.75 关/天。
     */
    challengesPerDay: { type: 'string', default: '8' },
    /**
     * 每天**手动挑战遗物副本**的场次（存档 v12：遗物只来自遗物副本）。
     *
     * ⚠ 祈愿已下线 ⇒ 遗物改走遗物副本（`dungeon.challenge`）。
     *   遗物是**零成本**产出（不花银两）⇒ 银两不再有「祈愿」这个出口。
     *
     * ⚠ 这是**模拟口径**（玩家不是无限刷的机器人），不是经济数值 ⇒
     *   与 `challengesPerDay` 同类，住在工具的命令行参数里。
     */
    relicRunsPerDay: { type: 'string', default: '2' },
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
const CHALLENGES_PER_DAY = Math.max(0, Number(values.challengesPerDay) || 0)
const RELIC_RUNS_PER_DAY = Math.max(0, Number(values.relicRunsPerDay) || 0)
const OUT_PATH = values.out ? resolve(process.cwd(), values.out) : ''

const HOUR_MS = 3_600_000
const BASE_NOW = Date.UTC(2026, 0, 5, 4, 0, 0)
const SEED = 20260105
/**
 * 每个「挂机日」的**掷奖次数**（每条通道各自一份）。
 *
 * ⚠ 口径必须走 core 的**离线效率曲线**（`computeOfflineEfficiency`），
 *   不能拿「满效率小时数 × 场次/小时」糊弄：
 *   真实玩家每天上线的收益是 f(离线时长)，不是 f(FULL_EFFICIENCY_HOURS)——
 *   尾部衰减与 CAP_HOURS 封顶都在 f 里（铁律 #1：口径必须复用 core）。
 *
 * ⚠ **挂机改版 v11**：挂机不再跑战斗，节奏单位从「战斗耗时」变成
 *   **掉落掷奖间隔**（`IDLE.SECONDS_PER_ROLL`）。两者数值都是 6 秒，
 *   但语义完全不同，名字必须跟着语义走（铁律 #4）。
 */
const ROLLS_PER_DAY = Math.floor(
  (computeOfflineEfficiency(OFFLINE_HOURS * 3600) * 3600) / IDLE.SECONDS_PER_ROLL,
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
 *   **同名碎片**——那是**真实流入**，发生在第 1 章。
 *   漏记它会让第 1 章的「产出 ÷ 消耗」凭空少一块，闸门会报一个**不存在的**卡手。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：重复卡**只**给同名碎片
 *   （印记与「N 卡重复给银两」两条旧路径同时退役），所以转化收益记在 `shards` 上。
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
  gachaFlow.shards = Object.values(pulled.result.shards).reduce((a, b) => a + b, 0)
  return { teamIds: team.map((h) => h.id), gachaFlow }
}

// ─────────────────────────── 养成策略 ───────────────────────────

/**
 * 一段时间内的资源收支（产出 / 消耗都是**真实动作结果**的累加，不是复算的规则）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：维度换成了
 *   经验（经验书折算）/ 银两 / 五行技能材料 / 三档强化石 / 同名碎片；
 *   术式结晶、遗物强化石（单一通用材料）、英灵印记全部退役。
 *   `items` 保留**逐道具 id 的明细**（技能材料按五行、强化石按档位），JSON 基线要靠它。
 */
interface ResourceFlow {
  silver: number
  /** 经验（经验书折算） */
  exp: number
  /** 五行技能材料合计 */
  skillMats: number
  /** 三档强化石合计 */
  relicStones: number
  /** 同名英灵碎片 */
  shards: number
  /** 遗物实例（只有产出侧有） */
  relics: number
  /** 逐道具 id 明细（技能材料按五行 / 强化石按档位） */
  items: Record<string, number>
}

function emptyFlow(): ResourceFlow {
  return {
    silver: 0,
    exp: 0,
    skillMats: 0,
    relicStones: 0,
    shards: 0,
    relics: 0,
    items: {},
  }
}

function addFlow(target: ResourceFlow, src: ResourceFlow): void {
  target.silver += src.silver
  target.exp += src.exp
  target.skillMats += src.skillMats
  target.relicStones += src.relicStones
  target.shards += src.shards
  target.relics += src.relics
  for (const [id, count] of Object.entries(src.items)) {
    target.items[id] = (target.items[id] ?? 0) + count
  }
}

/** 把一批道具折进流量（产出侧用） */
function addItemsToFlow(flow: ResourceFlow, items: Partial<Record<ItemId, number>> | undefined): void {
  if (!items) return
  const materials = materialTotals(items)
  flow.exp += itemsToExp(items)
  flow.skillMats += materials.skillMats
  flow.relicStones += materials.relicStones
  for (const [id, count] of Object.entries(items)) {
    flow.items[id] = (flow.items[id] ?? 0) + (count ?? 0)
  }
}

/**
 * 把资源按固定优先级花掉（与 newplayer.ts 的「理性玩家」模型一致）：
 *   ① 等级：喂给等级最低的上阵英灵；② 境界：卡门槛且银两够就突破；
 *   ③ 遗物强化：轮转升级；④ 技能升级：剩下的五行技能材料。
 *
 * ⚠ 返回**实际消耗**：每个消耗量都取自动作结果（`FeedBooksResult.applied` /
 *   `RelicUpgradeResult.cost` / 境界突破成本），不复算一遍扣费口径——
 *   复算就会和游戏实际扣的钱对不上（铁律 #4）。
 */
function spendGrowth(
  save: SaveData,
  ctx: ActionContext,
  teamIds: string[],
): { spent: ResourceFlow; maxAction: { silver: number; relicStones: number; skillMats: number; shards: number } } {
  const spent = emptyFlow()
  /**
   * 本次养成里**最贵的单次消费动作**。
   *
   * ⚠ 这是回收比容差的来源：淬炼段的一次强化要几十万银两，
   *   拿「基础 500」当粒度会把「差一步」误判成「缺一大截」。
   */
  const maxAction = { silver: 0, relicStones: 0, skillMats: 0, shards: 0 }
  let guard = 0
  while (guard++ < 5000) {
    const states = teamIds.map((id) => save.heroes[id]).filter((s): s is NonNullable<typeof s> => !!s)
    if (states.length === 0) break
    const target = states.sort((a, b) => a.level - b.level || b.exp - a.exp)[0]

    if (atRealmGate(target.level)) {
      // 突破成本要在**突破前**取：突破后等级跨入新境界，成本就变了
      const breakCost = realmBreakCost(target.level)
      const broke = applyAction(save, { type: 'hero.breakRealm', heroId: target.id }, ctx)
      if (broke.ok) {
        // ⚠ **实施修正（资源/背包版本 v10）**：突破改扣**银两**（印记已退役）
        spent.silver += breakCost?.silver ?? 0
        maxAction.silver = Math.max(maxAction.silver, breakCost?.silver ?? 0)
        continue
      }
      const alt = states.filter((s) => !atRealmGate(s.level)).sort((a, b) => a.level - b.level)[0]
      if (!alt) break
      const fed = feedBooks(save, ctx, alt.id)
      if (!fed.fed) break
      spent.exp += fed.exp
      continue
    }

    const fed = feedBooks(save, ctx, target.id)
    if (!fed.fed) break
    spent.exp += fed.exp
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
    if (save.player.silver < cost.silver) break
    // ⚠ 强化石**按档位拆分**：逐档比对背包里的持有量
    let stoneShort = false
    for (const [id, n] of Object.entries(cost.stones)) {
      if ((save.items[id as ItemId] ?? 0) < (n ?? 0)) {
        stoneShort = true
        break
      }
    }
    if (stoneShort) break
    const up = applyAction(save, { type: 'relic.upgrade', uid: relic.uid }, ctx)
    if (!up.ok) break
    spent.silver += up.result.cost.silver
    // ⚠ 强化石按档位累加（`cost.stones` 是 map，不再是单个数字）
    for (const [id, n] of Object.entries(up.result.cost.stones)) {
      spent.relicStones += n ?? 0
      spent.items[id] = (spent.items[id] ?? 0) + (n ?? 0)
    }
    maxAction.silver = Math.max(maxAction.silver, up.result.cost.silver)
    maxAction.relicStones = Math.max(
      maxAction.relicStones,
      ...Object.values(up.result.cost.stones).map((n) => n ?? 0),
    )
  }

  let skillGuard = 0
  while (skillGuard++ < 400) {
    let upgraded = false
    for (const heroId of teamIds) {
      const state = save.heroes[heroId]
      if (!state) continue
      const element = HERO_INDEX.get(heroId)?.element
      if (!element) continue
      // ⚠ 技能材料按**英灵五行**取（唯一口径 `ITEM_BY_ELEMENT`）
      const materialId = ITEM_BY_ELEMENT[element]
      for (let index = 0; index < state.skillLevels.length; index++) {
        if ((state.skillLevels[index] ?? 0) >= skillLevelCap(state.level)) continue
        if ((save.items[materialId] ?? 0) < SKILL.MATERIAL_PER_LEVEL) continue
        if (save.player.silver < SKILL.SILVER_PER_LEVEL) continue
        const up = applyAction(save, { type: 'hero.upgradeSkill', heroId, index }, ctx)
        if (up.ok) {
          spent.skillMats += SKILL.MATERIAL_PER_LEVEL
          spent.items[materialId] = (spent.items[materialId] ?? 0) + SKILL.MATERIAL_PER_LEVEL
          spent.silver += SKILL.SILVER_PER_LEVEL
          maxAction.silver = Math.max(maxAction.silver, SKILL.SILVER_PER_LEVEL)
          maxAction.skillMats = Math.max(maxAction.skillMats, SKILL.MATERIAL_PER_LEVEL)
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
  /**
   * 上阵英灵技能的**平均**等级（参考养成曲线的实测依据）。
   *
   * ⚠ 技能等级受境界上限压制（`skillLevelCap`），
   *   所以它与「等级」不是同一条曲线，必须单独看。
   */
  skillLevel: number
  /** 上阵英灵的**平均**星级（同名碎片的升星维度；模拟里没有碎片来源 ⇒ 恒为 1） */
  starLevel: number
  /** 当天实际结算的掷奖次数（四通道合计） */
  rolls: number
  /** 当天被卡住的关卡（手动挑战打不赢的那一关） */
  blockedAtStage: number | null
  /** 当天手动挑战打通的关卡数（主线推进只能靠它） */
  manualWins: number
  /**
   * 当天**用的挂机去向**（主线 / 技能副本 · 五行 / 强化副本 · 石档）。
   *
   * ⚠ 副本不写 `campaign`：去向切到副本的那几天，关卡进度是**停**的。
   */
  target: string
  /** 当天的产出（真实挂机回放的奖励包，含主线首通掉落） */
  produced: ResourceFlow
  /** 当天的养成消耗（真实动作结果累加） */
  spent: ResourceFlow
  /**
   * 英灵身上**存着**的经验（已投入、还没兑现成等级）。
   *
   * ⚠ 这部分经验是玩家**可用的**，算净余额时必须加上，
   *   否则会误报「入不敷出」（经验书是离散单位，一喂就是整本，存量必然很大）。
   */
  expInFlight: number
  /** 当天做过的**最贵的一次消费动作**（回收比容差的来源） */
  maxAction: { silver: number; relicStones: number; skillMats: number; shards: number }
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
 * **手动挑战主线关卡**（挂机改版 v11：主线推进只走手动挑战）。
 *
 * ⚠ 挂机不再跑战斗 ⇒ 关卡进度**不会**自己往前走。
 *   模型口径：玩家每次上线打若干关，**打不赢就停**（等明天的养成把战力拉上去）。
 *
 * ⚠ 走**真实动作层**（`campaign.challenge`）⇒ 战斗判定、奖励、首通保底
 *   全部是 core 的真实逻辑，不是复算的规则。
 *
 * @returns 战败停下的那一关（= 玩家卡住的地方）、当天打通的关卡数
 */
function runManualCampaignChallenges(
  save: SaveData,
  ctx: ActionContext,
  limit: number,
): { blockedAt: number | null; wins: number } {
  let wins = 0
  for (let i = 0; i < limit; i++) {
    const next = save.campaign.clearedStage + 1
    if (next > STAGES.length) break
    const res = applyAction(save, { type: 'campaign.challenge', stageId: next }, ctx)
    if (!res.ok) return { blockedAt: next, wins }
    if (!res.result.win) return { blockedAt: next, wins }
    wins++
  }
  return { blockedAt: null, wins }
}

/** 资源快照（银两 / 道具 / 结晶）——用来算动作的**净产出** */
function snapshotResources(save: SaveData): {
  silver: number
  crystals: number
  items: Record<string, number>
} {
  return {
    silver: save.player.silver,
    crystals: save.player.crystals,
    items: { ...save.items },
  }
}

/**
 * 两个资源快照的**差**（产出侧）。
 *
 * ⚠ 为什么用差值而不是动作回包：`campaign.challenge` 首通时会在内部
 *   结清主线通道，那部分奖励**直接入库、不在回包里**——
 *   只看回包会凭空少记一块产出，回收比直接失真。
 */
function diffResources(
  before: ReturnType<typeof snapshotResources>,
  after: ReturnType<typeof snapshotResources>,
): { silver: number; items: Record<string, number> } {
  const silver = after.silver - before.silver
  const items: Record<string, number> = {}
  for (const [id, count] of Object.entries(after.items)) {
    const diff = count - (before.items[id] ?? 0)
    if (diff > 0) items[id] = diff
  }
  return { silver, items }
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

    // ── ① 玩家上线：手动挑战（挂机改版 v11） ──
    //
    // ⚠ **主线推进只走手动挑战**（`campaign.challenge`）：挂机不再跑战斗，
    //   关卡进度**不会**自己往前走 ⇒ 40 天曲线由「每天打几关」驱动
    //   （`CHALLENGES_PER_DAY`）。
    //
    // ⚠ **副本也要手动挑战**才解锁挂机（`dungeon.challenge`）——
    //   挂机目标必须**已通关**（设计稿 §3.1）。
    //
    // ⚠ 手动挑战的产出用**资源差值**统计，不用动作回包：
    //   `campaign.challenge` 首通时会在内部结清主线通道，
    //   那部分奖励**不在回包里**（直接入库），漏记就会凭空少一块产出。
    const beforeChallenge = snapshotResources(save)
    const mainResult = runManualCampaignChallenges(save, ctx, CHALLENGES_PER_DAY)
    const draft = decideChannels(save, ctx, teamIds, ROLLS_PER_DAY, ctx.now + OFFLINE_HOURS * HOUR_MS)
    for (const stageId of draft.challenges) {
      challengeDungeonStage(save, ctx, stageId)
    }
    const challengeFlow = diffResources(beforeChallenge, snapshotResources(save))

    // ── 遗物副本：遗物的**唯一来源**（存档 v12） ──
    //
    // ⚠ 祈愿已下线（`relic.acquire` 已从动作层移除）：
    //   遗物改由**遗物副本**产出（`dungeon.challenge` → `rewards.relics`）。
    //   ⇒ 银两**不再**有「祈愿」这个出口（遗物是零成本产出）。
    //
    // ⚠ **每天限量**：手动挑战遗物副本的场次由 `RELIC_RUNS_PER_DAY` 给
    //   （模拟口径，不是经济数值）——模拟玩家不是无限刷的机器人。
    //
    // ⚠ 目标关卡取「**打得赢的最高**遗物副本关卡」（`bestRelicDungeonStage`）：
    //   与挂机通道选的是同一关 ⇒ 手动挑战顺带把它**打通**，
    //   之后它就能当挂机目标（挂机只挂已通关内容）。
    // ⚠ 放在**挂机结算之前**：打通了 ⇒ 第四通道（遗物）当天的挂机产出才有着落。
    const relicTarget = bestRelicDungeonStage(save)
    let relicWins = 0
    if (relicTarget) {
      for (let i = 0; i < RELIC_RUNS_PER_DAY; i++) {
        if (!challengeDungeonStage(save, ctx, relicTarget.stageId)) break
        relicWins++
      }
      if (relicWins > 0) {
        // 新遗物立即按推荐穿上（否则强化链路拿不到可升的对象）
        for (const heroId of teamIds) {
          applyAction(save, { type: 'relic.autoEquip', heroId }, ctx)
        }
      }
    }

    // ── ② 定四通道目标（必须在离线期开始之前） ──
    //
    // ⚠ **目标是存档状态**：它决定了「下一段离线期归谁」。
    //   切换时服务端先按**旧目标**结清，所以这里必须在
    //   「那段挂机时间开始之前」选，而不是在结算之后。
    //
    // ⚠ **四通道并行**（挂机改版 v11 + 遗物副本 v12）：不用分配时间，
    //   每条通道各自拿满同一段墙钟时间。
    const decision = decideChannels(save, ctx, teamIds, ROLLS_PER_DAY, ctx.now + OFFLINE_HOURS * HOUR_MS)
    applyChannels(save, ctx, decision.plans)
    const todayTargetName = targetPlanName(decision.plans)

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
    // ④ 领奖：四通道按各自预算结算（次数由服务端按账本决定，客户端只是上限）
    const tick = applyAction(save, { type: 'idle.tick' }, ctx)
    const idleResult = tick.ok ? tick.result : null

    // 当天的产出：直接取真实挂机回放的奖励包（**分通道**）
    const produced = emptyFlow()
    for (const detail of idleResult?.channels ?? []) {
      produced.silver += detail.rewards.silver ?? 0
      // ⚠ **实施修正（资源/背包版本 v10）**：经验书 → 经验折算，
      //   技能材料 / 强化石按道具 id 归类（主线只掉经验书与银两；
      //   材料只能靠**刷副本**拿到——技能 / 强化通道各自发自己的材料）。
      addItemsToFlow(produced, detail.rewards.items)
      produced.shards += Object.values(detail.rewards.shards ?? {}).reduce((a, b) => a + b, 0)
      produced.relics += detail.rewards.relics?.length ?? 0
    }
    // 手动挑战的产出（基础掉落 + 首通经验书保底 + 首通时结清的主线通道）
    produced.silver += challengeFlow.silver
    addItemsToFlow(produced, challengeFlow.items)
    // ⚠ **遗物副本手动挑战的产出**（存档 v12）：遗物是**实例**，
    //   不走 `items`（堆叠道具）⇒ 单独记进 `produced.relics`。
    produced.relics += relicWins
    // ⚠ **新号启动资金 + 新手十连的重复转化计入第 1 章的产出**：
    //   `createNewSave` 给的新号启动资金（银两 5 万 / 起步经验书）是真实流入，
    //   只是发生在 t=0、不在挂机回包里；新手十连的重复转化（同名碎片）同理——
    //   它们都发生在第 1 章。不计它们的话，第 1 章的「产出 ÷ 消耗」必然 <1
    //   （消耗把启动资金花掉了），闸门会报一个**不存在的**卡手。
    if (day === 1) {
      produced.silver += START_RESOURCES.silver + gachaFlow.silver
      addItemsToFlow(produced, START_ITEMS)
      produced.shards += gachaFlow.shards
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
    // 技能 / 星级：养成链路的另外两个乘区，与等级、遗物等级并排看
    const skillLevel = teamSkillLevel(save, teamIds)
    const starLevel =
      teamIds.length > 0
        ? teamIds.reduce((sum, id) => sum + (save.heroes[id]?.star ?? 1), 0) / teamIds.length
        : 1

    days.push({
      day,
      clearedStage: save.campaign.clearedStage,
      chapter: Math.min(STAGE.CHAPTERS, Math.ceil(save.campaign.clearedStage / 31)),
      chapterAtStart,
      level,
      power,
      /** 经验（经验书折算；玩家经验池已退役） */
      exp: itemsToExp(save.items),
      silver: save.player.silver,
      relics: save.relics.length,
      relicLevel: Math.round(relicLevel * 10) / 10,
      skillLevel: Math.round(skillLevel * 10) / 10,
      starLevel: Math.round(starLevel * 10) / 10,
      /** 当天实际结算的掷奖次数（四通道合计） */
      rolls: idleResult?.rolls ?? 0,
      /** 当天被卡住的关卡（手动挑战打不赢的那一关） */
      blockedAtStage: mainResult.blockedAt,
      /** 当天手动挑战打通的关卡数 */
      manualWins: mainResult.wins,
      target: todayTargetName,
      produced,
      spent,
      /** 英灵身上存着的经验（已投入、未兑现） */
      expInFlight: storedExp(save),
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
  `  每通道每挂机日 ${ROLLS_PER_DAY} 次掷奖（离线 ${OFFLINE_HOURS}h → 折算 ` +
    `${computeOfflineEfficiency(OFFLINE_HOURS * 3600).toFixed(2)}h 有效时长` +
    `${ONLINE_HOURS > 0 ? ` + 在线 ${ONLINE_HOURS}h` : ''}）· 节奏验证 ${DAYS} 天`,
)
console.log(
  `  手动挑战 ${CHALLENGES_PER_DAY} 关/天 · 遗物副本 ${RELIC_RUNS_PER_DAY} 场/天` +
    `（挂机改版 v11 + 遗物副本 v12：主线推进只走手动挑战，四通道并行）`,
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
console.log(
  '  天 | 关卡 | 章 | 等级 | 战力 | 掷奖 | 手动 | 卡关 | 经验 | 银两 | 遗物 | 遗物等级 | 技能等级 | 星级 | 通道',
)
for (const d of result.days) {
  console.log(
    `  ${String(d.day).padStart(2)} | ${String(d.clearedStage).padStart(4)} | ` +
      `${String(d.chapter).padStart(2)} | ${String(d.level).padStart(3)} | ` +
      `${Math.round(d.power).toString().padStart(9)} | ${String(d.rolls).padStart(4)} | ` +
      `${String(d.manualWins).padStart(4)} | ` +
      `${String(d.blockedAtStage ?? '-').padStart(4)} | ` +
      `${Math.round(d.exp).toString().padStart(11)} | ` +
      `${Math.round(d.silver).toString().padStart(12)} | ${String(d.relics).padStart(4)} | ` +
      `${d.relicLevel.toString().padStart(6)} | ${d.skillLevel.toString().padStart(6)} | ` +
      `${d.starLevel.toString().padStart(4)} | ${d.target}`,
  )
}

// ── 速度口径：产出速度 vs 消耗速度（§5.8）──
//
// ⚠ 为什么不能用「主线 310 关首通投放 ÷ 满养成消耗」的**存量**口径：
//   挂机游戏里经验的产出主体是**挂机刷取**（每天上千次掷奖），
//   主线 310 次首通只是零头（实测 4384万 vs 满养成 26.5亿 = 0.02×）。
//   存量口径把零头当成全部产出，结论必然是「缺口」，而玩家实际并不缺经验。
//   §5.8 原文就是「产出速度 vs 消耗速度」——这里按章聚合真实链路的收支。
//
// ⚠ 两侧都是**真实动作结果**：
//   产出 = `idle.tick` 返回的奖励包（含主线首通掉落）；
//   消耗 = 喂经验书 / 境界突破 / 遗物强化 / 技能升级的动作回包累加。

interface ChapterVelocity {
  days: number
  produced: ResourceFlow
  spent: ResourceFlow
  /**
   * 本章末英灵身上**存着**的经验（已投入、未兑现成等级）。
   *
   * ⚠ 算经验的净余额时必须加上：经验书是离散单位，一喂就是整本，
   *   存量必然很大——不算进去会误报「入不敷出」。
   */
  expInFlight: number
  /** 本章做过的最贵的一次消费动作（回收比容差的来源） */
  maxAction: { silver: number; relicStones: number; skillMats: number; shards: number }
}

const velocity: ChapterVelocity[] = Array.from({ length: STAGE.CHAPTERS }, () => ({
  days: 0,
  produced: emptyFlow(),
  spent: emptyFlow(),
  expInFlight: 0,
  maxAction: { silver: 0, relicStones: 0, skillMats: 0, shards: 0 },
}))
for (const d of result.days) {
  const v = velocity[d.chapterAtStart - 1]
  v.days += 1
  addFlow(v.produced, d.produced)
  addFlow(v.spent, d.spent)
  // 章末的存量 = 该章最后一天的存量
  v.expInFlight = d.expInFlight
  v.maxAction.silver = Math.max(v.maxAction.silver, d.maxAction.silver)
  v.maxAction.relicStones = Math.max(v.maxAction.relicStones, d.maxAction.relicStones)
  v.maxAction.skillMats = Math.max(v.maxAction.skillMats, d.maxAction.skillMats)
  v.maxAction.shards = Math.max(v.maxAction.shards, d.maxAction.shards)
}

function ratioCell(supply: number, need: number): string {
  if (need <= 0) return '—'
  return `${(supply / need).toFixed(2)}×`
}

/**
 * 资源键 → 展示名（表格顺序）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：术式结晶 / 遗物强化石（单一通用材料）
 *   与英灵印记全部退役，换成：
 *     · 五行技能材料（副本专属，按英灵五行分列，判定时取合计）；
 *     · 三档强化石（副本专属，按档位分列，判定时取合计）；
 *     · 同名碎片（升星专用，印记的接班人）。
 */
const RESOURCE_ROWS = [
  { key: 'exp', label: '经验' },
  { key: 'silver', label: '银两' },
  { key: 'skillMats', label: '五行技能材料' },
  { key: 'relicStones', label: '三档强化石' },
  { key: 'shards', label: '同名碎片' },
] as const

type ResourceKey = (typeof RESOURCE_ROWS)[number]['key']

/**
 * 每个资源「**一次最小消费动作**」的成本——回收比的**容差**。
 *
 * ⚠ 容差**不是**随手取的小 epsilon，而是游戏自己的**决策粒度**：
 *   产出与消耗都是离散动作（一次遗物强化 = 500 银两 + 2 石、一次喂经验书 = 1,000 经验），
 *   所以「差一次动作」不是缺钱，而是**出口已饱和**——
 *   玩家的钱正好用来买了下一次升级，剩下的不够再买一次。
 *   回收阀门建好之后，逐章比值会**贴着 1.0 上下摆动**，
 *   那正是「钱没有堆积」的签名，不是卡手。
 *   超过一步长才是真的卡手（玩家攒不够一次升级，只能干等产出）。
 *
 * ⚠ 遗物强化的**单价随进度变贵**（淬炼段指数上升），
 *   所以银两 / 强化石的粒度必须取**玩家在该章实际付过的最贵一次**，
 *   不能用基础价 500 / 2 ——否则会把「差一步」误判成「缺一大截」。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：
 *   - 经验的一次动作 = 喂**一本小经验书**（`EXP_BOOK.small.exp`）；
 *   - 术式结晶 → 五行技能材料，一次动作 = `SKILL.MATERIAL_PER_LEVEL`；
 *   - 遗物强化石 → 三档强化石，一次动作 = `RELIC.STONES_PER_LEVEL`（标准段）；
 *   - 英灵印记 → 同名碎片，一次动作 = `STAR.SHARDS_PER_STAR`。
 */
const STATIC_STEP: Record<ResourceKey, number> = {
  exp: EXP_BOOK.small.exp,
  silver: RELIC.SILVER_PER_LEVEL,
  skillMats: SKILL.MATERIAL_PER_LEVEL,
  relicStones: RELIC.STONES_PER_LEVEL,
  shards: STAR.SHARDS_PER_STAR,
}

/**
 * 该章该资源的「差一步」容差。
 *
 * ⚠ **存量资源**（银两 / 五行材料 / 强化石 / 碎片）的容差取三者的较大值：
 *   ① 一次消费动作的粒度；
 *   ② 本章**每会话平均**产出；
 *   ③ **玩家一个会话的产出能力**（截至本章为止，该资源单会话产出的历史最大值）。
 *
 *   为什么必须有 ③：材料副本模型下**产出按夜结算、消耗按结算批量发生**——
 *   副本夜**只发材料不发银两**，而一夜的养成会把余额一次性花光。
 *   于是「本章产出 < 本章消耗」是**常态**（跨章结转），
 *   玩家可以靠上一章的结余撑过去（并没有卡住）。
 *   ③ 的含义 = 「玩家欠的量不超过他一个会话能挣回来的量」⇒ 下一夜就补得回来 ⇒ 不算卡手。
 *   ⚠ 不能只用 ②：某章恰好**一个副本夜都没有**时 ② = 0（该章没产出），
 *   而这一章恰恰可能是**把上一章结余花掉**的那一章（实测第 3 章强化石）。
 *
 * ⚠ **经验**是流量资源（经验书到账即喂，喂书动作贪婪），天然贴着 1.0 走
 *   ⇒ 容差只取「一次喂书」的面值。
 */
function stepOf(
  key: ResourceKey,
  chapterMaxAction: { silver: number; relicStones: number; skillMats: number; shards: number },
  perSession: number,
  capability: number,
): number {
  if (key === 'exp') return STATIC_STEP.exp
  if (key === 'silver') {
    return Math.max(STATIC_STEP.silver, chapterMaxAction.silver, perSession, capability)
  }
  if (key === 'relicStones') {
    return Math.max(STATIC_STEP.relicStones, chapterMaxAction.relicStones, perSession, capability)
  }
  if (key === 'skillMats') {
    return Math.max(STATIC_STEP.skillMats, chapterMaxAction.skillMats, perSession, capability)
  }
  if (key === 'shards') {
    return Math.max(STATIC_STEP.shards, chapterMaxAction.shards, perSession, capability)
  }
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
    '技能材料 比 | 强化石 比 | 碎片 比',
)
console.log('  ' + '-'.repeat(104))

const cells: VelocityCell[][] = []
const cumNet: Record<ResourceKey, number> = {
  exp: 0,
  silver: 0,
  skillMats: 0,
  relicStones: 0,
  shards: 0,
}

/**
 * 「玩家一个会话的产出能力」：截至第 C 章，该资源**单会话**产出的历史最大值。
 *
 * ⚠ 容差要用它（而不是本章平均）：某章可能一个副本夜都没有 → 本章平均 = 0，
 *   而那一章恰恰可能是「把上一章结余花掉」的那一章（跨章结转，不是卡手）。
 */
const capabilityByChapter: Array<Record<ResourceKey, number>> = []
{
  const cap: Record<ResourceKey, number> = {
    exp: 0,
    silver: 0,
    skillMats: 0,
    relicStones: 0,
    shards: 0,
  }
  for (let c = 0; c < velocity.length; c++) {
    for (const d of result.days) {
      if (d.chapterAtStart - 1 !== c) continue
      for (const { key } of RESOURCE_ROWS) {
        cap[key] = Math.max(cap[key], d.produced[key])
      }
    }
    capabilityByChapter.push({ ...cap })
  }
}

for (const [index, v] of velocity.entries()) {
  const chapterRow: VelocityCell[] = RESOURCE_ROWS.map(({ key }) => {
    const produced = v.produced[key]
    const spent = v.spent[key]
    const net = produced - spent
    cumNet[key] += net
    // ⚠ 经验维度要加上英灵身上**存着**的经验（已投入、未兑现）——
    //   它是玩家可用的经验，不加就会误报「入不敷出」。
    const inFlight = key === 'exp' ? v.expInFlight : 0
    const cum = cumNet[key] + inFlight
    const step = stepOf(
      key,
      v.maxAction,
      v.days > 0 ? v.produced[key] / v.days : 0,
      capabilityByChapter[index]?.[key] ?? 0,
    )
    // ⚠ 判定口径只有一份：`tools/balance/recycle-verdict.ts`
    //   （工具与单测共用，铁律 #4 / #29）。
    const verdict = judgeRecycle({ produced, spent, cumNet: cum, step })
    return {
      produced,
      spent,
      ratio: verdict.ratio,
      net,
      cumNet: cum,
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
      `${ratioCell(p.skillMats, s.skillMats).padStart(10)} | ` +
      `${ratioCell(p.relicStones, s.relicStones).padStart(8)} | ` +
      `${ratioCell(p.shards, s.shards).padStart(7)}`,
  )
}
console.log(
  '\n  注：材料两维（技能材料 / 强化石）**只从副本产出**——'
    + '模拟里挂机去向切到副本的那几天才有流入，'
    + '其余天数的去向是主线（副本不写 campaign，关卡进度会停）。',
)

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
      ? '✓ 全部章节通过（累计净额全程 ≥0，且逐章欠账不超过「差一步」的容差）'
      : `✗ ${failures.join('；')}`),
)

if (OUT_PATH && !values.dry) {
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date(BASE_NOW).toISOString(),
        rollsPerDayPerChannel: ROLLS_PER_DAY,
        challengesPerDay: CHALLENGES_PER_DAY,
        /**
         * 每天**手动挑战遗物副本**的场次（存档 v12）。
         *
         * ⚠ 旧键 `relicsPerDay` 是「每天祈愿遗物件数」——祈愿已下线，
         *   口径换成「遗物副本场次」（量纲一致：件/天 ≈ 场/天）。
         */
        relicRunsPerDay: RELIC_RUNS_PER_DAY,
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
