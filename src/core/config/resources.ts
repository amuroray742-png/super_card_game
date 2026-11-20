/**
 * 资源登记表（名称 / 作用描述的唯一出处）。
 *
 * ## 为什么单独一张表
 *
 * 资源名称此前在**四处**各写一份：
 *   `presentation/App.vue`（顶栏清单）、`components/BattleResultPanel.vue`
 *   （掉落预览）、`views/StageDetailView.vue`（掉落预览）、
 *   `tools/artgen/icon-prompt.ts`（生图提示词里的「游戏内显示名」）。
 *   四份已经对不上——同一个「强化石」在结算面板里叫「遗物强化石」，
 *   在关卡页里叫「强化石」。**两处各写一套必然对不上**（铁律 #4）。
 *
 * 现在名称与描述只此一处：`RESOURCE_DEFS`。
 * 界面上凡是「图标 + 名称」并排的地方，名称一律取这里，禁止就地写中文名。
 *
 * ## 与道具登记表的关系
 *
 * - **钱包 / 历史余额**（银两、圣杯结晶、卡碎片、竞技勋章、竞技材料）→ 本表；
 * - **背包堆叠物**（经验书、五行技能材料、三档强化石）→ `config/items.ts`。
 *
 * 两类都在 `RESOURCE_ICON_KEYS` 里（都要出图），但**名字与描述各只有一处**：
 * 道具那几条在本表里**转调** `ITEM_DEFS`，不另写一份中文名。
 *
 * ## 描述里的数字用占位符，不写死
 *
 * 玩家是照着描述做养成决策的，描述里的价格必须**等于**真实数值。
 * 因此 `{key}` 占位符的取值全部来自 `economy.ts`（与合规页同一套路），
 * 渲染时填充 → 数值一改，描述自动跟着改（公示 = 实际）。
 *
 * ⚠ 占位符漏配时**原样保留** `{xxx}`（宁可看到 `{gachaCost}`，
 *   也不要显示成空白或 0）——`tests/unit/resources.test.ts` 会拦下这种漏配。
 */
import type { ResourceIconKey } from './art.ts'
import { GACHA } from './economy.ts'
import { ITEM_DEFS, ITEM_IDS, ITEM_TEXT_VARS } from './items.ts'

export interface ResourceDef {
  /** 唯一展示名（界面一律取这里） */
  name: string
  /** 作用描述；可含 `{key}` 占位符，取值见 `RESOURCE_TEXT_VARS` */
  desc: string
  /** 是否给出「前往召唤」入口（抽卡类资源）——抽卡是核心循环，入口必须可达（铁律 #10） */
  gachaEntry?: boolean
}

/**
 * 背包堆叠物的资源条目（名称与描述**转调** `ITEM_DEFS`，不另写一份）。
 *
 * ⚠ 放在**最前面**展开：钱包类资源在后面逐个覆盖。
 *   （写在后面会被 TS 判成「属性被重复指定」。）
 */
const ITEM_RESOURCE_DEFS = Object.fromEntries(
  ITEM_IDS.map((id) => [id, { name: ITEM_DEFS[id].name, desc: ITEM_DEFS[id].desc }]),
) as Record<ResourceIconKey, ResourceDef>

/**
 * 全量资源登记。
 *
 * ⚠ 类型是 `Record<ResourceIconKey, ResourceDef>`：
 *   `RESOURCE_ICON_KEYS`（`art.ts`）新增一个 key 而这里没登记 → **编译期报错**，
 *   不会出现「有图标但没有名字 / 没有说明」的半成品资源（铁律 #22）。
 */
export const RESOURCE_DEFS: Record<ResourceIconKey, ResourceDef> = {
  ...ITEM_RESOURCE_DEFS,
  silver: {
    name: '银两',
    desc: '通用货币。用于遗物强化（每级 {relicSilverCost} 银两起，淬炼段递增）'
      + '与英灵技能升级（每级 {skillSilverCost} 银两）；境界突破也消耗银两。',
  },
  crystals: {
    name: '圣杯结晶',
    desc: '召唤英灵的主要消耗，每抽 {gachaCost} 点，十连为 {tenPullCount} 抽。'
      + '主线各关**首次通关**另有结晶赠送。',
    gachaEntry: true,
  },
  shards: {
    name: '卡碎片',
    desc: '同名英灵碎片，用于提升该英灵的星级。重复获得的英灵会转化为同名碎片；'
      + '升星只扣同名碎片，满星后碎片仍按同一规则入包。',
  },
  medals: {
    name: '竞技勋章',
    desc: '竞技场历史产出（**已停止新增**）。旧余额保留为只读记录，不再发放也不再消耗。',
  },
  arenaMaterials: {
    name: '竞技材料',
    desc: '竞技场历史产出（**已停止新增**）。旧余额保留为只读记录，不再发放也不再消耗。',
  },
}

/**
 * 顶部资源条常驻的资源。
 *
 * ⚠ 每一项都必须是 `player` 上的**数值字段**——
 *   `shards` 是「英灵 id → 碎片数」的映射（Record），进不了顶栏；
 *   `medals` / `arenaMaterials` 挂在 `arena` 上，也不是 player 字段。
 *   `tests/unit/resources.test.ts` 会按存档类型校验这条。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：钱包只有**两种货币**——
 *   设计稿 §4「顶栏展示两种货币」。道具不进顶栏（它们在背包里）。
 */
export const TOP_BAR_RESOURCE_KEYS = [
  'silver',
  'crystals',
] as const satisfies readonly ResourceIconKey[]

/** 顶栏资源 key 类型 */
export type TopBarResourceKey = (typeof TOP_BAR_RESOURCE_KEYS)[number]

/**
 * 描述文案的占位符取值——**全部来自 economy 配置**，不写死。
 *
 * ⚠ 道具描述的占位符（`{expBookSmallExp}` 等）一并纳入这里，
 *   这样「资源说明弹窗」与「背包道具描述」走**同一套填充逻辑**。
 */
export const RESOURCE_TEXT_VARS = {
  gachaCost: GACHA.COST_SINGLE,
  tenPullCount: GACHA.TEN_PULL_COUNT,
  ...ITEM_TEXT_VARS,
} as const

/**
 * 填充 `{key}` 占位符。
 *
 * 未提供的 key **原样保留**（与合规页 `fillTemplate` 同一口径）：
 * 宁可让玩家看到 `{gachaCost}`，也不要显示成空白或 0。
 */
export function resourceText(text: string): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in RESOURCE_TEXT_VARS
      ? String(RESOURCE_TEXT_VARS[key as keyof typeof RESOURCE_TEXT_VARS])
      : match,
  )
}

/** 取某个资源的展示名 */
export function resourceName(key: ResourceIconKey): string {
  return RESOURCE_DEFS[key].name
}

/** 取某个资源的作用描述（已填好占位符） */
export function resourceDesc(key: ResourceIconKey): string {
  return resourceText(RESOURCE_DEFS[key].desc)
}
