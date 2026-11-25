/**
 * 遗物获取链路（真实链路回归：store → 服务端 → core）。
 *
 * ⚠ 历史 bug：core 的掉落结算只把遗物放进**独立数组** `relics`，
 *   `rewards.relics` 从未被赋值；而 store 的 `applyRewards` **只读 rewards**
 *   → 挂机 / 离线结算产出的遗物 100% 被丢弃，玩家一个遗物都拿不到
 *   （整条遗物养成线是死的：强化石能掉但没东西可强化、套装效果永不触发）。
 *
 * ⚠ **遗物副本 v12**：遗物的**唯一来源**是**遗物副本**
 *   （`dungeon.challenge` → `rewards.relics`）；「花银两祈愿」（`relic.acquire`）已下线。
 *   ⇒ 本文件守的是：
 *     ① **主线**通道仍然**不**产出遗物（防止哪天又混回掉落表）；
 *     ② 遗物副本这条**唯一入口**真的能拿到遗物；
 *     ③ 遗物实例结构完整（能强化、能装备）、uid 唯一、仓库逐件累加；
 *     ④ 遗物是**零成本**产出（不扣银两），但**每日额度**只管挂机通道。
 *
 * 同 AGENTS.md 铁律 #22 的教训：养成链路的「配置齐全」≠「功能可用」。
 *
 * ⚠ 服务端权威后，遗物是**服务端**产出的、本地只是镜像：
 *   所以这里跑的是真实链路（真实后端 + 真实 core），不是客户端自算。
 *
 * ⚠ **存档分包**后，客户端镜像里**只有已装备遗物**（≤36 件）：
 *   仓库里的其它遗物走 `GET /api/relics` 分页接口。
 *   所以断言「仓库里有几件」必须问服务端，不能看镜像（铁律 #8 / #16）。
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
const { getRelicMods, relicUpgradeCost } = await import('../../src/core/systems/relic.ts')
const { makeTestRelic } = await import('./helpers.ts')
const { getEquippedRelics } = await import('../../src/core/systems/loadout.ts')
const { Rng } = await import('../../src/core/rng.ts')
const { dungeonStageId } = await import('../../src/core/config/dungeons.ts')

/** 强化一级的花费（与 core 的 relicUpgradeCost 同一口径，不在测试里写死数字） */
const RELIC_UPGRADE = relicUpgradeCost(1)!

/** 遗物副本「锋锐 · 简易」关卡 id（关卡 id 的唯一出处是 `dungeonStageId`） */
const RELIC_EASY = dungeonStageId('relicZhanTan', 'easy')

let harness: ServerHarness
let now: number
function advanceBattles(count: number) { now += count * 6_000 }

beforeEach(async () => {
  now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  mem.clear()
  setActivePinia(createPinia())
  harness = startServerHarness()
})

afterEach(async () => {
  await harness.close()
  vi.restoreAllMocks()
})

/** 缓存槽位：登录后按账号 id 分槽位 */
function cached(): { relics?: unknown[] } {
  const key = [...mem.keys()].find((k) => k !== 'main')
  return JSON.parse(mem.get(key ?? '') ?? '{}') as { relics?: unknown[] }
}

/**
 * 服务端仓库（分页接口）。
 *
 * ⚠ 客户端镜像里只有已装备遗物 → 「仓库里有几件」只能问服务端。
 */
async function serverRelics(): Promise<Array<{ uid: string; defId: string; level: number }>> {
  const store = useGameStore()
  const page = await store.loadRelicPage({ page: 1, size: 200 })
  return page?.items ?? []
}

/** 服务端仓库总件数（分页接口的 total） */
async function serverRelicTotal(): Promise<number> {
  const store = useGameStore()
  const page = await store.loadRelicPage({ page: 1, size: 1 })
  return page?.total ?? 0
}

