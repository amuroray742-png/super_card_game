/**
 * 英灵装配（§8.3）。
 *
 * 由名册 + 技能模板装配出完整 HeroDef。
 * 新增英灵只需在 roster.ts 追加条目，此处零改动（数据驱动铁律）。
 */
import type { HeroDef, Rarity, SlotKind, Stats } from '../../model/types.ts'
import { ROSTER, type RosterEntry, type Tier } from './roster.ts'
import { buildPassives, buildSkills } from '../skills.ts'
import { portraitPath } from '../art.ts'
import { getBio } from '../../../content/bios/index.ts'

/** 稀有度档位 → 基础属性与成长 */
interface TierProfile {
  base: Stats
  growth: { atk: number; def: number; hp: number; spd: number }
}

const TIER_PROFILES: Record<Tier, TierProfile> = {
  1: {
    base: { atk: 55, def: 28, hp: 700, spd: 95, crit: 0.05, cdmg: 0.5 },
    growth: { atk: 3.2, def: 1.8, hp: 38, spd: 0.25 },
  },
  2: {
    base: { atk: 68, def: 34, hp: 880, spd: 100, crit: 0.05, cdmg: 0.5 },
    growth: { atk: 3.9, def: 2.2, hp: 46, spd: 0.28 },
  },
  3: {
    base: { atk: 84, def: 42, hp: 1080, spd: 106, crit: 0.06, cdmg: 0.55 },
    growth: { atk: 4.7, def: 2.7, hp: 56, spd: 0.3 },
  },
  4: {
    base: { atk: 102, def: 50, hp: 1300, spd: 112, crit: 0.07, cdmg: 0.6 },
    growth: { atk: 5.6, def: 3.3, hp: 68, spd: 0.33 },
  },
}

const RARITY_TIER: Record<Rarity, Tier> = { N: 1, R: 2, SR: 3, SSR: 4 }

function preferredSlots(role: RosterEntry['role']): SlotKind[] {
  switch (role) {
    case '猛将':
      return ['front']
    case '统帅':
      return ['front', 'back']
    default:
      return ['back']
  }
}

/** 遗物套装偏好（按定位）—— 仅作推荐，不强制 */
function relicAffinity(role: RosterEntry['role']): string[] {
  switch (role) {
    case '猛将':
      return ['set_zhanshen', 'set_bingjie']
    case '统帅':
      return ['set_jiangtun', 'set_shangzhan']
    case '谋士':
      return ['set_tanpo', 'set_liuhe']
    case '医者':
      return ['set_huichun', 'set_shengming']
    case '器者':
      return ['set_jixie', 'set_lingqi']
  }
}

function buildHero(entry: RosterEntry): HeroDef {
  const profile = TIER_PROFILES[entry.tier]
  return {
    id: entry.id,
    name: entry.name,
    pinyin: entry.pinyin,
    era: entry.era,
    region: entry.region,
    rarity: entry.rarity,
    role: entry.role,
    element: entry.element,
    baseStats: profile.base,
    growth: profile.growth,
    skills: buildSkills(entry.role, entry.ultimateEffect, entry.tier, entry.ultimate, entry.ultimateDesc),
    passives: buildPassives(entry.role, entry.tier),
    relicAffinity: relicAffinity(entry.role),
    bio: getBio(entry.id),
    portrait: portraitPath(entry.id),
    accent: entry.accent,
    preferredSlots: preferredSlots(entry.role),
  }
}

export const HEROES: readonly HeroDef[] = ROSTER.map(buildHero)

export const HERO_INDEX = new Map(HEROES.map((h) => [h.id, h]))

export function getHero(id: string): HeroDef {
  const hero = HERO_INDEX.get(id)
  if (!hero) throw new Error(`未知英灵：${id}`)
  return hero
}

/** 按稀有度筛选 */
export function heroesByRarity(rarity: Rarity): HeroDef[] {
  return HEROES.filter((h) => h.rarity === rarity)
}

/** 抽卡池可选项（§6.9 竞技池统一开放；此处为 PVE 收集用） */
export function allHeroIds(): string[] {
  return HEROES.map((h) => h.id)
}

export { ROSTER, RARITY_TIER }
export type { RosterEntry, Tier }
