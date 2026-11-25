/**
 * 材料副本配置（**副本的唯一出处**）。
 *
 * ## 副本是 42 个独立关卡（挂机改版 v11 + 遗物副本 v12）
 *
 * `(变体 × 难度) = 1 关`，共 5 技能变体 × 3 难度 + 3 强化变体 × 3 难度
 * + **6 遗物变体 × 3 难度** = **42 关**。
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
 * ## 三种副本
 *
 * - **技能副本**（金 / 木 / 水 / 火 / 土）：产出对应五行的技能材料；
 * - **强化副本**（初阶 / 中阶 / 高阶）：产出对应档位的强化石；
 * - **遗物副本**（6 个，套装两两配对）：产出**遗物实例**（存档 v12）。
 *
 * ⚠ **元素主题落在「产出材料」上，不落在敌人上**：
 *   敌人池五行分布不均（土仅 2 只普通怪），强行换敌人会脱离已标定的难度锚点。
 *   元素专属敌人是后续内容批次的事（设计稿 §3.2.1 ③）。
 *
 * ⚠ **同一变体的三个难度段用同一批敌人**：
 *   差异只来自**缩放锚点 / 战力门槛 / 产量**——难度问题一律回标定工具，
 *   不靠改敌人表救难度（设计稿 §3.2.1 ③ / U8）。
 *
 * ⚠ **材料副本与遗物副本的产出形状不同**：
 *   材料是**堆叠物**（`drop.items`），遗物是**实例**（`relicPool` + `rewards.relics`）。
 *   一关**只**产其中一种。
 */
import type { Element } from '../model/types.ts'
import type { DungeonDifficultyId, RelicStoneTierId } from './economy.ts'
import { DUNGEON, DUNGEON_DIFFICULTIES, DUNGEON_DIFFICULTY_ORDER, DUNGEON_DROPS, RELIC } from './economy.ts'
import { ITEM_BY_ELEMENT, ITEM_DEFS, RELIC_STONE_ITEM_BY_TIER, type ItemId } from './items.ts'
import { relicIdsBySet } from './relics.ts'

/** 副本种类 */
export type DungeonKind = 'skill' | 'enhance' | 'relic'

/** 副本变体 id（5 技能 + 3 强化 + 6 遗物） */
export type DungeonVariantId =
  | 'skillGold'
  | 'skillWood'
  | 'skillWater'
  | 'skillFire'
  | 'skillEarth'
  | 'enhanceTier1'
  | 'enhanceTier2'
  | 'enhanceTier3'
  | 'relicZhanTan'
  | 'relicJiYing'
  | 'relicJianBi'
  | 'relicShengXi'
  | 'relicLingDong'
  | 'relicJunHeng'

