/**
 * 道具登记表（**堆叠物的唯一出处**）。
 *
 * ## 为什么单独一张表
 *
 * 资源登记表（`config/resources.ts`）管的是**钱包里的数值字段**——
 * 银两 / 圣杯结晶这种能直接加在 `player` 上的东西。
 * 本表管的是**背包里的堆叠物**：经验书、五行技能材料、三档强化石。
 *
 * ⚠ **两者不可混用**：
 *   - 钱包资源 → `player.<字段>`（数值，能进顶栏）；
 *   - 堆叠道具 → `save.items[<道具 id>]`（键值表，**不能**进顶栏——
 *     顶栏要求 `player` 上是数值字段，见 `tests/unit/resources.test.ts`）。
 *
 * ## 命名口径
 *
 * 道具的**展示名与作用描述只此一处**。界面上凡是「图标 + 名称」并排的地方，
 * 名称一律取 `ITEM_DEFS` / `resourceName()`，禁止就地写中文名（铁律 #8）。
 * 同名碎片不进本表——它按**英灵**分堆，存在 `player.shards`（形状天然不同）。
 *
 * ## 数值
 *
 * 本表**不含任何可调数值**：面额、数量、价格一律在 `config/economy.ts`
 * （铁律 #5）。这里只有「叫什么 / 属于哪类 / 用什么图标 / 从哪来」。
 */
import type { Element } from '../model/types.ts'
import type { ResourceIconKey } from './art.ts'
import { EXP_BOOK, LEGACY_CONVERSION, RELIC, SKILL } from './economy.ts'

// ─────────────────────────── 道具 id ───────────────────────────

/**
 * 全部堆叠道具 id（唯一口径）。
 *
 * ⚠ 这份清单与 `RESOURCE_ICON_KEYS`（`config/art.ts`）是**两回事**：
 *   - `RESOURCE_ICON_KEYS` = **需要出图**的资源 key（含钱包货币、竞技历史余额）；
 *   - 本清单 = **存进背包**的堆叠物。
 *   每个堆叠道具的 `iconKey` 必须落在 `RESOURCE_ICON_KEYS` 里。
 */
export const ITEM_IDS = [
  'expBookSmall',
  'expBookLarge',
  'skillMatGold',
  'skillMatWood',
  'skillMatWater',
  'skillMatFire',
  'skillMatEarth',
  'relicStoneTier1',
  'relicStoneTier2',
  'relicStoneTier3',
] as const

export type ItemId = (typeof ITEM_IDS)[number]

// ─────────────────────────── 分类 ───────────────────────────

export type ItemCategory = 'skillMat' | 'relicStone' | 'expBook'

/** 分类展示名（背包页的分类标签） */
export const ITEM_CATEGORY_NAMES: Record<ItemCategory, string> = {
  skillMat: '技能材料',
  relicStone: '强化材料',
  expBook: '经验书',
}

/** 分类在背包页的展示顺序 */
export const ITEM_CATEGORY_ORDER: readonly ItemCategory[] = ['skillMat', 'relicStone', 'expBook'] as const

// ─────────────────────────── 定义 ───────────────────────────

export interface ItemDef {
  id: ItemId
  /** 展示名（全局唯一） */
  name: string
  /** 作用描述；可含 `{key}` 占位符，取值见 `ITEM_TEXT_VARS` */
  desc: string
  category: ItemCategory
  /** 图标 key（必须落在 `RESOURCE_ICON_KEYS`） */
  iconKey: ResourceIconKey
  /** 同类内的稳定排序（数量相同的条目按它 + id 排列，设计稿 §4） */
  sort: number
  /** 来源提示（设计稿 §4「可使用的英灵和对应副本」「适用等级、可强化的遗物和来源」） */
  source: string
}

/**
 * 全量道具登记。
 *
 * ⚠ 类型是 `Record<ItemId, ItemDef>`：`ITEM_IDS` 新增一个 id 而这里没登记
 *   → **编译期报错**，不会出现「有道具但没名字 / 没说明」的半成品（铁律 #22）。
 */
