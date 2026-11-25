/**
 * **挂机通道与材料副本刷取口径**（节奏模拟与副本产出的唯一出处 · 铁律 #4）。
 *
 * ## 四通道并行模型（挂机改版 v11 + 遗物副本 v12 · 设计稿 §3.9）
 *
 * 旧模型：主线 / 技能副本 / 强化副本**共用一份挂机时间**，玩家必须**分配**它
 *   ⇒ 工具要回答「今晚挂哪个去向」。
 * 新模型：**四条通道同时跑**，各自计量同一段墙钟时间、各自记账
 *   ⇒ 工具要回答「每条通道各自挂哪个目标」。
 *
 * | 通道 | 目标 | 产出 |
 * |---|---|---|
 * | `main` | **跟随最新通关关卡**（`stageId = null`） | 经验书 + 银两 |
 * | `skill` | 已通关的**技能副本关卡** | 对应五行的技能材料 |
 * | `enhance` | 已通关的**强化副本关卡** | 对应石档的遗物强化石 |
 * | `relic` | 已通关的**遗物副本关卡** | **遗物实例**（受每日额度约束） |
 *
 * ⚠ 挂机**不再跑战斗**——按掉落表逐次掷奖，所以「副本关卡」在挂机里
 *   只提供**产量表**，不提供战斗难度；难度只在**手动挑战**时起作用。
 *
 * ## 目标必须是「已通关」的
 *
 * 副本通道的目标必须已记录通关（`save.dungeons.cleared`）——
 * 这是「挂机永不卡关」的根本保证（设计稿 §3.1）。
 * 因此工具要区分两种「最高关」：
 *
 * - `bestDungeonStage()`：**战力门槛**打得赢的最高一关（可能还没通关）；
 * - `bestIdleDungeonStage()`：**已通关且打得赢**的最高一关（可直接当挂机目标）。
 *
 * ## 增益口径（ln · 全队口径）
 *
 * 三个**养成**通道的增益必须**同单位**（都是「全队战力相对增幅」）才能比，
 * 所以一律取 ln：
 *
 * - 主线：`人均涨级 × ln(LEVEL.MULT)`（倍率是**每个英灵**各自的）。
 * - 技能：`受影响英灵的技能等级总数 ÷ 队伍人数` = 人均技能等级 → 每级相对增益。
 * - 强化：遗物只穿在**已装备遗物的英灵**身上 ⇒ 按装备占比折算。
 *
 * ⚠ 历史教训：技能分支漏了「÷ 队伍人数」⇒ 技能增益被系统性放大 4~6 倍。
 *
 * ## 遗物通道是**第四类**产出（不参与 ln 比较）
 *
 * ⚠ 遗物是**实例**、**零成本**产出（不花银两、不发材料），而且**与其它通道并行**
 *   （不抢挂机时间）⇒ 它没有「和另外三条通道抢收益」的问题，不需要折算成战力增幅。
 *   它的价值另算：**件数 × 期望稀有度价值**（期望稀有度取 core 的公示口径
 *   `relicDropRates`，**不在工具里另写一份权重表** —— 铁律 #4）。
 *   ⚠ 唯一约束是**每日额度**（`RELIC_DROP.DAILY_CAP`）：额度用完 ⇒ 今晚产出 0，
 *   所以决策时必须把额度算进去（否则模型会以为遗物通道能无限产出）。
 *
 * ## 银两瓶颈必须进增益口径
 *
 * 副本**只发材料不发银两**，所以「一夜能升多少级」取决于**买得起多少**
 * （技能 `SKILL.SILVER_PER_LEVEL` / 级、遗物 `RELIC.SILVER_PER_LEVEL` / 级），
 * 不是「材料够多少」。
 *
 * ⚠⚠ 只看「缺口大小」会死锁：副本不发银两 → 银两耗尽 → 遗物升不动 →
 *   缺口仍在 → 策略继续把他留在副本里。
 *   ⇒ 副本必须**同时满足两个条件**才值得去：
 *     ① 材料真的不够；② 银两够（材料到了就能立刻花出去）。
 */
import { HERO_INDEX } from '../../src/core/config/heroes/index.ts'
import { EXP_BOOK_ITEM_EXP, ITEM_BY_ELEMENT } from '../../src/core/config/items.ts'
import {
  DROP_TABLES,
  LEVEL,
  RELIC,
  RELIC_DROP,
  SKILL,
  STAGE,
  DUNGEON_DIFFICULTY_ORDER,
  type DungeonDifficultyId,
  type RelicStoneTierId,
} from '../../src/core/config/economy.ts'
import {
  DUNGEON_INDEX,
  DUNGEON_VARIANTS,
  dungeonStageById,
  dungeonStagesOfVariant,
  type DungeonVariant,
  type DungeonVariantId,
} from '../../src/core/config/dungeons.ts'
import { applyAction, type ActionContext, type IdleActionResult } from '../../src/core/systems/actions.ts'
import { buildPveContext, buildTeam } from '../../src/core/systems/derive.ts'
import { atRealmGate, expToNext, skillLevelCap } from '../../src/core/systems/growth.ts'
import {
  relicMainMultiplier,
  relicQuotaLeft,
  relicStoneTierForLevel,
  relicUpgradeCost,
  relicDropRates,
  RELIC_RARITY_ORDER,
} from '../../src/core/systems/relic.ts'
import { getTeamPower } from '../../src/core/systems/team.ts'
import { dungeonUnlocked } from '../../src/core/systems/dungeons.ts'
import { referenceGearAt } from './reference-build.ts'
import type { Element, SaveData } from '../../src/core/model/types.ts'

