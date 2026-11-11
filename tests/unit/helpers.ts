import type { HeroRuntime, HeroState } from '../../src/core/model/types.ts'
import { HERO_INDEX } from '../../src/core/config/heroes/index.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { generateRelic } from '../../src/core/systems/relic.ts'
import { Rng } from '../../src/core/rng.ts'
import '../../src/core/config/relics.ts'

/** 构造一个用于测试的英灵运行时对象 */
export function makeHero(
  id: string,
  overrides: Partial<HeroState> = {},
): HeroRuntime {
  const def = HERO_INDEX.get(id)
  if (!def) throw new Error(`未知英灵：${id}`)
  const base = createHeroState(id, 0)
  const state: HeroState = { ...base, ...overrides }
  if (overrides.skillLevels) state.skillLevels = [...overrides.skillLevels]
  return { def, state, relics: [] }
}

/** 构造一支队伍 */
export function makeTeam(
  ids: string[],
  overrides: Partial<HeroState> = {},
): HeroRuntime[] {
  return ids.map((id) => makeHero(id, overrides))
}

/** 满养成英灵（240 级 / 6★ / 满技能 / 6 件满强化遗物） */
export function maxedHero(id: string): HeroRuntime {
  const hero = makeHero(id, {
    level: 240,
    star: 6,
    skillLevels: [20, 20, 20],
    coreAwakened: true,
  })
  const rng = new Rng(0x5ac0 + id.length)
  hero.relics = [
    generateRelic('set_zhanshen_1', rng, 60),
    generateRelic('set_zhanshen_2', rng, 60),
    generateRelic('set_zhanshen_3', rng, 60),
    generateRelic('set_zhanshen_4', rng, 60),
    generateRelic('set_zhanshen_5', rng, 60),
    generateRelic('set_zhanshen_1', rng, 60),
  ]
  return hero
}

/** 裸装英灵（1 级 / 1★） */
export function nakedHero(id: string): HeroRuntime {
  return makeHero(id, { level: 1, star: 1, skillLevels: [1, 1, 1] })
}
