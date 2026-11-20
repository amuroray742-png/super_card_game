import { describe, it, expect } from 'vitest'
import { applyAction } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { START_RESOURCES } from '../../src/core/config/economy.ts'
import { Rng } from '../../src/core/rng.ts'

describe('旧档导入边界', () => {
  it.each([
    ['超大解码负载', (s: any) => { s.padding = 'x'.repeat(500_001) }],
    ['超长集合', (s: any) => { s.codes = Array(2001).fill('x') }],
    ['负数资源', (s: any) => { s.player.crystals = -1 }],
    ['不安全整数', (s: any) => { s.player.silver = 1e100 }],
    ['未知英灵', (s: any) => { s.heroes.fake = { id: 'fake' } }],
    ['悬空编队', (s: any) => { s.team.slots[0] = 'xiangyu' }],
    ['未知关卡', (s: any) => { s.idle.currentStage = 99999 }],
    ['错误集合', (s: any) => { s.relics = {} }],
  ])('%s被拒绝且不改存档', (_name, patch) => {
    const save = createNewSave(1000, 7)
    const raw = createNewSave(1000, 42)
    patch(raw)
    const before = structuredClone(save)
    const rng = new Rng(7)
    const outcome = applyAction(save, { type: 'save.import', payload: exportSave(raw) }, { now: 5000, rng, randomSeed: () => 123 })
    expect(outcome.ok).toBe(false)
    expect(save).toEqual(before)
    expect(rng.snapshot().counter).toBe(0)
  })

  it('迁移保留资产但重建RNG与时间周期控制字段', () => {
    const save = createNewSave(1000, 7)
    const raw = createNewSave(1000, 42)
    raw.daily.lastSignInDay = 999999
    raw.arena.weeklyMedals = 0
    const outcome = applyAction(save, { type: 'save.import', payload: exportSave(raw) }, { now: 5000, rng: new Rng(7), randomSeed: () => 123 })
    expect(outcome.ok).toBe(true)
    expect(save.rng).toEqual({ seed: 123, counter: 0 })
    expect(save.lastTickAt).toBe(5000)
    expect(save.createdAt).toBe(5000)
    expect(save.daily.lastSignInDay).not.toBe(999999)
    // ⚠ 资源/背包版本 v10：抽卡券退役 → 新号起始结晶 6,000（= 20 抽）
    expect(save.player.crystals).toBe(START_RESOURCES.crystals)
  })
})