// ─────────────────────────── 需求侧 ───────────────────────────

/** 材料缺口（按道具 id 分列；数值口径一律取 core） */
export interface MaterialDemand {
  /** 五行技能材料缺口 */
  skillMats: Record<string, number>
  /** 三档强化石缺口 */
  relicStones: Record<string, number>
}

/**
 * 队伍里所有上阵英灵的**技能材料缺口**（按道具 id 分列）。
 *
 * ⚠ 口径：
 *   技能等级上限 = `skillLevelCap(level)`（受境界压制），
 *   每级消耗 = `SKILL.MATERIAL_PER_LEVEL`，
 *   材料 id 按英灵**五行**取（唯一口径 `ITEM_BY_ELEMENT`）。
 */
export function skillMaterialDemand(
  save: SaveData,
  teamIds: readonly string[],
): Record<string, number> {
  const demand: Record<string, number> = {}
  for (const heroId of teamIds) {
    const state = save.heroes[heroId]
    if (!state) continue
    const element = HERO_INDEX.get(heroId)?.element
    if (!element) continue
    const materialId = ITEM_BY_ELEMENT[element]
    const cap = skillLevelCap(state.level)
    let need = 0
    for (const level of state.skillLevels) {
      need += Math.max(0, cap - (level ?? 0))
    }
    if (need <= 0) continue
    demand[materialId] = (demand[materialId] ?? 0) + need * SKILL.MATERIAL_PER_LEVEL
  }
  return demand
}

/**
 * 已装备遗物升到 `targetLevel` 需要的**强化石**（按道具 id 分列）。
 *
 * ⚠ 逐级取 `relicUpgradeCost(level).stones` 的**真实扣费口径**，
 *   不按「每级 2 颗」糊弄——淬炼段的价格是指数的（`STONE_COST_GROWTH`）。
 */
export function relicStoneDemand(
  save: SaveData,
  targetLevel: number,
): Record<string, number> {
  const demand: Record<string, number> = {}
  for (const equipped of Object.values(save.equipped)) {
    const relic = save.relics.find((r) => r.uid === equipped.relicId)
    if (!relic) continue
    const target = Math.min(targetLevel, RELIC.MAX_LEVEL)
    for (let l = relic.level; l < target; l++) {
      const cost = relicUpgradeCost(l)
      if (!cost) break
      for (const [id, n] of Object.entries(cost.stones)) {
        demand[id] = (demand[id] ?? 0) + (n ?? 0)
      }
    }
  }
  return demand
}

/** 需求侧汇总 */
export function materialDemand(
  save: SaveData,
  teamIds: readonly string[],
  targetRelicLevel: number,
): MaterialDemand {
  return {
    skillMats: skillMaterialDemand(save, teamIds),
    relicStones: relicStoneDemand(save, targetRelicLevel),
  }
}

// ─────────────────────────── 当前进度 vs 参考曲线 ───────────────────────────

/** 参考曲线：某等级下的遗物强化等级（走 `reference-build`，单一数据源） */
export function referenceRelicLevel(level: number): number {
  return referenceGearAt(level)[2]
}

/** 参考曲线：某等级下的技能等级 */
export function referenceSkillLevel(level: number): number {
  return referenceGearAt(level)[1]
}

/** 队伍里等级最低的上阵英灵等级（队伍是一起长的，取最低的那条线） */
export function teamLevel(save: SaveData, teamIds: readonly string[]): number {
  let min = Number.POSITIVE_INFINITY
  for (const id of teamIds) {
    const state = save.heroes[id]
    if (!state) continue
    min = Math.min(min, state.level)
  }
  return Number.isFinite(min) ? min : 1
}

/** 已装备遗物的**平均**强化等级（无装备时为 0） */
export function equippedRelicLevel(save: SaveData): number {
  const relics = equippedRelics(save)
  if (relics.length === 0) return 0
  return relics.reduce((sum, r) => sum + r.level, 0) / relics.length
}

/** 已装备遗物实例列表 */
export function equippedRelics(save: SaveData) {
  return Object.values(save.equipped)
    .map((e) => save.relics.find((r) => r.uid === e.relicId))
    .filter((r): r is NonNullable<typeof r> => !!r)
}