describe('遗物获取链路（遗物副本：遗物的唯一来源）', () => {
  beforeEach(async () => {
    await registerAndLoad('relic_user')
  })

  /** 造一份「主线已通关第 1 关」的存档（遗物副本的解锁线） */
  async function seedRelicReady(): Promise<void> {
    await seedSave((save) => {
      save.campaign.clearedStage = 1
    })
  }

  it('⚠ **主线**通道**不再产出遗物**（掉落表只剩银两 + 经验书）', async () => {
    const store = useGameStore()
    await seedSave((save) => {
      // ⚠ 主线通道跟随最新通关关卡 ⇒ 先打通一关才有产出
      save.campaign.clearedStage = 1
    })
    const before = await serverRelicTotal()

    advanceBattles(3)
    const result = await store.tickIdle()
    expect(result).not.toBeNull()
    // 主线通道明细里的遗物清单**恒空**
    expect(result!.channels.every((c) => (c.rewards.relics?.length ?? 0) === 0)).toBe(true)
    // 仓库件数不变
    expect(await serverRelicTotal()).toBe(before)
  })

  it('打遗物副本：仓库真的多了一件', async () => {
    // ⚠ 铁律 #22：「配置齐全」≠「功能可用」。
    //   遗物是**整条强化链的入口**（初阶强化副本要求「持有 Lv1 遗物」才解锁），
    //   所以「打一把遗物副本 → 服务端仓库真的多了一件」必须被守住。
    const store = useGameStore()
    await seedRelicReady()
    const before = await serverRelicTotal()

    const res = await store.challengeDungeon(RELIC_EASY)
    expect(res).not.toBeNull()
    expect(res!.win).toBe(true)
    expect(res!.rewards.relics?.length).toBeGreaterThan(0)
    expect(await serverRelicTotal()).toBe(before + res!.rewards.relics!.length)
  })

  it('遗物副本产出的遗物实例结构完整（defId / uid / 等级齐全，能被强化与装备）', async () => {
    const store = useGameStore()
    await seedRelicReady()
    const res = await store.challengeDungeon(RELIC_EASY)
    expect(res).not.toBeNull()

    const relics = await serverRelics()
    expect(relics.length).toBeGreaterThan(0)
    const defId = res!.rewards.relics![0]
    const relic = relics.find((r) => r.defId === defId)
    expect(relic).toBeDefined()
    expect(relic!.uid).toBeTruthy()
    expect(relic!.level).toBeGreaterThanOrEqual(1)
  })

  it('⚠ 遗物是**零成本**产出（不扣银两），且手动挑战**不消耗每日额度**', async () => {
    // ⚠ 每日额度（`RELIC_DROP.DAILY_CAP`）是**挂机**的防通胀闸门：
    //   遗物零成本 ⇒ 挂机不限额就是印钞机；
    //   但手动挑战是**主动行为**（逐场结算、耗时换产出），不该被卡住。
    const store = useGameStore()
    await seedRelicReady()
    const silver0 = store.save.player.silver

    const res = await store.challengeDungeon(RELIC_EASY)
    expect(res).not.toBeNull()
    expect(res!.win).toBe(true)
    // 银两一分没少
    expect(store.save.player.silver).toBe(silver0)
    // 额度计数仍然是 0（额度只管挂机通道）
    expect(store.save.relicDaily.count).toBe(0)
  })

  it('多次挑战遗物副本：每件 uid 唯一，仓库逐件累加', async () => {
    const store = useGameStore()
    await seedRelicReady()
    const before = await serverRelicTotal()

    const uids: string[] = []
    for (let i = 0; i < 3; i++) {
      const res = await store.challengeDungeon(RELIC_EASY)
      expect(res).not.toBeNull()
      uids.push(...(res!.rewards.relics ?? []))
    }
    expect(await serverRelicTotal()).toBe(before + uids.length)
    const relics = await serverRelics()
    expect(new Set(relics.map((r) => r.uid)).size).toBe(relics.length)
  })

  it('仓库分页接口可用：分页取到的件数与总数对得上', async () => {
    const store = useGameStore()
    await seedRelicReady()
    for (let i = 0; i < 3; i++) await store.challengeDungeon(RELIC_EASY)

    const page = await store.loadRelicPage({ page: 1, size: 2 })
    expect(page).not.toBeNull()
    expect(page!.items.length).toBeLessThanOrEqual(2)
    expect(page!.total).toBeGreaterThanOrEqual(page!.items.length)
    expect(page!.pages).toBe(Math.max(1, Math.ceil(page!.total / page!.size)))
  })

  it('遗物统计接口给出仓库总数（顶栏件数与图鉴收藏数靠它）', async () => {
    const store = useGameStore()
    await seedRelicReady()
    await store.challengeDungeon(RELIC_EASY)
    await store.challengeDungeon(RELIC_EASY)

    const stats = await store.loadRelicStats()
    expect(stats).not.toBeNull()
    expect(stats!.total).toBe(await serverRelicTotal())
    expect(Object.keys(stats!.byDefId).length).toBeGreaterThan(0)
  })

  it('镜像只带已装备遗物（仓库不进镜像，首屏不会被几千件遗物撑爆）', async () => {
    const store = useGameStore()
    const rng = new Rng(7)
    await seedSave((save) => {
      save.relics = [
        makeTestRelic('set_zhanshen_1', rng, 1),
        makeTestRelic('set_zhanshen_2', rng, 1),
        makeTestRelic('set_zhanshen_3', rng, 1),
      ]
    })

    // 一件都没装备 → 镜像里的遗物数组是空的
    expect(store.save.relics).toHaveLength(0)
    // 但服务端仓库里确实有 3 件
    expect(await serverRelicTotal()).toBe(3)
  })

  it('⚠ 离线结算**主线通道同样不产出遗物**（服务端按自己的时间补算也不产出）', async () => {
    const store = useGameStore()
    await seedSave((save) => {
      save.campaign.clearedStage = 1
    })
    advanceBattles(10)

    await store.claimOffline()
    expect(store.offlineReport).not.toBeNull()
    expect(
      store.offlineReport!.channels.every((c) => (c.rewards.relics?.length ?? 0) === 0),
    ).toBe(true)
    expect(await serverRelicTotal()).toBe(0)
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
    const relic = makeTestRelic('set_zhanshen_1', rng, 1)
    await seedSave((save) => {
      save.relics = [relic]
    })
    const silver0 = store.save.player.silver
    const stones0 = store.save.items.relicStoneTier1

    await store.upgradeRelic(relic.uid)

    const upgraded = (await serverRelics()).find((r) => r.uid === relic.uid)
    expect(upgraded?.level).toBe(2)
    expect(store.save.player.silver).toBe(silver0 - RELIC_UPGRADE.silver)
    // ⚠ 资源/背包版本 v10：强化石按**档位**扣（Lv1 → Lv2 落在初阶）
    expect(store.save.items.relicStoneTier1).toBe(
      stones0 - (RELIC_UPGRADE.stones.relicStoneTier1 ?? 0),
    )
  })

  it('资源不足时拒绝强化：不扣资源、等级不变', async () => {
    const store = useGameStore()
    const rng = new Rng(2024)
    const relic = makeTestRelic('set_zhanshen_1', rng, 1)
    await seedSave((save) => {
      save.relics = [relic]
      save.player.silver = 0
      save.items.relicStoneTier1 = 0
    })

    await store.upgradeRelic(relic.uid)

    const unchanged = (await serverRelics()).find((r) => r.uid === relic.uid)
    expect(unchanged?.level).toBe(1)
    expect(store.save.player.silver).toBe(0)
    expect(store.save.items.relicStoneTier1).toBe(0)
  })

  it('强化会真的提升属性（主词条随等级缩放）', async () => {
    const store = useGameStore()
    const rng = new Rng(2024)
    const relic = makeTestRelic('set_zhanshen_1', rng, 1)
    await seedSave((save) => {
      save.relics = [relic]
    })
    const before = getRelicMods(relic).map((m) => m.value)

    await store.upgradeRelic(relic.uid)

    const upgraded = (await serverRelics()).find((r) => r.uid === relic.uid)
    expect(upgraded).toBeDefined()
    const after = getRelicMods({ ...relic, level: upgraded!.level }).map((m) => m.value)

    // 主词条变大，副词条不变 → 至少有一条变大
    expect(after.some((v, i) => v > before[i])).toBe(true)
  })
})

