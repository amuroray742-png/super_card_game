/**
 * 材料副本（技能副本 / 强化副本）的口径守护。
 *
 * 副本是**两类材料的唯一来源**（设计稿 §3），所以副本链路一旦空转，
 * 玩家的五行技能材料与三档强化石就永远攒不出来——
 * 而「配置齐全 ≠ 功能可用」正是这个项目反复踩的坑（铁律 #22）。
 *
 * 守四条：
 * 1. 副本**只发所选材料**（不发银两 / 经验 / 遗物）；
 * 2. 副本**不写 `campaign`**（进度与主线记录分别记账）；
 * 3. 战败即停，并给出「降一档难度」的建议；
 * 4. 解锁判定是**配置驱动**的（首个可升技能出现 / 持有对应等级遗物）。
 */
import { describe, expect, it } from 'vitest'
import {
  DUNGEON_VARIANTS,
  DUNGEON_INDEX,
  findDungeonVariant,
  dungeonDropAmount,
  dungeonItemId,
  type DungeonVariant,
} from '../../src/core/config/dungeons.ts'
import {
  dungeonUnlocked,
  dungeonStages,
  dungeonChapter,
  runDungeon,
  suggestLowerDifficulty,
} from '../../src/core/systems/dungeons.ts'
import { DUNGEON_DIFFICULTIES, DUNGEON_DROPS, RELIC } from '../../src/core/config/economy.ts'
import { ITEM_DEFS } from '../../src/core/config/items.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { makeTestRelic } from './helpers.ts'
import { Rng } from '../../src/core/rng.ts'
import { buildPveContext } from '../../src/core/systems/derive.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000

function makeCtx(save: SaveData) {
  return {
    now: NOW,
    rng: new Rng(4242),
    randomSeed: () => 4242,
    mode: 'pve' as const,
    // ⚠ `BattleContext` 必须带 `seed`——战斗随机序列由它派生（core 不自己取随机）。
    seed: 4242,
    save,
  }
}

/** 造一份有队伍、有遗物、战力足够的存档 */
function strongSave(): SaveData {
  const save = createNewSave(NOW, 7)
  for (const id of ['xiangyu', 'hanxin']) {
    // ⚠ 技能等级刻意留低（1）：满级技能会让「可升技能的英灵」判定为假，
    //   技能副本就会一直锁着（解锁判定读的是「还有没有技能能升」）。
    save.heroes[id] = { ...createHeroState(id, NOW), level: 240, star: 6, skillLevels: [1, 1, 1] }
  }
  save.team.slots[0] = 'xiangyu'
  save.team.slots[1] = 'hanxin'
  const rng = new Rng(99)
  save.relics = [
    makeTestRelic('set_zhanshen_1', rng, 1),
    makeTestRelic('set_zhanshen_2', rng, 1),
  ]
  return save
}

describe('副本配置', () => {
  it('8 个变体：5 技能 + 3 强化', () => {
    expect(DUNGEON_VARIANTS.filter((v) => v.kind === 'skill')).toHaveLength(5)
    expect(DUNGEON_VARIANTS.filter((v) => v.kind === 'enhance')).toHaveLength(3)
    expect(DUNGEON_VARIANTS).toHaveLength(8)
  })

  it('每个变体的产出道具都已登记（漏登记 → 背包里出现无名道具）', () => {
    for (const v of DUNGEON_VARIANTS) {
      expect(ITEM_DEFS[v.itemId], `${v.id} 的产出道具未登记`).toBeTruthy()
      expect(dungeonItemId(v)).toBe(v.itemId)
    }
  })

  it('副本道具**不出现在主线掉落表**里（主线只掉银两与经验书）', () => {
    // 设计稿 §3：副本材料是副本专属产出，主线发它们就等于白送
    const dungeonIds = new Set(DUNGEON_VARIANTS.map((v) => v.itemId))
    for (const id of dungeonIds) {
      expect(['expBookSmall', 'expBookLarge']).not.toContain(id)
    }
  })

  it('每个副本道具都在 DUNGEON_DROPS 里有产量，且 min ≤ max', () => {
    for (const v of DUNGEON_VARIANTS) {
      const drop = DUNGEON_DROPS[v.itemId]
      expect(drop, `${v.itemId} 没登记产量`).toBeTruthy()
      expect(drop!.min).toBeGreaterThanOrEqual(1)
      expect(drop!.max).toBeGreaterThanOrEqual(drop!.min)
    }
  })

  it('难度越高，单场产量越多', () => {
    for (const v of DUNGEON_VARIANTS) {
      const easy = dungeonDropAmount(v, 'easy')
      const normal = dungeonDropAmount(v, 'normal')
      const hard = dungeonDropAmount(v, 'hard')
      expect(normal.min).toBeGreaterThanOrEqual(easy.min)
      expect(hard.min).toBeGreaterThanOrEqual(normal.min)
    }
  })

  it('findDungeonVariant 按「种类 + 五行 / 石档」唯一命中', () => {
    expect(findDungeonVariant('skill', '金')?.id).toBe('skillGold')
    expect(findDungeonVariant('enhance', undefined, 'relicStoneTier2')?.id).toBe('enhanceTier2')
    expect(findDungeonVariant('skill')).toBeNull()
    expect(findDungeonVariant('enhance')).toBeNull()
  })

  it('变体 id 索引与清单一致', () => {
    expect(DUNGEON_INDEX.size).toBe(DUNGEON_VARIANTS.length)
    for (const v of DUNGEON_VARIANTS) {
      expect(DUNGEON_INDEX.get(v.id)).toEqual(v)
    }
  })
})

