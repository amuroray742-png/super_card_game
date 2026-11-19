/**
 * 动作层回归（core 的纯函数）。
 *
 * 服务端权威化后，**所有改变存档的动作**都由 `src/core/systems/actions.ts` 执行，
 * 服务端与客户端共用这一份。本文件守的是动作层的**契约**：
 *
 * - 成功：资源按配置扣、进度按规则涨；
 * - 失败：**存档一个字节都没变**（原子性，不存在「扣了费却没出货」）；
 * - 失败**不消耗随机序列**（序列只前进，不倒退也不浪费）；
 * - 收益只经 `rewards` 入库；竞技产出不回流 PVE 经济。
 *
 * ⚠ 与 store 的区别：这里**直接**调用动作层，不经过 Pinia /
 *   表现层，因此断言的是「规则本身」，而不是「界面点下去有没有生效」。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeTestRelic } from './helpers.ts'
import type { SaveData } from '../../src/core/model/types.ts'
import { applyAction, computeRelicAdvice, type ActionContext } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { relicUpgradeCost, getRelicMods } from '../../src/core/systems/relic.ts'
import { getEquippedRelics } from '../../src/core/systems/loadout.ts'
import { Rng } from '../../src/core/rng.ts'
import { GACHA, RELIC } from '../../src/core/config/economy.ts'

const NOW = 1_700_000_000_000
const SEED = 20241117

/** 一个可控的上下文：时间固定、随机源可观察 */
function makeCtx(save: SaveData) {
  const rng = Rng.fromSnapshot(save.rng.seed || SEED, save.rng.counter)
  const ctx: ActionContext = {
    now: NOW,
    rng,
    randomSeed: () => 987654321,
  }
  return { ctx, rng }
}

function makeSave(): SaveData {
  const save = createNewSave(NOW, SEED)
  return save
}

/** 造一支能打关的队伍 */
function seedTeam(save: SaveData): void {
  save.heroes['xiangyu'] = { ...createHeroState('xiangyu', NOW), level: 240, star: 6, skillLevels: [20, 20, 20] }
  save.heroes['hanxin'] = { ...createHeroState('hanxin', NOW), level: 240, star: 6, skillLevels: [20, 20, 20] }
  save.team.slots[0] = 'xiangyu'
  save.team.slots[1] = 'hanxin'
}

