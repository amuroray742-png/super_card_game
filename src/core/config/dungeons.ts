/**
 * 材料副本配置（**副本的唯一出处**）。
 *
 * ## 副本是 24 个独立关卡（挂机改版 v11）
 *
 * `(变体 × 难度) = 1 关`，共 5 技能变体 × 3 难度 + 3 强化变体 × 3 难度 = **24 关**。
 * 每关有自己的敌人组合、缩放锚点、战力门槛与产量，**打赢一次即通关**。
 *
 * ⚠ **不再借用主线波次**：旧实现里「难度 = 取材主线某章」，
 *   副本其实没有自己的关卡实体（设计稿 F14）——现已拆成独立关卡。
 *
 * ## 为什么是平行配置，不进 `STAGES`
 *
 * `STAGES`（`config/stages.ts`）有三处硬约束：
 *   ① `stageMonotonicityIssues(STAGES)` 要求**全局单调递增**；
 *   ② `import-validation.ts` 要求 `clearedStage ≤ STAGES.length`；
 *   ③ 主线的末关判定。
 * 副本关卡混进 `STAGES` 会把这三处都拖下水，也会破难度标定的单调性不变量。
 *
 * ## 两种副本
 *
 * - **技能副本**（金 / 木 / 水 / 火 / 土）：产出对应五行的技能材料；
 * - **强化副本**（初阶 / 中阶 / 高阶）：产出对应档位的强化石。
 *
 * ⚠ **元素主题落在「产出材料」上，不落在敌人上**：
 *   敌人池五行分布不均（土仅 2 只普通怪），强行换敌人会脱离已标定的难度锚点。
 *   元素专属敌人是后续内容批次的事（设计稿 §3.2.1 ③）。
 *
 * ⚠ **同一变体的三个难度段用同一批敌人**：
 *   差异只来自**缩放锚点 / 战力门槛 / 产量**——难度问题一律回标定工具，
 *   不靠改敌人表救难度（设计稿 §3.2.1 ③ / U8）。
 */
import type { Element } from '../model/types.ts'
import type { DungeonDifficultyId, RelicStoneTierId } from './economy.ts'
import { DUNGEON, DUNGEON_DIFFICULTIES, DUNGEON_DIFFICULTY_ORDER, DUNGEON_DROPS, RELIC } from './economy.ts'
import { ITEM_BY_ELEMENT, ITEM_DEFS, RELIC_STONE_ITEM_BY_TIER, type ItemId } from './items.ts'

/** 副本种类 */
export type DungeonKind = 'skill' | 'enhance'

/** 副本变体 id（5 技能 + 3 强化） */
export type DungeonVariantId =
  | 'skillGold'
  | 'skillWood'
  | 'skillWater'
  | 'skillFire'
  | 'skillEarth'
  | 'enhanceTier1'
  | 'enhanceTier2'
  | 'enhanceTier3'

export interface DungeonVariant {
  id: DungeonVariantId
  kind: DungeonKind
  /** 展示名 */
  name: string
  /** 产出的道具 id（经验书不在此列——副本只发副本材料） */
  itemId: ItemId
  /** 技能副本：五行 */
  element?: Element
  /** 强化副本：石档 */
  tier?: RelicStoneTierId
  /** 解锁说明（未解锁时展示） */
  unlockHint: string
}

