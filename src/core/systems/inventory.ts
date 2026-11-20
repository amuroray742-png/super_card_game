/**
 * 遗物库存治理（仓库上限与溢出处理）。
 *
 * 遗物是唯一随挂机时长线性增长的存档字段：12 小时离线可积出数千件。
 * 上限的意义有三：
 *   ① 存档体积护杆（分包后主体不再随遗物数膨胀，但遗物表仍会）；
 *   ② 逼玩家做「分解还是留着」的决策 —— 仓库不再是垃圾桶；
 *   ③ 让「仓库满了」这件事**可见**，而不是悄悄吞掉掉落。
 *
 * ⚠ **绝不销毁玩家标记过的东西**：
 *   锁定的遗物、已装备的遗物**永不**自动分解。
 *   溢出部分若全是受保护遗物，则允许突破上限并上报 `skipped`，
 *   由服务端记日志、界面给提示 —— 而不是毁掉一件玩家特意留下的遗物。
 */
import type { RelicInstance, SaveData } from '../model/types.ts'
import { RARITY_RANK, RELIC } from '../config/economy.ts'
import { RELIC_DEFS, decomposeValue } from './relic.ts'

/** 溢出处理结果（会并入结算明细，让玩家看见发生了什么） */
export interface InventoryOverflowResult {
  /** 自动分解的件数 */
  salvaged: number
  /** 折算出的银两 */
  silver: number
  /** 因受保护（锁定 / 已装备）而保留、仍超出上限的件数 */
  skipped: number
}

/** 空结果（未触发溢出时返回） */
export function emptyOverflow(): InventoryOverflowResult {
  return { salvaged: 0, silver: 0, skipped: 0 }
}

/** 存档里已装备的遗物 uid */
export function equippedRelicIds(save: SaveData): Set<string> {
  return new Set(Object.values(save.equipped).map((entry) => entry.relicId))
}

/**
 * 「最没用」的排序：等级低 → 稀有度低。
 *
 * 只在**候选集**（未锁定且未装备）内部排序；
 * 锁定与已装备的遗物根本不进候选集。
 */
function compareSalvagePriority(a: RelicInstance, b: RelicInstance): number {
  if (a.level !== b.level) return a.level - b.level
  const ra = RARITY_RANK[RELIC_DEFS.get(a.defId)?.rarity ?? 'N']
  const rb = RARITY_RANK[RELIC_DEFS.get(b.defId)?.rarity ?? 'N']
  if (ra !== rb) return ra - rb
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0
}

/**
 * 执行库存上限（**原地修改存档**）。
 *
 * 扣减走 `decomposeValue` —— 与玩家手动分解同一口径，不另算一套。
 */
export function enforceInventoryCap(save: SaveData): InventoryOverflowResult {
  const result = emptyOverflow()
  const cap = RELIC.INVENTORY_CAP
  if (save.relics.length <= cap) return result

  const surplus = save.relics.length - cap
  const equipped = equippedRelicIds(save)
  const candidates = save.relics
    .filter((relic) => !relic.locked && !equipped.has(relic.uid))
    .sort(compareSalvagePriority)

  const take = candidates.slice(0, surplus)
  if (take.length === 0) {
    // 溢出部分全是受保护遗物 → 允许突破上限，但不销毁
    result.skipped = surplus
    return result
  }

  const taken = new Set(take.map((relic) => relic.uid))
  let silver = 0
  for (const relic of take) {
    const value = decomposeValue(relic)
    silver += value.silver
  }
  save.relics = save.relics.filter((relic) => !taken.has(relic.uid))
  save.player.silver += silver

  result.salvaged = take.length
  result.silver = silver
  result.skipped = surplus - take.length
  return result
}

/** 库存占用率（0..1），界面用它显示提醒 */
export function inventoryUsage(save: SaveData): number {
  if (RELIC.INVENTORY_CAP <= 0) return 0
  return save.relics.length / RELIC.INVENTORY_CAP
}

/** 是否已接近上限（界面提示用） */
export function inventoryNearCap(save: SaveData): boolean {
  return inventoryUsage(save) >= RELIC.INVENTORY_WARN_RATIO
}
