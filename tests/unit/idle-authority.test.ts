import { describe, expect, it } from 'vitest'
import { applyAction, settleIdleLedger } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { Rng } from '../../src/core/rng.ts'
import { runIdle, settleOffline, computeOfflineEfficiency } from '../../src/core/systems/idle.ts'
import { buildPveContext, buildTeam, buildTeamPower } from '../../src/core/systems/derive.ts'
import { maxedHero } from './helpers.ts'
import { BATTLE, IDLE } from '../../src/core/config/economy.ts'
import { getStage } from '../../src/core/config/stages.ts'

const NOW = 1700000000000
function fixture() {
  const save = createNewSave(NOW, 123)
  save.heroes.xiangyu = { ...createHeroState('xiangyu', NOW), level: 240, star: 6 }
  save.team.slots[0] = 'xiangyu'
  const rng = new Rng(123)
  return { save, rng, ctx: { now: NOW, rng, randomSeed: () => 456 } }
}

function bossFixture() {
  const save = createNewSave(NOW, 1)
  const ids = ['jeannedarc', 'nangdengel', 'huatuo', 'bianque']
  ids.forEach((id, slot) => {
    // ⚠ 等级要同时满足两件事：编队战力**过**第 62 关（第二章 BOSS）的门槛，
    //   但实战**打不赢**它 —— 这正是「过门槛却败于 BOSS」这条用例的前提。
    //   门槛随锚点重标定而变（roadmap P1-2），所以这里的等级随之调整。
    save.heroes[id] = { ...createHeroState(id, NOW), level: 62 }
    save.team.slots[slot] = id
  })
  save.campaign.clearedStage = 60
  save.idle.currentStage = 61
  return { save, ctx: { now: NOW, rng: new Rng(1), randomSeed: () => 2 } }
}

