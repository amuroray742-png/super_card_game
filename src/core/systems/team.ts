/**
 * 编队与羁绊（§5.6）。
 *
 * 6 槽位：前排 3 / 后排 3。英灵有偏好阵位但不强制。
 * 羁绊按编队内标签自动计数，实时重算。
 */
import type {
  BondDef,
  BondEffect,
  Element,
  HeroRuntime,
  Role,
  StatMod,
} from '../model/types.ts'
import { BONDS } from '../config/bonds.ts'
import { computePower, resolveStats } from './stats.ts'
import { getHeroPassiveMods } from './growth.ts'
import { getHeroSetMods } from './relic.ts'

export const TEAM_SIZE = 6
export const FRONT_SLOTS = 3

export function slotKind(index: number): 'front' | 'back' {
  return index < FRONT_SLOTS ? 'front' : 'back'
}

/** 定位偏好阵位 */
export function preferredSlotForRole(role: Role): 'front' | 'back' {
  switch (role) {
    case '猛将':
      return 'front'
    case '统帅':
      return 'front'
    case '谋士':
    case '医者':
    case '器者':
      return 'back'
  }
}

// ─────────────────────────── 羁绊 ───────────────────────────

export interface BondState {
  bond: BondDef
  count: number
  active: boolean
}

/** 计算编队羁绊状态 */
export function computeBondState(heroes: (HeroRuntime | null)[]): BondState[] {
  const list = heroes.filter((h): h is HeroRuntime => !!h)
  const roleCount = new Map<Role, number>()
  const elementCount = new Map<Element, number>()
  for (const hero of list) {
    roleCount.set(hero.def.role, (roleCount.get(hero.def.role) ?? 0) + 1)
    elementCount.set(hero.def.element, (elementCount.get(hero.def.element) ?? 0) + 1)
  }
  const distinctElements = elementCount.size

  return BONDS.map((bond) => {
    let count = 0
    const cond = bond.condition
    switch (cond.type) {
      case 'role':
        count = roleCount.get(cond.role) ?? 0
        break
      case 'element':
        count = elementCount.get(cond.element) ?? 0
        break
      case 'distinctElements':
        count = distinctElements
        break
      case 'rarity':
        count = list.length
        break
    }
    return { bond, count, active: count >= cond.count }
  })
}

/** 生效羁绊的属性修正 */
export function getBondMods(heroes: (HeroRuntime | null)[]): StatMod[] {
  const mods: StatMod[] = []
  for (const state of computeBondState(heroes)) {
    if (!state.active) continue
    for (const effect of state.bond.effects) mods.push(...effect.mods)
  }
  return mods
}

/** 生效羁绊的非属性规则修正（治疗加成、异常伤害、冷却缩减） */
export function getBondExtras(heroes: (HeroRuntime | null)[]): NonNullable<BondEffect['extra']>[] {
  const extras: NonNullable<BondEffect['extra']>[] = []
  for (const state of computeBondState(heroes)) {
    if (!state.active) continue
    for (const effect of state.bond.effects) {
      if (effect.extra) extras.push(effect.extra)
    }
  }
  return extras
}

// ─────────────────────────── 编队 ───────────────────────────

/** 编队内的英灵（按槽位顺序，跳过空位） */
export function teamHeroes(
  slots: (string | null)[],
  all: Record<string, HeroRuntime>,
): (HeroRuntime | null)[] {
  return slots.slice(0, TEAM_SIZE).map((id) => (id ? (all[id] ?? null) : null))
}

/**
 * 编队战力 = 各英灵战力和 × 编队乘区。
 *
 * @param ctx 战斗上下文（竞技模式下走归一化路径）
 */
export function getTeamPower(
  heroes: (HeroRuntime | null)[],
  ctx: { mode: 'pve' | 'arena' | 'tower'; teamMods?: { bond?: StatMod[]; set?: StatMod[]; progress?: StatMod[] } },
): number {
  const bondMods = getBondMods(heroes)
  const sum = heroes.reduce((acc, hero) => {
    if (!hero) return acc
    const stats = resolveStats(hero, {
      mode: ctx.mode,
      seed: 1,
      teamMods: {
        bond: bondMods,
        // 进度乘区（圣杯重启永久加成等）由调用方提供
        progress: ctx.teamMods?.progress,
      },
    }, {
      passives: getHeroPassiveMods(hero),
      setMods: getHeroSetMods(hero),
    })
    return acc + computePower(stats)
  }, 0)
  return sum
}

/** 战力构成明细（供 UI 展示成长增量） */
export interface PowerBreakdown {
  total: number
  perHero: { heroId: string; name: string; power: number }[]
  bondMods: StatMod[]
}

export function breakdownTeamPower(
  heroes: (HeroRuntime | null)[],
  ctx: { mode: 'pve' | 'arena' | 'tower' },
): PowerBreakdown {
  const bondMods = getBondMods(heroes)
  const perHero = heroes
    .filter((h): h is HeroRuntime => !!h)
    .map((hero) => {
      const stats = resolveStats(hero, { mode: ctx.mode, seed: 1, teamMods: { bond: bondMods } }, {
        passives: getHeroPassiveMods(hero),
        setMods: getHeroSetMods(hero),
      })
      return { heroId: hero.def.id, name: hero.def.name, power: computePower(stats) }
    })
  return {
    total: perHero.reduce((s, h) => s + h.power, 0),
    perHero,
    bondMods,
  }
}

/** 编队是否为空 */
export function isTeamEmpty(slots: (string | null)[]): boolean {
  return slots.filter(Boolean).length === 0
}
