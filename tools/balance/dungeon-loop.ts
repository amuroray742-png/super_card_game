/**
 * **材料副本刷取口径**（节奏模拟与副本产出的唯一出处 · 铁律 #4）。
 *
 * ## 为什么单独一份
 *
 * `newplayer.ts`（新号首日）与 `recalibrate.ts`（40 天关卡曲线）都要回答同一个问题：
 * 「玩家怎么刷副本拿材料、刷多少、去向怎么切」。
 * 各写一份必然对不上——而副本产出的材料是**养成链路的唯一入口**，
 * 口径一旦分叉，模拟出来的养成速度与真实游戏对不上，整条曲线都会偏。
 *
 * ## 时间账本口径（**最容易被写错的一段**）
 *
 * 游戏的三个去向（主线 / 技能副本 / 强化副本）**共用一份挂机时间账本**，
 * 切换时服务端**先按旧去向结清**再换新去向（设计稿 §3）。
 * 由此推出三条硬约束，本模块的策略全部建立在它们之上：
 *
 * 1. **去向是存档状态**：玩家「上次设的去向」决定了「这段离线期归谁」。
 *    所以模拟里「选去向」必须发生在**那段挂机时间开始之前**。
 * 2. **一段离线期的有效时长是一整块**：core 的离线曲线按「累计离线时长」折算，
 *    而累计时长**只在玩家活跃（onlineMs > 0）时归零**。
 *    ⇒ 一段 24h 离线期的有效预算（f(24h) = 2.6h）**无法在期间拆分给两个去向**：
 *    中途切换只会让这一整块按**旧去向**结清。
 *    ⇒ 模拟里的时间单位必须是「一段完整的会话」（recalibrate = 1 天 1 段，
 *    newplayer = 1 小时 1 段），**在段与段之间**切去向。
 * 3. **段内不能重复套用离线曲线**：只要在段内让租约生效（onlineMs > 0），
 *    累计离线时长就会归零，离线曲线被**重新**跑一遍 ⇒ 有效时长成倍膨胀。
 *    本模块的 `settleIdle` **不调用 heartbeat**，
 *    计量一律走动作层自己的 `settleIdleLedger`（累计口径，不重复套曲线）。
 *
 * ## 策略口径：按「一夜能换多少战力」分配挂机时间
 *
 * 三个去向**共用一份挂机时间**，所以玩家必须**分配**它。
 * 分配的依据只有一个：**这一夜挂在这个去向上，战力涨得最多**。
 *
 * | 去向 | 一夜产出 | 换到的东西 | 增益（ln 口径 · **全队口径**） |
 * |---|---|---|---|
 * | 主线 | 经验（+银两） | 等级 | **人均**Δ等级 × ln(1.03) |
 * | 强化副本 | 强化石 | 遗物强化等级 | ln(新倍率/旧倍率) × **已装备遗物的英灵占比** |
 * | 技能副本 | 五行材料 | 技能等级 | **技能等级总数 ÷ 队伍人数** × 0.02/技能倍率 |
 *
 * ⚠ 用 ln（相对变化）而不是绝对战力：战力是几个**乘区**相乘的
 *   （等级 × 遗物倍率 × 技能强度 × 星级），只有相对变化才能放在一个尺度上比。
 *
 * ⚠⚠ **三个去向必须同单位**（都是「全队战力相对增幅」）才能比。
 *   历史上技能分支漏了「÷ 队伍人数」——`bought` 是**受影响英灵**的技能等级总数，
 *   直接当全队增益用 ⇒ 技能增益被系统性放大 4~6 倍 ⇒
 *   新号开局「先刷 6 小时技能副本、主线一关不打」（首日第 123 关 → 第 85 关）。
 *
 * ⚠⚠ **银两瓶颈必须进增益口径**：副本**只发材料不发银两**，
 *   所以「一夜能升多少级」取决于**买得起多少**（技能 800/级、遗物 500/级），
 *   不是「材料够多少」。只按材料算 ⇒ 模型会说「一夜买满全部剩余技能」，
 *   而玩家根本买不起（实测：新号开局 50,000 银两只够买 62 级，模型却按 120 级算）。
 *
 * ⚠⚠ **踩过的坑：只看「缺口大小」会死锁**。
 *   早期版本「缺口最大的一维就去刷对应副本」，结果模拟第 2 天就卡死：
 *   玩家进了强化副本 → 副本**只发材料、不发银两** → 银两耗尽 →
 *   遗物升不动 → 缺口仍在 → 策略继续把他留在副本里 → 40 天零推进。
 *   ⇒ 副本必须**同时满足两个条件**才值得去：
 *     ① 材料（石头 / 五行材料）**真的不够**；
 *     ② 银两**够**（材料到了就能立刻花出去，不至于白刷一天）。
 *   银两不够 ⇒ 回主线（银两只有主线能给）。
 *
 * ⚠ **参考曲线（`reference-build`）是难度标定的尺，不是玩家的养成上限**。
 *   真实玩家手里有银两就会继续强化遗物（上限 Lv200），
 *   所以遗物维度按**石档结构 + 边际收益**自然收敛：淬炼段每级只 +0.6%，
 *   边际收益很快低于主线 ⇒ 玩家会自己停下来（这正是「回收阀门」的设计意图）。
 */