describe('挂机权威时间账本', () => {
  it('零时间不产出奖励也不消耗随机序列', () => {
    const { save, rng, ctx } = fixture()
    const before = JSON.stringify(save)
    const result = applyAction(save, { type: 'idle.tick', battles: 100 }, ctx)
    expect(result.ok && result.result.battles).toBe(0)
    expect(JSON.stringify(save)).toBe(before)
    expect(rng.snapshot().counter).toBe(0)
  })
  it('请求场次只是上限，保留不足一场的毫秒余数，在线离线不得重复领', () => {
    const { save, ctx } = fixture()
    ctx.now += 13500
    const first = applyAction(save, { type: 'idle.tick', battles: 100 }, ctx)
    expect(first.ok && first.result.battles).toBe(2)
    expect(save.lastTickAt).toBe(NOW + 12000)
    const offline = applyAction(save, { type: 'idle.claimOffline' }, ctx)
    expect(offline.ok && offline.result).toBeNull()
    ctx.now += 4500
    const next = applyAction(save, { type: 'idle.tick', battles: 100 }, ctx)
    expect(next.ok && next.result.battles).toBe(1)
    expect(save.lastTickAt).toBe(NOW + 18000)
  })
  it('请求上限留下已累积时间，时钟回退不重新发奖励', () => {
    const { save, ctx, rng } = fixture()
    ctx.now += 18000
    const first = applyAction(save, { type: 'idle.tick', battles: 1 }, ctx)
    expect(first.ok && first.result.battles).toBe(1)
    expect(save.lastTickAt).toBe(NOW + 6000)
    ctx.now = NOW
    const before = rng.snapshot().counter
    const second = applyAction(save, { type: 'idle.tick', battles: 100 }, ctx)
    expect(second.ok && second.result.battles).toBe(0)
    expect(save.lastTickAt).toBe(NOW + 6000)
    expect(rng.snapshot().counter).toBe(before)
  })
  it('非法场次失败且原子', () => {
    for (const battles of [0, -1, NaN, Infinity, 1.5]) {
      const { save, ctx, rng } = fixture()
      ctx.now += 60000
      const before = JSON.stringify(save)
      expect(applyAction(save, { type: 'idle.tick', battles }, ctx).ok).toBe(false)
      expect(JSON.stringify(save)).toBe(before)
      expect(rng.snapshot().counter).toBe(0)
    }
  })
  it('目标最多为已通关的下一关，不能直接跳至末关', () => {
    const { save, ctx } = fixture()
    expect(applyAction(save, { type: 'idle.setTarget', kind: 'campaign', stageId: 310 }, ctx).ok).toBe(false)
    expect(save.idle.currentStage).toBe(1)
  })
  it('战败不能算通关，通关与下一目标独立', () => {
    const weak = runIdle([maxedHero('xiangyu')], 310, 1, 9)
    expect(weak.blockedAtStage).toBe(310)
    expect(weak.lastClearedStage).toBeNull()
    const win = runIdle([maxedHero('xiangyu')], 1, 1, 9)
    expect(win.lastClearedStage).toBe(1)
    expect(win.nextTargetStage).toBe(2)
  })
  it('过门槛却败于 BOSS 时只结算实际场次，保留挑战并改刷已通关关卡', () => {
    const { save, ctx } = bossFixture()
    expect(buildTeamPower(save)).toBeGreaterThanOrEqual(getStage(62).powerRequired)
    const battleMs = BATTLE.SECONDS_PER_BATTLE * 1000
    ctx.now += 12 * battleMs + 500
    const before = settleIdleLedger(save, ctx, 1)
    expect(before).toMatchObject({ lastClearedStage: 61, nextTargetStage: 62 })

    const lost = settleIdleLedger(save, ctx, 1)
    expect(lost).toMatchObject({ battles: 1, blockedAtStage: 62, rewards: {}, lastClearedStage: null })
    expect(save.idle.effectiveMs).toBeCloseTo(10 * battleMs + 500)
    expect(save.idle.farm).toEqual({ stage: 61, winsUntilRetry: IDLE.FARM_WINS_BEFORE_RETRY })

    const farmed = settleIdleLedger(save, ctx, 2)
    expect(farmed).toMatchObject({ battles: 2, lastClearedStage: 61, reachedStage: 61, nextTargetStage: 62 })
    expect(farmed?.rewards.relics).toHaveLength(2)
    expect(save.idle.currentStage).toBe(62)
    expect(save.idle.farm).toEqual({ stage: 61, winsUntilRetry: IDLE.FARM_WINS_BEFORE_RETRY - 2 })
    expect(save.idle.effectiveMs).toBeCloseTo(8 * battleMs + 500)
  })

  it('分批领取与一次领取的刷取收益一致，凑够胜场才重试原关', () => {
    const one = bossFixture()
    const split = bossFixture()
    const battles = 2 + IDLE.FARM_WINS_BEFORE_RETRY
    const elapsed = battles * BATTLE.SECONDS_PER_BATTLE * 1000
    one.ctx.now += elapsed
    split.ctx.now += elapsed
    const full = settleIdleLedger(one.save, one.ctx, battles)
    expect(full?.rewards.relics).toHaveLength(1 + IDLE.FARM_WINS_BEFORE_RETRY)
    for (let i = 0; i < battles; i++) settleIdleLedger(split.save, split.ctx, 1)
    expect(split.save.idle.farm).toEqual({ stage: 61, winsUntilRetry: 0 })
    expect(split.save.idle).toEqual(one.save.idle)
    expect(split.save.player).toEqual(one.save.player)
    expect(split.ctx.rng.snapshot()).toEqual(one.ctx.rng.snapshot())

    split.ctx.now += BATTLE.SECONDS_PER_BATTLE * 1000
    expect(settleIdleLedger(split.save, split.ctx, 1)).toMatchObject({ blockedAtStage: 62 })
    expect(split.save.idle.farm?.winsUntilRetry).toBe(IDLE.FARM_WINS_BEFORE_RETRY)
    expect(applyAction(split.save, { type: 'idle.setTarget', kind: 'campaign', stageId: 61 }, split.ctx).ok).toBe(true)
    expect(split.save.idle.farm).toBeUndefined()
  })
  it('频繁领取与一次领取使用相同的线性时间预算', () => {
    const { save, ctx } = fixture()
    let battles = 0
    for (let i = 0; i < 10; i++) {
      ctx.now += 6000
      const result = applyAction(save, { type: 'idle.tick', battles: 100 }, ctx)
      if (result.ok) battles += result.result.battles
    }
    const other = fixture()
    other.ctx.now += 60000
    const once = applyAction(other.save, { type: 'idle.claimOffline' }, other.ctx)
    expect(battles).toBe(10)
    expect(once.ok && once.result?.battles).toBe(10)
    expect(other.save.campaign.clearedStage).toBe(save.campaign.clearedStage)
    expect(other.save.player).toEqual(save.player)
    expect(other.save.relics.map(r => r.defId)).toEqual(save.relics.map(r => r.defId))
  })
  it('空队不足一场的时间也不能在编队后追领', () => {
    const { save, ctx, rng } = fixture()
    save.team.slots.fill(null)
    ctx.now += 5500
    expect(settleIdleLedger(save, ctx)).toBeNull()
    expect(save.lastTickAt).toBe(ctx.now)
    expect(rng.snapshot().counter).toBe(0)
    save.team.slots[0] = 'xiangyu'
    ctx.now += 500
    const result = applyAction(save, { type: 'idle.tick', battles: 10 }, ctx)
    expect(result.ok && result.result.battles).toBe(0)
  })
  it('首次tick历史只按离线结算，未来租约在线为3倍', () => {
    const { save, ctx } = fixture()
    ctx.now += 6000
    const first = applyAction(save, { type: 'idle.tick', battles: 100 }, ctx)
    expect(first.ok && first.result.battles).toBe(1)
    applyAction(save, { type: 'idle.heartbeat' }, ctx)
    ctx.now += 2000
    const future = applyAction(save, { type: 'idle.tick', battles: 100 }, ctx)
    expect(future.ok && future.result.battles).toBe(1)
  })
  it('频繁离线入口不重置连续离线衰减周期', () => {
    const frequent = fixture()
    const once = fixture()
    frequent.save.team.slots.fill(null)
    once.save.team.slots.fill(null)
    for (let i = 0; i < 10; i++) {
      frequent.ctx.now += 3600000
      settleIdleLedger(frequent.save, frequent.ctx)
    }
    once.ctx.now += 10 * 3600000
    settleIdleLedger(once.save, once.ctx)
    expect(frequent.save.idle.offlineElapsedMs).toBe(once.save.idle.offlineElapsedMs)
    expect(frequent.save.idle.offlineElapsedMs).toBe(10 * 3600000)
  })
  it('10小时离线分段计量与一次计量均为同一条曲线的预算', () => {
    const frequent = fixture()
    const once = fixture()
    // 每小时计量但不领奖，避免回放上限影响对曲线积分的断言。
    for (let i = 0; i < 10; i++) {
      frequent.ctx.now += 3600000
      settleIdleLedger(frequent.save, frequent.ctx, 0)
    }
    once.ctx.now += 10 * 3600000
    settleIdleLedger(once.save, once.ctx, 0)
    // 预算取 core 的离线效率曲线（口径唯一：IDLE.FULL_EFFICIENCY_HOURS / CAP_HOURS / TAIL_RATE）
    const budget = computeOfflineEfficiency(10 * 3600) * 3600000
    expect(frequent.save.idle.effectiveMs).toBeCloseTo(budget)
    expect(frequent.save.idle.effectiveMs).toBeCloseTo(once.save.idle.effectiveMs!)
  })
  it('空队时间在编队动作前丢弃，新队不能追领', () => {
    const { save, ctx } = fixture()
    save.team.slots.fill(null)
    ctx.now += 60000
    expect(applyAction(save, { type: 'team.setSlot', index: 0, heroId: 'xiangyu' }, ctx).ok).toBe(true)
    const result = applyAction(save, { type: 'idle.tick', battles: 100 }, ctx)
    expect(result.ok && result.result.battles).toBe(0)
  })
  it('离线回放不外推未打赢的场次奖励', () => {
    const team = [maxedHero('xiangyu')]
    const one = settleOffline(team, 310, 6, 9)
    const long = settleOffline(team, 310, 43200, 9)
    expect(long.rewards).toEqual(one.rewards)
  })
  it('永久加成进入PVE战力并影响真实挂机', () => {
    const { save, ctx } = fixture()
    const before = buildTeamPower(save)
    save.player.permBoost = 0.5
    expect(buildPveContext(save).teamMods?.progress).toContainEqual({ stat: 'spd', value: 0.5, kind: 'pct', zone: 'progress' })
    expect(buildTeamPower(save)).toBeGreaterThan(before)
    expect(buildTeam(save)).toHaveLength(1)
    ctx.now += 6000
    const result = applyAction(save, { type: 'idle.tick', battles: 1 }, ctx)
    expect(result.ok && result.result.battles).toBe(1)
  })
})