export const DUNGEON_VARIANTS: readonly DungeonVariant[] = [
  {
    id: 'skillGold',
    kind: 'skill',
    name: '技能副本 · 金',
    itemId: ITEM_BY_ELEMENT.金,
    element: '金',
    unlockHint: '拥有金属性英灵即可进入',
  },
  {
    id: 'skillWood',
    kind: 'skill',
    name: '技能副本 · 木',
    itemId: ITEM_BY_ELEMENT.木,
    element: '木',
    unlockHint: '拥有木属性英灵即可进入',
  },
  {
    id: 'skillWater',
    kind: 'skill',
    name: '技能副本 · 水',
    itemId: ITEM_BY_ELEMENT.水,
    element: '水',
    unlockHint: '拥有水属性英灵即可进入',
  },
  {
    id: 'skillFire',
    kind: 'skill',
    name: '技能副本 · 火',
    itemId: ITEM_BY_ELEMENT.火,
    element: '火',
    unlockHint: '拥有火属性英灵即可进入',
  },
  {
    id: 'skillEarth',
    kind: 'skill',
    name: '技能副本 · 土',
    itemId: ITEM_BY_ELEMENT.土,
    element: '土',
    unlockHint: '拥有土属性英灵即可进入',
  },
  {
    id: 'enhanceTier1',
    kind: 'enhance',
    name: '强化副本 · 初阶',
    itemId: RELIC_STONE_ITEM_BY_TIER.relicStoneTier1,
    tier: 'relicStoneTier1',
    unlockHint: '持有任意遗物即可进入',
  },
  {
    id: 'enhanceTier2',
    kind: 'enhance',
    name: '强化副本 · 中阶',
    itemId: RELIC_STONE_ITEM_BY_TIER.relicStoneTier2,
    tier: 'relicStoneTier2',
    unlockHint: '持有 Lv60 遗物即可进入',
  },
  {
    id: 'enhanceTier3',
    kind: 'enhance',
    name: '强化副本 · 高阶',
    itemId: RELIC_STONE_ITEM_BY_TIER.relicStoneTier3,
    tier: 'relicStoneTier3',
    unlockHint: '持有 Lv130 遗物即可进入',
  },
] as const

export const DUNGEON_INDEX: ReadonlyMap<DungeonVariantId, DungeonVariant> = new Map(
  DUNGEON_VARIANTS.map((v) => [v.id, v]),
)

/** 按 id 取变体（找不到返回 null） */
export function getDungeonVariant(id: DungeonVariantId): DungeonVariant | null {
  return DUNGEON_INDEX.get(id) ?? null
}

/**
 * 按「种类 + 五行 / 石档」找变体。
 *
 * ⚠ 动作层用它把客户端传来的 `element` / `tier` 解析成**唯一**的变体 id——
 *   表现层不得自己拼 id（铁律 #3 / #8）。
 */
export function findDungeonVariant(
  kind: DungeonKind,
  element?: Element,
  tier?: RelicStoneTierId,
): DungeonVariant | null {
  if (kind === 'skill') {
    if (!element) return null
    return DUNGEON_VARIANTS.find((v) => v.kind === 'skill' && v.element === element) ?? null
  }
  if (!tier) return null
  return DUNGEON_VARIANTS.find((v) => v.kind === 'enhance' && v.tier === tier) ?? null
}

/** 副本产出的道具 id（唯一口径） */
export function dungeonItemId(variant: DungeonVariant): ItemId {
  return variant.itemId
}

/** 副本每胜产量（按难度倍率） */
export function dungeonDropAmount(
  variant: DungeonVariant,
  difficulty: DungeonDifficultyId,
): { min: number; max: number } {
  const base = DUNGEON_DROPS[variant.itemId] ?? { min: 1, max: 1 }
  const mul = DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.dropMul ?? 1
  return {
    min: Math.max(1, Math.round(base.min * mul)),
    max: Math.max(1, Math.round(base.max * mul)),
  }
}

/** 道具展示名（转调唯一口径，避免各处就地写中文名） */
export function dungeonItemName(variant: DungeonVariant): string {
  return ITEM_DEFS[variant.itemId].name
}

/**
 * 变体的**列表标签**（技能 = 「火系」，强化 = 石档名「初阶」）。
 *
 * ⚠ 强化变体的标签**不能**直接打 `variant.tier`（那是 id `relicStoneTier1`，
 *   玩家看到的是一串内部标识）。石档名取 `RELIC.STONE_TIERS[].name`
 *   （铁律 #8：名称取登记表）。
 */
export function dungeonVariantLabel(variant: DungeonVariant): string {
  if (variant.kind === 'skill') return `${variant.element}系`
  const tier = RELIC.STONE_TIERS.find((t) => t.id === variant.tier)
  return tier?.name ?? variant.tier ?? ''
}

