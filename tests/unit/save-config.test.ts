/**
 * 存档迁移与配置校验（§15.1）
 */
import { describe, expect, it } from 'vitest'
import { createNewSave, migrate, normalizeSave, SAVE_VERSION } from '../../src/core/save/schema.ts'
import { deserialize, serialize } from '../../src/core/save/serialize.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { RELICS, RELIC_SETS } from '../../src/core/config/relics.ts'
import { STAGES, CHAPTERS, stageDifficulty, stageMonotonicityIssues } from '../../src/core/config/stages.ts'
import { ENEMIES } from '../../src/core/config/enemies.ts'
import { POOLS } from '../../src/core/config/pools.ts'
import { BONDS } from '../../src/core/config/bonds.ts'
import { BASE_RATES, GACHA, STAGE } from '../../src/core/config/economy.ts'
import { getTeamPower } from '../../src/core/systems/team.ts'
import { nextRelicUid } from '../../src/core/systems/relic.ts'
import { ELEMENTS, ROLES } from '../../src/core/model/types.ts'
import { maxedHero } from './helpers.ts'

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

  it('v6 → v7：遗物 uid 重编号后互不重复，装备引用同步改写', () => {
    const old = createNewSave(4000) as unknown as Record<string, unknown>
    old.version = 6
    old.heroes = {
      xiangyu: {
        id: 'xiangyu',
        level: 10,
        exp: 0,
        star: 1,
        skillLevels: [1, 1, 1],
        shards: 0,
        coreAwakened: false,
        obtainedAt: 0,
      },
    }
    // 旧格式 uid：r + 计数器(36) + 随机后缀(36)
    old.relics = [
      { uid: 'r1t', defId: 'set_zhanshen_1', level: 3, subStats: [], locked: false },
      { uid: 'r2k', defId: 'set_zhanshen_2', level: 5, subStats: [], locked: false },
      { uid: 'rt1', defId: 'set_zhanshen_3', level: 7, subStats: [], locked: false },
    ]
    old.equipped = { 'xiangyu#0': { heroId: 'xiangyu', relicId: 'r2k' } }

    // 走真实载入路径（deserialize 会按存档版本跑迁移链）
    const migrated = deserialize(JSON.stringify(old))
    expect(migrated.version).toBe(SAVE_VERSION)

    const uids = migrated.relics.map((r) => r.uid)
    expect(new Set(uids).size).toBe(uids.length)
    // 旧 uid 全部换掉
    expect(uids).not.toContain('r1t')
    expect(uids).not.toContain('r2k')
    expect(uids).not.toContain('rt1')
    // 序号从「旧 uid 可能的最大计数器」之后开始
    expect(migrated.relicSeq).toBeGreaterThan(29)

    // 装备关系不能丢：引用的仍是同一件遗物
    const equipped = migrated.equipped['xiangyu#0']
    expect(equipped).toBeDefined()
    expect(migrated.relics.some((r) => r.uid === equipped.relicId)).toBe(true)
    // 且指向原来那件（defId 不变）
    expect(migrated.relics.find((r) => r.uid === equipped.relicId)!.defId).toBe('set_zhanshen_2')
  })

  it('v6 → v7：重编号后的 uid 不会被后续生成撞上', () => {
    const old = createNewSave(5000) as unknown as Record<string, unknown>
    old.version = 6
    old.relics = [{ uid: 'r1t', defId: 'set_zhanshen_1', level: 1, subStats: [], locked: false }]
    const migrated = deserialize(JSON.stringify(old))
    const seen = new Set(migrated.relics.map((r) => r.uid))
    for (let i = 0; i < 100; i++) {
      const uid = nextRelicUid(migrated)
      expect(seen.has(uid)).toBe(false)
      seen.add(uid)
    }
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

  it('敌方难度不倒挂：门槛全局递增 + 章内缩放严格递增 + 章首难度跨章递增', () => {
    // ⚠ **实施修正（roadmap P1-2）**：原断言是「全曲线缩放严格递增」，
    //   它隐含假设「敌方基础属性不跨章增长」。实际基础属性约 1.25×/章
    //   （§6.5「已知限制」第 1 条），章内总跨度抬到 2.03 后字面执行
    //   「锚点比 ≥ 章内总跨度」会让难度增速 = 1.25 × 2.03 = 2.54×/章，
    //   跑在玩家养成（1.03^24 = 2.03×/章）前面 → 曲线没有不动点。
    //   正确的口径是「**难度**（基础属性 × 缩放）不倒挂」：
    //   章内缩放严格递增（章末 BOSS 尖峰），章与章之间按**章首难度**递增。
    //   不变量的唯一一份口径在 core（`stageMonotonicityIssues`），与配置校验同源（铁律 #4）。
    expect(stageMonotonicityIssues(STAGES)).toEqual([])

    for (let i = 1; i < STAGES.length; i++) {
      const prev = STAGES[i - 1]
      const cur = STAGES[i]
      if (prev.chapter === cur.chapter) {
        expect(cur.enemyScale).toBeGreaterThan(prev.enemyScale)
      }
    }
    // 章首难度（基础属性 × 缩放）跨章严格递增
    for (let c = 1; c < STAGE.CHAPTERS; c++) {
      const prevFirst = STAGES[(c - 1) * 31]
      const nextFirst = STAGES[c * 31]
      expect(nextFirst.enemyScale).toBeGreaterThan(prevFirst.enemyScale)
      expect(stageDifficulty(nextFirst)).toBeGreaterThan(stageDifficulty(prevFirst))
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

  it('关卡难度曲线：逐章锚点 + 章内等比 + 章末 BOSS 尖峰', () => {
    // 两条曲线都是逐章锚点（不再用统一指数外推）
    expect(STAGE.SCALE_ANCHORS).toHaveLength(STAGE.CHAPTERS)
    expect(STAGE.POWER_ANCHORS).toHaveLength(STAGE.CHAPTERS)
    expect(STAGE.IN_CHAPTER_SPAN).toBeCloseTo(1.765, 6)
    expect(STAGE.BOSS_MULTIPLIER).toBeCloseTo(1.15, 6)
    expect(STAGE.CHAPTER_GATE_GAP).toBeCloseTo(1.05, 6)

    // 章内：普通关等比铺开，章末 BOSS = 锚点 × 章内总跨度
    for (const stage of STAGES) {
      const anchor = STAGE.SCALE_ANCHORS[stage.chapter - 1]
      const span = STAGE.IN_CHAPTER_SPAN * STAGE.BOSS_MULTIPLIER
      if (stage.isBoss) {
        expect(stage.enemyScale).toBeCloseTo(anchor * span, 6)
        expect(stage.powerRequired).toBe(STAGE.POWER_ANCHORS[stage.chapter - 1])
      } else {
        const step = Math.pow(STAGE.IN_CHAPTER_SPAN, 1 / STAGE.STAGES_PER_CHAPTER)
        expect(stage.enemyScale).toBeCloseTo(anchor * Math.pow(step, stage.index - 1), 6)
      }
    }

    // 章边界：门槛严格递增（下一章首关 > 上一章末关）。
    // 敌方**难度**在章边界允许回落——章末 BOSS 的基础属性是普通敌的 3.6~6.9 倍，
    // BOSS 打完进入下一章第一关是设计上的「喘息」（下一章再重新爬坡）。
    // 章与章之间的难度递增由上面那条「章首难度跨章递增」守住。
    for (let c = 1; c < 10; c++) {
      const prevBoss = STAGES[c * 31 - 1]
      const nextFirst = STAGES[c * 31]
      expect(nextFirst.powerRequired).toBeGreaterThan(prevBoss.powerRequired)
    }

    // 门槛总跨度必须落在「玩家养成跨度」之内（Lv1 约 7.4×10³ → 满养成约 3.6×10⁷）
    const span = STAGES[309].powerRequired / STAGES[0].powerRequired
    expect(span).toBeGreaterThan(1e3)
    expect(span).toBeLessThan(1e5)
  })

  it('满养成对末关留有 1.5× 以上余量（门槛不高于满养成战力的 2/3）', () => {
    const maxedTeam = HEROES.filter((h) => h.rarity === 'SSR')
      .slice(0, 6)
      .map((def, slot) => ({ ...maxedHero(def.id), slot }))
    const maxedPower = getTeamPower(maxedTeam, { mode: 'pve' })
    expect(maxedPower).toBeGreaterThan(0)
    expect(STAGES[309].powerRequired).toBeLessThanOrEqual(maxedPower / 1.5)
  })
})