/** 队伍里所有上阵英灵技能的**平均**等级 */
export function teamSkillLevel(save: SaveData, teamIds: readonly string[]): number {
  let sum = 0
  let count = 0
  for (const id of teamIds) {
    const state = save.heroes[id]
    if (!state) continue
    for (const level of state.skillLevels) {
      sum += level ?? 0
      count += 1
    }
  }
  return count === 0 ? 0 : sum / count
}

/**
 * 每个五行的**技能等级缺口**（对照参考曲线的目标技能等级）。
 *
 * ⚠ 一行只能靠**自己的**副本补（副本只发所选材料），所以缺口必须按行分列。
 * ⚠ 缺口 = 参考曲线该等级的目标技能等级 − 该行英灵的**当前平均**技能等级；
 *   不是「离境界上限还差多少」——后者在低等级阶段恒为正，会让玩家一开局就刷副本。
 */
export function skillGapByElement(
  save: SaveData,
  teamIds: readonly string[],
  targetSkillLevel: number,
): Record<Element, number> {
  const sum: Record<Element, number> = {} as Record<Element, number>
  const count: Record<Element, number> = {} as Record<Element, number>
  for (const heroId of teamIds) {
    const state = save.heroes[heroId]
    if (!state) continue
    const element = HERO_INDEX.get(heroId)?.element
    if (!element) continue
    let total = 0
    for (const level of state.skillLevels) total += level ?? 0
    sum[element] = (sum[element] ?? 0) + total
    count[element] = (count[element] ?? 0) + state.skillLevels.length
  }
  const gap = {} as Record<Element, number>
  for (const element of Object.keys(sum) as Element[]) {
    const avg = count[element] > 0 ? sum[element] / count[element] : 0
    gap[element] = Math.max(0, targetSkillLevel - avg)
  }
  return gap
}

/** 某五行「还能升多少技能等级」（全行合计，受境界上限压制） */
export function skillHeadroomByElement(
  save: SaveData,
  teamIds: readonly string[],
): Record<string, number> {
  const headroom: Record<string, number> = {}
  for (const heroId of teamIds) {
    const state = save.heroes[heroId]
    if (!state) continue
    const element = HERO_INDEX.get(heroId)?.element
    if (!element) continue
    const cap = skillLevelCap(state.level)
    let levels = 0
    for (const level of state.skillLevels) levels += Math.max(0, cap - (level ?? 0))
    headroom[element] = (headroom[element] ?? 0) + levels
  }
  return headroom
}

// ─────────────────────────── 副本关卡选择 ───────────────────────────

/**
 * **副本关卡**（挂机改版 v11 + 遗物副本 v12：副本是 42 个独立关卡）。
 *
 * ⚠ 难度**不再取材主线波次**——每关有自己的敌人组合、缩放锚点与战力门槛
 *   （`core/config/dungeons.ts` 是唯一定义处）。
 */
export interface DungeonStageChoice {
  /** 副本关卡 id（`dgn_<变体>_<难度>`） */
  stageId: string
  /** 所属变体 */
  variantId: DungeonVariantId
  /** 难度档 */
  difficulty: DungeonDifficultyId
}

/** 某副本关卡的**战力门槛**（放行线；读关卡自己的配置，不是主线波次） */
export function dungeonGatePower(stageId: string): number {
  return dungeonStageById(stageId)?.powerRequired ?? 0
}

/** 队伍当前战力（与主线放行同一把尺） */
function teamPower(save: SaveData): number {
  const team = buildTeam(save)
  if (team.length === 0) return 0
  return getTeamPower(team, buildPveContext(save))
}

/**
 * 某变体下**打得赢的最高一关**（战力门槛口径）。
 *
 * ⚠ 不要求已通关——这是「下一关该挑战哪一关」的答案。
 */
export function bestDungeonStage(
  variantId: DungeonVariantId,
  save: SaveData,
  _ctx?: ActionContext,
): DungeonStageChoice | null {
  const team = buildTeam(save)
  if (team.length === 0) return null
  const power = teamPower(save)
  let best: DungeonStageChoice | null = null
  for (const stage of dungeonStagesOfVariant(variantId)) {
    if (power < stage.powerRequired) continue
    best = { stageId: stage.id, variantId, difficulty: stage.difficulty }
  }
  return best
}

/**
 * 某变体下**已通关且能打赢的最高一关**（可直接作为挂机目标）。
 *
 * ⚠ 「已通关」是硬条件——挂机只挂已通关内容（设计稿 §3.1）。
 */
export function bestIdleDungeonStage(
  variantId: DungeonVariantId,
  save: SaveData,
  _ctx?: ActionContext,
): DungeonStageChoice | null {
  const team = buildTeam(save)
  if (team.length === 0) return null
  const power = teamPower(save)
  let best: DungeonStageChoice | null = null
  for (const stage of dungeonStagesOfVariant(variantId)) {
    if (save.dungeons.cleared[stage.id] !== true) continue
    if (power < stage.powerRequired) continue
    best = { stageId: stage.id, variantId, difficulty: stage.difficulty }
  }
  return best
}