import { HERO_INDEX } from '../../src/core/config/heroes/index.ts'
import { EXP_BOOK_ITEM_EXP, ITEM_BY_ELEMENT, type ItemId } from '../../src/core/config/items.ts'
import {
  DROP_TABLES,
  DUNGEON_DIFFICULTIES,
  LEVEL,
  RELIC,
  SKILL,
  STAGE,
  type DungeonDifficultyId,
  type RelicStoneTierId,
} from '../../src/core/config/economy.ts'
import {
  DUNGEON_VARIANTS,
  dungeonDropAmount,
  type DungeonVariant,
} from '../../src/core/config/dungeons.ts'
import { STAGES } from '../../src/core/config/stages.ts'
import { applyAction, type ActionContext, type IdleActionResult } from '../../src/core/systems/actions.ts'
import { buildPveContext, buildTeam } from '../../src/core/systems/derive.ts'
import { atRealmGate, expToNext, skillLevelCap } from '../../src/core/systems/growth.ts'
import {
  relicMainMultiplier,
  relicStoneTierForLevel,
  relicUpgradeCost,
} from '../../src/core/systems/relic.ts'
import { getTeamPower } from '../../src/core/systems/team.ts'
import { dungeonUnlocked, suggestLowerDifficulty } from '../../src/core/systems/dungeons.ts'
import { referenceGearAt } from './reference-build.ts'
import type { Element, IdleTarget, SaveData } from '../../src/core/model/types.ts'

// ─────────────────────────── 类型 ───────────────────────────

/** 挂机去向（与 core 的 `IdleTarget` 同形） */
export interface IdleTargetPlan {
  kind: 'campaign' | 'skill' | 'enhance'
  /** 技能副本：五行 */
  element?: Element
  /** 强化副本：石档 */
  tier?: RelicStoneTierId
  /** 副本难度（主线去向不用） */
  difficulty?: DungeonDifficultyId
}

/** 材料缺口（按道具 id 分列；数值口径一律取 core） */
export interface MaterialDemand {
  /** 五行技能材料缺口 */
  skillMats: Record<string, number>
  /** 三档强化石缺口 */
  relicStones: Record<string, number>
}

// ─────────────────────────── 需求侧 ───────────────────────────

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

// ─────────────────────────── 副本难度 ───────────────────────────

/**
 * 某难度取材章节的 **BOSS 关卡门槛**（战力放行线）。
 *
 * ⚠ 副本波次 = 该章**全部**主线关卡（含章末 BOSS），所以判定口径取 BOSS：
 *   BOSS 都打不过，这一档就整体打不过（与主线放行口径同一把尺）。
 */
