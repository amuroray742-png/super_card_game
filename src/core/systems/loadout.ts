/**
 * 遗物装备（§5.5）。
 *
 * 存档里 `equipped` 的 key 格式此前没有定义（表现层只能自己拼字符串，
 * 违反「禁硬编码」铁律）。本模块把装备读写收进 core：
 *   key = `${heroId}#${slot}`，slot ∈ [0, 6)
 *   value = { heroId, relicId }
 *
 * 遗物本体没有「部位」字段，6 个槽位是**通用槽**；
 * 套装效果按槽内套装件数计算（见 relic.ts 的 getSetMods）。
 */
import type { RelicInstance, SaveData } from '../model/types.ts'

/** 每名英灵的遗物槽数 */
export const RELIC_SLOT_COUNT = 6

/** 槽位在存档中的 key */
export function equipKey(heroId: string, slot: number): string {
  return `${heroId}#${slot}`
}

/** 解析存档 key → { heroId, slot } */
export function parseEquipKey(key: string): { heroId: string; slot: number } | null {
  const idx = key.lastIndexOf('#')
  if (idx <= 0) return null
  const heroId = key.slice(0, idx)
  const slot = Number(key.slice(idx + 1))
  if (!Number.isInteger(slot) || slot < 0 || slot >= RELIC_SLOT_COUNT) return null
  return { heroId, slot }
}

/** 某英灵的 6 个遗物槽（未装备为 null） */
export function getEquippedRelics(save: SaveData, heroId: string): (RelicInstance | null)[] {
  const byUid = new Map(save.relics.map((r) => [r.uid, r]))
  const slots: (RelicInstance | null)[] = new Array(RELIC_SLOT_COUNT).fill(null)
  for (const [key, entry] of Object.entries(save.equipped)) {
    const parsed = parseEquipKey(key)
    if (!parsed || parsed.heroId !== heroId) continue
    slots[parsed.slot] = byUid.get(entry.relicId) ?? null
  }
  return slots
}

/** 装备遗物（自动从其他槽位卸下同一件遗物） */
export function equipRelic(save: SaveData, heroId: string, slot: number, relicId: string): void {
  if (slot < 0 || slot >= RELIC_SLOT_COUNT) return
  if (!save.heroes[heroId]) return
  if (!save.relics.some((r) => r.uid === relicId)) return

  // 先从所有槽位移除该遗物
  for (const key of Object.keys(save.equipped)) {
    if (save.equipped[key].relicId === relicId) delete save.equipped[key]
  }
  // 原槽位上的遗物先卸下
  const oldKey = equipKey(heroId, slot)
  if (save.equipped[oldKey]) delete save.equipped[oldKey]

  save.equipped[equipKey(heroId, slot)] = { heroId, relicId }
}

/** 卸下某槽位的遗物 */
export function unequipRelic(save: SaveData, heroId: string, slot: number): void {
  const key = equipKey(heroId, slot)
  if (save.equipped[key]) delete save.equipped[key]
}

/** 某英灵当前装备的全部遗物（按槽位顺序） */
export function listEquipped(save: SaveData, heroId: string): RelicInstance[] {
  return getEquippedRelics(save, heroId).filter((r): r is RelicInstance => r !== null)
}