export const ITEM_DEFS: Record<ItemId, ItemDef> = {
  expBookSmall: {
    id: 'expBookSmall',
    name: '小经验书',
    desc: '通用经验书，喂给任意英灵（不挑职业），每本提供 {expBookSmallExp} 点经验。'
      + '主线推征与普通关卡掉落，缺口时也可用大经验书代替。',
    category: 'expBook',
    iconKey: 'expBookSmall',
    sort: 1,
    source: '主线普通关 / 章末 BOSS',
  },
  expBookLarge: {
    id: 'expBookLarge',
    name: '大经验书',
    desc: '通用经验书，喂给任意英灵（不挑职业），每本提供 {expBookLargeExp} 点经验。'
      + '中后期主线掉落占比更高。',
    category: 'expBook',
    iconKey: 'expBookLarge',
    sort: 2,
    source: '主线普通关 / 章末 BOSS（中后期占比更高）',
  },
  skillMatGold: {
    id: 'skillMatGold',
    name: '金系技能材料',
    desc: '金属性英灵升级技能所需材料，每级消耗 {skillMaterialCost} 个（另需 {skillSilverCost} 银两）。'
      + '在「技能副本 · 金」中刷取。',
    category: 'skillMat',
    iconKey: 'skillMatGold',
    sort: 11,
    source: '技能副本 · 金',
  },
  skillMatWood: {
    id: 'skillMatWood',
    name: '木系技能材料',
    desc: '木属性英灵升级技能所需材料，每级消耗 {skillMaterialCost} 个（另需 {skillSilverCost} 银两）。'
      + '在「技能副本 · 木」中刷取。',
    category: 'skillMat',
    iconKey: 'skillMatWood',
    sort: 12,
    source: '技能副本 · 木',
  },
  skillMatWater: {
    id: 'skillMatWater',
    name: '水系技能材料',
    desc: '水属性英灵升级技能所需材料，每级消耗 {skillMaterialCost} 个（另需 {skillSilverCost} 银两）。'
      + '在「技能副本 · 水」中刷取。',
    category: 'skillMat',
    iconKey: 'skillMatWater',
    sort: 13,
    source: '技能副本 · 水',
  },
  skillMatFire: {
    id: 'skillMatFire',
    name: '火系技能材料',
    desc: '火属性英灵升级技能所需材料，每级消耗 {skillMaterialCost} 个（另需 {skillSilverCost} 银两）。'
      + '在「技能副本 · 火」中刷取。',
    category: 'skillMat',
    iconKey: 'skillMatFire',
    sort: 14,
    source: '技能副本 · 火',
  },
  skillMatEarth: {
    id: 'skillMatEarth',
    name: '土系技能材料',
    desc: '土属性英灵升级技能所需材料，每级消耗 {skillMaterialCost} 个（另需 {skillSilverCost} 银两）。'
      + '在「技能副本 · 土」中刷取。',
    category: 'skillMat',
    iconKey: 'skillMatEarth',
    sort: 15,
    source: '技能副本 · 土',
  },
  relicStoneTier1: {
    id: 'relicStoneTier1',
    name: '初阶强化石',
    desc: '遗物强化材料，用于把遗物强化到 Lv{relicStoneTier1Max}（含），每级消耗 {relicStoneCost} 个'
      + '（另需 {relicSilverCost} 银两）。在「强化副本 · 初阶」中刷取。',
    category: 'relicStone',
    iconKey: 'relicStoneTier1',
    sort: 21,
    source: '强化副本 · 初阶',
  },
  relicStoneTier2: {
    id: 'relicStoneTier2',
    name: '中阶强化石',
    desc: '遗物强化材料，用于把遗物强化到 Lv{relicStoneTier2Min}~{relicStoneTier2Max}，每级消耗 {relicStoneCost} 个'
      + '（另需 {relicSilverCost} 银两）。在「强化副本 · 中阶」中刷取。',
    category: 'relicStone',
    iconKey: 'relicStoneTier2',
    sort: 22,
    source: '强化副本 · 中阶',
  },
  relicStoneTier3: {
    id: 'relicStoneTier3',
    name: '高阶强化石',
    desc: '遗物强化材料，用于把遗物强化到 Lv{relicStoneTier3Min}~{relicStoneTier3Max}，每级消耗 {relicStoneCost} 个'
      + '（另需 {relicSilverCost} 银两）。在「强化副本 · 高阶」中刷取。',
    category: 'relicStone',
    iconKey: 'relicStoneTier3',
    sort: 23,
    source: '强化副本 · 高阶',
  },
}

/** 按 sort 稳定排序的道具清单（背包页展示用） */
export const ITEM_LIST: readonly ItemDef[] = ITEM_IDS.map((id) => ITEM_DEFS[id]).sort(
  (a, b) => (a.sort !== b.sort ? a.sort - b.sort : a.id < b.id ? -1 : 1),
)

/** 某分类下的道具清单 */
export function itemsOfCategory(category: ItemCategory): readonly ItemDef[] {
  return ITEM_LIST.filter((item) => item.category === category)
}

// ─────────────────────────── 五行映射 ───────────────────────────

