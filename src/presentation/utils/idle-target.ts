/**
 * **挂机通道目标的显示名**（表现层公用）。
 *
 * ## 为什么单独抽一份
 *
 * 推征页（L1 的通道摘要行）与关卡一览页（L2 的「挂机目标」行）
 * 都要显示「这条通道现在挂的是哪一关」。
 * 两处各写一套 ⇒ 同一个目标在两个页面显示的名字会不一样
 * （铁律 #4「单一数据源」同款问题）。
 *
 * ⚠ 名字一律取 **core 配置表**：
 *   主线关卡名走 `STAGES`，副本关卡名走 `DUNGEON_STAGE_INDEX`，
 *   表现层**禁止**自己拼字符串（铁律 #8）。
 */
import { STAGES } from '../../core/config/stages.ts'
import { DUNGEON_STAGE_INDEX } from '../../core/config/dungeons.ts'
import type { IdleChannelKind, SaveData } from '../../core/model/types.ts'

/**
 * **主线通道的目标名**。
 *
 * - `stageId === null` = 跟随最新通关关卡 ⇒ 显示「<关卡名>（跟随）」；
 * - 还没通关任何关卡 ⇒ `null`（界面上写「未设置目标」）。
 *
 * ⚠ 后缀用「（跟随）」而不是「（跟随最新）」：挂机通道行在一屏里只有 ~140px
 *   留给目标名，「（跟随最新）」会把关卡名截成「…（跟随…」——
 *   看得见的半个词比短一截的完整词更糟（铁律 #68：一屏化的代价必须可控）。
 */
export function mainIdleTargetName(save: SaveData, clearedStage: number): string | null {
  const t = save.idle.channels.main.target
  if (!t || t.kind !== 'main') return null
  if (t.stageId === null) {
    if (clearedStage <= 0) return null
    const s = STAGES.find((x) => x.id === clearedStage)
    return s ? `${s.name}（跟随）` : null
  }
  const s = STAGES.find((x) => x.id === t.stageId)
  return s ? s.name : null
}

/**
 * **副本通道的目标名**（技能 / 强化 / 遗物三条通道）。
 *
 * ⚠ **遗物通道也算副本目标**（存档 v12）：旧判断只认 `skill` / `enhance`，
 *   遗物通道的目标永远显示不出来（卡片上写着「未设置目标」，玩家以为没挂上）。
 */
export function dungeonIdleTargetName(save: SaveData, kind: IdleChannelKind): string | null {
  const t = save.idle.channels[kind].target
  if (!t) return null
  const id =
    t.kind === 'skill' || t.kind === 'enhance' || t.kind === 'relic' ? t.dungeonStageId : null
  if (!id) return null
  return DUNGEON_STAGE_INDEX.get(id)?.name ?? null
}
