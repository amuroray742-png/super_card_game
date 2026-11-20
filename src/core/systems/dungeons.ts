/**
 * 材料副本运行器（技能副本 / 强化副本）。
 *
 * ## 契约
 *
 * - **波次来源**：取材章节的**主线关卡 id 列表**（`STAGES` 按 chapter 过滤），
 *   逐场 `runBattle`（复用 `core/systems/battle.ts`，**不新写战斗**）。
 * - **掉落**：胜利结算**只发所选材料**，不发银两 / 经验 / 遗物
 *   （设计稿 §3「副本胜利只发所选的五行材料或石档」）。
 * - **不写 `campaign`**：`clearedStage` / `stageStars` / `creditedStages` 全部不动
 *   （副本进度与主线记录分别记账）。
 * - **失败处理**：战败即停本次副本结算，并回报「在第 N 场战败」
 *   +「可降难度继续」（设计稿「副本失败给出可刷的低难度选择」）。
 *   **不**沿用主线的 `farm` 回退逻辑（副本不刷关卡）。
 */
import type { BattleContext, SaveData } from '../model/types.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { STAGES, getStage } from '../config/stages.ts'
import { getEnemy } from '../config/enemies.ts'
import { RELIC, DUNGEON_DIFFICULTIES, type DungeonDifficultyId } from '../config/economy.ts'
import {
  DUNGEON_INDEX,
  dungeonDropAmount,
  type DungeonVariant,
  type DungeonVariantId,
} from '../config/dungeons.ts'
import { skillLevelCap } from './growth.ts'
import { Rng } from '../rng.ts'
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
 * 副本解锁判定。
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

/** 取材章节的主线关卡 id 列表（副本波次顺序） */
export function dungeonStages(chapter: number): number[] {
  return STAGES.filter((s) => s.chapter === chapter).map((s) => s.id)
}

/** 副本难度 → 取材章节 */
export function dungeonChapter(difficulty: DungeonDifficultyId): number {
  return DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.chapter ?? 1
}

/** 变体 id → 定义（找不到返回 null） */
export function variantById(id: DungeonVariantId): DungeonVariant | null {
  return DUNGEON_INDEX.get(id) ?? null
}

/** 一次副本结算的结果 */
export interface DungeonRunResult {
  /** 实际跑掉的场次 */
  battles: number
  /** 胜利场次 */
  wins: number
  /** 掉落（道具 id → 数量） */
  items: Record<string, number>
  /** 是否被卡住（战败） */
  blocked: boolean
  /** 战败发生在第几场（1 起） */
  blockedAtBattle: number | null
  /** 建议降到的难度（战败时给出） */
  suggestDifficulty: DungeonDifficultyId | null
}

/**
 * 跑一次副本。
 *
 * ⚠ 副本**不写 `campaign`**：进度与主线记录分别记账（设计稿 §3）。
 *
 * @param battles 要跑的场次（由挂机时间账本换算而来）
 */
export function runDungeon(
  save: SaveData,
  variant: DungeonVariant,
  difficulty: DungeonDifficultyId,
  battles: number,
  seed: number,
  ctx: BattleContext,
): DungeonRunResult {
  const rng = new Rng(seed)
  const team = buildTeam(save)
  const waves = dungeonStages(dungeonChapter(difficulty))
  const drop = dungeonDropAmount(variant, difficulty)

  const result: DungeonRunResult = {
    battles: 0,
    wins: 0,
    items: {},
    blocked: false,
    blockedAtBattle: null,
    suggestDifficulty: null,
  }
  if (team.length === 0 || waves.length === 0) {
    result.blocked = true
    result.blockedAtBattle = 1
    result.suggestDifficulty = suggestLowerDifficulty(difficulty)
    return result
  }

  const pve = buildPveContext(save)
  for (let i = 0; i < battles; i++) {
    const stage = getStage(waves[i % waves.length])
    const enemies = stage.enemyIds
      .map((id) => getEnemy(id))
      .filter((e): e is NonNullable<typeof e> => e !== null)
    if (enemies.length === 0) {
      result.blocked = true
      result.blockedAtBattle = result.battles + 1
      result.suggestDifficulty = suggestLowerDifficulty(difficulty)
      break
    }
    const battle = runBattle({
      allies: team,
      enemies,
      enemyScale: stage.enemyScale,
      ctx: { ...ctx, mode: 'pve', seed: rng.nextSeed() },
    })
    result.battles++
    if (!battle.win) {
      result.blocked = true
      result.blockedAtBattle = result.battles
      result.suggestDifficulty = suggestLowerDifficulty(difficulty)
      break
    }
    result.wins++
    const count = rng.int(drop.min, drop.max)
    result.items[variant.itemId] = (result.items[variant.itemId] ?? 0) + count
  }
  return result
}

/** 战败时建议降一档难度（已经最低就返回 null） */
export function suggestLowerDifficulty(
  difficulty: DungeonDifficultyId,
): DungeonDifficultyId | null {
  const order: DungeonDifficultyId[] = ['easy', 'normal', 'hard']
  const idx = order.indexOf(difficulty)
  if (idx <= 0) return null
  return order[idx - 1]
}
