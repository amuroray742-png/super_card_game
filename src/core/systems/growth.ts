/**
 * 养成系统（§5.4）：等级、星级、技能。
 *
 * 全部走独立乘区：
 * - 等级 / 星级 → 基础属性
 * - 星级被动   → skill 乘区
 * - 境界       → realm 乘区
 */
import type { Element, HeroRuntime, HeroState, StatMod } from '../model/types.ts'
import type { ItemId } from '../config/items.ts'
import { LEVEL, REALMS, SKILL, STAR } from '../config/economy.ts'
import { ITEM_BY_ELEMENT } from '../config/items.ts'
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
 *
 * 境界门槛：达到本境界上限（凡阶 Lv60 / 名阶 Lv120 / 圣阶 Lv180）时停下，
 * 需玩家先完成**境界突破**（消耗**银两**）才能继续（§5.4）。
 * 停在门槛上时，已投入但没用完的经验保留在 `hero.exp`，突破后立刻兑现。
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

/**
 * 喂经验书的**预览**（纯计算，不改存档）。
 *
 * ⚠ 界面用它显示「喂 N 本会升几级 / 会不会被境界门槛卡住」——
 *   表现层不得自己算（铁律 #4：口径只有一份）。
 *
 * @param bookExp 单本经验书的经验值
 * @param count   想喂的本数
 */
export function previewFeed(hero: HeroState, bookExp: number, count: number): FeedBooksResult {
  const want = Math.max(0, Math.floor(count))
  if (want <= 0 || hero.level >= LEVEL.MAX) {
    return { applied: 0, booksUsed: 0, expRemaining: hero.exp, levelsGained: 0, blockedByRealm: false }
  }
  const clone: HeroState = { ...hero, skillLevels: [...hero.skillLevels] }
  const res = applyExp(clone, bookExp * want)
  return {
    applied: want * bookExp,
    booksUsed: want,
    expRemaining: res.expRemaining,
    levelsGained: res.levelsGained,
    blockedByRealm: res.blockedByRealm,
  }
}

/** 喂经验书的结果 */
export interface FeedBooksResult {
  /**
   * **本次投入**的经验（= `booksUsed × 单本面值`）。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：原先写成 `expConsumed + expRemaining`，
   *   而 `expRemaining` 是英灵**全部**存量经验 —— 于是每次喂书都把存量重报一遍
   *   （喂 10 次虚报 10 倍），界面上「投入 6232 经验」而玩家只喂了 1000。
   *   「本次投入」只能是这次喂进去的那部分；存量另走 `expRemaining`。
   */
  applied: number
  /** 实际消耗的书本数 */
  booksUsed: number
  /** 喂完之后英灵身上**存着**的经验（卡在境界门槛上时不为 0） */
  expRemaining: number
  levelsGained: number
  blockedByRealm: boolean
}

/**
 * 执行喂经验书（**只改英灵状态，不动资源**）。
 *
 * ⚠ 资源扣减由动作层（`core/systems/actions.ts`）负责——
 *   与 `applySkillUp` / `applyStarUp` 一致，避免两处各写一套扣费规则。
 */
export function applyFeedBooks(hero: HeroState, bookExp: number, count: number): FeedBooksResult {
  const preview = previewFeed(hero, bookExp, count)
  if (preview.booksUsed <= 0) return preview
  const res = applyExp(hero, bookExp * preview.booksUsed)
  return {
    applied: preview.booksUsed * bookExp,
    booksUsed: preview.booksUsed,
    expRemaining: res.expRemaining,
    levelsGained: res.levelsGained,
    blockedByRealm: res.blockedByRealm,
  }
}

/** 境界突破：消耗材料提升境界上限 */
export interface RealmBreakCost {
  /** 突破消耗的**银两**数量 */
  silver: number
  /** 突破后进入的境界 id */
  realmId: string
  /** 突破后达到的等级（即新境界的第 1 级） */
  targetLevel: number
}