// ─────────────────────────── 副本独立关卡（挂机改版 v11） ───────────────────────────

/**
 * **副本关卡定义**（24 关的唯一定义）。
 *
 * ⚠ `enemyScale` 与 `powerRequired` **不是手填值**：它们由
 *   `economy.ts` 的 `DUNGEON.SCALE_ANCHORS` / `DUNGEON.POWER_ANCHORS`
 *   按下标读出（锚点由 `npm run balance:recalibrate:dungeon` 实测标定，
 *   铁律 #41）。这里只登记**配置**，不登记**标定结果**——
 *   否则改数值就会「配置与现实脱节」而没人发现。
 */
export interface DungeonStageDef {
  /** 关卡 id（`dgn_<变体>_<难度>`，全项目唯一） */
  id: string
  /** 所属变体（决定产出材料） */
  variantId: DungeonVariantId
  /** 难度档 */
  difficulty: DungeonDifficultyId
  /** 关卡名（如「金 · 简易 · 残响回廊」） */
  name: string
  /** 敌人组合（复用现有敌人库，见 §3.2.1 ③） */
  enemyIds: string[]
  /** 敌方属性缩放倍率（由锚点算出，**不手填**） */
  enemyScale: number
  /** 战力门槛（放行线 / UI 提示） */
  powerRequired: number
  /** 每胜产量（材料 id → 数量区间） */
  drop: { itemId: ItemId; min: number; max: number }
}

/** 变体顺序（**固定**：锚点表与关卡表共用这一个顺序） */
export const DUNGEON_VARIANT_ORDER: readonly DungeonVariantId[] = [
  'skillGold',
  'skillWood',
  'skillWater',
  'skillFire',
  'skillEarth',
  'enhanceTier1',
  'enhanceTier2',
  'enhanceTier3',
] as const

/**
 * 难度段顺序（**固定**：锚点表与关卡表共用这一个顺序，见 `economy.ts`）。
 *
 * ⚠ 这里**转出** `economy.ts` 的那份常量，不另立一份（铁律 #4）。
 */
export { DUNGEON_DIFFICULTY_ORDER } from './economy.ts'

/**
 * 每个变体的**敌人组合**（同一变体的三个难度段共用同一批敌人）。
 *
 * ⚠ 难度差异只来自**缩放锚点 / 门槛 / 产量**，不靠改敌人表救难度
 *   （设计稿 §3.2.1 ③ / U8）。
 *
 * ⚠ 元素主题仍然只落在**产出材料**上：这里按「变体对应的元素」挑敌人
 *   只是为了让同一难度段内的五行星感不至于完全一致；
 *   真正的元素主题仍在产出材料上。
 */
const DUNGEON_ENEMY_SETS: Record<DungeonVariantId, readonly string[]> = {
  skillGold: ['illusion', 'void_echo'],
  skillWood: ['thorn_beast', 'spore_drake'],
  skillWater: ['tide_construct', 'brine_wisp'],
  skillFire: ['storm_golem', 'spark_wisp'],
  skillEarth: ['wanderer', 'dust_shade'],
  enhanceTier1: ['sand_mirage', 'burrower'],
  enhanceTier2: ['frost_wraith', 'ice_guard'],
  enhanceTier3: ['star_shard', 'void_mirror'],
}

/** 每个难度段的**地点名**（按变体顺序） */
const DUNGEON_PLACE_NAMES: Record<DungeonDifficultyId, readonly string[]> = {
  easy: ['残响回廊', '青苔阶', '沉沙井', '灰烬台', '断根坪', '初火台', '霜前哨', '星陨边'],
  normal: ['织梦回廊', '幽林深处', '潮汐甬道', '熔心裂谷', '断崖石阶', '雷髓中庭', '雪线高台', '沉渊环廊'],
  hard: ['织梦者座', '万木之影庭', '潮汐主宰座', '雷髓之主殿', '荒原巨影台', '熔心巨像座', '霜寂冰宫', '星陨幻象顶'],
}