/**
 * 一键推荐装备（真实链路）。
 *
 * ⚠ 守的是「点了按钮之后遗物真的穿上了、战力真的涨了」，
 *   不是「core 里有个推荐函数」——同 AGENTS.md 铁律 #22 的教训。
 *
 * ⚠ 预览走**服务端**（`GET /api/relics/advice`）：分包后客户端镜像里
 *   只有已装备遗物，本地算不出「仓库里哪件更强」。
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
      save.relics = pool.map((id) => makeTestRelic(id, rng, 60))
    })

    const before = await store.fetchRelicAdvice('xiangyu')
    expect(before).not.toBeNull()
    expect(before!.currentPower).toBeGreaterThan(0)

    const advice = await store.autoEquipRelics('xiangyu')
    expect(advice).not.toBeNull()
    expect(advice!.gain).toBeGreaterThan(0)

    // 6 个槽位真的穿上了
    const equipped = getEquippedRelics(store.save, 'xiangyu').filter(Boolean)
    expect(equipped).toHaveLength(6)

    // 战力确实涨了（重新取属性，与推荐算的是同一套口径）
    const after = await store.fetchRelicAdvice('xiangyu')
    expect(after!.currentPower).toBeGreaterThanOrEqual(before!.currentPower)
  })

  it('一键推荐不抢其他英灵身上的遗物', async () => {
    const store = useGameStore()
    const rng = new Rng(99)
    const relics = [
      makeTestRelic('set_zhanshen_1', rng, 60),
      makeTestRelic('set_zhanshen_2', rng, 60),
      makeTestRelic('set_zhanshen_3', rng, 60),
      makeTestRelic('set_zhanshen_4', rng, 60),
      makeTestRelic('set_tanpo_1', rng, 60),
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

/**
 * 批量操作与锁定（真实链路）。
 *
 * ⚠ 守的是「批量走服务端权威动作」——覆盖已装备、锁定与重复提交
 *   （roadmap P1-1 验收条件）。
 */
