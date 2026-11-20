/**
 * 英灵养成的两处回归（真实链路 store → 服务端 → core + core 属性）。
 *
 * 1. **技能升级扣的是对应五行的技能材料**（`save.items[skillMat<五行>]`），
 *    不是圣杯结晶（crystals）。
 *    历史 bug：实现扣了 `player.crystals` → 玩家术式结晶堆到 2 万
 *    也升不动技能，还白扣抽卡资源。
 * 2. **升级 / 升星确实带来属性提升**（详情页的属性面板要展示这个）。
 *
 * ⚠ 服务端权威后，养成动作由**服务端**执行，这里跑的是真实链路。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：
 *   - 术式结晶 / 英灵印记 / 玩家经验池全部退役；
 *   - 技能材料按**英灵五行**区分（`ITEM_BY_ELEMENT`）；
 *   - 喂经验改成**投喂经验书**（扣背包里的书，不是经验池）；
 *   - 境界突破改扣**银两**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { startServerHarness, type ServerHarness } from './helpers/server-harness.ts'
import { registerAndLoad, seedSave } from './helpers/store-harness.ts'

/** 模拟存储：key = slot，value = 序列化后的存档（只读缓存） */
const mem = vi.hoisted(() => new Map<string, string>())

vi.mock('../../src/platform/storage.ts', () => ({
  storage: {
    async load(slot: string) {
      const text = mem.get(slot)
      return text ? JSON.parse(text) : null
    },
    async save(slot: string, data: unknown) {
      mem.set(slot, JSON.stringify(data))
    },
    async export(data: unknown) {
      return JSON.stringify(data)
    },
    async import(text: string) {
      return JSON.parse(text)
    },
    async clear(slot: string) {
      mem.delete(slot)
    },
    async getFlag() {
      return false
    },
    async setFlag() {
      /* noop */
    },
  },
}))

const { useGameStore } = await import('../../src/presentation/stores/game.ts')
const { createHeroState } = await import('../../src/core/systems/growth.ts')
const { skillUpCost, skillLevelCap, realmBreakCost } = await import('../../src/core/systems/growth.ts')
const { resolveStats, computePower } = await import('../../src/core/systems/stats.ts')
const { getHeroPassiveMods } = await import('../../src/core/systems/growth.ts')
const { HERO_INDEX } = await import('../../src/core/config/heroes/index.ts')
const { SKILL } = await import('../../src/core/config/economy.ts')
const { ITEM_BY_ELEMENT } = await import('../../src/core/config/items.ts')

const HERO_ID = 'xiangyu'
/** 主角的五行（土）→ 技能材料扣土系那一叠 */
const HERO_ELEMENT = HERO_INDEX.get(HERO_ID)!.element
const MAT_ID = ITEM_BY_ELEMENT[HERO_ELEMENT]

let harness: ServerHarness

beforeEach(async () => {
  mem.clear()
  setActivePinia(createPinia())
  harness = startServerHarness()
})

afterEach(async () => {
  await harness.close()
})

/** 备好一个英灵（默认 1 级）+ 指定资源 */
async function seedHero(opts: {
  level?: number
  /** 技能材料（土系）数量 */
  mats?: number
  /** 小经验书数量 */
  books?: number
  silver?: number
  crystals?: number
} = {}) {
  await registerAndLoad('growth_user')
  await seedSave((save) => {
    save.heroes[HERO_ID] = { ...createHeroState(HERO_ID, 1_000), level: opts.level ?? 1 }
    if (opts.mats !== undefined) save.items[MAT_ID] = opts.mats
    if (opts.books !== undefined) save.items.expBookSmall = opts.books
    if (opts.silver !== undefined) save.player.silver = opts.silver
    if (opts.crystals !== undefined) save.player.crystals = opts.crystals
  })
}

describe('技能升级的资源口径', () => {
  it('扣对应五行的技能材料，不扣圣杯结晶', async () => {
    await seedHero({ crystals: 0, mats: 21_000, silver: 1_000_000 })
    const store = useGameStore()

    const before = store.save.heroes[HERO_ID].skillLevels[0]
    await store.upgradeSkill(HERO_ID, 0)

    const after = store.save.heroes[HERO_ID].skillLevels[0]
    expect(after).toBe(before + 1)
    // 技能材料被扣
    expect(store.save.items[MAT_ID]).toBe(21_000 - SKILL.MATERIAL_PER_LEVEL)
    // 圣杯结晶**一分没动**（原实现扣的是它）
    expect(store.save.player.crystals).toBe(0)
  })

  it('技能材料不足时拒绝，且不扣任何资源', async () => {
    await seedHero({ crystals: 999, mats: 0, silver: 1_000_000 })
    const store = useGameStore()

    const before = store.save.heroes[HERO_ID].skillLevels[0]
    await store.upgradeSkill(HERO_ID, 0)

    expect(store.save.heroes[HERO_ID].skillLevels[0]).toBe(before)
    expect(store.save.player.silver).toBe(1_000_000)
    expect(store.save.player.crystals).toBe(999)
  })

  it('银两不足时拒绝', async () => {
    await seedHero({ mats: 21_000, silver: 0 })
    const store = useGameStore()

    const before = store.save.heroes[HERO_ID].skillLevels[0]
    await store.upgradeSkill(HERO_ID, 0)
    expect(store.save.heroes[HERO_ID].skillLevels[0]).toBe(before)
  })

  it('技能等级上限受境界门槛约束（满级时不该报「资源不足」）', () => {
    const state = createHeroState(HERO_ID, 1_000)
    const cap = skillLevelCap(state.level)
    expect(cap).toBeGreaterThan(1)
    expect(cap).toBeLessThanOrEqual(SKILL.MAX_LEVEL)
    // 成本表在满级时返回 null
    expect(skillUpCost(SKILL.MAX_LEVEL, HERO_ELEMENT)).toBeNull()
  })

  it('成本表用的是技能材料口径（不是圣杯结晶）', () => {
    const cost = skillUpCost(1, HERO_ELEMENT)
    expect(cost).not.toBeNull()
    expect(cost!.material).toBe(SKILL.MATERIAL_PER_LEVEL)
    expect(cost!.materialId).toBe(MAT_ID)
    expect(cost!.silver).toBe(SKILL.SILVER_PER_LEVEL)
  })
})

