/**
 * 材料副本（技能副本 / 强化副本）——**挂机改版 v11**。
 *
 * ## 副本是 42 个独立关卡
 *
 * `(变体 × 难度) = 1 关`，共 5 技能变体 × 3 难度 + 3 强化变体 × 3 难度
 * + 6 遗物变体 × 3 难度 = **42 关**（遗物副本是存档 v12 加的第 4 条挂机通道）。
 * 每关有自己的敌人组合、缩放锚点、战力门槛与产量，**打赢一次即通关**。
 *
 * ## 契约
 *
 * - **战斗**：手动挑战打**一场**真实战斗（`core/systems/battle.ts`，**不新写战斗**）。
 *   挂机**不跑战斗**——挂机按掉落表逐次掷奖（见 `core/systems/idle.ts`）。
 * - **掉落**：胜利结算**只发所选材料**，不发银两 / 经验书 / 遗物 / 首通结晶。
 * - **不写 `campaign`**：`clearedStage` / `stageStars` / `creditedStages` 全部不动
 *   （副本进度与主线记录分别记账）。
 * - **解锁判定在 systems 层**（`dungeonUnlocked`）：技能副本要「该五行有可升技能的英灵」，
 *   强化副本要「持有该档解锁线以上的遗物」。判定依赖英灵定义与遗物实例 →
 *   不能放纯配置层。
 */
import type { BattleContext, BattleResult, SaveData } from '../model/types.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { getEnemy } from '../config/enemies.ts'
import { RELIC, RELIC_DROP, DUNGEON_DIFFICULTY_ORDER, type DungeonDifficultyId } from '../config/economy.ts'
import {
  DUNGEON_INDEX,
  dungeonStageById,
  type DungeonStageDef,
  type DungeonVariant,
  type DungeonVariantId,
} from '../config/dungeons.ts'
import { skillLevelCap } from './growth.ts'
import { runBattle } from './battle.ts'
import { buildPveContext, buildTeam } from './derive.ts'

/**
 * 解锁判定需要的**仓库事实**（客户端算不出来的那部分）。
 *
 * ⚠ 客户端镜像里 `save.relics` **只有已装备件**（存档分包，铁律 #8），
 *   仓库里那件 Lv60 的遗物客户端根本看不见 →
 *   强化副本的解锁线必须由服务端统计后传入，否则界面永远显示「未解锁」。
 */
export interface DungeonUnlockFacts {
  /** 仓库里遗物的最高等级（无遗物时为 0） */
  maxRelicLevel: number
}

/**
 * 副本解锁判定（**按变体**，三个难度段共用同一条判定）。
 *
 * - **技能副本**：该五行**有可升技能的英灵**（拥有该五行英灵且其技能未达境界上限）。
 * - **强化副本**：持有遗物的**最高等级** ≥ 该档解锁线（初阶 1 / 中阶 60 / 高阶 130）。
 *
 * ⚠ 「有可升技能的英灵」要读**英灵定义**（五行 + 技能等级上限），
 *   所以这个判定放在 systems 层而不是纯配置的 config 层。
 *
 * @param facts 仓库事实；**服务端**的存档里有全仓库遗物，可以不传（自行从 `save.relics` 取），
 *   **客户端**必须传服务端统计出来的 `maxRelicLevel`（镜像里只有已装备件）。
 * @returns 未解锁时给出**原因**与**引导路由**（养成页据此给直达入口）
 */