describe('遗物批量操作与锁定', () => {
  beforeEach(async () => {
    await registerAndLoad('relic_user')
  })

  it('锁定：锁定件不被批量分解，且锁定状态真的落库', async () => {
    const store = useGameStore()
    const rng = new Rng(31337)
    const relics = [
      makeTestRelic('set_zhanshen_1', rng, 1),
      makeTestRelic('set_zhanshen_2', rng, 1),
    ]
    await seedSave((save) => {
      save.relics = relics
    })

    await store.lockRelic(relics[0].uid, true)
    const locked = (await serverRelics()).find((r) => r.uid === relics[0].uid)
    expect(locked).toBeDefined()

    const res = await store.decomposeRelics([relics[0].uid, relics[1].uid])
    expect(res).not.toBeNull()
    expect(res!.decomposed).toBe(1)
    expect(res!.skipped).toEqual([relics[0].uid])

    const left = await serverRelics()
    expect(left.map((r) => r.uid)).toEqual([relics[0].uid])
  })

  it('批量分解：全部拆掉，银两与强化石按同一口径返还', async () => {
    const store = useGameStore()
    const rng = new Rng(4242)
    const relics = [
      makeTestRelic('set_zhanshen_1', rng, 3),
      makeTestRelic('set_zhanshen_2', rng, 3),
      makeTestRelic('set_zhanshen_3', rng, 3),
    ]
    await seedSave((save) => {
      save.relics = relics
    })
    const silver0 = store.save.player.silver

    const res = await store.decomposeRelics(relics.map((r) => r.uid))
    expect(res).not.toBeNull()
    expect(res!.decomposed).toBe(3)
    expect(await serverRelicTotal()).toBe(0)
    expect(store.save.player.silver).toBe(silver0 + res!.silver)
  })

  it('重复提交的 uid 只处理一次', async () => {
    const store = useGameStore()
    const rng = new Rng(777)
    const relic = makeTestRelic('set_zhanshen_1', rng, 1)
    await seedSave((save) => {
      save.relics = [relic]
    })

    const res = await store.decomposeRelics([relic.uid, relic.uid, relic.uid])
    expect(res).not.toBeNull()
    expect(res!.decomposed).toBe(1)
    expect(await serverRelicTotal()).toBe(0)
  })

  it('已装备的遗物批量分解时先卸下（装备关系不留悬空引用）', async () => {
    const store = useGameStore()
    const rng = new Rng(8888)
    const relic = makeTestRelic('set_zhanshen_1', rng, 1)
    await seedSave((save) => {
      save.relics = [relic]
      save.equipped['xiangyu#0'] = { heroId: 'xiangyu', relicId: relic.uid }
    })

    const res = await store.decomposeRelics([relic.uid])
    expect(res).not.toBeNull()
    expect(res!.unequipped).toBe(1)
    expect(getEquippedRelics(store.save, 'xiangyu').filter(Boolean)).toHaveLength(0)
  })

  it('批量强化：资源不够就整批拒绝（一件都不强化）', async () => {
    const store = useGameStore()
    const rng = new Rng(9999)
    const relics = [
      makeTestRelic('set_zhanshen_1', rng, 1),
      makeTestRelic('set_zhanshen_2', rng, 1),
    ]
    await seedSave((save) => {
      save.relics = relics
      save.player.silver = 0
      // ⚠ 资源/背包版本 v10：强化石不再是 `player.relicStones`，
      //   而是背包里的**分档道具**（目标等级落在哪一档就扣哪一档）。
      for (const id of Object.keys(save.items)) save.items[id as keyof typeof save.items] = 0
    })

    const res = await store.upgradeRelics(relics.map((r) => r.uid))
    expect(res).toBeNull()
    const after = await serverRelics()
    expect(after.every((r) => r.level === 1)).toBe(true)
  })

  it('一键分解：只清未锁定、未装备的低等级件', async () => {
    const store = useGameStore()
    const rng = new Rng(1212)
    const junk = makeTestRelic('set_zhanshen_1', rng, 1)
    const kept = makeTestRelic('set_zhanshen_2', rng, 60)
    const locked = makeTestRelic('set_zhanshen_3', rng, 1)
    await seedSave((save) => {
      save.relics = [junk, kept, locked]
      save.equipped['xiangyu#0'] = { heroId: 'xiangyu', relicId: kept.uid }
    })
    await store.lockRelic(locked.uid, true)

    const res = await store.decomposeByFilter({ maxLevel: 1 })
    expect(res).not.toBeNull()
    expect(res!.decomposed).toBe(1)
    const left = (await serverRelics()).map((r) => r.uid)
    expect(left.sort()).toEqual([kept.uid, locked.uid].sort())
  })
})