/**
 * **一件遗物的「稀有度价值」**（N=1 / R=2 / SR=3 / SSR=4）。
 *
 * ⚠ 档序取 core 的 `RELIC_RARITY_ORDER`（唯一出处），**不在工具里另写一份档序**。
 *   「价值」= 稀有度在档序里的序号 ⇒ 单位是「档」，可加、可比。
 */
export function relicRarityValue(rarity: string): number {
  const index = RELIC_RARITY_ORDER.indexOf(rarity as (typeof RELIC_RARITY_ORDER)[number])
  return index < 0 ? 0 : index + 1
}

/**
 * **一次遗物掉落的期望稀有度价值**（公示口径 `relicDropRates`，铁律 #4）。
 *
 * ⚠ 期望稀有度**必须**取 core 的公示函数（`relicDropRates`）：
 *   那是「公示 = 实际」的唯一一份口径（实际抽签 `rollRelicDrop` 也读同一张权重表）。
 *   工具里另写一份权重表 ⇒ 公示与实际对不上（合规硬伤）。
 */
export function expectedRelicRarityValue(difficulty: DungeonDifficultyId): number {
  let value = 0
  for (const rate of relicDropRates(difficulty)) {
    value += rate.percent * relicRarityValue(rate.rarity)
  }
  return value
}

/**
 * **一场胜利的期望件数**（难度档区间中值；口径取 `RELIC_DROP.COUNT`）。
 *
 * ⚠ 遗物是**实例**，产出形状与材料副本不同：
 *   材料副本 = 固定堆叠物；遗物副本 = 1~3 **件实例**（按难度档）。
 */
export function relicExpectedPieces(difficulty: DungeonDifficultyId): number {
  const range = RELIC_DROP.COUNT[difficulty]
  return (range.min + range.max) / 2
}

/**
 * 副本关卡一夜（`rolls` 次）的**期望产量**。
 *
 * ⚠ **两种单位**（按关卡种类分流，调用方必须知道自己在比什么）：
 *   - 材料副本 → **件数**（堆叠物，产量区间中值 × 次数）；
 *   - 遗物副本 → **期望稀有度价值**（件数 × 期望稀有度价值）——
 *     遗物是**实例**，不能按堆叠物计（同一件遗物不能被"缩放"成 2.5 件）。
 *
 * ⚠ 遗物副本的 `drop` 是 `null`（遗物不是堆叠物）⇒ 直接读 `stage.drop` 会崩，
 *   这里必须先分流（这正是存档 v12 把 `drop` 改成可空的原因）。
 */
export function dungeonExpectedYield(stageId: string, rolls: number): number {
  const stage = dungeonStageById(stageId)
  if (!stage) return 0
  if (stage.relicPool) {
    // 遗物副本：件数 × 期望稀有度价值
    return relicExpectedPieces(stage.difficulty) * expectedRelicRarityValue(stage.difficulty) * rolls
  }
  if (!stage.drop) return 0
  return Math.round(((stage.drop.min + stage.drop.max) / 2) * rolls)
}

/** 变体是否已解锁（副本入口的门槛判定，转调 core） */
export function variantUnlocked(save: SaveData, variant: DungeonVariant): boolean {
  return dungeonUnlocked(save, variant).unlocked
}

// ─────────────────────────── 通道决策 ───────────────────────────

/**
 * 一个通道「一夜」的**战力增益**（ln 口径，三个养成通道放在一起比）。
 *
 * ⚠ 为什么用 ln：战力是几个**乘区**相乘的（等级 × 遗物倍率 × 技能强度 × 星级），
 *   所以「战力涨了多少」用**相对变化**才有意义，而相对变化取 ln 之后可加：
 *   ln(新战力/旧战力) = Σ 各乘区的相对变化。
 */
export interface NightGains {
  /** 主线：经验书换等级 */
  campaign: number
  /** 强化副本：石头换遗物强化等级 */
  enhance: number
  /** 技能副本：五行材料换技能等级 */
  skill: number
  /**
   * 遗物副本：**件数 × 期望稀有度价值**。
   *
   * ⚠ 单位与上面三条**不同**（那是 ln 战力增幅，这是「稀有度档」）。
   *   遗物是**零成本**产出、且与其它通道**并行**（不抢时间）⇒ 没有互相挤压，
   *   不需要折算成战力增幅；它只受**每日额度**约束。
   */
  relic: number
}

/**
 * 四通道的目标计划（与 core 的 `IdleChannelTarget` 同形）。
 *
 * ⚠ `relic` 是**可选**键：它是存档 v12 新增的第四键，
 *   旧的三键调用点（测试里的字面量）不必改也能编译 ⇒ 决策器永远会给出它，
 *   但「手写一份三键计划」的调用方不会被类型卡住。
 */