export function dungeonUnlocked(
  save: SaveData,
  variant: DungeonVariant,
  facts?: DungeonUnlockFacts,
): { unlocked: boolean; reason: string; hintRoute: string } {
  if (variant.kind === 'relic') {
    // ⚠ 遗物副本按**主线进度**解锁，**不能**挂在遗物上——
    //   强化副本要求「持有 Lv1 遗物」，若遗物副本也要求持有遗物 ⇒ 循环依赖
    //   ⇒ 首件遗物永远拿不到 ⇒ 整条强化链锁死（2026-11-24 那次故障的成因）。
    const need = RELIC_DROP.UNLOCK_STAGE[variant.id] ?? 1
    const cleared = save.campaign.clearedStage
    if (cleared < need) {
      return {
        unlocked: false,
        reason: `需要主线通关第 ${need} 关（当前第 ${cleared} 关）`,
        hintRoute: 'expedition',
      }
    }
    return { unlocked: true, reason: '', hintRoute: 'expedition' }
  }

  if (variant.kind === 'enhance') {
    const tier = RELIC.STONE_TIERS.find((t) => t.id === variant.tier)
    const unlockLevel = tier?.unlockRelicLevel ?? 1
    const maxRelicLevel =
      facts?.maxRelicLevel ?? save.relics.reduce((max, r) => Math.max(max, r.level), 0)
    if (maxRelicLevel < unlockLevel) {
      return {
        unlocked: false,
        reason: `需要持有 Lv${unlockLevel} 遗物（当前最高 Lv${maxRelicLevel}）`,
        hintRoute: 'forge',
      }
    }
    return { unlocked: true, reason: '', hintRoute: 'forge' }
  }

  const element = variant.element
  if (!element) {
    return { unlocked: false, reason: '副本配置异常', hintRoute: 'dungeon' }
  }
  if (Object.keys(save.heroes).length === 0) {
    return { unlocked: false, reason: '还没有英灵，无法进入技能副本', hintRoute: 'gacha' }
  }
  let usable = 0
  for (const state of Object.values(save.heroes)) {
    const def = HERO_INDEX.get(state.id)
    if (!def || def.element !== element) continue
    const cap = skillLevelCap(state.level)
    if (state.skillLevels.some((lv) => lv < cap)) usable++
  }
  if (usable === 0) {
    return {
      unlocked: false,
      reason: `没有可升级技能的${element}属性英灵`,
      hintRoute: 'hero',
    }
  }
  return { unlocked: true, reason: '', hintRoute: 'hero' }
}

/** 变体 id → 定义（找不到返回 null） */
export function variantById(id: DungeonVariantId): DungeonVariant | null {
  return DUNGEON_INDEX.get(id) ?? null
}

/**
 * **副本关卡的解锁判定**（按关卡取其变体后走同一条判定）。
 */
export function dungeonStageUnlocked(
  save: SaveData,
  stage: DungeonStageDef,
  facts?: DungeonUnlockFacts,
): { unlocked: boolean; reason: string; hintRoute: string } {
  const variant = DUNGEON_INDEX.get(stage.variantId)
  if (!variant) return { unlocked: false, reason: '副本配置异常', hintRoute: 'dungeon' }
  return dungeonUnlocked(save, variant, facts)
}

/** 战败时建议降一档难度（已经最低就返回 null） */
export function suggestLowerDifficulty(
  difficulty: DungeonDifficultyId,
): DungeonDifficultyId | null {
  const idx = DUNGEON_DIFFICULTY_ORDER.indexOf(difficulty)
  if (idx <= 0) return null
  return DUNGEON_DIFFICULTY_ORDER[idx - 1]
}

/**
 * 跑**一场**副本关卡的真实战斗。
 *
 * ⚠ 敌人 = 关卡定义里的 `enemyIds`，缩放 = 关卡自己的 `enemyScale`；
 *   两者都来自 `core/config/dungeons.ts`（**唯一出处**，铁律 #3 / #8）。
 *
 * @returns 胜负 + 完整战斗结果（回放用）
 */
export function runDungeonLevel(
  save: SaveData,
  stageId: string,
  seed: number,
  ctx: BattleContext = { mode: 'pve', seed },
): { win: boolean; battle: BattleResult | null; stage: DungeonStageDef | null } {
  const stage = dungeonStageById(stageId)
  if (!stage) return { win: false, battle: null, stage: null }
  const team = buildTeam(save)
  if (team.length === 0) return { win: false, battle: null, stage }

  const enemies = stage.enemyIds
    .map((id) => getEnemy(id))
    .filter((e): e is NonNullable<typeof e> => e !== null)
  if (enemies.length === 0) return { win: false, battle: null, stage }

  const pve = buildPveContext(save)
  const battle = runBattle({
    allies: team,
    enemies,
    enemyScale: stage.enemyScale,
    ctx: { ...ctx, mode: 'pve', seed },
  })
  return { win: battle.win, battle, stage }
}
