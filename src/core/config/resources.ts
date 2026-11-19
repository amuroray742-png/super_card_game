/**
 * 资源登记表（名称 / 作用描述的唯一出处）。
 *
 * ## 为什么单独一张表
 *
 * 资源名称此前在**四处**各写一份：
 *   `presentation/App.vue`（顶栏清单）、`components/BattleResultPanel.vue`
 *   （掉落预览）、`views/StageDetailView.vue`（掉落预览）、
 *   `tools/artgen/icon-prompt.ts`（生图提示词里的「游戏内显示名」）。
 * 四份已经对不上——同一个「强化石」在结算面板里叫「遗物强化石」，
 * 在关卡页里叫「强化石」。**两处各写一套必然对不上**（铁律 #4）。
 *
 * 现在名称与描述只此一处：`RESOURCE_DEFS`。
 * 界面上凡是「图标 + 名称」并排的地方，名称一律取这里，禁止就地写中文名。
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
import { GACHA, RELIC, SKILL } from './economy.ts'

export interface ResourceDef {
  /** 唯一展示名（界面一律取这里） */
  name: string
  /** 作用描述；可含 `{key}` 占位符，取值见 `RESOURCE_TEXT_VARS` */
  desc: string
  /** 是否给出「前往召唤」入口（抽卡类资源）——抽卡是核心循环，入口必须可达（铁律 #10） */
  gachaEntry?: boolean
}

/**
 * 全量资源登记。
 *
 * ⚠ 类型是 `Record<ResourceIconKey, ResourceDef>`：
 *   `RESOURCE_ICON_KEYS`（`art.ts`）新增一个 key 而这里没登记 → **编译期报错**，
 *   不会出现「有图标但没有名字 / 没有说明」的半成品资源（铁律 #22）。
 */
export const RESOURCE_DEFS: Record<ResourceIconKey, ResourceDef> = {
  silver: {
    name: '银两',
    desc: '通用货币。用于遗物强化（标准段每级 {relicSilverCost} 银两）与英灵技能升级'
      + '（每级 {skillSilverCost} 银两）；分解不用的遗物时也会返还一部分。',
  },
  exp: {
    name: '经验',
    desc: '英灵的经验来源。推征与离线结算会累积到玩家经验池，再手动喂给英灵；'
      + '英灵卡在境界门槛上时，需要先消耗英灵印记突破才会继续成长。',
  },
  crystals: {
    name: '圣杯结晶',
    desc: '召唤英灵的主要消耗，每抽 {gachaCost} 点，十连为 {tenPullCount} 抽。'
      + '结晶不足时，结算会自动改用抽卡券抵扣。',
    gachaEntry: true,
  },
  tickets: {
    name: '抽卡券',
    desc: '{ticketPerPull} 张抵 1 抽，单抽与十连通用。结算时优先扣圣杯结晶，'
      + '不够的部分自动改用抽卡券，不会把余额扣成负数。',
    gachaEntry: true,
  },
  skillStones: {
    name: '术式结晶',
    desc: '英灵技能升级材料，每级 {skillStoneCost} 颗（另需 {skillSilverCost} 银两）。'
      + '注意它与圣杯结晶不是同一种资源，升级技能不消耗圣杯结晶。',
  },
  relicStones: {
    name: '强化石',
    desc: '遗物强化材料，标准段每级 {relicStoneCost} 颗（另需 {relicSilverCost} 银两）；'
      + 'Lv{overSegmentStart} 起的淬炼段价格按指数递增。',
  },
  emblems: {
    name: '英灵印记',
    desc: '重复获得的英灵会转化为英灵印记。用于英灵升星与境界突破——'
      + '英灵卡在境界门槛上时，需要消耗印记突破才能继续成长。',
  },
  shards: {
    name: '英灵碎片',
    desc: '同名英灵碎片，用于提升该英灵的星级。重复获得的高稀有度英灵会额外返还同名碎片。',
  },
  medals: {
    name: '竞技勋章',
    desc: '竞技场专属产出，用于竞技兑换，每周有获取上限。竞技产出不回流主线养成经济。',
  },
  arenaMaterials: {
    name: '竞技材料',
    desc: '竞技场专属产出之一，用于竞技兑换。竞技产出不回流主线养成经济。',
  },
}

/**
 * 顶部资源条常驻的资源。
 *
 * ⚠ 每一项都必须是 `player` 上的**数值字段**——
 *   `shards` 是「英灵 id → 碎片数」的映射（Record），进不了顶栏；
 *   `medals` / `arenaMaterials` 挂在 `arena` 上，也不是 player 字段。
 *   `tests/unit/resources.test.ts` 会按存档类型校验这条。
 */
export const TOP_BAR_RESOURCE_KEYS = [
  'silver',
  'crystals',
  'tickets',
  'skillStones',
  'relicStones',
  'emblems',
] as const satisfies readonly ResourceIconKey[]

/** 顶栏资源 key 类型 */
export type TopBarResourceKey = (typeof TOP_BAR_RESOURCE_KEYS)[number]

/**
 * 描述文案的占位符取值——**全部来自 economy 配置**，不写死。
 */
export const RESOURCE_TEXT_VARS = {
  gachaCost: GACHA.COST_SINGLE,
  tenPullCount: GACHA.TEN_PULL_COUNT,
  ticketPerPull: GACHA.TICKET_PER_PULL,
  skillStoneCost: SKILL.SKILL_STONES_PER_LEVEL,
  skillSilverCost: SKILL.SILVER_PER_LEVEL,
  relicStoneCost: RELIC.STONES_PER_LEVEL,
  relicSilverCost: RELIC.SILVER_PER_LEVEL,
  overSegmentStart: RELIC.OVER_SEGMENT_START,
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
