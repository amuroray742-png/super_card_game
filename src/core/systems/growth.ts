/**
 * 养成系统（§5.4）：等级、星级、技能。
 *
 * 全部走独立乘区：
 * - 等级 / 星级 → 基础属性
 * - 星级被动   → skill 乘区
 * - 境界       → realm 乘区
 */
import type { HeroRuntime, HeroState, StatMod } from '../model/types.ts'
import { LEVEL, REALMS, SKILL, STAR } from '../config/economy.ts'
import { getRealm, nextRealm } from './stats.ts'

// ─────────────────────────── 等级 ───────────────────────────

/**
 * 升到下一级所需经验。
 *
 * 指数项用**全局等级**（L-1），境界通过 realm.expScale 做乘数。
 *
 * ⚠ 原实现用境界内局部等级做指数（localIndex = L - realm.minLevel），
 * 导致境界切换那一级的经验需求断崖式下跌：
 *   expToNext(60) = 60 × 1.115^59 × 1     = 36,929
 *   expToNext(61) = 60 × 1.115^0  × 8     =    480   ← 骤降 77 倍
 * 后果是玩家一进新境界就能瞬间连升数级，境界门槛形同虚设。
 * 改为全局指数后，境界切换是 expScale 带来的**向上**台阶（真正的门槛）。
 */
export function expToNext(level: number): number {
  const realm = getRealm(level)
  return Math.floor(LEVEL.EXP_BASE * Math.pow(LEVEL.EXP_GROWTH, level - 1) * realm.expScale)
}

/** 当前等级累计消耗经验 */
export function totalExpToReach(level: number): number {
  let sum = 0
  for (let l = 1; l < level; l++) sum += expToNext(l)
  return sum
}

export interface LevelUpResult {
  levelsGained: number
  expConsumed: number
  expRemaining: number
  blockedByRealm: boolean
}

/**
 * 消耗经验提升等级。
 * 境界门槛：达到下一境界最低等级时停下，需玩家使用突破材料才能继续（§5.4）。
 */
export function applyExp(hero: HeroState, expGain: number): LevelUpResult {
  let exp = hero.exp + Math.max(0, Math.floor(expGain))
  let consumed = 0
  let levels = 0
  let blocked = false

  const next = nextRealm(hero.level)
  const hardCap = next ? next.minLevel - 1 : LEVEL.MAX

  while (hero.level < hardCap && hero.level < LEVEL.MAX) {
    const need = expToNext(hero.level)
    if (exp < need) break
    exp -= need
    consumed += need
    hero.level++
    levels++
  }

  // 撞到境界门槛
  if (hero.level === hardCap && next && exp >= expToNext(hero.level)) {
    blocked = true
  }
  if (hero.level >= LEVEL.MAX) blocked = false

  hero.exp = exp
  return { levelsGained: levels, expConsumed: consumed, expRemaining: exp, blockedByRealm: blocked }
}

/** 境界突破：消耗材料提升境界上限 */
export interface RealmBreakCost {
  material: string
  count: number
}

export function realmBreakCost(level: number): RealmBreakCost | null {
  const next = nextRealm(level)
  if (!next || !next.breakMaterial) return null
  return { material: next.breakMaterial, count: next.breakCount }
}

/** 境界是否已解锁（等级达标 + 材料已消耗） */
export function realmUnlocked(level: number): boolean {
  const realm = getRealm(level)
  return realm.breakMaterial === null || level > realm.minLevel
}

// ─────────────────────────── 星级 ───────────────────────────

export interface StarUpCost {
  shards: number
  emblems: number
}

/**
 * 升星消耗。同名碎片来自卡池重复转化，印记来自通用回收。
 * 注意：重复抽卡**不**直接提升星级数值（合规 §2.1），
 * 重复英灵统一转化为印记，印记再兑换养成材料。
 */
export function starUpCost(currentStar: number): StarUpCost | null {
  if (currentStar >= STAR.MAX) return null
  return { shards: STAR.SHARDS_PER_STAR, emblems: STAR.SHARDS_PER_STAR * 2 }
}

export function canStarUp(hero: HeroState, shards: number, emblems: number): boolean {
  const cost = starUpCost(hero.star)
  if (!cost) return false
  return shards >= cost.shards && emblems >= cost.emblems
}

export function applyStarUp(hero: HeroState): boolean {
  if (hero.star >= STAR.MAX) return false
  hero.star++
  return true
}

// ─────────────────────────── 被动 ───────────────────────────

/**
 * 已解锁的星级被动修正（skill 乘区）。
 * 竞技模式下由 resolveStats 按 passiveScale 打折。
 */
export function getHeroPassiveMods(hero: HeroRuntime): StatMod[] {
  const mods: StatMod[] = []
  for (const passive of hero.def.passives) {
    if (hero.state.star < passive.unlockStar) continue
    mods.push(...passive.mods)
  }
  return mods
}

// ─────────────────────────── 技能 ───────────────────────────

export interface SkillUpCost {
  crystals: number
  silver: number
}

export function skillUpCost(currentLevel: number): SkillUpCost | null {
  if (currentLevel >= SKILL.MAX_LEVEL) return null
  return {
    crystals: SKILL.CRYSTALS_PER_LEVEL,
    silver: SKILL.SILVER_PER_LEVEL,
  }
}

/**
 * 技能升级。同时受境界门槛约束（技能等级上限 = min(20, 境界内等级 + 10)）。
 *
 * ⚠ 原实现写作 `realm.maxLevel - realm.minLevel + 1 + 10`，
 * 而每个境界的等级区间恒为 60 关，该表达式恒等于 70，
 * 导致**境界门槛完全失效**——英雄 1 级就能把技能升满 20 级，
 * 技能维度对养成深度没有任何约束力。
 * 正确语义是「在当前境界内已推进的等级数 + 10」，
 * 即进入新境界后技能上限回落到 11 级，随境界推进逐步解锁到 20 级。
 */
export function skillLevelCap(level: number): number {
  const realm = getRealm(level)
  const cap = Math.min(SKILL.MAX_LEVEL, level - realm.minLevel + 1 + 10)
  return cap
}

export function applySkillUp(hero: HeroState, index: number): boolean {
  if (index < 0 || index >= hero.skillLevels.length) return false
  const cap = skillLevelCap(hero.level)
  if (hero.skillLevels[index] >= cap) return false
  hero.skillLevels[index]++
  return true
}

/** 技能等级带来的效果强度（PVE 全额） */
export function skillEffectPct(level: number): number {
  return (Math.max(SKILL.MIN_LEVEL, Math.min(SKILL.MAX_LEVEL, level)) - 1) * SKILL.PCT_PER_LEVEL
}

// ─────────────────────────── 初始化 ───────────────────────────

export function createHeroState(id: string, now: number): HeroState {
  return {
    id,
    level: LEVEL.MIN,
    exp: 0,
    star: STAR.MIN,
    skillLevels: [1, 1, 1],
    shards: 0,
    coreAwakened: false,
    obtainedAt: now,
  }
}

export { REALMS }
