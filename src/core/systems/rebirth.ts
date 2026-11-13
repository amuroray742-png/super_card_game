/**
 * 圣杯重启（§10.2 回收阀门之一）。
 *
 * 把"无限增长"转成"有限的多周目"：重置养成进度换取永久加成。
 * 这是长循环的核心——没有它，数值后期必然崩坏。
 */
import type { SaveData } from '../model/types.ts'
import { LEVEL, REBIRTH, STAR } from '../config/economy.ts'
import { realmBreakCost } from './growth.ts'

export interface RebirthPreview {
  /** 是否满足重启条件 */
  eligible: boolean
  /** 不满足时的原因 */
  reason: string
  /** 重启后获得的永久加成 */
  gainedPermBoost: number
  /** 当前永久加成 */
  currentPermBoost: number
  /** 重启后的永久加成 */
  nextPermBoost: number
  /** 距离永久加成上限还差多少 */
  permBoostCapRemaining: number
  /** 将被重置的英灵数量 */
  resetHeroes: number
  /** 将被保留的英灵数量 */
  keptHeroes: number
}

/**
 * 重启条件：等级 ≥ 120 且通关第 5 章。
 */
export function previewRebirth(save: SaveData): RebirthPreview {
  const levels = Object.values(save.heroes).map((h) => h.level)
  const maxLevel = levels.length > 0 ? Math.max(...levels) : 0
  const clearedChapter = Math.floor(save.campaign.clearedStage / 30)

  const levelOk = maxLevel >= REBIRTH.MIN_LEVEL
  const chapterOk = clearedChapter >= REBIRTH.MIN_CHAPTER

  const reason = !levelOk
    ? `需要任一英灵达到 ${REBIRTH.MIN_LEVEL} 级（当前最高 ${maxLevel} 级）`
    : !chapterOk
      ? `需要通关第 ${REBIRTH.MIN_CHAPTER} 章（当前第 ${clearedChapter} 章）`
      : ''

  const gainedPermBoost = Math.min(
    REBIRTH.PERM_BOOST_PER_ROUND,
    REBIRTH.PERM_BOOST_CAP - save.player.permBoost,
  )

  return {
    eligible: levelOk && chapterOk,
    reason,
    gainedPermBoost,
    currentPermBoost: save.player.permBoost,
    nextPermBoost: save.player.permBoost + gainedPermBoost,
    permBoostCapRemaining: REBIRTH.PERM_BOOST_CAP - save.player.permBoost,
    resetHeroes: Object.keys(save.heroes).length,
    keptHeroes: Object.keys(save.heroes).length,
  }
}

/**
 * 执行圣杯重启。
 *
 * 重置：等级、经验、星级、技能等级、遗物强化等级
 * 保留：英灵本体、印记、同名碎片、图鉴、赛季段位、遗物实例本身
 */
export function performRebirth(save: SaveData): RebirthPreview {
  const preview = previewRebirth(save)
  if (!preview.eligible) return preview

  for (const hero of Object.values(save.heroes)) {
    hero.level = LEVEL.MIN
    hero.exp = 0
    hero.star = STAR.MIN
    hero.skillLevels = [1, 1, 1]
  }

  for (const relic of save.relics) {
    relic.level = 1
  }

  save.player.permBoost = preview.nextPermBoost
  save.player.rebirthCount += 1

  return preview
}

/**
 * 境界突破消耗检查（用于 UI 提示）。
 * 突破消耗**英灵印记**（emblems）。
 */
export function realmBreakRequirement(level: number) {
  return realmBreakCost(level)
}
