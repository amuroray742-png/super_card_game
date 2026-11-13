/**
 * 英灵养成的两处回归（表现层 store + core 属性）。
 *
 * 1. **技能升级扣的是术式结晶**（skillStones），不是圣杯结晶（crystals）。
 *    历史 bug：实现扣了 `player.crystals` → 玩家术式结晶堆到 2 万
 *    也升不动技能，还白扣抽卡资源。
 * 2. **升级 / 升星确实带来属性提升**（详情页的属性面板要展示这个）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/** 模拟存储：key = slot，value = 序列化后的存档 */
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
  },
}))

const { useGameStore } = await import('../../src/presentation/stores/game.ts')
const { createHeroState } = await import('../../src/core/systems/growth.ts')
const { skillUpCost, skillLevelCap } = await import('../../src/core/systems/growth.ts')
const { resolveStats, computePower } = await import('../../src/core/systems/stats.ts')
const { getHeroPassiveMods } = await import('../../src/core/systems/growth.ts')
const { HERO_INDEX } = await import('../../src/core/config/heroes/index.ts')
const { SKILL } = await import('../../src/core/config/economy.ts')

const SLOT = 'main'
const HERO_ID = 'xiangyu'

describe('技能升级的资源口径', () => {
  beforeEach(() => {
    mem.clear()
    setActivePinia(createPinia())
  })

  it('扣术式结晶，不扣圣杯结晶', async () => {
    const store = useGameStore()
    await store.load()

    // 给一个英灵，并把「圣杯结晶清零、术式结晶充足」——正是玩家报的场景
    store.save.heroes[HERO_ID] = createHeroState(HERO_ID, 1_000)
    store.save.player.crystals = 0
    store.save.player.skillStones = 21_000
    store.save.player.silver = 1_000_000

    const before = store.save.heroes[HERO_ID].skillLevels[0]
    await store.upgradeSkill(HERO_ID, 0)

    const after = store.save.heroes[HERO_ID].skillLevels[0]
    expect(after).toBe(before + 1)
    // 术式结晶被扣
    expect(store.save.player.skillStones).toBe(21_000 - SKILL.SKILL_STONES_PER_LEVEL)
    // 圣杯结晶**一分没动**（原实现扣的是它）
    expect(store.save.player.crystals).toBe(0)
  })

  it('术式结晶不足时拒绝，且不扣任何资源', async () => {
    const store = useGameStore()
    await store.load()
    store.save.heroes[HERO_ID] = createHeroState(HERO_ID, 1_000)
    store.save.player.crystals = 999
    store.save.player.skillStones = 0
    store.save.player.silver = 1_000_000

    const before = store.save.heroes[HERO_ID].skillLevels[0]
    await store.upgradeSkill(HERO_ID, 0)

    expect(store.save.heroes[HERO_ID].skillLevels[0]).toBe(before)
    expect(store.save.player.silver).toBe(1_000_000)
    expect(store.save.player.crystals).toBe(999)
  })

  it('银两不足时拒绝', async () => {
    const store = useGameStore()
    await store.load()
    store.save.heroes[HERO_ID] = createHeroState(HERO_ID, 1_000)
    store.save.player.skillStones = 21_000
    store.save.player.silver = 0

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
    expect(skillUpCost(SKILL.MAX_LEVEL)).toBeNull()
  })

  it('成本表用的是术式结晶口径（不是圣杯结晶）', () => {
    const cost = skillUpCost(1)
    expect(cost).not.toBeNull()
    expect(cost!.skillStones).toBe(SKILL.SKILL_STONES_PER_LEVEL)
    expect(cost!.silver).toBe(SKILL.SILVER_PER_LEVEL)
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
