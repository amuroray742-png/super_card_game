/**
 * 旧档迁移 v9 → v10（资源/背包版本）。
 *
 * 迁移是**资产搬运**，一旦口径错了就是静默的资产损失：
 * 玩家攒了 100 张券、5 万印记、80 万经验，迁移后少了一样却没有任何提示。
 *
 * 守四条：
 * 1. **抽卡券 → 圣杯结晶**（每张 300，设计稿 §2）；
 * 2. **英灵印记 → 银两**；
 * 3. **玩家经验池 → 经验书**（大书优先，尾差向上补一本小书）；
 * 4. **术式结晶 / 遗物强化石 → 一次性分配权益**（`save.legacy`），**不自动折算**。
 *
 * 另外守两条容易漏的：
 * - 迁移**幂等**：`migrate()` 每次载入都会跑一遍，不能重复折算；
 * - 退役字段在迁移后**必须消失**（不能靠「客户端不读」来兜底）。
 */
import { describe, expect, it } from 'vitest'
import { createNewSave, migrate, normalizeSave, SAVE_VERSION } from '../../src/core/save/schema.ts'
import { EXP_BOOK, LEGACY_CONVERSION } from '../../src/core/config/economy.ts'
import { ITEM_BY_ELEMENT } from '../../src/core/config/items.ts'
import { applyAction } from '../../src/core/systems/actions.ts'
import { Rng } from '../../src/core/rng.ts'
import { GAME_ERROR_CODES } from '../../src/core/config/game-errors.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000

function makeCtx() {
  return { now: NOW, rng: new Rng(42), randomSeed: () => 42 }
}

/**
 * 造一份 **v9 形态**的存档（带全部退役字段）。
 *
 * ⚠ 不用 `createNewSave` 再改字段——那样造出来的还是 v10 结构，
 *   迁移链的行为会被绕过。
 * ⚠ v9 存档**没有背包道具**（`items` 是 v10 才有的字段），
 *   所以这里要把起步道具清零，否则会把「新号起步道具」算进折算结果。
 */
function legacyV9Save(): SaveData {
  const save = createNewSave(NOW, 7)
  const player = save.player as unknown as Record<string, unknown>
  player.tickets = 10
  player.emblems = 50
  player.exp = 25_000
  player.skillStones = 300
  player.relicStones = 120
  for (const id of Object.keys(save.items)) save.items[id as keyof typeof save.items] = 0
  save.version = 9
  return save
}

describe('v9 → v10 迁移', () => {
  it('抽卡券按每张 300 折算成圣杯结晶', () => {
    const save = migrate(legacyV9Save())
    expect(save.player.crystals).toBeGreaterThanOrEqual(10 * LEGACY_CONVERSION.ticketToCrystals)
  })

  it('英灵印记按 1,000 折算成银两', () => {
    const before = legacyV9Save().player.silver
    const save = migrate(legacyV9Save())
    expect(save.player.silver).toBe(before + 50 * LEGACY_CONVERSION.emblemToSilver)
  })

  it('玩家经验池折算成经验书（大书优先 + 尾差补一本小书）', () => {
    const save = migrate(legacyV9Save())
    // 25,000 经验 = 2 本大书（20,000）+ 5 本小书（5,000）
    expect(save.items[EXP_BOOK.large.id]).toBe(2)
    expect(save.items[EXP_BOOK.small.id]).toBe(5)
  })

  it('术式结晶 / 遗物强化石**不自动折算**，记进一次性分配权益', () => {
    const save = migrate(legacyV9Save())
    expect(save.legacy.skillStones).toBe(300)
    expect(save.legacy.relicStones).toBe(120)
    expect(save.legacy.allocated).toBe(false)
    // 背包里一个技能材料 / 强化石都没多
    for (const id of Object.values(ITEM_BY_ELEMENT)) {
      expect(save.items[id]).toBe(0)
    }
    expect(save.items.relicStoneTier1).toBe(0)
  })

  it('退役字段在迁移后彻底消失', () => {
    const save = migrate(legacyV9Save())
    const player = save.player as unknown as Record<string, unknown>
    expect(player).not.toHaveProperty('tickets')
    expect(player).not.toHaveProperty('emblems')
    expect(player).not.toHaveProperty('exp')
    expect(player).not.toHaveProperty('skillStones')
    expect(player).not.toHaveProperty('relicStones')
  })

  it('迁移是幂等的（重复载入不会重复折算）', () => {
    const once = migrate(legacyV9Save())
    const twice = migrate(structuredClone(once))
    expect(twice.player.crystals).toBe(once.player.crystals)
    expect(twice.player.silver).toBe(once.player.silver)
    expect(twice.items[EXP_BOOK.small.id]).toBe(once.items[EXP_BOOK.small.id])
    expect(twice.items[EXP_BOOK.large.id]).toBe(once.items[EXP_BOOK.large.id])
    expect(twice.legacy.skillStones).toBe(once.legacy.skillStones)
    expect(twice.legacy.relicStones).toBe(once.legacy.relicStones)
  })

  it('存档版本升到当前版本', () => {
    expect(migrate(legacyV9Save()).version).toBe(SAVE_VERSION)
    // ⚠ 遗物副本 v12（遗物唯一来源 = 遗物副本，祈愿下线）
    expect(SAVE_VERSION).toBe(12)
  })

  it('normalizeSave 保留原始版本号（迁移由 migrate 负责，不由规范化负责）', () => {
    const legacy = legacyV9Save()
    expect(normalizeSave(legacy).version).toBe(9)
  })
})

describe('旧档一次性分配权益（legacy.allocateMaterials）', () => {
  it('分配后：术式结晶变成选定五行的材料，强化石变成选定档位', () => {
    const save = migrate(legacyV9Save())
    const res = applyAction(
      save,
      { type: 'legacy.allocateMaterials', skillElement: '金', relicTier: 'relicStoneTier2' },
      makeCtx(),
    )
    expect(res.ok).toBe(true)
    expect(save.items[ITEM_BY_ELEMENT.金]).toBe(300)
    expect(save.items.relicStoneTier2).toBe(120)
    // 原额核销
    expect(save.legacy.skillStones).toBe(0)
    expect(save.legacy.relicStones).toBe(0)
    expect(save.legacy.allocated).toBe(true)
  })

  it('只能分配一次（第二次被拒）', () => {
    const save = migrate(legacyV9Save())
    applyAction(
      save,
      { type: 'legacy.allocateMaterials', skillElement: '金', relicTier: 'relicStoneTier2' },
      makeCtx(),
    )
    const again = applyAction(
      save,
      { type: 'legacy.allocateMaterials', skillElement: '木', relicTier: 'relicStoneTier1' },
      makeCtx(),
    )
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe(GAME_ERROR_CODES.LEGACY_ALREADY_ALLOCATED)
    // 第二次没有改动任何东西
    expect(save.items[ITEM_BY_ELEMENT.木]).toBe(0)
    expect(save.items.relicStoneTier1).toBe(0)
  })

  it('没有可分配的权益时被拒', () => {
    const save = createNewSave(NOW, 7)
    const res = applyAction(
      save,
      { type: 'legacy.allocateMaterials', skillElement: '金', relicTier: 'relicStoneTier1' },
      makeCtx(),
    )
    expect(res.ok).toBe(false)
  })
})