export function dungeonGatePower(difficulty: DungeonDifficultyId): number {
  const chapter = DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.chapter ?? 1
  const boss = STAGES.find((s) => s.chapter === chapter && s.isBoss)
  return boss?.powerRequired ?? 0
}

/**
 * 队伍**打得赢的最高难度**。
 *
 * ⚠ 口径与主线放行一致：`power >= powerRequired`（`idle.ts` 的推进判定同款）。
 *   副本产量随难度倍率走（1.0 / 1.6 / 2.6），所以玩家一定选最高能打的那档。
 */
export function bestDungeonDifficulty(save: SaveData, ctx: ActionContext): DungeonDifficultyId {
  const team = buildTeam(save)
  if (team.length === 0) return 'easy'
  const power = getTeamPower(team, buildPveContext(save))
  let best: DungeonDifficultyId = 'easy'
  for (const d of DUNGEON_DIFFICULTIES) {
    if (power >= dungeonGatePower(d.id)) best = d.id
  }
  return best
}

/** 副本一夜（`battles` 场）的**期望产量**（按难度倍率取整后的 min/max 中值） */
export function dungeonExpectedYield(
  variant: DungeonVariant,
  difficulty: DungeonDifficultyId,
  battles: number,
): number {
  const drop = dungeonDropAmount(variant, difficulty)
  return Math.round(((drop.min + drop.max) / 2) * battles)
}

// ─────────────────────────── 去向决策 ───────────────────────────

/**
 * 一个去向「一夜」的**战力增益**（ln 口径，三个去向放在一起比）。
 *
 * ⚠ 为什么用 ln：战力是几个**乘区**相乘的（等级 × 遗物倍率 × 技能强度 × 星级），
 *   所以「战力涨了多少」用**相对变化**才有意义，而相对变化取 ln 之后可加：
 *   ln(新战力/旧战力) = Σ 各乘区的相对变化。
 *   直接比「绝对战力」会把量级大的维度（等级）天然压过量级小的维度（技能）。
 */
export interface NightGains {
  /** 主线：经验换等级 */
  campaign: number
  /** 强化副本：石头换遗物强化等级 */
  enhance: number
  /** 技能副本：五行材料换技能等级 */
  skill: number
}

