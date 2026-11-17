/**
 * 遗物获取链路（真实链路回归：store → 服务端 → core）。
 *
 * ⚠ 历史 bug：core 的 `rollRewards` 只把遗物放进**独立数组** `relics`，
 *   `rewards.relics` 从未被赋值；而 store 的 `applyRewards` **只读 rewards**
 *   → 挂机 / 离线结算产出的遗物 100% 被丢弃，玩家一个遗物都拿不到
 *   （整条遗物养成线是死的：强化石能掉但没东西可强化、套装效果永不触发）。
 *
 * 本文件守的是「玩家**真的**能拿到遗物」，不是「配置齐全」——
 * 同 AGENTS.md 铁律 #22 的教训：养成链路的「配置齐全」≠「功能可用」。
 *
 * ⚠ 服务端权威后，遗物是**服务端**掉的、本地只是镜像：
 *   所以这里跑的是真实链路（真实后端 + 真实 core），不是客户端自算。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { startServerHarness, type ServerHarness } from './helpers/server-harness.ts'
import { registerAndLoad, seedSave } from './helpers/store-harness.ts'

/** 模拟存储：key = slot，value = 序列化后的存档（本地只读缓存） */
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
    async getFlag() {
      return false
    },
    async setFlag() {
      /* noop */
    },
  },
}))

const { useGameStore } = await import('../../src/presentation/stores/game.ts')
const { createHeroState } = await import('../../src/core/systems/growth.ts')
const { generateRelic, getRelicMods, relicUpgradeCost } = await import('../../src/core/systems/relic.ts')
const { getEquippedRelics } = await import('../../src/core/systems/loadout.ts')
const { Rng } = await import('../../src/core/rng.ts')

/** 强化一级的花费（与 core 的 relicUpgradeCost 同一口径，不在测试里写死数字） */
const RELIC_UPGRADE = relicUpgradeCost(1)!

let harness: ServerHarness

beforeEach(async () => {
  mem.clear()
  setActivePinia(createPinia())
  harness = startServerHarness()
})

afterEach(async () => {
  await harness.close()
})

/** 缓存槽位：登录后按账号 id 分槽位 */
function cached(): { relics?: unknown[] } {
  const key = [...mem.keys()].find((k) => k !== 'main')
  return JSON.parse(mem.get(key ?? '') ?? '{}') as { relics?: unknown[] }
}

describe('遗物获取链路', () => {
  beforeEach(async () => {
    await registerAndLoad('relic_user')
  })

  it('挂机一场：遗物真的进了仓库（不是被丢弃）', async () => {
    const store = useGameStore()
    await seedSave()
    const before = store.save.relics.length

    const result = await store.tickIdle(1)
    expect(result).not.toBeNull()
    // core 产出的遗物清单
    const dropped = result!.rewards.relics?.length ?? 0
    expect(dropped).toBeGreaterThan(0)

    // 服务端入库后，镜像里确实多了
    expect(store.save.relics.length).toBe(before + dropped)
  })

  it('入库的遗物实例结构完整（defId / uid / 等级齐全，能被强化与装备）', async () => {
    const store = useGameStore()
    await seedSave()
    await store.tickIdle(2)

    const relic = store.save.relics[0]
    expect(relic).toBeDefined()
    expect(relic.defId).toBeTruthy()
    expect(relic.uid).toBeTruthy()
    expect(relic.level).toBeGreaterThanOrEqual(1)
  })

  it('多场挂机：遗物逐场累加（不是只剩最后一场的）', async () => {
    const store = useGameStore()
    await seedSave()
    await store.tickIdle(1)
    const one = store.save.relics.length
    await store.tickIdle(3)
    expect(store.save.relics.length).toBe(one + 3)
  })

  it('遗物也进了本地缓存（断网时还能看到最近进度）', async () => {
    const store = useGameStore()
    await seedSave()
    await store.tickIdle(1)
    const inSave = store.save.relics.length
    expect(inSave).toBeGreaterThan(0)

    expect(cached().relics?.length ?? 0).toBe(inSave)
  })

  it('离线结算同样产出遗物（服务端按自己的时间补算）', async () => {
    const store = useGameStore()
    // 造一份「离开两小时」的存档
    await seedSave((save) => {
      save.lastTickAt = Date.now() - 2 * 3600 * 1000
    })

    await store.claimOffline()
    expect(store.offlineReport).not.toBeNull()
    expect(store.offlineReport!.rewards.relics?.length ?? 0).toBeGreaterThan(0)
    expect(store.save.relics.length).toBeGreaterThan(0)
  })
})

/**
 * 遗物强化（真实链路：store → 服务端 → core）。
 *
 * ⚠ 玩家反馈「遗物现在好像不能强化升级」。根因**不在** core 的强化逻辑
 *   （`applyRelicUpgrade` / `relicUpgradeCost` 一直是对的），
 *   而在**界面**：铸造页（遗物仓库）**根本没有强化按钮**，
 *   唯一入口藏在英灵页、且要求遗物**已经装备**——
 *   仓库里躺着的一堆遗物一件都强化不了。
 *
 * 这里守的是「点了强化，资源真的扣了、等级真的涨了、落盘没丢」。
 */