export interface ChannelPlan {
  /** 主线通道：跟随最新通关关卡（`stageId = null`） */
  main: { kind: 'main'; stageId: number | null }
  /** 技能通道：目标副本关卡 id（`null` = 关闭） */
  skill: string | null
  /** 强化通道：目标副本关卡 id（`null` = 关闭） */
  enhance: string | null
  /** 遗物通道：目标遗物副本关卡 id（`null` / 省略 = 关闭） */
  relic?: string | null
}

/** 通道决策的完整结果（增益明细留给报告用） */
export interface ChannelDecision {
  plans: ChannelPlan
  gains: NightGains
  /** 技能副本选中的五行 */
  skillElement: Element | null
  /** 强化副本选中的石档 */
  enhanceTier: RelicStoneTierId | null
  /** 遗物副本选中的变体 id */
  relicVariantId: DungeonVariantId | null
  /**
   * **需要手动挑战才能解锁的副本关卡**。
   *
   * ⚠ 副本通道的目标必须**已通关**才能挂 ⇒ 选中的关卡若还没通关，
   *   玩家要先手动挑战一次（`dungeon.challenge`）把它打通。
   */
  challenges: string[]
}

/** 该章普通关的**每场期望经验**（经验书折算） */
export function expectedExpPerBattle(chapter: number): number {
  const table = DROP_TABLES[`stage_${chapter}`]
  if (!table) return 0
  let exp = 0
  for (const drop of table.items) {
    const face = EXP_BOOK_ITEM_EXP[drop.id]
    if (!face) continue
    exp += (drop.chance / 100) * ((drop.min + drop.max) / 2) * face
  }
  return exp
}

/** 全队「升一级」需要的经验合计（境界门槛上的英灵不计入——那里的经验兑现不了） */
export function teamExpToNext(save: SaveData, teamIds: readonly string[]): number {
  let sum = 0
  for (const id of teamIds) {
    const state = save.heroes[id]
    if (!state) continue
    if (atRealmGate(state.level)) continue
    sum += Math.max(0, expToNext(state.level) - state.exp)
  }
  return Math.max(1, sum)
}

/**
 * **为四条通道各选目标**（**理性玩家模型** · 挂机改版 v11 + 遗物副本 v12 · 设计稿 §3.9）。
 *
 * ## 增益口径（同单位才能比）
 *
 * - 主线：经验书 → 等级；`人均涨级 × ln(LEVEL.MULT)`。
 * - 技能：缺口最大的五行 → 该变体**打得赢的最高一关**的产量 → 买得起的技能等级。
 * - 强化：缺口最大的石档 → 同理。
 * - 遗物：**零成本**产出（不花银两 / 不发材料，且与其它通道并行不抢时间）
 *   ⇒ 不参与 ln 比较，价值按「件数 × 期望稀有度价值」计，
 *   并受**每日额度**（`RELIC_DROP.DAILY_CAP`）约束。
 *
 * ## 四条硬约束（否则会死锁 / 空转）
 *
 * 1. **副本必须已解锁**（core 的 `dungeonUnlocked`）——不替玩家开挂。
 * 2. **银两必须够下一次升级**——副本只发材料不发银两，
 *    银两不够还去刷副本 = 白刷一天（历史上模拟在这条上死锁过）。
 * 3. **境界门槛上主线是唯一出路**——经验卡在门槛不兑现，
 *    突破要银两、而银两只有主线给 ⇒ 门槛上的主线增益 = ∞。
 * 4. **遗物通道要算额度**——额度用完 ⇒ 今晚产出 0（不是「少产出」，是「没有产出」）。
 */
