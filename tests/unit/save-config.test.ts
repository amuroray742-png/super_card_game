/**
 * 存档迁移与配置校验（§15.1）
 */
import { describe, expect, it } from 'vitest'
import { createNewSave, migrate, normalizeSave, SAVE_VERSION } from '../../src/core/save/schema.ts'
import { deserialize, serialize } from '../../src/core/save/serialize.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { RELICS, RELIC_SETS } from '../../src/core/config/relics.ts'
import { STAGES, CHAPTERS } from '../../src/core/config/stages.ts'
import { ENEMIES } from '../../src/core/config/enemies.ts'
import { POOLS } from '../../src/core/config/pools.ts'
import { BONDS } from '../../src/core/config/bonds.ts'
import { BASE_RATES, GACHA, STAGE } from '../../src/core/config/economy.ts'
import { ELEMENTS, ROLES } from '../../src/core/model/types.ts'

describe('存档结构与迁移（§12.3 铁律 #4）', () => {
  it('新存档包含全部必需字段', () => {
    const save = createNewSave(1000)
    expect(save.version).toBe(SAVE_VERSION)
    expect(save.player).toBeDefined()
    expect(save.arena).toBeDefined()
    expect(save.daily).toBeDefined()
    expect(save.team.slots).toHaveLength(6)
  })

  it('序列化 → 反序列化 往返一致', () => {
    const save = createNewSave(2000)
    save.player.silver = 12345
    save.heroes['xiangyu'] = {
      id: 'xiangyu',
      level: 42,
      exp: 100,
      star: 3,
      skillLevels: [5, 5, 1],
      shards: 7,
      coreAwakened: false,
      obtainedAt: 1,
    }
    const restored = deserialize(serialize(save))
    expect(restored.player.silver).toBe(12345)
    expect(restored.heroes['xiangyu'].level).toBe(42)
    expect(restored.heroes['xiangyu'].skillLevels).toEqual([5, 5, 1])
  })

  it('v1 存档迁移后补齐竞技场字段，数据无损', () => {
    const old = createNewSave(3000) as unknown as Record<string, unknown>
    old.version = 1
    delete old.arena
    delete old.daily
    const migrated = migrate(normalizeSave(old))
    expect(migrated.version).toBe(SAVE_VERSION)
    expect(migrated.arena).toBeDefined()
    expect(migrated.daily).toBeDefined()
    expect(migrated.player.silver).toBe(createNewSave(0).player.silver)
  })

  it('损坏存档被规范化为可用状态', () => {
    const broken = { version: 99, player: { silver: 10 } } as unknown
    const fixed = normalizeSave(broken)
    expect(fixed.player.silver).toBe(10)
    expect(fixed.team.slots).toHaveLength(6)
    expect(fixed.arena.medals).toBe(0)
  })
})

describe('配置校验（§15.1）', () => {
  it('英灵 id 唯一', () => {
    const ids = HEROES.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('英灵数量与稀有度分布符合方案（72 位）', () => {
    expect(HEROES).toHaveLength(72)
    const counts = { SSR: 0, SR: 0, R: 0, N: 0 }
    for (const h of HEROES) counts[h.rarity]++
    expect(counts.SSR).toBe(12)
    expect(counts.SR).toBe(24)
    expect(counts.R).toBe(24)
    expect(counts.N).toBe(12)
  })

  it('每个英灵都有 3 个技能与至少 5 条被动', () => {
    for (const h of HEROES) {
      expect(h.skills).toHaveLength(3)
      expect(h.passives.length).toBeGreaterThanOrEqual(5)
      expect(h.bio.length).toBeGreaterThan(0)
    }
  })

  it('五行与定位全部被覆盖', () => {
    const elements = new Set(HEROES.map((h) => h.element))
    const roles = new Set(HEROES.map((h) => h.role))
    for (const e of ELEMENTS) expect(elements.has(e)).toBe(true)
    for (const r of ROLES) expect(roles.has(r)).toBe(true)
  })

  it('基础属性在合法区间内', () => {
    for (const h of HEROES) {
      expect(h.baseStats.atk).toBeGreaterThan(0)
      expect(h.baseStats.hp).toBeGreaterThan(0)
      expect(h.baseStats.crit).toBeGreaterThanOrEqual(0)
      expect(h.baseStats.crit).toBeLessThanOrEqual(1)
      expect(h.growth.atk).toBeGreaterThan(0)
      expect(h.growth.hp).toBeGreaterThan(0)
    }
  })

  it('遗物 id 唯一且套装引用有效', () => {
    const ids = RELICS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(RELICS).toHaveLength(60)
    const setIds = new Set(RELIC_SETS.map((s) => s.id))
    for (const r of RELICS) expect(setIds.has(r.setId)).toBe(true)
  })

  it('关卡数量与章节结构符合方案', () => {
    expect(STAGES).toHaveLength(310)
    expect(CHAPTERS).toHaveLength(10)
    expect(STAGES.filter((s) => s.isBoss)).toHaveLength(10)
    expect(STAGES[0].id).toBe(1)
    expect(STAGES[309].id).toBe(310)
  })

  it('每关的敌人引用存在', () => {
    const enemyIds = new Set(ENEMIES.map((e) => e.id))
    for (const s of STAGES) {
      expect(s.enemyIds.length).toBeGreaterThan(0)
      for (const id of s.enemyIds) expect(enemyIds.has(id)).toBe(true)
    }
  })

  it('关卡战力需求单调递增', () => {
    for (let i = 1; i < STAGES.length; i++) {
      expect(STAGES[i].powerRequired).toBeGreaterThan(STAGES[i - 1].powerRequired)
    }
  })

  it('抽卡基础概率之和为 100%', () => {
    const total = Object.values(BASE_RATES).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(100, 6)
  })

  it('保底参数合法', () => {
    expect(GACHA.PITY_SSR_MAX).toBe(90)
    expect(GACHA.SOFT_PITY_START).toBeGreaterThan(1)
    expect(GACHA.SOFT_PITY_START).toBeLessThanOrEqual(GACHA.PITY_SSR_MAX)
  })

  it('卡池概率引用同一份基础概率', () => {
    for (const pool of POOLS) {
      expect(pool.rates).toEqual(BASE_RATES)
    }
  })

  it('羁绊 id 唯一', () => {
    const ids = BONDS.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('关卡难度曲线参数与推导一致（总跨度 ≈ 2.7e5，满养成可通关末关）', () => {
    expect(STAGE.BASE_POWER).toBe(120)
    expect(STAGE.CHAPTER_GROWTH).toBe(3.5)
    expect(STAGE.BOSS_MULTIPLIER).toBe(1.5)
    expect(STAGE.IN_CHAPTER_GROWTH).toBeCloseTo(Math.pow(3.5 / 1.5, 1 / 31), 10)
    // 310 关总跨度
    const span = STAGES[309].powerRequired / STAGES[0].powerRequired
    expect(span).toBeGreaterThan(1e5)
    expect(span).toBeLessThan(1e6)
    // 章边界严格递增：每章首关 > 上一章末关
    for (let c = 1; c < 10; c++) {
      const prevBoss = STAGES[c * 31 - 1].powerRequired
      const nextFirst = STAGES[c * 31].powerRequired
      expect(nextFirst).toBeGreaterThan(prevBoss)
    }
  })
})
