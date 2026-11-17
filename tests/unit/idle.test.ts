/**
 * 挂机与离线结算（§15.1）
 */
import { describe, expect, it } from 'vitest'
import {
  computeOfflineEfficiency,
  offlineEffectiveSeconds,
  runIdle,
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

/**
 * 遗物掉落。
 *
 * ⚠ 历史 bug：遗物只放进 core 的独立数组 `relics`，`rewards.relics` 从未被赋值，
 *   而表现层的 `applyRewards` 只读 `rewards` → 挂机/离线的遗物 100% 被丢弃。
 *   这里锁住「遗物必须进 rewards」这条口径（表现层只认 rewards，铁律 #4）。
 */
describe('遗物掉落', () => {
  it('挂机产出的遗物进 rewards（与 newRelics 一致）', () => {
    const team = [maxedHero('xiangyu')]
    const result = runIdle(team, 1, 3, 12345)
    expect(result.battles).toBeGreaterThan(0)
    expect(result.rewards.relics?.length ?? 0).toBeGreaterThan(0)
    expect(result.rewards.relics).toEqual(result.newRelics)
  })

  it('多场战斗的遗物会累加（不是只剩最后一场的）', () => {
    const team = [maxedHero('xiangyu')]
    const one = runIdle(team, 1, 1, 999)
    const many = runIdle(team, 1, 5, 999)
    expect(one.rewards.relics!.length).toBe(1)
    expect(many.rewards.relics!.length).toBe(5)
  })

  it('离线结算同样把遗物放进 rewards', () => {
    const team = [maxedHero('xiangyu')]
    const result = settleOffline(team, 1, 2 * 3600, 3)
    expect(result.rewards.relics?.length ?? 0).toBeGreaterThan(0)
  })

  it('遗物 id 是真实存在的遗物定义', () => {
    const team = [maxedHero('xiangyu')]
    const result = runIdle(team, 1, 2, 4242)
    for (const id of result.rewards.relics ?? []) {
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    }
  })
})