export function decideChannels(
  save: SaveData,
  ctx: ActionContext,
  teamIds: readonly string[],
  rollsPerNight: number,
  /**
   * **即将结算的时刻**（可选，默认 = `ctx.now`）。
   *
   * ⚠ 为什么需要它：**每日额度**按 UTC 日期判定，而「决策」发生在结算**之前**
   *   （目标是存档状态，它决定这段挂机归谁 —— 设计稿 §3）。
   *   ⇒ 判断「遗物通道这一段能不能产出」必须看**结算那一刻**的额度：
   *   决策时额度往往已经被上一段用完了（跨日才重置），
   *   拿决策时的额度去判断 ⇒ 每天都判成「额度用完」⇒ 第四通道永远选不上。
   */
  settleAt: number = ctx.now,
): ChannelDecision {
  const gains: NightGains = { campaign: 0, enhance: 0, skill: 0, relic: 0 }
  const challenges: string[] = []
  /**
   * 队伍人数（**全队口径的分母**）。
   *
   * ⚠ 三个通道的增益必须**同单位**才能比：都是「全队战力相对增幅（ln）」。
   *   - 主线：`人均涨级 × ln(LEVEL.MULT)`（倍率是**每个英灵**各自的）
   *   - 技能：受影响英灵的技能等级**总数** ÷ 队伍人数 = 人均技能等级
   *   - 强化：遗物只穿在**已装备遗物的英灵**身上 ⇒ 按装备占比折算
   */
  const teamSize = Math.max(1, teamIds.length)

  // ── 主线：经验书换等级（跟随最新通关关卡） ──
  const chapter = Math.min(
    STAGE.CHAPTERS,
    Math.max(1, Math.ceil((save.campaign.clearedStage + 1) / (STAGE.STAGES_PER_CHAPTER + 1))),
  )
  const nightlyExp = expectedExpPerBattle(chapter) * rollsPerNight
  const levelGain = nightlyExp / teamExpToNext(save, teamIds)
  gains.campaign = levelGain * Math.log(LEVEL.MULT)
  // ⚠ 境界门槛：经验卡在门槛上不兑现，突破要银两而银两只有主线给
  if (teamIds.some((id) => atRealmGate(save.heroes[id]?.level ?? 1))) {
    gains.campaign = Number.POSITIVE_INFINITY
  }

  // ── 强化副本：石头换遗物强化等级 ──
  const relics = equippedRelics(save)
  let enhanceTier: RelicStoneTierId | null = null
  let enhanceStageId: string | null = null
  if (relics.length > 0) {
    const lowest = Math.min(...relics.map((r) => r.level))
    const avg = equippedRelicLevel(save)
    const tier = relicStoneTierForLevel(lowest + 1)
    const cost = relicUpgradeCost(lowest)
    if (tier && cost) {
      const variant = DUNGEON_VARIANTS.find((v) => v.kind === 'enhance' && v.tier === tier.id)
      const stonesPerLevel = cost.stones[tier.id] ?? 0
      const tierInfo = RELIC.STONE_TIERS.find((t) => t.id === tier.id)
      // 本档位还剩多少级可升（越过档位边界就要换另一种石头了）
      const rangeLeft = tierInfo ? Math.max(0, tierInfo.maxLevel - avg) : 0
      const choice = variant ? pickDungeonTarget(variant, save) : null
      const fromYield =
        choice && stonesPerLevel > 0
          ? dungeonExpectedYield(choice.stageId, rollsPerNight) / (stonesPerLevel * relics.length)
          : 0
      /**
       * ⚠ **银两瓶颈**：每件遗物升 1 级要 `cost.silver` 银两，
       *   而强化是**轮转**（每件都升），所以「每件 +1 级」的银两成本是
       *   `cost.silver × 遗物件数`。不按买得起的算 ⇒ 模型会高估一整夜的强化收益。
       */
      const affordable = Math.floor(
        save.player.silver / (cost.silver * Math.max(1, relics.length)),
      )
      const levels = Math.min(fromYield, rangeLeft, affordable)
      if (
        levels > 0 &&
        choice &&
        variant &&
        variantUnlocked(save, variant) &&
        save.player.silver >= cost.silver
      ) {
        // ⚠ 队伍口径：只有**已装备遗物的英灵**吃得到这个倍率
        const share = Math.min(1, relics.length / teamSize)
        gains.enhance =
          share * Math.log(relicMainMultiplier(avg + levels) / relicMainMultiplier(avg))
        enhanceTier = tier.id
        enhanceStageId = choice.stageId
        if (!choice.cleared) challenges.push(choice.stageId)
      }
    }
  }

  // ── 技能副本：五行材料换技能等级 ──
  const headroom = skillHeadroomByElement(save, teamIds)
  const avgSkill = teamSkillLevel(save, teamIds)
  let bestElement: Element | null = null
  let bestGain = 0
  let skillStageId: string | null = null
  for (const element of Object.keys(headroom) as Element[]) {
    const levels = headroom[element] ?? 0
    if (levels <= 0) continue
    const variant = DUNGEON_VARIANTS.find((v) => v.kind === 'skill' && v.element === element)
    if (!variant) continue
    if (!variantUnlocked(save, variant)) continue
    if (save.player.silver < SKILL.SILVER_PER_LEVEL) continue
    const choice = pickDungeonTarget(variant, save)
    if (!choice) continue
    const material = dungeonExpectedYield(choice.stageId, rollsPerNight)
    /**
     * ⚠ **银两瓶颈**：技能每级要 `SKILL.SILVER_PER_LEVEL` 银两。
     *   不按买得起的算 ⇒ 模型会说「一夜买满全部剩余技能等级」，
     *   而玩家根本买不起（材料够了、银两不够）。
     */
    const affordable = Math.floor(save.player.silver / SKILL.SILVER_PER_LEVEL)
    const bought = Math.min(levels, material / SKILL.MATERIAL_PER_LEVEL, affordable)
    if (bought <= 0) continue
    // 技能强度倍率 = 1 + 0.02 × (等级 - 1)，每级的相对增益 = 0.02 / 倍率
    const perLevel =
      SKILL.PCT_PER_LEVEL / (1 + SKILL.PCT_PER_LEVEL * Math.max(0, avgSkill - 1))
    // ⚠ 队伍口径：`bought` 是**受影响英灵**的技能等级总数 ⇒ 除以队伍人数得人均值
    const gain = (bought / teamSize) * perLevel
    if (gain > bestGain) {
      bestGain = gain
      bestElement = element
      skillStageId = choice.stageId
      if (!choice.cleared) challenges.push(choice.stageId)
    }
  }
  gains.skill = bestGain

  // ── 遗物副本：零成本产出，但受每日额度约束 ──
  //
  // ⚠ **遗物是唯一来源**（存档 v12）：强化副本要求「持有 Lv1 遗物」，
  //   遗物副本不通 ⇒ 首件遗物拿不到 ⇒ 强化链路整条锁死。
  //   所以这条通道**不受银两瓶颈约束**（遗物不花钱），也不和其它通道抢时间。
  //
  // ⚠ **额度必须进决策**：额度按「件」计（`RELIC_DROP.DAILY_CAP`），
  //   额度用完 ⇒ 今晚产出 0（不是「少产出」，是「没有产出」）⇒ 不该挂。
  let relicStageId: string | null = null
  let relicVariantId: DungeonVariantId | null = null
  const quotaLeft = relicQuotaLeft(save, settleAt)
  if (quotaLeft > 0) {
    const pick = bestRelicDungeonStage(save)
    if (pick) {
      const piecesPerWin = relicExpectedPieces(pick.difficulty)
      // 今晚实际能产出的件数 = 「掷奖能出的件数」与「剩余额度」的较小者
      const producible = Math.min(rollsPerNight * piecesPerWin, quotaLeft)
      gains.relic = producible * expectedRelicRarityValue(pick.difficulty)
      relicStageId = pick.stageId
      relicVariantId = pick.variantId
      if (!pick.cleared) challenges.push(pick.stageId)
    }
  }

  return {
    plans: {
      main: { kind: 'main', stageId: null },
      skill: skillStageId,
      enhance: enhanceStageId,
      relic: relicStageId,
    },
    gains,
    skillElement: bestElement,
    enhanceTier,
    relicVariantId,
    challenges,
  }
}

