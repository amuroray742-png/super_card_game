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
const { generateRelic } = await import('../../src/core/systems/relic.ts')
const { getEquippedRelics } = await import('../../src/core/systems/loadout.ts')
const { Rng } = await import('../../src/core/rng.ts')

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

/**
 * 一键推荐装备（真实 store 链路）。
 *
 * ⚠ 守的是「点了按钮之后遗物真的穿上了、战力真的涨了」，
 *   不是「core 里有个推荐函数」——同 AGENTS.md 铁律 #22 的教训。
 */
describe('遗物一键推荐装备', () => {
  beforeEach(async () => {
    mem.clear()
    setActivePinia(createPinia())
    const store = useGameStore()
    await store.load()
    store.save.heroes['xiangyu'] = {
      ...createHeroState('xiangyu', 0),
      level: 240,
      star: 6,
      skillLevels: [20, 20, 20],
    }
    store.save.team.slots[0] = 'xiangyu'
  })

  it('一键推荐：6 个槽位被填上，战力不低于之前', async () => {
    const store = useGameStore()
    // 造 8 件遗物：4 件战神套 + 4 件探破套
    const rng = new Rng(424242)
    const pool = [
      'set_zhanshen_1',
      'set_zhanshen_2',
      'set_zhanshen_3',
      'set_zhanshen_4',
      'set_tanpo_1',
      'set_tanpo_2',
      'set_tanpo_3',
      'set_tanpo_4',
    ]
    store.save.relics = pool.map((id) => generateRelic(id, rng, 60))

    const before = store.relicAdvice('xiangyu')
    expect(before).not.toBeNull()
    expect(before!.currentPower).toBeGreaterThan(0)

    const advice = await store.autoEquipRelics('xiangyu')
    expect(advice).not.toBeNull()
    expect(advice!.gain).toBeGreaterThan(0)

    // 6 个槽位真的穿上了
    const equipped = getEquippedRelics(store.save, 'xiangyu')
    expect(equipped.filter(Boolean)).toHaveLength(6)

    // 战力确实涨了（重新取属性，与推荐算的是同一套口径）
    const after = store.relicAdvice('xiangyu')
    expect(after!.currentPower).toBeGreaterThanOrEqual(before!.currentPower)
  })

  it('一键推荐不抢其他英灵身上的遗物', async () => {
    const store = useGameStore()
    const rng = new Rng(99)
    store.save.heroes['hanxin'] = { ...createHeroState('hanxin', 0), level: 60 }
    store.save.relics = [
      generateRelic('set_zhanshen_1', rng, 60),
      generateRelic('set_zhanshen_2', rng, 60),
      generateRelic('set_zhanshen_3', rng, 60),
      generateRelic('set_zhanshen_4', rng, 60),
      generateRelic('set_tanpo_1', rng, 60),
    ]
    // 先给 hanxin 穿上 4 件战神套
    store.save.equipped['hanxin#0'] = { heroId: 'hanxin', relicId: store.save.relics[0].uid }
    store.save.equipped['hanxin#1'] = { heroId: 'hanxin', relicId: store.save.relics[1].uid }
    store.save.equipped['hanxin#2'] = { heroId: 'hanxin', relicId: store.save.relics[2].uid }
    store.save.equipped['hanxin#3'] = { heroId: 'hanxin', relicId: store.save.relics[3].uid }

    await store.autoEquipRelics('xiangyu')

    // xiangyu 身上只能出现没被 hanxin 占用的那件
    const mine = getEquippedRelics(store.save, 'xiangyu').filter(Boolean).map((r) => r!.uid)
    expect(mine).toEqual([store.save.relics[4].uid])
    // hanxin 的 4 件没被抢走
    expect(getEquippedRelics(store.save, 'hanxin').filter(Boolean)).toHaveLength(4)
  })

  it('仓库为空时一键推荐不报错、不动装备', async () => {
    const store = useGameStore()
    store.save.relics = []
    const advice = await store.autoEquipRelics('xiangyu')
    expect(advice).not.toBeNull()
    expect(advice!.gain).toBe(0)
    expect(getEquippedRelics(store.save, 'xiangyu').filter(Boolean)).toHaveLength(0)
  })
})