/**
 * 下一个境界的突破消耗；已在最高境界返回 null。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：消耗品从「英灵印记」改为**银两**
 *   （设计稿 §2「建议 Lv60、120、180 的境界突破改扣银两，
 *   维持低星英灵通往满级的路线」）。印记已随钱包收敛而退役。
 */
export function realmBreakCost(level: number): RealmBreakCost | null {
  const next = nextRealm(level)
  if (!next || !next.breakCost) return null
  return { silver: next.breakCost.silver, realmId: next.id, targetLevel: next.minLevel }
}

/**
 * 是否卡在境界门槛（已到本境界上限，需要突破才能继续升级）。
 *
 * 境界门槛是 `applyExp` 的硬上限（`next.minLevel - 1`），所以英灵会在
 * 凡阶末（Lv60）/ 名阶末（Lv120）/ 圣阶末（Lv180）停下，等待突破。
 */
export function atRealmGate(level: number): boolean {
  const next = nextRealm(level)
  if (!next) return false
  return level >= next.minLevel - 1
}

/** 银两是否足够突破（且确实卡在门槛上） */
export function canBreakRealm(level: number, silver: number): boolean {
  const cost = realmBreakCost(level)
  if (!cost) return false
  if (!atRealmGate(level)) return false
  return silver >= cost.silver
}

/**
 * 执行境界突破：等级跨入下一境界（第 1 级）。
 *
 * 与 `applySkillUp` / `applyStarUp` 一致，**只改英灵状态、不动资源**——
 * 资源由表现层的 store 扣，避免两处各写一套扣费规则。
 *
 * 突破时英灵身上已投入但未升级的经验**不丢失**，会保留在 `hero.exp`，
 * 下一次喂经验（或 store 主动触发结算）时立刻兑现成等级。
 */
export function applyRealmBreak(hero: HeroState): boolean {
  if (!atRealmGate(hero.level)) return false
  const next = nextRealm(hero.level)
  if (!next) return false
  hero.level = next.minLevel
  return true
}

/** 境界是否已解锁（起始境界恒为已解锁，其余境界需等级跨入） */
export function realmUnlocked(level: number): boolean {
  const realm = getRealm(level)
  if (realm.breakCost === null) return true
  return level >= realm.minLevel
}

// ─────────────────────────── 星级 ───────────────────────────

export interface StarUpCost {
  /**
   * 升星所需的**同名碎片**数量。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：印记需求已取消——
   *   设计稿 §2「升星只扣同名碎片」。重复抽卡**不**直接提升星级数值（合规 §2.1），
   *   重复卡统一转化为同名碎片，碎片再兑换星级。
   */
  shards: number
}

/**
 * 升星消耗。同名碎片来自卡池重复转化。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：只扣同名碎片（不再扣印记）。
 */
export function starUpCost(currentStar: number): StarUpCost | null {
  if (currentStar >= STAR.MAX) return null
  return { shards: STAR.SHARDS_PER_STAR }
}

export function canStarUp(hero: HeroState, shards: number): boolean {
  const cost = starUpCost(hero.star)
  if (!cost) return false
  return shards >= cost.shards
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
  /**
   * 消耗的**五行技能材料**数量。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：术式结晶（单一通用材料）已退役，
   *   改为按英灵五行匹配的材料（金→金系技能材料 …）。
   *   材料 id 见 `core/config/items.ts` 的 `ITEM_BY_ELEMENT`（唯一口径）。
   */
  material: number
  /** 材料道具 id（写入 / 扣费都用它，禁止各写一份） */
  materialId: ItemId
  silver: number
}

/**
 * 技能升级消耗。
 *
 * @param currentLevel 当前技能等级
 * @param element     英灵**五行**——决定用哪种材料
 */
export function skillUpCost(currentLevel: number, element: Element): SkillUpCost | null {
  if (currentLevel >= SKILL.MAX_LEVEL) return null
  return {
    material: SKILL.MATERIAL_PER_LEVEL,
    materialId: ITEM_BY_ELEMENT[element],
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