export interface DungeonVariant {
  id: DungeonVariantId
  kind: DungeonKind
  /** 展示名 */
  name: string
  /**
   * 产出的**堆叠道具** id。
   *
   * ⚠ **遗物副本为 `null`**——遗物是**实例**（走 `save.relics`），不是堆叠物。
   *   遗物副本改用 `relicSetIds` / `relicPool`（铁律 #22：不做半成品道具）。
   */
  itemId: ItemId | null
  /** 遗物副本覆盖的**套装 id**（两个，存档 v12） */
  relicSetIds?: readonly string[]
  /** 技能副本：五行 */
  element?: Element
  /** 强化副本：石档 */
  tier?: RelicStoneTierId
  /** 遗物副本：关卡名里的短标签（材料副本由 element / tier 推导） */
  shortName?: string
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
  // ── 遗物副本（存档 v12）：12 个套装两两配对 = 6 个副本 ──
  //
  // ⚠ 配对按**定位互补**：输出 / 速度 / 生存 / 续航 / 攻速 / 通用，
  //   每个副本里的 2 个套装覆盖不同属性维度，玩家按需求选副本。
  {
    id: 'relicZhanTan',
    kind: 'relic',
    name: '锋锐遗窟',
    itemId: null,
    relicSetIds: ['set_zhanshen', 'set_tanpo'],
    shortName: '锋锐',
    unlockHint: '主线通关第 1 关即可进入',
  },
  {
    id: 'relicJiYing',
    kind: 'relic',
    name: '疾影遗窟',
    itemId: null,
    relicSetIds: ['set_bingjie', 'set_qingming'],
    shortName: '疾影',
    unlockHint: '主线通关第 5 关即可进入',
  },
  {
    id: 'relicJianBi',
    kind: 'relic',
    name: '坚壁遗窟',
    itemId: null,
    relicSetIds: ['set_jiangtun', 'set_xuanwu'],
    shortName: '坚壁',
    unlockHint: '主线通关第 15 关即可进入',
  },
  {
    id: 'relicShengXi',
    kind: 'relic',
    name: '生息遗窟',
    itemId: null,
    relicSetIds: ['set_huichun', 'set_shengming'],
    shortName: '生息',
    unlockHint: '主线通关第 30 关即可进入',
  },
  {
    id: 'relicLingDong',
    kind: 'relic',
    name: '灵动遗窟',
    itemId: null,
    relicSetIds: ['set_jixie', 'set_lingqi'],
    shortName: '灵动',
    unlockHint: '主线通关第 50 关即可进入',
  },
  {
    id: 'relicJunHeng',
    kind: 'relic',
    name: '均衡遗窟',
    itemId: null,
    relicSetIds: ['set_shangzhan', 'set_liuhe'],
    shortName: '均衡',
    unlockHint: '主线通关第 70 关即可进入',
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
 *
 * ⚠ **遗物副本不走这个入口**：它的定位键是**套装**，
 *   用 `findRelicDungeonVariant(setId)`（遗物副本 ↔ 套装的唯一映射）。
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
  if (kind === 'enhance') {
    if (!tier) return null
    return DUNGEON_VARIANTS.find((v) => v.kind === 'enhance' && v.tier === tier) ?? null
  }
  return null
}

/**
 * **按套装找遗物副本**（遗物副本 ↔ 套装的唯一映射）。
 *
 * ⚬ 表现层用它在「缺哪套 → 去哪个副本」之间搭桥（背包 / 仓库的直达入口），
 *   禁止自己遍历变体表（铁律 #3 / #8）。
 */
export function findRelicDungeonVariant(setId: string): DungeonVariant | null {
  return DUNGEON_VARIANTS.find((v) => v.kind === 'relic' && v.relicSetIds?.includes(setId)) ?? null
}

/**
 * **遗物副本的候选遗物池**（该副本覆盖的 2 个套装 × 5 件 = 10 件）。
 *
 * ⚠ 唯一出处：套装 → 遗物 id 的映射走 `config/relics.ts` 的 `relicIdsBySet`。
 * @returns 遗物定义 id 列表；不是遗物副本时返回 `null`
 */
export function relicPoolOf(variant: DungeonVariant): readonly string[] | null {
  if (variant.kind !== 'relic' || !variant.relicSetIds) return null
  const pool: string[] = []
  for (const setId of variant.relicSetIds) {
    pool.push(...relicIdsBySet(setId))
  }
  return pool
}

/** 副本产出的道具 id（唯一口径；遗物副本没有堆叠道具） */
export function dungeonItemId(variant: DungeonVariant): ItemId | null {
  return variant.itemId
}

/** 副本每胜产量（按难度倍率；遗物副本为 null） */
export function dungeonDropAmount(
  variant: DungeonVariant,
  difficulty: DungeonDifficultyId,
): { min: number; max: number } | null {
  if (!variant.itemId) return null
  const base = DUNGEON_DROPS[variant.itemId] ?? { min: 1, max: 1 }
  const mul = DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.dropMul ?? 1
  return {
    min: Math.max(1, Math.round(base.min * mul)),
    max: Math.max(1, Math.round(base.max * mul)),
  }
}

/** 道具展示名（转调唯一口径，避免各处就地写中文名） */
export function dungeonItemName(variant: DungeonVariant): string {
  return variant.itemId ? ITEM_DEFS[variant.itemId].name : variant.name
}

/**
 * 变体的**列表标签**（技能 = 「火系」，强化 = 石档名「初阶」，遗物 = 副本短名）。
 *
 * ⚠ 强化变体的标签**不能**直接打 `variant.tier`（那是 id `relicStoneTier1`，
 *   玩家看到的是一串内部标识）。石档名取 `RELIC.STONE_TIERS[].name`
 *   （铁律 #8：名称取登记表）。
 */
export function dungeonVariantLabel(variant: DungeonVariant): string {
  if (variant.kind === 'skill') return `${variant.element}系`
  if (variant.kind === 'relic') return variant.shortName ?? variant.name
  const tier = RELIC.STONE_TIERS.find((t) => t.id === variant.tier)
  return tier?.name ?? variant.tier ?? ''
}

// ─────────────────────────── 副本独立关卡（挂机改版 v11） ───────────────────────────

/**
 * **副本关卡定义**（42 关的唯一定义）。
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
  /**
   * 每胜产量（材料 id → 数量区间）。
   *
   * ⚠ **遗物副本为 `null`**：遗物是**实例**（`relicPool` + `rewards.relics`），
   *   不是堆叠物。一关**只**产其中一种。
   */
  drop: { itemId: ItemId; min: number; max: number } | null
  /**
   * 遗物副本的**候选遗物池**（该副本覆盖的 2 个套装 × 5 件 = 10 件）。
   *
   * ⚠ 材料副本为 `null`。
   */
  relicPool: readonly string[] | null
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
  // ⚠ 遗物副本**追加在末尾**：现有 8 个变体在 easy 段的下标不变，
  //   只有 normal / hard 段平移 —— 重跑标定时 diff 最小、最易读。
  'relicZhanTan',
  'relicJiYing',
  'relicJianBi',
  'relicShengXi',
  'relicLingDong',
  'relicJunHeng',
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
  relicZhanTan: ['illusion', 'void_echo'],
  relicJiYing: ['dream_weaver', 'illusion'],
  relicJianBi: ['ice_guard', 'dust_shade'],
  relicShengXi: ['thorn_beast', 'wanderer'],
  relicLingDong: ['spark_wisp', 'frost_wraith'],
  relicJunHeng: ['star_shard', 'void_mirror'],
}

