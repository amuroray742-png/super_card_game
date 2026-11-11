/**
 * 挂机与离线结算（§15.1）
 */
import { describe, expect, it } from 'vitest'
import {
  computeOfflineEfficiency,
  offlineEffectiveSeconds,
  settleOffline,
  OFFLINE_CAP_SECONDS,
} from '../../src/core/systems/idle.ts'
import { IDLE } from '../../src/core/config/economy.ts'
import { makeHero, maxedHero } from './helpers.ts'

describe('离线收益曲线（§5.7）', () => {
  it('8 小时内效率为 100%', () => {
    expect(computeOfflineEfficiency(0)).toBe(0)
    expect(computeOfflineEfficiency(3600)).toBeCloseTo(1, 6)
    expect(computeOfflineEfficiency(8 * 3600)).toBeCloseTo(8, 6)
  })

  it('8~12 小时线性衰减至 60%', () => {
    // 12 小时：8h 满额 + 4h 平均效率 (1.0 + 0.6)/2 = 0.8
    expect(computeOfflineEfficiency(12 * 3600)).toBeCloseTo(8 + 4 * 0.8, 6)
    // 10 小时：8h 满额 + 2h × 0.8
    expect(computeOfflineEfficiency(10 * 3600)).toBeCloseTo(8 + 2 * 0.8, 6)
  })

  it('12 小时封顶，超出不再产出', () => {
    expect(computeOfflineEfficiency(12 * 3600)).toBeCloseTo(
      computeOfflineEfficiency(48 * 3600),
      6,
    )
    expect(OFFLINE_CAP_SECONDS).toBe(12 * 3600)
  })

  it('有效时长 = 真实时长 × 效率', () => {
    expect(offlineEffectiveSeconds(3600)).toBeCloseTo(3600, 6)
    expect(offlineEffectiveSeconds(4 * 3600)).toBeCloseTo(4 * 3600, 6)
  })

  it('在线效率为离线的 3 倍（8h 离线 ≈ 在线 2 小时 40 分）', () => {
    const offline = offlineEffectiveSeconds(8 * 3600) / 3600 // 8 小时等价
    const onlineEquivalent = offline / IDLE.ONLINE_MULTIPLIER // 2.667 小时
    expect(onlineEquivalent).toBeCloseTo(8 / 3, 6)
    expect(IDLE.ONLINE_MULTIPLIER).toBe(3)
  })
})

describe('离线结算', () => {
  it('无编队时不产生收益但结构完整', () => {
    const result = settleOffline([], 1, 3600, 1)
    expect(result.battles).toBe(0)
    expect(result.rewards).toBeDefined()
  })

  it('离线 12 小时与离线 4 小时（衰减前区间）收益关系正确', () => {
    const team = [maxedHero('xiangyu'), maxedHero('hanxin')]
    const four = settleOffline(team, 1, 4 * 3600, 42)
    const twelve = settleOffline(team, 1, 12 * 3600, 42)
    expect(twelve.battles).toBeGreaterThanOrEqual(four.battles)
    // 12h 有效时长 11.2h，4h 有效时长 4h，比值 2.8
    const ratio = (twelve.rewards.exp ?? 0) / Math.max(1, four.rewards.exp ?? 0)
    expect(ratio).toBeGreaterThan(2.2)
    expect(ratio).toBeLessThan(3.4)
  })

  it('超过 12 小时的离线收益不再增加', () => {
    const team = [maxedHero('xiangyu')]
    const twelve = settleOffline(team, 1, 12 * 3600, 7)
    const forty = settleOffline(team, 1, 40 * 3600, 7)
    expect(forty.rewards.exp).toBe(twelve.rewards.exp)
  })

  it('离线收益包含经验与银两', () => {
    const team = [maxedHero('xiangyu')]
    const result = settleOffline(team, 1, 2 * 3600, 3)
    expect(result.rewards.exp).toBeGreaterThan(0)
    expect(result.rewards.silver).toBeGreaterThan(0)
  })
})
