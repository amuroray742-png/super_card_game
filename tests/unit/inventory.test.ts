/**
 * 遗物库存治理（仓库上限与溢出处理）。
 *
 * ⚠ 守的是「仓库满了会怎样」这条**没人告诉过玩家**的规则：
 *   遗物是唯一随挂机时长线性增长的字段（12 小时离线能积出数千件），
 *   没有上限的话存档会无界膨胀，而且掉落会被「悄悄吞掉」。
 *
 * 核心承诺：**绝不销毁玩家标记过的东西**——
 *   锁定的、已装备的遗物永不自动分解；溢出全是受保护件时允许突破上限并上报。
 *
 * ⚠ 上限取 `RELIC.INVENTORY_CAP`（配置唯一出处，铁律 #5）：
 *   测试造「上限 + N」件遗物，不在测试里写死业务数字。
 */
import { describe, expect, it } from 'vitest'
import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { RELIC } from '../../src/core/config/economy.ts'
import {
  enforceInventoryCap,
  equippedRelicIds,
  inventoryNearCap,
  inventoryUsage,
} from '../../src/core/systems/inventory.ts'
import { RELIC_DEFS } from '../../src/core/systems/relic.ts'
import type { RelicInstance, SaveData } from '../../src/core/model/types.ts'

const CAP = RELIC.INVENTORY_CAP
/** 战神套 1 号是 SSR、5 号是 N（稀有度排序用） */
const SSR_DEF = 'set_zhanshen_1'
const N_DEF = 'set_zhanshen_5'

/** 造一件遗物（uid 顺序递增，便于断言） */
function relic(uid: string, defId: string, level: number, locked = false): RelicInstance {
  return { uid, defId, level, subStats: [], locked }
}

/** 造一份带指定遗物的存档 */
function saveWith(relics: RelicInstance[]): SaveData {
  const save = createNewSave(0, 1)
  save.heroes['xiangyu'] = createHeroState('xiangyu', 0)
  save.relics = relics
  return save
}

/** 批量造 N 件同定义遗物 */
function many(count: number, defId = SSR_DEF, level = 1, locked = false): RelicInstance[] {
  return Array.from({ length: count }, (_, i) => relic(`r${i}`, defId, level, locked))
}

describe('库存上限', () => {
  it('没超上限时不动任何东西', () => {
    const save = saveWith(many(10))
    const silver0 = save.player.silver
    const result = enforceInventoryCap(save)
    expect(result.salvaged).toBe(0)
    expect(result.skipped).toBe(0)
    expect(save.relics).toHaveLength(10)
    expect(save.player.silver).toBe(silver0)
  })

  it('超上限时自动分解最没用的：等级低的先走', () => {
    // CAP 件 1 级 + 1 件 60 级 → 溢出 1 件，分解对象应该是 1 级那批里的第一件
    const relics = many(CAP, SSR_DEF, 1)
    relics.push(relic('keeper', SSR_DEF, 60))
    const save = saveWith(relics)

    const result = enforceInventoryCap(save)
    expect(result.salvaged).toBe(1)
    expect(save.relics).toHaveLength(CAP)
    expect(save.relics.some((r) => r.uid === 'keeper'), '高等级那件必须留下').toBe(true)
    expect(save.relics.some((r) => r.uid === 'r0'), '同等级按 uid 序，最先被分解').toBe(false)
  })

  it('同等级时稀有度低的先走', () => {
    // 溢出 1 件：SSR 与 N 同为 1 级 → N 稀有度低，先被分解
    const relics = many(CAP, SSR_DEF, 1)
    relics.push(relic('common', N_DEF, 1))
    const save = saveWith(relics)

    const result = enforceInventoryCap(save)
    expect(result.salvaged).toBe(1)
    expect(save.relics.some((r) => r.uid === 'common')).toBe(false)
    expect(save.relics.some((r) => r.uid === 'r0')).toBe(true)
  })

  it('锁定件永不被自动分解', () => {
    const relics = many(CAP, SSR_DEF, 1)
    relics[0].locked = true
    relics.push(relic('extra', SSR_DEF, 1))
    const save = saveWith(relics)

    const result = enforceInventoryCap(save)
    expect(result.salvaged).toBe(1)
    expect(save.relics).toHaveLength(CAP)
    expect(save.relics.some((r) => r.uid === 'r0'), '锁定件必须留下').toBe(true)
    expect(save.relics.some((r) => r.uid === 'extra')).toBe(false)
  })

  it('已装备件永不被自动分解', () => {
    const relics = many(CAP, SSR_DEF, 1)
    const save = saveWith(relics)
    save.equipped['xiangyu#0'] = { heroId: 'xiangyu', relicId: 'r0' }
    relics.push(relic('extra', SSR_DEF, 1))

    const result = enforceInventoryCap(save)
    expect(result.salvaged).toBe(1)
    expect(save.relics).toHaveLength(CAP)
    expect(save.relics.some((r) => r.uid === 'r0'), '已装备件必须留下').toBe(true)
    expect(save.relics.some((r) => r.uid === 'extra')).toBe(false)
  })

  it('溢出全是受保护件时：允许突破上限，不销毁，并上报 skipped', () => {
    const relics = many(CAP, SSR_DEF, 1, true)
    relics.push(relic('extra', SSR_DEF, 1, true))
    const save = saveWith(relics)

    const result = enforceInventoryCap(save)
    expect(result.salvaged).toBe(0)
    expect(result.skipped).toBe(1)
    expect(save.relics).toHaveLength(CAP + 1)
  })

  it('自动分解的折算进银两与强化石（与手动分解同一口径）', () => {
    const save = saveWith(many(CAP + 1))
    const silver0 = save.player.silver
    const stones0 = save.player.relicStones

    const result = enforceInventoryCap(save)
    expect(result.salvaged).toBe(1)
    expect(result.silver).toBeGreaterThan(0)
    expect(save.player.silver).toBe(silver0 + result.silver)
    expect(save.player.relicStones).toBe(stones0 + result.stones)
  })

  it('占用率与接近上限的判定按配置走', () => {
    const save = saveWith(many(CAP))
    expect(inventoryUsage(save)).toBe(1)
    expect(inventoryNearCap(save)).toBe(true)

    const light = saveWith(many(1))
    expect(inventoryUsage(light)).toBeCloseTo(1 / CAP, 6)
    expect(inventoryNearCap(light)).toBe(false)
  })

  it('已装备遗物 id 集合取自 equipped 映射', () => {
    const save = saveWith([relic('a', SSR_DEF, 1), relic('b', SSR_DEF, 1)])
    save.equipped['xiangyu#0'] = { heroId: 'xiangyu', relicId: 'a' }
    expect([...equippedRelicIds(save)]).toEqual(['a'])
  })

  it('遗物定义都存在（自动分解要按稀有度排序，配错 id 会静默排错）', () => {
    expect(RELIC_DEFS.get(SSR_DEF)).toBeDefined()
    expect(RELIC_DEFS.get(N_DEF)).toBeDefined()
    expect(RELIC_DEFS.get(SSR_DEF)?.rarity).toBe('SSR')
    expect(RELIC_DEFS.get(N_DEF)?.rarity).toBe('N')
  })
})