describe('喂经验书 + 境界突破', () => {
  it('喂经验书从背包扣书，并真的提升等级', async () => {
    await seedHero({ books: 10 })
    const store = useGameStore()

    const before = store.save.heroes[HERO_ID].level
    await store.feedBooks(HERO_ID, 'expBookSmall', 1)

    // ⚠ 原实现只加不减 → 经验池是死资源，喂经验等于白嫖等级
    expect(store.save.items.expBookSmall).toBe(9)
    expect(store.save.heroes[HERO_ID].level).toBeGreaterThan(before)
  })

  it('经验书不足时拒绝，且不扣任何资源、不升级', async () => {
    await seedHero({ books: 0 })
    const store = useGameStore()

    const before = store.save.heroes[HERO_ID].level
    await store.feedBooks(HERO_ID, 'expBookSmall', 1)

    expect(store.save.items.expBookSmall).toBe(0)
    expect(store.save.heroes[HERO_ID].level).toBe(before)
  })

  it('卡在境界门槛时经验不丢（存在英灵身上，等突破后兑现）', async () => {
    await seedHero({ level: 60, books: 10 })
    const store = useGameStore()

    await store.feedBooks(HERO_ID, 'expBookSmall', 1)

    expect(store.save.items.expBookSmall).toBe(9)
    expect(store.save.heroes[HERO_ID].level).toBe(60)
    expect(store.save.heroes[HERO_ID].exp).toBeGreaterThan(0)
  })

  it('境界突破消耗银两，并跨入新境界', async () => {
    await seedHero({ level: 60, silver: 1_000_000 })
    const store = useGameStore()

    const cost = realmBreakCost(60)!
    await store.breakRealm(HERO_ID)

    expect(store.save.player.silver).toBe(1_000_000 - cost.silver)
    expect(store.save.heroes[HERO_ID].level).toBe(cost.targetLevel)
  })

  it('银两不足时拒绝突破，且不扣银两', async () => {
    await seedHero({ level: 60, silver: 0 })
    const store = useGameStore()

    await store.breakRealm(HERO_ID)

    expect(store.save.heroes[HERO_ID].level).toBe(60)
    expect(store.save.player.silver).toBe(0)
  })

  it('未到境界门槛时不能突破', async () => {
    await seedHero({ level: 30, silver: 999_999 })
    const store = useGameStore()

    await store.breakRealm(HERO_ID)

    expect(store.save.heroes[HERO_ID].level).toBe(30)
    expect(store.save.player.silver).toBe(999_999)
  })

  it('突破后存着的经验立刻兑现成等级', async () => {
    await seedHero({ level: 60, books: 10, silver: 1_000_000 })
    const store = useGameStore()
    await store.feedBooks(HERO_ID, 'expBookSmall', 1)
    expect(store.save.heroes[HERO_ID].level).toBe(60)

    await store.breakRealm(HERO_ID)
    expect(store.save.heroes[HERO_ID].level).toBeGreaterThan(60)
  })
})

describe('升级 / 升星的属性提升', () => {
  function runtimeAt(level: number, star: number) {
    const def = HERO_INDEX.get(HERO_ID)!
    const state = { ...createHeroState(HERO_ID, 1_000), level, star }
    return { def, state, relics: new Array(6).fill(null), slot: 0 }
  }

  function statsOf(level: number, star: number) {
    const rt = runtimeAt(level, star)
    return resolveStats(rt, { mode: 'pve', seed: 0 }, { passives: getHeroPassiveMods(rt) })
  }

  it('升 1 级后攻击 / 生命 / 战力都上升', () => {
    const a = statsOf(1, 3)
    const b = statsOf(2, 3)
    expect(b.atk).toBeGreaterThan(a.atk)
    expect(b.hp).toBeGreaterThan(a.hp)
    expect(computePower(b)).toBeGreaterThan(computePower(a))
  })

  it('升 1 星后攻击 / 生命 / 战力都上升（星级被动同时解锁）', () => {
    const a = statsOf(10, 3)
    const b = statsOf(10, 4)
    expect(b.atk).toBeGreaterThan(a.atk)
    expect(b.hp).toBeGreaterThan(a.hp)
    expect(computePower(b)).toBeGreaterThan(computePower(a))
  })
})