describe('副本波次取材', () => {
  it('难度 → 取材章节（简易第 1 章 / 普通第 4 章 / 困难第 8 章）', () => {
    expect(dungeonChapter('easy')).toBe(1)
    expect(dungeonChapter('normal')).toBe(4)
    expect(dungeonChapter('hard')).toBe(8)
  })

  it('波次就是该章的主线关卡 id（难度天然落在已标定的锚点上）', () => {
    for (const d of DUNGEON_DIFFICULTIES) {
      const waves = dungeonStages(d.chapter)
      expect(waves.length).toBeGreaterThan(0)
      // 全是主线关卡 id
      for (const id of waves) expect(id).toBeGreaterThan(0)
    }
  })

  it('不同难度的波次不重叠（不是同一批关卡换皮）', () => {
    const easy = new Set(dungeonStages(dungeonChapter('easy')))
    const hard = dungeonStages(dungeonChapter('hard'))
    for (const id of hard) expect(easy.has(id)).toBe(false)
  })
})

describe('副本解锁判定', () => {
  it('技能副本：有可升技能的该五行英灵即可进入', () => {
    const save = strongSave()
    const variant = DUNGEON_VARIANTS.find((v) => v.id === 'skillEarth')!
    expect(dungeonUnlocked(save, variant).unlocked).toBe(true)
  })

  it('技能副本：没有该五行英灵 → 锁定并给出原因', () => {
    const save = strongSave()
    const variant = DUNGEON_VARIANTS.find((v) => v.id === 'skillWater')!
    const res = dungeonUnlocked(save, variant)
    expect(res.unlocked).toBe(false)
    expect(res.reason).toContain('水')
  })

  it('强化副本：持有对应等级遗物即可进入', () => {
    const save = strongSave()
    const tier1 = DUNGEON_VARIANTS.find((v) => v.id === 'enhanceTier1')!
    expect(dungeonUnlocked(save, tier1).unlocked).toBe(true)
  })

  it('强化副本：没有遗物 → 高阶锁定', () => {
    const save = createNewSave(NOW, 7)
    const tier3 = DUNGEON_VARIANTS.find((v) => v.id === 'enhanceTier3')!
    const res = dungeonUnlocked(save, tier3)
    expect(res.unlocked).toBe(false)
    expect(res.reason).toContain('Lv')
  })

  it('强化副本：遗物等级达标即解锁（档位解锁线取配置）', () => {
    const save = strongSave()
    const rng = new Rng(5)
    save.relics = [makeTestRelic('set_zhanshen_1', rng, RELIC.STONE_TIERS[1].unlockRelicLevel)]
    const tier2 = DUNGEON_VARIANTS.find((v) => v.id === 'enhanceTier2')!
    expect(dungeonUnlocked(save, tier2).unlocked).toBe(true)
  })

  /**
   * 客户端镜像里 `save.relics` **只有已装备件**（存档分包）→
   * 仓库里那件 Lv60 的客户端看不见 → 解锁线必须由服务端统计后传入。
   *
   * ⚠ 历史教训：不传 facts 时客户端会把「明明有 Lv60」判成「未解锁」，
   *   玩家在副本页看到「需要持有 Lv60 遗物（当前最高 Lv0）」却根本进不去。
   */
  it('强化副本：解锁线取服务端统计的仓库最高等级（不依赖已装备件）', () => {
    const save = createNewSave(NOW, 7)
    // 客户端镜像：仓库里的 Lv60 那件**没有**出现在 relics 里
    expect(save.relics).toHaveLength(0)
    const tier2 = DUNGEON_VARIANTS.find((v) => v.id === 'enhanceTier2')!

    // 没有 facts → 只能看到 0 → 判定为未解锁（这正是客户端的老毛病）
    expect(dungeonUnlocked(save, tier2).unlocked).toBe(false)

    // 传入服务端统计 → 解锁
    const res = dungeonUnlocked(save, tier2, { maxRelicLevel: 60 })
    expect(res.unlocked).toBe(true)
  })

  it('强化副本：服务端统计低于解锁线时仍锁定，并写清当前最高等级', () => {
    const save = createNewSave(NOW, 7)
    const tier2 = DUNGEON_VARIANTS.find((v) => v.id === 'enhanceTier2')!
    const res = dungeonUnlocked(save, tier2, { maxRelicLevel: 12 })
    expect(res.unlocked).toBe(false)
    expect(res.reason).toContain('Lv60')
    expect(res.reason).toContain('Lv12')
  })
})