/** 副本关卡 id（**唯一出处**，表现层与动作层都从这里取，禁止自行拼接） */
export function dungeonStageId(
  variantId: DungeonVariantId,
  difficulty: DungeonDifficultyId,
): string {
  return `dgn_${variantId}_${difficulty}`
}

/** 该变体在该难度段的产量区间（`DUNGEON_DROPS` × 难度倍率） */
function dungeonDropFor(
  variantId: DungeonVariantId,
  difficulty: DungeonDifficultyId,
): { itemId: ItemId; min: number; max: number } {
  const variant = DUNGEON_INDEX.get(variantId)
  if (!variant) throw new Error(`未知副本变体：${variantId}`)
  const base = DUNGEON_DROPS[variant.itemId] ?? { min: 1, max: 1 }
  const mul = DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.dropMul ?? 1
  return {
    itemId: variant.itemId,
    min: Math.max(1, Math.round(base.min * mul)),
    max: Math.max(1, Math.round(base.max * mul)),
  }
}

/** 变体的**短标签**（技能 = 「金」，强化 = 石档名） */
function dungeonVariantShortLabel(variant: DungeonVariant): string {
  if (variant.kind === 'skill') return variant.element ?? ''
  const tier = RELIC.STONE_TIERS.find((t) => t.id === variant.tier)
  return tier?.name ?? variant.tier ?? ''
}

/**
 * **副本关卡定义表（24 关）**——按 `[难度段] × [变体]` 的固定顺序排列。
 *
 * ⚠ 顺序必须与 `DUNGEON.SCALE_ANCHORS` / `POWER_ANCHORS` / `DESIGN_LEVELS`
 *   **逐位对齐**（同一份顺序常量 `DUNGEON_VARIANT_ORDER` / `DUNGEON_DIFFICULTY_ORDER`）。
 */
export const DUNGEON_STAGES: readonly DungeonStageDef[] = (() => {
  const out: DungeonStageDef[] = []
  for (const difficulty of DUNGEON_DIFFICULTY_ORDER) {
    const diffName = DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.name ?? difficulty
    const places = DUNGEON_PLACE_NAMES[difficulty]
    DUNGEON_VARIANT_ORDER.forEach((variantId, slot) => {
      const variant = DUNGEON_INDEX.get(variantId)!
      const index = DUNGEON_DIFFICULTY_ORDER.indexOf(difficulty) * DUNGEON_VARIANT_ORDER.length + slot
      out.push({
        id: dungeonStageId(variantId, difficulty),
        variantId,
        difficulty,
        name: `${dungeonVariantShortLabel(variant)} · ${diffName} · ${places[slot]}`,
        enemyIds: [...DUNGEON_ENEMY_SETS[variantId]],
        // ⚠ 缩放与门槛来自**标定锚点表**，不是手填值（铁律 #41）
        enemyScale: DUNGEON.SCALE_ANCHORS[index],
        powerRequired: DUNGEON.POWER_ANCHORS[index],
        drop: dungeonDropFor(variantId, difficulty),
      })
    })
  }
  return out
})()

export const DUNGEON_STAGE_INDEX: ReadonlyMap<string, DungeonStageDef> = new Map(
  DUNGEON_STAGES.map((s) => [s.id, s]),
)

/** 按 id 取副本关卡（找不到返回 null） */
export function dungeonStageById(id: string): DungeonStageDef | null {
  return DUNGEON_STAGE_INDEX.get(id) ?? null
}

/** 取某个种类（技能 / 强化）的全部关卡 */
export function dungeonStagesOf(kind: DungeonKind): readonly DungeonStageDef[] {
  return DUNGEON_STAGES.filter((s) => DUNGEON_INDEX.get(s.variantId)?.kind === kind)
}

/** 取某个变体的全部关卡（按难度段顺序） */
export function dungeonStagesOfVariant(variantId: DungeonVariantId): readonly DungeonStageDef[] {
  return DUNGEON_STAGES.filter((s) => s.variantId === variantId)
}