describe('动作层：失败即原子（存档不变）', () => {
  let save: SaveData

  beforeEach(() => {
    save = makeSave()
  })

  it('遗物强化：资源不足 → 等级与资源都不变', () => {
    const rng = new Rng(1)
    save.relics = [makeTestRelic('set_zhanshen_1', rng, 1)]
    save.player.silver = 0
    save.player.relicStones = 0
    const before = JSON.stringify(save)

    const { ctx } = makeCtx(save)
    const res = applyAction(save, { type: 'relic.upgrade', uid: save.relics[0].uid }, ctx)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('INSUFFICIENT_FUNDS')
    expect(save.relics[0].level).toBe(1)
    expect(save.player.silver).toBe(0)
    expect(save.player.relicStones).toBe(0)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('抽卡：余额不足 → 一个字节都没变，且不消耗随机序列', () => {
    save.player.crystals = 0
    save.player.tickets = 0
    const before = JSON.stringify(save)
    const { ctx, rng } = makeCtx(save)
    const counterBefore = rng.snapshot().counter

    const res = applyAction(save, { type: 'gacha.pull', poolId: 'standard', count: 10 }, ctx)

    expect(res.ok).toBe(false)
    expect(JSON.stringify(save)).toBe(before)
    // 失败不消耗序列（否则玩家可以「刷失败」来对齐下一次抽卡的种子）
    expect(rng.snapshot().counter).toBe(counterBefore)
  })

  it('喂经验：经验池不足 → 池子与英灵等级都不变', () => {
    save.heroes['xiangyu'] = createHeroState('xiangyu', NOW)
    save.player.exp = 10
    const before = JSON.stringify(save)
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'hero.feedExp', heroId: 'xiangyu', amount: 9999 }, ctx)

    expect(res.ok).toBe(false)
    expect(save.player.exp).toBe(10)
    expect(save.heroes['xiangyu'].level).toBe(1)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('境界突破：印记不足 → 印记不变、境界不变', () => {
    save.heroes['xiangyu'] = { ...createHeroState('xiangyu', NOW), level: 60 }
    save.player.emblems = 0
    const before = JSON.stringify(save)
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'hero.breakRealm', heroId: 'xiangyu' }, ctx)

    expect(res.ok).toBe(false)
    expect(save.player.emblems).toBe(0)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('技能升级：术式结晶不足 → 结晶不变；且不会误扣圣杯结晶', () => {
    save.heroes['xiangyu'] = createHeroState('xiangyu', NOW)
    save.player.skillStones = 0
    save.player.silver = 100_000
    save.player.crystals = 5_000
    const crystalsBefore = save.player.crystals
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'hero.upgradeSkill', heroId: 'xiangyu', index: 0 }, ctx)

    expect(res.ok).toBe(false)
    expect(save.player.skillStones).toBe(0)
    // ⚠ 术式结晶与圣杯结晶是两个资源，扣错就白扣抽卡资源（历史 bug）
    expect(save.player.crystals).toBe(crystalsBefore)
  })

  it('升星：碎片或印记不足 → 都不变', () => {
    save.heroes['xiangyu'] = createHeroState('xiangyu', NOW)
    save.player.shards['xiangyu'] = 0
    save.player.emblems = 0
    const before = JSON.stringify(save)
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'hero.upgradeStar', heroId: 'xiangyu' }, ctx)

    expect(res.ok).toBe(false)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('兑换码：无效 → 不变；已使用 → 不变', () => {
    const before = JSON.stringify(save)
    const { ctx } = makeCtx(save)

    const bad = applyAction(save, { type: 'code.redeem', code: 'NOT-A-CODE' }, ctx)
    expect(bad.ok).toBe(false)
    expect(JSON.stringify(save)).toBe(before)

    save.codes.push('SGW-WELCOME')
    const used = applyAction(save, { type: 'code.redeem', code: 'SGW-WELCOME' }, ctx)
    expect(used.ok).toBe(false)
  })

  it('签到：同一天第二次 → 拒绝且不变', () => {
    const { ctx } = makeCtx(save)
    const first = applyAction(save, { type: 'daily.signIn' }, ctx)
    expect(first.ok).toBe(true)
    const afterFirst = JSON.stringify(save)

    const second = applyAction(save, { type: 'daily.signIn' }, ctx)
    expect(second.ok).toBe(false)
    expect(JSON.stringify(save)).toBe(afterFirst)
  })

  it('导入存档：内容无效 → 拒绝且不变', () => {
    const before = JSON.stringify(save)
    const { ctx } = makeCtx(save)
    const res = applyAction(save, { type: 'save.import', payload: '这不是 base64' }, ctx)
    expect(res.ok).toBe(false)
    expect(JSON.stringify(save)).toBe(before)
  })
})