/** 副本目标选取结果（附带「是否已通关」） */
export interface DungeonTargetPick extends DungeonStageChoice {
  /** 是否已通关（未通关 ⇒ 需要先手动挑战） */
  cleared: boolean
}

/**
 * 选副本目标：**优先已通关的最高关**；没有已通关的可挂关卡时，
 * 退而取「打得赢的最高关」（并要求玩家先手动挑战打通）。
 */
function pickDungeonTarget(variant: DungeonVariant, save: SaveData): DungeonTargetPick | null {
  const idle = bestIdleDungeonStage(variant.id, save)
  if (idle) return { ...idle, cleared: true }
  const winnable = bestDungeonStage(variant.id, save)
  if (!winnable) return null
  return { ...winnable, cleared: save.dungeons.cleared[winnable.stageId] === true }
}

/**
 * 选**遗物副本**的挂机目标（**跨 6 个遗物变体**挑，存档 v12）。
 *
 * ⚠ 挑选规则（按优先级）：
 *   ① **已通关**——挂机只挂已通关内容（核心的 `idle.setChannel` 会拒未通关的关卡）；
 *   ② **难度更高**——每胜件数更多（`RELIC_DROP.COUNT` 的 hard 档是 2~3 件）。
 *
 * ⚠ **不替玩家开挂**：变体必须已解锁（`RELIC_DROP.UNLOCK_STAGE` 的主线进度线），
 *   关卡必须**打得赢**（战力门槛）。
 *
 * ⚠ 手动挑战也用这个函数挑目标：打通了同一关 ⇒ 它随后就能当挂机目标
 *   （挂机只挂已通关内容，设计稿 §3.1）。
 */
export function bestRelicDungeonStage(save: SaveData): DungeonTargetPick | null {
  const power = teamPower(save)
  const diffRank = (d: DungeonDifficultyId) => DUNGEON_DIFFICULTY_ORDER.indexOf(d)
  let best: DungeonTargetPick | null = null
  for (const variant of DUNGEON_VARIANTS) {
    if (variant.kind !== 'relic') continue
    if (!variantUnlocked(save, variant)) continue
    for (const stage of dungeonStagesOfVariant(variant.id)) {
      if (power < stage.powerRequired) continue
      const pick: DungeonTargetPick = {
        stageId: stage.id,
        variantId: variant.id,
        difficulty: stage.difficulty,
        cleared: save.dungeons.cleared[stage.id] === true,
      }
      if (!best) {
        best = pick
        continue
      }
      if (pick.cleared !== best.cleared) {
        if (pick.cleared) best = pick
        continue
      }
      if (diffRank(pick.difficulty) > diffRank(best.difficulty)) best = pick
    }
  }
  return best
}

/**
 * 选四通道目标（`decideChannels` 的薄封装）。
 *
 * ⚠ 保留薄封装是为了让两个模拟脚本的调用点保持一致；
 *   完整决策明细用 `decideChannels`。
 */
