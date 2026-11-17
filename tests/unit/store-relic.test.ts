/**
 * 遗物获取链路（真实链路回归）。
 *
 * ⚠ 历史 bug：core 的 `rollRewards` 只把遗物放进**独立数组** `relics`，
 *   `rewards.relics` 从未被赋值；而 store 的 `applyRewards` **只读 rewards**
 *   → 挂机 / 离线结算产出的遗物 100% 被丢弃，玩家一个遗物都拿不到
 *   （整条遗物养成线是死的：强化石能掉但没东西可强化、套装效果永不触发）。
 *
 * 本文件守的是「玩家**真的**能拿到遗物」，不是「配置齐全」——
 * 同 AGENTS.md 铁律 #22 的教训：养成链路的「配置齐全」≠「功能可用」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/** 模拟存储：key = slot，value = 序列化后的存档 */
const mem = vi.hoisted(() => new Map<string, string>())

vi.mock('../../src/platform/storage.ts', () => ({
  storage: {
    async load(slot: string) {
      const text = mem.get(slot)
      return text ? JSON.parse(text) : null
    },
    async save(slot: string, data: unknown) {
      mem.set(slot, JSON.stringify(data))
    },
    async export(data: unknown) {
      return JSON.stringify(data)
    },
    async import(text: string) {
      return JSON.parse(text)
    },
    async clear(slot: string) {
      mem.delete(slot)
    },
  },
}))

const { useGameStore } = await import('../../src/presentation/stores/game.ts')
const { createHeroState } = await import('../../src/core/systems/growth.ts')

const SLOT = 'main'

describe('遗物获取链路', () => {
  beforeEach(async () => {
    mem.clear()
    setActivePinia(createPinia())
    const store = useGameStore()
    await store.load()
    // 造一支能打过第 1 关的队伍（等级/星级够就行，遗物仓库本来就是空的）
    store.save.heroes['xiangyu'] = {
      ...createHeroState('xiangyu', 0),
      level: 240,
      star: 6,
      skillLevels: [20, 20, 20],
    }
    store.save.team.slots[0] = 'xiangyu'
  })

  it('挂机一场：遗物真的进了仓库（不是被丢弃）', async () => {
    const store = useGameStore()
    const before = store.save.relics.length

    const result = await store.tickIdle(1)
    expect(result).not.toBeNull()
    // core 产出的遗物清单
    const dropped = result!.rewards.relics?.length ?? 0
    expect(dropped).toBeGreaterThan(0)

    // 表现层真的把它们入库了
    expect(store.save.relics.length).toBe(before + dropped)
  })

  it('入库的遗物实例结构完整（defId / uid / 等级齐全，能被强化与装备）', async () => {
    const store = useGameStore()
    await store.tickIdle(2)

    const relic = store.save.relics[0]
    expect(relic).toBeDefined()
    expect(relic.defId).toBeTruthy()
    expect(relic.uid).toBeTruthy()
    expect(relic.level).toBeGreaterThanOrEqual(1)
  })

  it('多场挂机：遗物逐场累加（不是只剩最后一场的）', async () => {
    const store = useGameStore()
    await store.tickIdle(1)
    const one = store.save.relics.length
    await store.tickIdle(3)
    expect(store.save.relics.length).toBe(one + 3)
  })

  it('遗物也落盘（刷新页面不会丢）', async () => {
    const store = useGameStore()
    await store.tickIdle(1)
    const inSave = store.save.relics.length
    expect(inSave).toBeGreaterThan(0)

    const stored = JSON.parse(mem.get(SLOT) ?? '{}') as { relics?: unknown[] }
    expect(stored.relics?.length ?? 0).toBe(inSave)
  })

  it('离线结算同样产出遗物', async () => {
    const store = useGameStore()
    // 伪造「离开很久」：把 lastTickAt 往前推 2 小时
    store.save.lastTickAt = store.save.lastTickAt - 2 * 3600 * 1000

    const result = await store.claimOffline()
    expect(result).not.toBeNull()
    expect(result!.rewards.relics?.length ?? 0).toBeGreaterThan(0)
    expect(store.save.relics.length).toBeGreaterThan(0)
  })
})