describe('动作层：成功路径', () => {
  let save: SaveData

  beforeEach(() => {
    save = makeSave()
  })

  it('遗物强化：等级 +1、银两与强化石按配置扣、主词条随之变强', () => {
    const rng = new Rng(7)
    save.relics = [makeTestRelic('set_zhanshen_1', rng, 1)]
    save.player.silver = 100_000
    save.player.relicStones = 500
    const uid = save.relics[0].uid
    const cost = relicUpgradeCost(1)!
    const modsBefore = getRelicMods(save.relics[0]).map((m) => m.value)

    const { ctx } = makeCtx(save)
    const res = applyAction(save, { type: 'relic.upgrade', uid }, ctx)

    expect(res.ok).toBe(true)
    expect(save.relics[0].level).toBe(2)
    expect(save.player.silver).toBe(100_000 - cost.silver)
    expect(save.player.relicStones).toBe(500 - cost.stones)
    const modsAfter = getRelicMods(save.relics[0]).map((m) => m.value)
    expect(modsAfter.some((v, i) => v > modsBefore[i])).toBe(true)
  })

  it('遗物强化：满级后拒绝（不会越过 MAX_LEVEL）', () => {
    const rng = new Rng(7)
    // ⚠ 上限取 core 配置，不写死数字（强化上限已由 60 提到 200）。
    save.relics = [makeTestRelic('set_zhanshen_1', rng, RELIC.MAX_LEVEL)]
    save.player.silver = 1_000_000_000
    save.player.relicStones = 10_000_000
    const { ctx } = makeCtx(save)
    const res = applyAction(save, { type: 'relic.upgrade', uid: save.relics[0].uid }, ctx)
    expect(res.ok).toBe(false)
    expect(save.relics[0].level).toBe(RELIC.MAX_LEVEL)
  })

  it('抽卡：结晶被扣、英灵入库、保底计数推进', () => {
    save.player.crystals = 3_000
    save.player.tickets = 0
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'gacha.pull', poolId: 'standard', count: 10 }, ctx)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(save.player.crystals).toBe(3_000 - GACHA.COST_SINGLE * 10)
    expect(res.result.items).toHaveLength(10)
    expect(Object.keys(save.heroes).length).toBeGreaterThan(0)
    expect(save.gacha.history).toHaveLength(10)
    expect(save.stats.totalPulls).toBe(10)
  })

  it('抽卡：结晶不够时自动用抽卡券补（逐抽计价）', () => {
    save.player.crystals = GACHA.COST_SINGLE * 3
    save.player.tickets = 7
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'gacha.pull', poolId: 'standard', count: 10 }, ctx)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.crystalsUsed).toBe(GACHA.COST_SINGLE * 3)
    expect(res.result.ticketsUsed).toBe(7)
    expect(save.player.crystals).toBe(0)
    expect(save.player.tickets).toBe(0)
  })

  it('喂经验：池子扣减、英灵升级（经验池是唯一来源）', () => {
    save.heroes['xiangyu'] = createHeroState('xiangyu', NOW)
    save.player.exp = 10_000
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'hero.feedExp', heroId: 'xiangyu', amount: 1_000 }, ctx)

    expect(res.ok).toBe(true)
    expect(save.player.exp).toBe(9_000)
    expect(save.heroes['xiangyu'].level).toBeGreaterThan(1)
  })

  it('境界突破：印记扣减、境界推进、门槛上的经验立刻兑现', () => {
    save.heroes['xiangyu'] = { ...createHeroState('xiangyu', NOW), level: 60, exp: 0 }
    save.player.emblems = 1_000
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'hero.breakRealm', heroId: 'xiangyu' }, ctx)

    expect(res.ok).toBe(true)
    expect(save.player.emblems).toBeLessThan(1_000)
    expect(save.heroes['xiangyu'].level).toBeGreaterThan(60)
  })

  it('遗物分解：返还银两与强化石、从仓库与装备槽移除', () => {
    const rng = new Rng(11)
    save.relics = [makeTestRelic('set_zhanshen_1', rng, 10)]
    save.heroes['xiangyu'] = createHeroState('xiangyu', NOW)
    const uid = save.relics[0].uid
    save.equipped['xiangyu#0'] = { heroId: 'xiangyu', relicId: uid }
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'relic.decompose', uid }, ctx)

    expect(res.ok).toBe(true)
    expect(save.relics).toHaveLength(0)
    expect(save.equipped['xiangyu#0']).toBeUndefined()
    expect(save.player.silver).toBeGreaterThan(0)
  })

  it('编队：同一个人不会占两个槽位', () => {
    seedTeam(save)
    const { ctx } = makeCtx(save)
    applyAction(save, { type: 'team.setSlot', index: 2, heroId: 'xiangyu' }, ctx)
    const used = save.team.slots.filter(Boolean)
    expect(used).toHaveLength(new Set(used).size)
  })

  it('编队预设：保存 → 应用 → 删除', () => {
    seedTeam(save)
    const { ctx } = makeCtx(save)
    const saved = applyAction(save, { type: 'team.savePreset', name: '主力' }, ctx)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const presetId = saved.result.id

    save.team.slots[0] = null
    applyAction(save, { type: 'team.applyPreset', presetId }, ctx)
    expect(save.team.slots[0]).toBe('xiangyu')

    applyAction(save, { type: 'team.removePreset', presetId }, ctx)
    expect(save.team.presets).toHaveLength(0)
  })

  it('挂机：收益入库（含遗物），且只认 rewards 这一份口径', () => {
    seedTeam(save)
    save.player.silver = 0
    const { ctx } = makeCtx(save)
    ctx.now += 12_000

    const res = applyAction(save, { type: 'idle.tick', battles: 2 }, ctx)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.rewards.silver ?? 0).toBeGreaterThan(0)
    expect(save.player.silver).toBe(res.result.rewards.silver ?? 0)
    // 遗物进仓库（走 rewards.relics，铁律 #4 / #26）
    expect(save.relics.length).toBe(res.result.rewards.relics?.length ?? 0)
  })

  it('离线结算：不足一场不结算；超过则结算并入库', () => {
    seedTeam(save)
    save.lastTickAt = NOW - 3_000
    const { ctx } = makeCtx(save)
    const tooSoon = applyAction(save, { type: 'idle.claimOffline' }, ctx)
    expect(tooSoon.ok).toBe(true)
    if (tooSoon.ok) expect(tooSoon.result).toBeNull()

    save.lastTickAt = NOW - 2 * 3600 * 1000
    const { ctx: ctx2 } = makeCtx(save)
    const res = applyAction(save, { type: 'idle.claimOffline' }, ctx2)
    expect(res.ok).toBe(true)
    if (res.ok && res.result) {
      expect(res.result.battles).toBeGreaterThan(0)
      expect(save.player.silver).toBeGreaterThan(0)
    }
  })

  it('竞技场：段位分与勋章入账，且产出不回流 PVE 经济', () => {
    seedTeam(save)
    const silverBefore = save.player.silver
    const expBefore = save.player.exp
    const stonesBefore = save.player.relicStones
    const crystalsBefore = save.player.crystals
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'arena.settle' }, ctx)

    expect(res.ok).toBe(true)
    expect(save.arena.tierPoints).toBeGreaterThanOrEqual(0)
    expect(save.arena.medals).toBeGreaterThanOrEqual(0)
    // 合规红线：竞技产出绝不回流 PVE 经济
    expect(save.player.silver).toBe(silverBefore)
    expect(save.player.exp).toBe(expBefore)
    expect(save.player.relicStones).toBe(stonesBefore)
    expect(save.player.crystals).toBe(crystalsBefore)
  })

  it('一键推荐：按推荐铺满槽位，战力不低于之前', () => {
    seedTeam(save)
    const rng = new Rng(4242)
    save.relics = ['set_zhanshen_1', 'set_zhanshen_2', 'set_zhanshen_3', 'set_zhanshen_4'].map((id) =>
      makeTestRelic(id, rng, 60),
    )
    const before = computeRelicAdvice(save, 'xiangyu')!
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'relic.autoEquip', heroId: 'xiangyu' }, ctx)

    expect(res.ok).toBe(true)
    expect(getEquippedRelics(save, 'xiangyu').filter(Boolean)).toHaveLength(4)
    const after = computeRelicAdvice(save, 'xiangyu')!
    expect(after.currentPower).toBeGreaterThanOrEqual(before.currentPower)
  })

  it('重置：进度清空并换一条全新的随机序列', () => {
    seedTeam(save)
    save.player.crystals = 999
    const { ctx } = makeCtx(save)

    const res = applyAction(save, { type: 'save.reset' }, ctx)

    expect(res.ok).toBe(true)
    expect(Object.keys(save.heroes)).toHaveLength(0)
    expect(save.player.crystals).toBe(createNewSave(NOW).player.crystals)
    expect(save.rng.seed).toBe(987654321)
  })
})

