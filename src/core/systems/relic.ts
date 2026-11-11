/**
 * 遗物系统（§5.4）：生成、强化、分解、套装。
 *
 * 遗物是最大的乘区来源（zone 'relic'）。
 * 竞技模式下：只取套装效果（×0.7），随机词条与强化等级一律无效（§6.8）。
 */
import type { RelicDef, RelicInstance, RelicSetDef, StatMod } from '../model/types.ts'
import { RELIC } from '../config/economy.ts'
import { Rng } from '../rng.ts'

/** 遗物定义索引（由 config/relics.ts 在加载时注册） */
export const RELIC_DEFS = new Map<string, RelicDef>()
export const RELIC_SETS = new Map<string, RelicSetDef>()

export function registerRelics(defs: readonly RelicDef[], sets: readonly RelicSetDef[]) {
  for (const d of defs) RELIC_DEFS.set(d.id, d)
  for (const s of sets) RELIC_SETS.set(s.id, s)
}

/** 全局遗物实例 id 计数器（存档内自增，避免随机碰撞） */
let instanceCounter = 0
export function nextRelicUid(prefix = 'r'): string {
  instanceCounter++
  return `${prefix}${instanceCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

// ─────────────────────────── 生成 ───────────────────────────

/**
 * 生成一件遗物实例。
 * 主词条来自定义（固定），副词条从词条池随机抽取并定值（生成后不变）。
 */
export function generateRelic(defId: string, rng: Rng, level: number = RELIC.MIN_LEVEL): RelicInstance {
  const def = RELIC_DEFS.get(defId)
  if (!def) throw new Error(`未知遗物定义：${defId}`)

  const pool = [...def.subStatPool]
  rng.shuffle(pool)
  const subStats: StatMod[] = pool.slice(0, Math.min(RELIC.SUB_COUNT, pool.length)).map((m) => ({
    ...m,
    value: roundMod(m.value * rng.float(0.8, 1.2)),
  }))

  return {
    uid: nextRelicUid(),
    defId,
    level: clampLevel(level),
    subStats,
    locked: false,
  }
}

/** 批量生成 */
export function generateRelics(defIds: readonly string[], rng: Rng): RelicInstance[] {
  return defIds.map((id) => generateRelic(id, rng))
}

// ─────────────────────────── 属性 ───────────────────────────

/**
 * 遗物主词条按强化等级缩放；副词条固定不变。
 * 副词条是"随机词条"——竞技模式下会被忽略（见 getHeroSetMods）。
 */
export function getRelicMods(instance: RelicInstance): StatMod[] {
  const def = RELIC_DEFS.get(instance.defId)
  if (!def) return []
  const mult = 1 + (instance.level - 1) * RELIC.PCT_PER_LEVEL
  const main: StatMod[] = def.mainStats.map((m) => ({
    ...m,
    value: m.kind === 'pct' ? roundMod(m.value * mult) : roundMod(m.value * mult),
  }))
  const sub: StatMod[] = instance.subStats.map((m) => ({ ...m }))
  return [...main, ...sub]
}

/**
 * 已装备遗物的套装效果（zone 'relic'）。
 * PVE：全强度。竞技：由 resolveStats 按 setScale 打折后套用。
 */
export function getSetMods(instances: (RelicInstance | null)[]): StatMod[] {
  const counts = new Map<string, number>()
  for (const inst of instances) {
    if (!inst) continue
    const def = RELIC_DEFS.get(inst.defId)
    if (!def) continue
    counts.set(def.setId, (counts.get(def.setId) ?? 0) + 1)
  }

  const mods: StatMod[] = []
  for (const [setId, count] of counts) {
    const set = RELIC_SETS.get(setId)
    if (!set) continue
    for (const bonus of set.bonuses) {
      if (count >= bonus.pieces) mods.push(...bonus.mods)
    }
  }
  return mods
}

/** 某英灵身上的套装修正（不含单件词条） */
export function getHeroSetMods(hero: { relics: (RelicInstance | null)[] }): StatMod[] {
  return getSetMods(hero.relics)
}

/**
 * 按套装 id 列表计算套装效果。
 *
 * 竞技场专用：快照只记录"装备了哪几件套"，不含强化等级与随机词条，
 * 因此套装效果在竞技场中以固定标准强度生效（再由 resolveStats 按 setScale 打折）。
 */
export function getSetModsBySetIds(setIds: (string | null)[]): StatMod[] {
  const counts = new Map<string, number>()
  for (const setId of setIds) {
    if (!setId) continue
    counts.set(setId, (counts.get(setId) ?? 0) + 1)
  }
  const mods: StatMod[] = []
  for (const [setId, count] of counts) {
    const set = RELIC_SETS.get(setId)
    if (!set) continue
    for (const bonus of set.bonuses) {
      if (count >= bonus.pieces) mods.push(...bonus.mods)
    }
  }
  return mods
}

// ─────────────────────────── 强化 / 分解 ───────────────────────────

export interface RelicUpgradeCost {
  silver: number
  stones: number
}

export function relicUpgradeCost(level: number): RelicUpgradeCost | null {
  if (level >= RELIC.MAX_LEVEL) return null
  return { silver: RELIC.SILVER_PER_LEVEL, stones: RELIC.STONES_PER_LEVEL }
}

export function applyRelicUpgrade(instance: RelicInstance): boolean {
  if (instance.level >= RELIC.MAX_LEVEL) return false
  instance.level++
  return true
}

/** 分解返还 */
export function decomposeValue(instance: RelicInstance): { silver: number; stones: number } {
  const def = RELIC_DEFS.get(instance.defId)
  const rarityFactor = def ? rarityWeight(def.rarity) : 1
  const silver = Math.floor(
    RELIC.SILVER_PER_LEVEL * instance.level * rarityFactor * RELIC.DECOMPOSE_RETURN_PCT,
  )
  const stones = Math.floor(instance.level * rarityFactor * RELIC.DECOMPOSE_RETURN_PCT)
  return { silver, stones }
}

function rarityWeight(rarity: string): number {
  switch (rarity) {
    case 'SSR':
      return 5
    case 'SR':
      return 3
    case 'R':
      return 1.5
    default:
      return 1
  }
}

// ─────────────────────────── 工具 ───────────────────────────

export function clampLevel(level: number): number {
  return Math.max(RELIC.MIN_LEVEL, Math.min(RELIC.MAX_LEVEL, Math.floor(level)))
}

function roundMod(v: number): number {
  return Math.round(v * 10000) / 10000
}

/** 遗物评分（用于列表排序与"是否更强"提示） */
export function relicScore(instance: RelicInstance): number {
  return getRelicMods(instance).reduce((sum, m) => {
    const weight = m.stat === 'hp' ? 0.28 : m.stat === 'atk' ? 2.2 : m.stat === 'def' ? 1.6 : 1
    return sum + (m.kind === 'pct' ? m.value * 100 * weight : m.value * weight)
  }, 0)
}