/**
 * 五行 → 对应技能材料道具 id。
 *
 * ⚠ **唯一口径**（铁律 #3：遍历配置表，禁止硬编码）。
 *   升技能时按英灵五行取这里——表现层不得自己拼 id。
 */
export const ITEM_BY_ELEMENT: Record<Element, ItemId> = {
  金: 'skillMatGold',
  木: 'skillMatWood',
  水: 'skillMatWater',
  火: 'skillMatFire',
  土: 'skillMatEarth',
}

/**
 * 道具 id → 五行（**逆向映射**，只有技能材料有；其余道具为 null）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：背包页原本用
 *   `def.id.replace('skillMat', '')` 反推五行 —— 那是**英文 id 后缀**
 *   （`skillMatFire` → `Fire`），与英灵的五行（`火`）根本不是一回事：
 *   - 「去副本」按钮拼出 `?element=Fire`，副本页按中文五行找变体 → **跳错副本**；
 *   - 筛选高亮的「置灰」判断永远不成立 → **五行筛选形同虚设**；
 *   - 「可使用的英灵」统计恒为 0。
 *   反推五行必须走这张表（铁律 #3：遍历配置表，禁止硬编码）。
 */
export const ITEM_ELEMENT: Partial<Record<ItemId, Element>> = Object.fromEntries(
  (Object.entries(ITEM_BY_ELEMENT) as [Element, ItemId][]).map(([element, id]) => [id, element]),
)

/** 取某个道具对应的五行（不是技能材料返回 null） */
export function itemElement(id: ItemId): Element | null {
  return ITEM_ELEMENT[id] ?? null
}

// ─────────────────────────── 强化石档位映射 ───────────────────────────

/**
 * 强化石档位 id → 道具 id。
 *
 * ⚠ 档位表在 `economy.ts` 的 `RELIC.STONE_TIERS`（数值与区间），
 *   这里只做 id 映射，避免两处各写一份（铁律 #4）。
 */
export const RELIC_STONE_ITEM_BY_TIER: Record<string, ItemId> = Object.fromEntries(
  RELIC.STONE_TIERS.map((tier) => [tier.id, tier.id as ItemId]),
)

// ─────────────────────────── 经验书 ───────────────────────────

/** 经验书 id → 面值（只登记经验书，其余道具不在此表） */
export const EXP_BOOK_ITEM_EXP: Partial<Record<ItemId, number>> = {
  expBookSmall: EXP_BOOK.small.exp,
  expBookLarge: EXP_BOOK.large.exp,
}

/** 是否是经验书 */
export function isExpBook(id: ItemId): boolean {
  return id === EXP_BOOK.small.id || id === EXP_BOOK.large.id
}

// ─────────────────────────── 文案 ───────────────────────────

/**
 * 描述文案的占位符取值——**全部来自 economy 配置**，不写死。
 */
export const ITEM_TEXT_VARS = {
  expBookSmallExp: EXP_BOOK.small.exp,
  expBookLargeExp: EXP_BOOK.large.exp,
  skillMaterialCost: SKILL.MATERIAL_PER_LEVEL,
  skillSilverCost: SKILL.SILVER_PER_LEVEL,
  relicStoneCost: RELIC.STONES_PER_LEVEL,
  relicSilverCost: RELIC.SILVER_PER_LEVEL,
  relicStoneTier1Max: RELIC.STONE_TIERS[0].maxLevel,
  relicStoneTier2Min: RELIC.STONE_TIERS[1].minLevel,
  relicStoneTier2Max: RELIC.STONE_TIERS[1].maxLevel,
  relicStoneTier3Min: RELIC.STONE_TIERS[2].minLevel,
  relicStoneTier3Max: RELIC.STONE_TIERS[2].maxLevel,
  legacyEmblemToSilver: LEGACY_CONVERSION.emblemToSilver,
} as const

/**
 * 填充 `{key}` 占位符。
 *
 * 未提供的 key **原样保留**（与合规页 / 资源描述同一口径）：
 * 宁可让玩家看到 `{xxx}`，也不要显示成空白或 0。
 */
export function itemText(text: string): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in ITEM_TEXT_VARS
      ? String(ITEM_TEXT_VARS[key as keyof typeof ITEM_TEXT_VARS])
      : match,
  )
}

/** 取某个道具的展示名 */
export function itemName(id: ItemId): string {
  return ITEM_DEFS[id].name
}

/** 取某个道具的作用描述（已填好占位符） */
export function itemDesc(id: ItemId): string {
  return itemText(ITEM_DEFS[id].desc)
}