/** 去向决策的完整结果（增益明细留给报告用） */
export interface IdleTargetDecision {
  plan: IdleTargetPlan
  gains: NightGains
  /** 技能副本候选里增益最大的那一行 */
  skillElement: Element | null
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
 * 按「一夜能换多少战力」选挂机去向（**理性玩家模型**）。
 *
 * ## 三条硬约束（否则会死锁 / 空转）
 *
 * 1. **副本必须已解锁**（core 的 `dungeonUnlocked`）——不替玩家开挂。
 * 2. **银两必须够下一次升级**——副本只发材料不发银两，
 *    银两不够还去刷副本 = 白刷一天（历史上模拟在这条上死锁过）。
 * 3. **境界门槛上主线是唯一出路**——经验卡在门槛不兑现，
 *    突破要银两、而银两只有主线给 ⇒ 门槛上的主线增益 = ∞。
 */
export function decideIdleTarget(
  save: SaveData,
  ctx: ActionContext,
  teamIds: readonly string[],
  difficulty: DungeonDifficultyId | undefined,
  battlesPerNight: number,
): IdleTargetDecision {
  const planDifficulty = difficulty ?? bestDungeonDifficulty(save, ctx)
  const gains: NightGains = { campaign: 0, enhance: 0, skill: 0 }
  /**
   * 队伍人数（**全队口径的分母**）。
   *
   * ⚠ 三个去向的增益必须**同单位**才能比：都是「全队战力相对增幅（ln）」。
   *   - 主线：`人均涨级 × ln(LEVEL.MULT)`（倍率是**每个英灵**各自的）
   *   - 技能：受影响英灵的技能等级**总数** ÷ 队伍人数 = 人均技能等级
   *   - 强化：遗物只穿在**已装备遗物的英灵**身上 ⇒ 按装备占比折算
   *   历史上技能分支漏了这个分母 ⇒ 技能增益被系统性放大 4~6 倍，
   *   新号会「开局先刷 6 小时技能副本、主线一关不打」。
   */
  const teamSize = Math.max(1, teamIds.length)

  // ── 主线：经验换等级 ──
  const chapter = Math.min(
    STAGE.CHAPTERS,
    Math.max(1, Math.ceil((save.campaign.clearedStage + 1) / (STAGE.STAGES_PER_CHAPTER + 1))),
  )
  const nightlyExp = expectedExpPerBattle(chapter) * battlesPerNight
  const levelGain = nightlyExp / teamExpToNext(save, teamIds)
  gains.campaign = levelGain * Math.log(LEVEL.MULT)
  // ⚠ 境界门槛：经验卡在门槛上不兑现，突破要银两而银两只有主线给
  if (teamIds.some((id) => atRealmGate(save.heroes[id]?.level ?? 1))) {
    gains.campaign = Number.POSITIVE_INFINITY
  }

  // ── 强化副本：石头换遗物强化等级 ──
  const relics = equippedRelics(save)
  let enhanceTier: RelicStoneTierId | null = null
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
      const fromYield =
        variant && stonesPerLevel > 0
          ? dungeonExpectedYield(variant, planDifficulty, battlesPerNight) /
            (stonesPerLevel * relics.length)
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
        variant &&
        dungeonUnlocked(save, variant).unlocked &&
        save.player.silver >= cost.silver
      ) {
        // ⚠ 队伍口径：只有**已装备遗物的英灵**吃得到这个倍率
        const share = Math.min(1, relics.length / teamSize)
        gains.enhance =
          share * Math.log(relicMainMultiplier(avg + levels) / relicMainMultiplier(avg))
        enhanceTier = tier.id
      }
    }
  }

  // ── 技能副本：五行材料换技能等级 ──
  const headroom = skillHeadroomByElement(save, teamIds)
  const avgSkill = teamSkillLevel(save, teamIds)
  let bestElement: Element | null = null
  let bestGain = 0
  for (const [element, levels] of Object.entries(headroom)) {
    if (levels <= 0) continue
    const variant = DUNGEON_VARIANTS.find(
      (v) => v.kind === 'skill' && v.element === (element as Element),
    )
    if (!variant) continue
    if (!dungeonUnlocked(save, variant).unlocked) continue
    if (save.player.silver < SKILL.SILVER_PER_LEVEL) continue
    const material = dungeonExpectedYield(variant, planDifficulty, battlesPerNight)
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
      bestElement = element as Element
    }
  }
  gains.skill = bestGain

  // ── 取增益最大的去向 ──
  if (enhanceTier && gains.enhance > gains.campaign && gains.enhance > gains.skill) {
    return {
      plan: { kind: 'enhance', tier: enhanceTier, difficulty: planDifficulty },
      gains,
      skillElement: bestElement,
    }
  }
  if (bestElement && gains.skill > gains.campaign) {
    return {
      plan: { kind: 'skill', element: bestElement, difficulty: planDifficulty },
      gains,
      skillElement: bestElement,
    }
  }
  return { plan: { kind: 'campaign' }, gains, skillElement: bestElement }
}

/**
 * 选挂机去向（`decideIdleTarget` 的薄封装）。
 *
 * ⚠ 保留旧名字是为了让两个模拟脚本的调用点保持一致；
 *   完整决策明细用 `decideIdleTarget`。
 */
