/**
 * 奖励包 → 展示行（**名称的唯一口径转调**）。
 *
 * ⚠ 铁律 #8：界面上凡是「图标 + 名称」并排的地方，名称一律取
 *   `core/config/resources.ts` 的 `RESOURCE_DEFS` / `core/config/items.ts`
 *   的 `ITEM_DEFS`，**禁止就地写中文名**。
 *
 * > 教训：资源名此前在**四处**各写一份（顶栏 / 结算面板 / 关卡页 / 生图提示词），
 * > 已经对不上——同一个「强化石」在结算面板里叫「遗物强化石」，
 * > 在关卡页里叫「强化石」。这里统一成一处。
 */
import type { RewardBundle } from '../../core/model/types.ts'
import type { DropTableDef } from '../../core/config/economy.ts'
import { RESOURCE_DEFS } from '../../core/config/resources.ts'
import { ITEM_DEFS, type ItemId } from '../../core/config/items.ts'
import { formatNumber } from './format'

export interface RewardLine {
  /** 稳定 key（同一行在多次渲染间不变） */
  key: string
  /** 展示名（来自登记表） */
  label: string
  /** 数量（掉落预览行用 0，文本放在 `text` 里） */
  value: number
  /** 图标 key（可选；`shards` 这类没有独立图标的留空） */
  iconKey?: string
  /** 自定义展示文本（掉落预览用「概率 + 数量」） */
  text?: string
}

/**
 * 把奖励包拆成展示行。
 *
 * ⚠ **只列出数量 > 0 的行**——结算面板不该出现一串 0。
 * ⚠ 遗物是**实例**，这里只报件数（详情走遗物列表）。
 */
export function rewardLines(rewards: RewardBundle | undefined | null): RewardLine[] {
  if (!rewards) return []
  const lines: RewardLine[] = []

  if (rewards.silver) {
    lines.push({ key: 'silver', label: RESOURCE_DEFS.silver.name, value: rewards.silver, iconKey: 'silver' })
  }
  if (rewards.crystals) {
    lines.push({ key: 'crystals', label: RESOURCE_DEFS.crystals.name, value: rewards.crystals, iconKey: 'crystals' })
  }
  if (rewards.items) {
    for (const [id, n] of Object.entries(rewards.items)) {
      if (!n) continue
      const def = ITEM_DEFS[id as ItemId]
      if (!def) continue
      lines.push({ key: `item:${id}`, label: def.name, value: n, iconKey: def.iconKey })
    }
  }
  if (rewards.shards) {
    const total = Object.values(rewards.shards).reduce((s, n) => s + n, 0)
    if (total > 0) {
      lines.push({ key: 'shards', label: RESOURCE_DEFS.shards.name, value: total, iconKey: 'shards' })
    }
  }
  if (rewards.relics?.length) {
    lines.push({ key: 'relics', label: '遗物', value: rewards.relics.length })
  }
  return lines
}

/**
 * 奖励包 → 一行文本（签到 / 兑换码这类单行提示用）。
 *
 * ⚠ 名称同样来自登记表（不就地写中文名）。
 */
export function rewardText(rewards: RewardBundle | undefined | null): string {
  const lines = rewardLines(rewards)
  if (lines.length === 0) return ''
  return lines.map((l) => `${l.label} ×${l.value}`).join(' · ')
}

/**
 * 掉落表 → 展示行（关卡详情 / 战后结算共用同一份口径）。
 *
 * ⚠ 每类道具**各自独立**掷概率（`ItemDrop.chance` 是百分比，不是权重），
 *   所以展示口径是「概率 + 数量区间」。
 *
 * ⚠ 名称一律取 `ITEM_DEFS`（铁律 #8）。
 */
export function dropTableLines(table: DropTableDef | undefined | null): RewardLine[] {
  if (!table) return []
  const lines: RewardLine[] = []
  lines.push({
    key: 'silver',
    label: RESOURCE_DEFS.silver.name,
    value: 0,
    iconKey: 'silver',
    text: `${formatNumber(table.silver[0])} ~ ${formatNumber(table.silver[1])}`,
  })
  for (const drop of table.items) {
    const def = ITEM_DEFS[drop.id as ItemId]
    if (!def) continue
    lines.push({
      key: `item:${drop.id}`,
      label: def.name,
      value: 0,
      iconKey: def.iconKey,
      text: drop.chance >= 100
        ? `${drop.min} ~ ${drop.max}`
        : `${formatRate(drop.chance / 100)} 概率 · ${drop.min} ~ ${drop.max}`,
    })
  }
  return lines
}

/** 百分比格式化（与概率公示页同一口径） */
export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`
}