describe('遗物强化', () => {
  beforeEach(async () => {
    await registerAndLoad('relic_user')
  })

  it('强化真的 +1：等级涨、银两与强化石被扣、缓存已更新', async () => {
    const store = useGameStore()
    const rng = new Rng(2024)
    const relic = generateRelic('set_zhanshen_1', rng, 1)
    await seedSave((save) => {
      save.relics = [relic]
    })
    const silver0 = store.save.player.silver
    const stones0 = store.save.player.relicStones

    await store.upgradeRelic(relic.uid)

    expect(store.save.relics[0].level).toBe(2)
    expect(store.save.player.silver).toBe(silver0 - RELIC_UPGRADE.silver)
    expect(store.save.player.relicStones).toBe(stones0 - RELIC_UPGRADE.stones)

    // 缓存里也是强化后的版本
    const cachedRelic = (cached().relics as Array<{ level: number }> | undefined)?.[0]
    expect(cachedRelic?.level).toBe(2)
  })

  it('资源不足时拒绝强化：不扣资源、等级不变', async () => {
    const store = useGameStore()
    const rng = new Rng(2024)
    const relic = generateRelic('set_zhanshen_1', rng, 1)
    await seedSave((save) => {
      save.relics = [relic]
      save.player.silver = 0
      save.player.relicStones = 0
    })

    await store.upgradeRelic(relic.uid)

    expect(store.save.relics[0].level).toBe(1)
    expect(store.save.player.silver).toBe(0)
    expect(store.save.player.relicStones).toBe(0)
  })

  it('强化会真的提升属性（主词条随等级缩放）', async () => {
    const store = useGameStore()
    const rng = new Rng(2024)
    const relic = generateRelic('set_zhanshen_1', rng, 1)
    await seedSave((save) => {
      save.relics = [relic]
    })
    const before = getRelicMods(store.save.relics[0]).map((m) => m.value)

    await store.upgradeRelic(relic.uid)
    const after = getRelicMods(store.save.relics[0]).map((m) => m.value)

    // 主词条变大，副词条不变 → 至少有一条变大
    expect(after.some((v, i) => v > before[i])).toBe(true)
  })
})

/**
 * 一键推荐装备（真实链路）。
 *
 * ⚠ 守的是「点了按钮之后遗物真的穿上了、战力真的涨了」，
 *   不是「core 里有个推荐函数」——同 AGENTS.md 铁律 #22 的教训。
 */
describe('遗物一键推荐装备', () => {
  beforeEach(async () => {
    await registerAndLoad('relic_user')
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
    await seedSave((save) => {
      save.relics = pool.map((id) => generateRelic(id, rng, 60))
    })

    const before = store.relicAdvice('xiangyu')
    expect(before).not.toBeNull()
    expect(before!.currentPower).toBeGreaterThan(0)

    const advice = await store.autoEquipRelics('xiangyu')
    expect(advice).not.toBeNull()
    expect(advice!.gain).toBeGreaterThan(0)

    // 6 个槽位真的穿上了
    const equipped = getEquippedRelics(store.save, 'xiangyu').filter(Boolean)
    expect(equipped).toHaveLength(6)

    // 战力确实涨了（重新取属性，与推荐算的是同一套口径）
    const after = store.relicAdvice('xiangyu')
    expect(after!.currentPower).toBeGreaterThanOrEqual(before!.currentPower)
  })

  it('一键推荐不抢其他英灵身上的遗物', async () => {
    const store = useGameStore()
    const rng = new Rng(99)
    const relics = [
      generateRelic('set_zhanshen_1', rng, 60),
      generateRelic('set_zhanshen_2', rng, 60),
      generateRelic('set_zhanshen_3', rng, 60),
      generateRelic('set_zhanshen_4', rng, 60),
      generateRelic('set_tanpo_1', rng, 60),
    ]
    await seedSave((save) => {
      save.heroes['hanxin'] = { ...createHeroState('hanxin', 0), level: 60 }
      save.relics = relics
      // 先给 hanxin 穿上 4 件战神套
      save.equipped['hanxin#0'] = { heroId: 'hanxin', relicId: relics[0].uid }
      save.equipped['hanxin#1'] = { heroId: 'hanxin', relicId: relics[1].uid }
      save.equipped['hanxin#2'] = { heroId: 'hanxin', relicId: relics[2].uid }
      save.equipped['hanxin#3'] = { heroId: 'hanxin', relicId: relics[3].uid }
    })

    await store.autoEquipRelics('xiangyu')

    // xiangyu 身上只能出现没被 hanxin 占用的那件
    const mine = getEquippedRelics(store.save, 'xiangyu').filter(Boolean).map((r) => r!.uid)
    expect(mine).toEqual([relics[4].uid])
    // hanxin 的 4 件没被抢走
    expect(getEquippedRelics(store.save, 'hanxin').filter(Boolean)).toHaveLength(4)
  })

  it('仓库为空时一键推荐不报错、不动装备', async () => {
    const store = useGameStore()
    await seedSave((save) => {
      save.relics = []
    })
    const advice = await store.autoEquipRelics('xiangyu')
    expect(advice).not.toBeNull()
    expect(advice!.gain).toBe(0)
    expect(getEquippedRelics(store.save, 'xiangyu').filter(Boolean)).toHaveLength(0)
  })
})
