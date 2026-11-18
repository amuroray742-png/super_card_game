import type { HeroRuntime, HeroState } from '../../src/core/model/types.ts'
import { HERO_INDEX } from '../../src/core/config/heroes/index.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { generateRelic, makeRelicUid } from '../../src/core/systems/relic.ts'
import { Rng } from '../../src/core/rng.ts'
import '../../src/core/config/relics.ts'

/**
 * 测试用的遗物 uid 自增器。
 *
 * 遗物 uid 现在必须由**存档内**计数器派生（`nextRelicUid(save)`），
 * 入存档的路径一律走那里；测试与模拟场景不入存档，用本计数器保证唯一。
 */
let testRelicSeq = 0

/** 构造一件测试用遗物（uid 唯一） */
export function makeTestRelic(
  defId: string,
  rng: Rng,
  level = 1,
): ReturnType<typeof generateRelic> {
  testRelicSeq += 1
  return generateRelic(defId, rng, level, makeRelicUid(testRelicSeq))
}

/** 重置测试遗物 uid 计数器（各测试文件互不干扰） */
export function resetTestRelicSeq(): void {
  testRelicSeq = 0
}

/** 构造一个用于测试的英灵运行时对象 */
export function makeHero(
  id: string,
  overrides: Partial<HeroState> = {},
  slot = 0,
): HeroRuntime {
  const def = HERO_INDEX.get(id)
  if (!def) throw new Error(`未知英灵：${id}`)
  const base = createHeroState(id, 0)
  const state: HeroState = { ...base, ...overrides }
  if (overrides.skillLevels) state.skillLevels = [...overrides.skillLevels]
  return { def, state, relics: [], slot }
}

/**
 * 构造一支队伍。
 *
 * slot 按顺序分配（0-2 前排 / 3-5 后排），
 * 便于测试「同血时前排先挨打」这类与站位相关的规则。
 */
export function makeTeam(
  ids: string[],
  overrides: Partial<HeroState> = {},
): HeroRuntime[] {
  return ids.map((id, i) => makeHero(id, overrides, i))
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
    makeTestRelic('set_zhanshen_1', rng, 60),
    makeTestRelic('set_zhanshen_2', rng, 60),
    makeTestRelic('set_zhanshen_3', rng, 60),
    makeTestRelic('set_zhanshen_4', rng, 60),
    makeTestRelic('set_zhanshen_5', rng, 60),
    makeTestRelic('set_zhanshen_1', rng, 60),
  ]
  return hero
}

/** 裸装英灵（1 级 / 1★） */
export function nakedHero(id: string): HeroRuntime {
  return makeHero(id, { level: 1, star: 1, skillLevels: [1, 1, 1] })
}