export function chooseChannels(
  save: SaveData,
  ctx: ActionContext,
  teamIds: readonly string[],
  rollsPerNight: number,
): ChannelPlan {
  return decideChannels(save, ctx, teamIds, rollsPerNight).plans
}

/**
 * 下一件遗物升级的成本（取**等级最低**的那件——养成动作就是轮转升最低的那件）。
 *
 * ⚠ 没有已装备遗物时返回 null（还没有可升的对象）。
 */
export function nextRelicUpgradeCost(save: SaveData): ReturnType<typeof relicUpgradeCost> {
  const relics = equippedRelics(save)
  if (relics.length === 0) return null
  const lowest = Math.min(...relics.map((r) => r.level))
  return relicUpgradeCost(lowest)
}

/** 通道目标的展示名（取 core 的登记表，禁止就地写中文名——铁律 #8） */
export function targetPlanName(plan: ChannelPlan): string {
  const parts: string[] = ['主线']
  if (plan.skill) {
    const stage = dungeonStageById(plan.skill)
    parts.push(stage ? `技能 · ${stage.name}` : '技能副本')
  }
  if (plan.enhance) {
    const stage = dungeonStageById(plan.enhance)
    parts.push(stage ? `强化 · ${stage.name}` : '强化副本')
  }
  if (plan.relic) {
    const stage = dungeonStageById(plan.relic)
    parts.push(stage ? `遗物 · ${stage.name}` : '遗物副本')
  }
  return parts.join(' / ')
}

// ─────────────────────────── 执行 ───────────────────────────

/**
 * 应用四通道目标（走真实动作层）。
 *
 * ⚠ **四条通道各自独立**：设置一条**不影响**另外两条的时间账本。
 * ⚠ **相同目标直接返回**（`idle.setChannel` 是无操作，不报错）。
 */
export function applyChannels(
  save: SaveData,
  ctx: ActionContext,
  plans: ChannelPlan,
): boolean {
  let ok = true
  // 主线：跟随最新通关关卡
  ok = applyChannel(save, ctx, 'main', { kind: 'main', stageId: plans.main.stageId }) && ok
  if (plans.skill) {
    ok =
      applyChannel(save, ctx, 'skill', { kind: 'skill', dungeonStageId: plans.skill }) && ok
  }
  if (plans.enhance) {
    ok =
      applyChannel(save, ctx, 'enhance', { kind: 'enhance', dungeonStageId: plans.enhance }) && ok
  }
  // 遗物通道：目标为空 ⇒ **不动它**（别把玩家已经挂好的遗物目标清掉）
  if (plans.relic) {
    ok =
      applyChannel(save, ctx, 'relic', { kind: 'relic', dungeonStageId: plans.relic }) && ok
  }
  return ok
}

/** 设置单条通道（走真实动作层） */
export function applyChannel(
  save: SaveData,
  ctx: ActionContext,
  channel: 'main' | 'skill' | 'enhance' | 'relic',
  target:
    | { kind: 'main'; stageId: number | null }
    | { kind: 'skill'; dungeonStageId: string }
    | { kind: 'enhance'; dungeonStageId: string }
    | { kind: 'relic'; dungeonStageId: string },
): boolean {
  const res = applyAction(save, { type: 'idle.setChannel', channel, ...target }, ctx)
  return res.ok
}

/**
 * 手动挑战一个副本关卡（走真实动作层）。
 *
 * ⚠ 副本目标必须**已通关**才能挂 ⇒ 工具选中的关卡若还没通关，
 *   就用这个入口把它打通（真实战斗，真实判定）。
 *
 * @returns 是否挑战成功（战败返回 false，存档不变）
 */
export function challengeDungeonStage(
  save: SaveData,
  ctx: ActionContext,
  stageId: string,
): boolean {
  const res = applyAction(save, { type: 'dungeon.challenge', stageId }, ctx)
  return res.ok && res.result.win
}

/**
 * 结算四通道的挂机收益（`idle.tick`）。
 *
 * ⚠ **不调用 heartbeat**：计量一律走动作层自己的四通道结算
 *   （累计离线时长口径），避免在段内重复套用离线曲线把有效时长放大。
 */
export function settleIdle(save: SaveData, ctx: ActionContext): IdleActionResult | null {
  const res = applyAction(save, { type: 'idle.tick' }, ctx)
  return res.ok ? res.result : null
}

/** 汇总一次结算的单条通道产出（工具内部按通道取数） */
export function channelRewards(
  result: IdleActionResult | null,
  channel: 'main' | 'skill' | 'enhance' | 'relic',
): { silver: number; items: Record<string, number>; rolls: number } {
  const out = { silver: 0, items: {} as Record<string, number>, rolls: 0 }
  for (const detail of result?.channels ?? []) {
    if (detail.channel !== channel) continue
    out.silver += detail.rewards.silver ?? 0
    out.rolls += detail.rolls
    for (const [id, n] of Object.entries(detail.rewards.items ?? {})) {
      out.items[id] = (out.items[id] ?? 0) + n
    }
  }
  return out
}