export function chooseIdleTarget(
  save: SaveData,
  ctx: ActionContext,
  teamIds: readonly string[],
  difficulty: DungeonDifficultyId | undefined,
  battlesPerNight: number,
): IdleTargetPlan {
  return decideIdleTarget(save, ctx, teamIds, difficulty, battlesPerNight).plan
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

/**
 * 副本难度自适应。
 *
 * ⚠ 战败就**降一档**（core 的 `suggestLowerDifficulty` 口径）；
 *   没战败就按当前战力重新取最高档（战力只涨不跌，所以难度可以稳步往上走）。
 *
 * @param blockedDifficulty 本段副本战败时的难度（null = 没战败）
 */
export function resolveDungeonDifficulty(
  save: SaveData,
  ctx: ActionContext,
  blockedDifficulty: DungeonDifficultyId | null,
): DungeonDifficultyId {
  if (blockedDifficulty) {
    return suggestLowerDifficulty(blockedDifficulty) ?? 'easy'
  }
  return bestDungeonDifficulty(save, ctx)
}

/** 去向的展示名（取 core 的登记表，禁止就地写中文名——铁律 #8） */
export function targetPlanName(plan: IdleTargetPlan): string {
  if (plan.kind === 'campaign') return '主线'
  if (plan.kind === 'skill') {
    const variant = DUNGEON_VARIANTS.find((v) => v.kind === 'skill' && v.element === plan.element)
    return variant?.name ?? '技能副本'
  }
  const variant = DUNGEON_VARIANTS.find((v) => v.kind === 'enhance' && v.tier === plan.tier)
  return variant?.name ?? '强化副本'
}

// ─────────────────────────── 执行 ───────────────────────────

/**
 * 切换挂机去向（走真实动作层）。
 *
 * ⚠ 切换**本身不产生场次**：它先把旧去向的预算结清，再写新去向（设计稿 §3）。
 *   所以必须在「那段挂机时间开始之前」调用——去向是存档状态，
 *   决定了后面那段离线期归谁。
 *
 * ⚠ **目标没变就不动**：`idle.setTarget` 会清掉 `save.idle.farm`
 *   （回退刷取状态），而主线卡关时靠它「先刷低关攒资源再回头挑战」。
 *   每天无脑重设一遍主线目标 = 每天把回退刷取进度清零。
 */
export function applyIdleTarget(
  save: SaveData,
  ctx: ActionContext,
  plan: IdleTargetPlan,
): boolean {
  if (sameTarget(save.idle.target, plan)) return true
  if (plan.kind === 'campaign') {
    const res = applyAction(save, { type: 'idle.setTarget', kind: 'campaign' }, ctx)
    return res.ok
  }
  if (plan.kind === 'skill') {
    const res = applyAction(
      save,
      {
        type: 'idle.setTarget',
        kind: 'skill',
        element: plan.element as Element,
        difficulty: plan.difficulty ?? 'easy',
      },
      ctx,
    )
    return res.ok
  }
  const res = applyAction(
    save,
    {
      type: 'idle.setTarget',
      kind: 'enhance',
      tier: plan.tier as RelicStoneTierId,
      difficulty: plan.difficulty ?? 'easy',
    },
    ctx,
  )
  return res.ok
}

/** 两个去向是否等价（kind + 变体 + 难度都一致） */
export function sameTarget(current: IdleTarget, plan: IdleTargetPlan): boolean {
  if (current.kind !== plan.kind) return false
  if (current.kind === 'campaign') return true
  if (current.kind === 'skill') {
    return (
      current.element === plan.element &&
      current.difficulty === (plan.difficulty ?? 'easy')
    )
  }
  return current.tier === plan.tier && current.difficulty === (plan.difficulty ?? 'easy')
}

/**
 * 结算当前去向的挂机收益（`idle.tick`）。
 *
 * ⚠ **不调用 heartbeat**：计量一律走动作层自己的 `settleIdleLedger`
 *   （累计离线时长口径），避免在段内重复套用离线曲线把有效时长放大。
 *
 * @param maxBattles 本次最多回放多少场（服务端已累计的有效时长才是上限）
 */
export function settleIdle(
  save: SaveData,
  ctx: ActionContext,
  maxBattles: number,
): IdleActionResult | null {
  const res = applyAction(save, { type: 'idle.tick', battles: Math.max(1, maxBattles) }, ctx)
  return res.ok ? res.result : null
}
