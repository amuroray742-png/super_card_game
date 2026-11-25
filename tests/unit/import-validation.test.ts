import { describe, it, expect } from 'vitest'
import { applyAction } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { START_RESOURCES } from '../../src/core/config/economy.ts'
import { dungeonStageId } from '../../src/core/config/dungeons.ts'
import { Rng } from '../../src/core/rng.ts'

describe('旧档导入边界', () => {
  it.each([
    ['超大解码负载', (s: any) => { s.padding = 'x'.repeat(500_001) }],
    ['超长集合', (s: any) => { s.codes = Array(2001).fill('x') }],
    ['负数资源', (s: any) => { s.player.crystals = -1 }],
    ['不安全整数', (s: any) => { s.player.silver = 1e100 }],
    ['未知英灵', (s: any) => { s.heroes.fake = { id: 'fake' } }],
    ['悬空编队', (s: any) => { s.team.slots[0] = 'xiangyu' }],
    ['未知关卡', (s: any) => { s.idle.channels.main.target = { kind: 'main', stageId: 99999 } }],
    ['未知副本关卡', (s: any) => { s.idle.channels.skill.target = { kind: 'skill', dungeonStageId: 'dgn_fake_easy' } }],
    ['错误集合', (s: any) => { s.relics = {} }],
    // ⚠ **遗物副本 v12**：遗物通道的目标必须指向**遗物**副本。
    //   `{kind:'relic', dungeonStageId:'dgn_skillGold_easy'}` 是「凭空捏造」——
    //   `normalizeIdleChannel` 会把它洗成 `null`，但归一化**之前**必须先拦住，
    //   否则校验就是死代码（坏数据照样被放进来）。
    ['遗物通道指向技能副本', (s: any) => {
      s.idle.channels.relic.target = { kind: 'relic', dungeonStageId: dungeonStageId('skillGold', 'easy') }
    }],
    ['遗物通道指向不存在的副本关卡', (s: any) => {
      s.idle.channels.relic.target = { kind: 'relic', dungeonStageId: 'dgn_fake_easy' }
    }],
    // ⚠ 保底计数**不能由客户端决定**：一份 `pity: 999` 的导入档会让保底形同虚设。
    ['保底计数引用不存在的关卡', (s: any) => { s.relicPity = { dgn_fake_easy: 1 } }],
    ['保底计数是负数', (s: any) => { s.relicPity = { [dungeonStageId('relicZhanTan', 'easy')]: -1 } }],
    ['保底计数不是整数', (s: any) => { s.relicPity = { [dungeonStageId('relicZhanTan', 'easy')]: 1.5 } }],
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
    expect(save.rng).toMatchObject({ seed: 123, counter: 0 })
    expect(save.lastTickAt).toBe(5000)
    expect(save.createdAt).toBe(5000)
    expect(save.daily.lastSignInDay).not.toBe(999999)
    // ⚠ 资源/背包版本 v10：抽卡券退役 → 新号起始结晶 6,000（= 20 抽）
    expect(save.player.crystals).toBe(START_RESOURCES.crystals)
  })

  it('⚠ 遗物通道的**合法目标**可以导入，但保底与每日额度**不继承**', () => {
    // ⚠ 导入的进度不是可信的凭证：
    //   继承 `pity: 999` 会让保底形同虚设；继承 `daily.count` 会白扣玩家额度。
    const save = createNewSave(1000, 7)
    const raw = createNewSave(1000, 42)
    raw.idle.channels.relic.target = {
      kind: 'relic',
      dungeonStageId: dungeonStageId('relicZhanTan', 'easy'),
    }
    raw.relicPity = { [dungeonStageId('relicZhanTan', 'easy')]: 9 }
    raw.relicDaily = { date: '2023-11-14', count: 15 }

    const outcome = applyAction(save, { type: 'save.import', payload: exportSave(raw) }, { now: 5000, rng: new Rng(7), randomSeed: () => 123 })
    expect(outcome.ok).toBe(true)
    // 保底与每日计数被清零
    expect(save.relicPity).toEqual({})
    expect(save.relicDaily).toEqual({ date: '', count: 0 })
    // 遗物通道的挂机目标同样被清空（导入的进度不是可信的通关凭证）
    expect(save.idle.channels.relic.target).toBeNull()
  })
})