/**
 * 每个难度段的**地点名**（按变体顺序）。
 *
 * ⚠ 用**元组类型**而不是 `string[]`：长度写错（漏扩一个变体）会在
 *   **编译期**报错——否则 `places[slot]` 变成字面量 `undefined`，
 *   关卡名里就会出现 "undefined"（历史上这类错误没人能一眼看出来）。
 */
type DungeonPlaceNames = readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string,
]

const DUNGEON_PLACE_NAMES: Record<DungeonDifficultyId, DungeonPlaceNames> = {
  easy: [
    '残响回廊', '青苔阶', '沉沙井', '灰烬台', '断根坪', '初火台', '霜前哨', '星陨边',
    '断兵坑', '掠影径', '残垣垒', '苗圃窟', '齿轮窖', '观测台',
  ],
  normal: [
    '织梦回廊', '幽林深处', '潮汐甬道', '熔心裂谷', '断崖石阶', '雷髓中庭', '雪线高台', '沉渊环廊',
    '锋刃祭坛', '疾风回廊', '铁壁回廊', '涌泉之庭', '轮转工坊', '均衡之庭',
  ],
  hard: [
    '织梦者座', '万木之影庭', '潮汐主宰座', '雷髓之主殿', '荒原巨影台', '熔心巨像座', '霜寂冰宫', '星陨幻象顶',
    '万刃刑场', '无踪之座', '不破之壁', '长生之坛', '万机之心', '万象中枢',
  ],
}

/** 副本关卡 id（**唯一出处**，表现层与动作层都从这里取，禁止自行拼接） */
export function dungeonStageId(
  variantId: DungeonVariantId,
  difficulty: DungeonDifficultyId,
): string {
  return `dgn_${variantId}_${difficulty}`
}

/** 该变体在该难度段的产量区间（`DUNGEON_DROPS` × 难度倍率；遗物副本为 null） */
function dungeonDropFor(
  variantId: DungeonVariantId,
  difficulty: DungeonDifficultyId,
): { itemId: ItemId; min: number; max: number } | null {
  const variant = DUNGEON_INDEX.get(variantId)
  if (!variant) throw new Error(`未知副本变体：${variantId}`)
  if (!variant.itemId) return null
  const base = DUNGEON_DROPS[variant.itemId] ?? { min: 1, max: 1 }
  const mul = DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.dropMul ?? 1
  return {
    itemId: variant.itemId,
    min: Math.max(1, Math.round(base.min * mul)),
    max: Math.max(1, Math.round(base.max * mul)),
  }
}

/** 变体的**短标签**（技能 = 「金」，强化 = 石档名，遗物 = 副本短名） */
function dungeonVariantShortLabel(variant: DungeonVariant): string {
  if (variant.kind === 'skill') return variant.element ?? ''
  if (variant.kind === 'relic') return variant.shortName ?? variant.name
  const tier = RELIC.STONE_TIERS.find((t) => t.id === variant.tier)
  return tier?.name ?? variant.tier ?? ''
}

/**
 * **副本关卡定义表（42 关）**——按 `[难度段] × [变体]` 的固定顺序排列。
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
        relicPool: relicPoolOf(variant),
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

/** 取某个种类（技能 / 强化 / 遗物）的全部关卡 */
export function dungeonStagesOf(kind: DungeonKind): readonly DungeonStageDef[] {
  return DUNGEON_STAGES.filter((s) => DUNGEON_INDEX.get(s.variantId)?.kind === kind)
}

/** 取某个变体的全部关卡（按难度段顺序） */
export function dungeonStagesOfVariant(variantId: DungeonVariantId): readonly DungeonStageDef[] {
  return DUNGEON_STAGES.filter((s) => s.variantId === variantId)
}
