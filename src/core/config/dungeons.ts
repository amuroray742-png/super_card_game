/**
 * 材料副本配置（**副本的唯一出处**）。
 *
 * ## 为什么是平行配置，不进 `STAGES`
 *
 * `STAGES`（`config/stages.ts`）有三处硬约束：
 *   ① `stageMonotonicityIssues(STAGES)` 要求**全局单调递增**；
 *   ② `import-validation.ts` 要求 `clearedStage ≤ STAGES.length`；
 *   ③ `idle.ts` 按 `TOTAL_STAGES` 判末关。
 * 副本波次如果混进 `STAGES`，这三处都会被迫改，难度标定的单调性不变量也会破。
 * 所以副本走**平行配置**：取材某章的主线关卡 id 列表，难度天然落在已标定的锚点上
 * （D3、铁律 #41：锚点不许手填）。
 *
 * ## 两种副本
 *
 * - **技能副本**（金 / 木 / 水 / 火 / 土）：产出对应五行的技能材料；
 * - **强化副本**（初阶 / 中阶 / 高阶）：产出对应档位的强化石。
 *
 * ⚠ **元素主题落在「产出材料」上，不落在敌人上**：
 *   敌人池五行分布不均（土仅 2 只普通怪），强行换敌人会脱离已标定的难度锚点。
 *   元素专属敌人是后续内容批次的事（实现文档 §4）。
 */
import type { Element } from '../model/types.ts'
import type { DungeonDifficultyId, RelicStoneTierId } from './economy.ts'
import { DUNGEON_DIFFICULTIES, DUNGEON_DROPS, RELIC } from './economy.ts'
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