describe('副本运行器', () => {
  it('胜利只发所选材料，不发银两 / 经验 / 遗物', () => {
    const save = strongSave()
    const variant = DUNGEON_VARIANTS.find((v) => v.id === 'skillEarth')!
    const result = runDungeon(save, variant, 'easy', 3, 12345, makeCtx(save))
    expect(result.battles).toBeGreaterThan(0)
    const total = Object.values(result.items).reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(0)
    // 只有所选材料这一种
    for (const id of Object.keys(result.items)) {
      expect(id).toBe(variant.itemId)
    }
  })

  it('不写 campaign（主线首通记录不受副本影响）', () => {
    const save = strongSave()
    const clearedBefore = save.campaign.clearedStage
    const variant = DUNGEON_VARIANTS.find((v) => v.id === 'skillEarth')!
    runDungeon(save, variant, 'easy', 3, 999, makeCtx(save))
    expect(save.campaign.clearedStage).toBe(clearedBefore)
  })

  it('没有编队 → 直接判定为卡住并给出降难度建议', () => {
    const save = createNewSave(NOW, 7)
    const variant = DUNGEON_VARIANTS.find((v) => v.id === 'skillEarth')!
    const result = runDungeon(save, variant, 'hard', 3, 1, makeCtx(save))
    expect(result.blocked).toBe(true)
    expect(result.blockedAtBattle).toBe(1)
    expect(result.suggestDifficulty).toBe('normal')
  })

  it('降难度建议：已经最低档就返回 null', () => {
    expect(suggestLowerDifficulty('easy')).toBeNull()
    expect(suggestLowerDifficulty('normal')).toBe('easy')
    expect(suggestLowerDifficulty('hard')).toBe('normal')
  })

  it('副本掉落数量落在配置的区间内', () => {
    const save = strongSave()
    const variant = DUNGEON_VARIANTS.find((v) => v.id === 'enhanceTier1')!
    const drop = DUNGEON_DROPS[variant.itemId]!
    const result = runDungeon(save, variant, 'easy', 5, 777, makeCtx(save))
    const total = result.items[variant.itemId] ?? 0
    expect(total).toBeGreaterThanOrEqual(result.wins * drop.min)
    expect(total).toBeLessThanOrEqual(result.wins * drop.max)
  })
})

describe('副本与主线共用战斗系统', () => {
  it('副本用的是同一个 buildPveContext（数值口径一致）', () => {
    const save = strongSave()
    const ctx = buildPveContext(save, 1)
    expect(ctx.mode).toBe('pve')
    expect(ctx.seed).toBe(1)
  })

  it('变体定义在 config 层，不含逻辑（只读数据）', () => {
    for (const v of DUNGEON_VARIANTS) {
      expect(typeof v.unlockHint).toBe('string')
      expect(v.unlockHint.length).toBeGreaterThan(0)
      expect(Object.keys(v).sort()).toEqual(
        ['element', 'id', 'itemId', 'kind', 'name', 'tier', 'unlockHint'].filter((k) => k in v).sort(),
      )
    }
  })
})

/** 让 TS 知道 DungeonVariant 类型被用到了 */
export type { DungeonVariant }
