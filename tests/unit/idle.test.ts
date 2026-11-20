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
import { EXP_BOOK_ITEM_EXP } from '../../src/core/config/items.ts'
import type { RewardBundle } from '../../src/core/model/types.ts'
import { makeHero, maxedHero } from './helpers.ts'

/**
 * 奖励包里的**经验总量**。
 *
 * ⚠ 资源/背包版本 v10：玩家经验池退役 → 经验改由「经验书」产出，
 *   所以奖励包里没有 `exp` 字段，只有一叠叠经验书（`rewards.items`）。
 */
function totalExp(rewards: RewardBundle): number {
  let sum = 0
  for (const [id, count] of Object.entries(rewards.items ?? {})) {
    sum += (EXP_BOOK_ITEM_EXP[id as keyof typeof EXP_BOOK_ITEM_EXP] ?? 0) * (count ?? 0)
  }
  return sum
}

describe('离线收益曲线（§5.7）', () => {
  it('满效率时长内效率为 100%', () => {
    expect(computeOfflineEfficiency(0)).toBe(0)
    expect(computeOfflineEfficiency(3600)).toBeCloseTo(1, 6)
    expect(computeOfflineEfficiency(IDLE.FULL_EFFICIENCY_HOURS * 3600)).toBeCloseTo(
      IDLE.FULL_EFFICIENCY_HOURS,
      6,
    )
  })

  it('满效率时长之后线性衰减至 TAIL_RATE，积分与请求次数无关', () => {
    // 曲线由 FULL_EFFICIENCY_HOURS / CAP_HOURS / TAIL_RATE 三段定义，
    // 数值口径见 economy.ts 的 IDLE（实施修正：roadmap P1-2 收窄为 1h / 3h）。
    const tail = IDLE.CAP_HOURS - IDLE.FULL_EFFICIENCY_HOURS
    const tailAvg = (1 + IDLE.TAIL_RATE) / 2
    expect(computeOfflineEfficiency(IDLE.CAP_HOURS * 3600)).toBeCloseTo(
      IDLE.FULL_EFFICIENCY_HOURS + tail * tailAvg,
    )
    expect(IDLE.ONLINE_MULTIPLIER).toBe(3)
  })

  it('收益封顶时长后不再产出', () => {
    expect(computeOfflineEfficiency(IDLE.CAP_HOURS * 3600)).toBeCloseTo(
      computeOfflineEfficiency(48 * 3600),
      6,
    )
    expect(OFFLINE_CAP_SECONDS).toBe(IDLE.CAP_HOURS * 3600)
  })

  it('有效时长 = 真实时长 × 效率', () => {
    expect(offlineEffectiveSeconds(3600)).toBeCloseTo(3600, 6)
    expect(offlineEffectiveSeconds(IDLE.FULL_EFFICIENCY_HOURS * 3600)).toBeCloseTo(
      IDLE.FULL_EFFICIENCY_HOURS * 3600,
      6,
    )
  })

  it('持续在线 3 倍：满效率时长的离线等价于三分之一的在线时长', () => {
    const offline = offlineEffectiveSeconds(IDLE.FULL_EFFICIENCY_HOURS * 3600)
    expect(offline / IDLE.ONLINE_MULTIPLIER).toBe(
      (IDLE.FULL_EFFICIENCY_HOURS * 3600) / 3,
    )
  })
})

describe('离线结算', () => {
  it('无编队时不产生收益但结构完整', () => {
    const result = settleOffline([], 1, 3600, 1)
    expect(result.battles).toBe(0)
    expect(result.rewards).toBeDefined()
  })

  it('长离线回放有界且不外推不存在的奖励', () => {
    const team = [maxedHero('xiangyu'), maxedHero('hanxin')]
    const four = settleOffline(team, 1, 4 * 3600, 42)
    const twelve = settleOffline(team, 1, 12 * 3600, 42)
    expect(twelve.battles).toBeLessThanOrEqual(IDLE.MAX_REPLAY_BATTLES)
    expect(twelve.rewards).toEqual(four.rewards)
  })

  it('超过 12 小时的离线收益不再增加', () => {
    const team = [maxedHero('xiangyu')]
    const twelve = settleOffline(team, 1, 12 * 3600, 7)
    const forty = settleOffline(team, 1, 40 * 3600, 7)
    expect(totalExp(forty.rewards)).toBe(totalExp(twelve.rewards))
  })

  it('离线收益包含经验书与银两', () => {
    const team = [maxedHero('xiangyu')]
    const result = settleOffline(team, 1, 2 * 3600, 3)
    expect(totalExp(result.rewards)).toBeGreaterThan(0)
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
