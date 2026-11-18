/**
 * store 的服务端权威语义（presentation/stores/game.ts）。
 *
 * 服务端权威后，客户端不再是「算完再存」，而是：
 *   - 发意图 → 服务端算 → 落库 → 回传存档 → 客户端覆盖本地镜像
 *   - localStorage 里的存档降级为**只读缓存**（首屏加速 / 断网查看）
 *
 * 这里守的正是这几条新语义：
 *   - 存档归属服务端（本地缓存被改也会被服务端版本覆盖）
 *   - 动作失败 → 存档一字节未变
 *   - 重置 → 服务端换新档
 *   - 服务端不可达 → 离线只读，操作被拒绝
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { BATTLE, REBIRTH } from '../../src/core/config/economy.ts'
import { getStage } from '../../src/core/config/stages.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { startServerHarness, type ServerHarness } from './helpers/server-harness.ts'
import { registerAndLoad, seedSave } from './helpers/store-harness.ts'

/** 模拟存储：key = slot，value = 序列化后的存档（只读缓存） */
const mem = vi.hoisted(() => new Map<string, string>())
/** 模拟存储的标记位（如 `legacyMigrated`） */
const flags = vi.hoisted(() => new Map<string, string>())

vi.mock('../../src/platform/storage.ts', async () => {
  // 用真实的导出/导入实现（base64 存档串）——
  // 服务端解的是同一个格式，mock 自己另编一套会解不开。
  const { exportSave, importSave } = await import('../../src/core/save/serialize.ts')
  return {
    storage: {
      async load(slot: string) {
        const text = mem.get(slot)
        return text ? JSON.parse(text) : null
      },
      async save(slot: string, data: unknown) {
        mem.set(slot, JSON.stringify(data))
      },
      async export(data: unknown) {
        return exportSave(data as never)
      },
      async import(text: string) {
        return importSave(text)
      },
      async clear(slot: string) {
        mem.delete(slot)
      },
      async getFlag(key: string) {
        return flags.get(key) === '1'
      },
      async setFlag(key: string, value: boolean) {
        if (value) flags.set(key, '1')
        else flags.delete(key)
      },
    },
  }
})

const { useGameStore } = await import('../../src/presentation/stores/game.ts')

let harness: ServerHarness

beforeEach(async () => {
  mem.clear()
  flags.clear()
  setActivePinia(createPinia())
  harness = startServerHarness()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await harness.close()
})

/** 账号缓存槽位（登录后按账号 id 分槽位） */
function cachedSlot(): string {
  return [...mem.keys()].find((k) => k !== 'main') ?? ''
}

function cached(): Record<string, never> {
  return JSON.parse(mem.get(cachedSlot()) ?? '{}') as Record<string, never>
}

describe('服务端权威：载入', () => {
  it('首次载入：服务端建档，本地缓存也落一份', async () => {
    const store = await registerAndLoad('saver')
    expect(store.loaded).toBe(true)
    expect(store.offline).toBe(false)
    expect(store.save.player.crystals).toBe(3000)
    // 本地缓存里也有同一份（首屏加速用）
    expect(cachedSlot()).not.toBe('')
    expect((cached() as { player?: { crystals: number } }).player?.crystals).toBe(3000)
  })

  it('十连：服务端扣费 + 记录 10 条历史（镜像可见）', async () => {
    const store = await registerAndLoad('saver')
    const summary = await store.pull('standard', 10)
    expect(summary).not.toBeNull()
    expect(store.save.player.crystals).toBe(0)
    expect(store.save.gacha.history).toHaveLength(10)
    expect(store.save.stats.totalPulls).toBe(10)
    expect(store.save.gacha.newbieUsed).toBe(true)
  })
})

describe('服务端权威：本地缓存不是权威', () => {
  it('本地缓存被别的标签页改过 → 下一次响应以服务端为准', async () => {
    const store = await registerAndLoad('saver')
    await store.pull('standard', 10)

    // 模拟「另一个标签页」把本地缓存改了（缓存不是权威，改了也没用）
    const raw = JSON.parse(mem.get(cachedSlot()) ?? '{}') as { player: { crystals: number } }
    raw.player.crystals = 777
    mem.set(cachedSlot(), JSON.stringify(raw))

    // 随便做一次动作 → 服务端版本覆盖镜像
    await store.signInDaily()
    expect(store.save.player.crystals).not.toBe(777)
    expect(store.save.gacha.history).toHaveLength(10)
  })
})

describe('编队战力', () => {
  it('永久加成让页面战力与挂机一起达到下一关门槛，竞技快照保持一致', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const store = await registerAndLoad('team_power')
    const hero = createHeroState('xiangyu', now)
    const nextStage = getStage(2)
    await seedSave((save) => { save.heroes[hero.id] = hero })

    expect(store.teamPower).toBeLessThan(nextStage.powerRequired)
    const arenaHash = store.arenaHash
    now += BATTLE.SECONDS_PER_BATTLE * 1000
    expect(await store.tickIdle(1)).toMatchObject({ lastClearedStage: 1, nextTargetStage: 1 })

    await seedSave((save) => {
      save.heroes[hero.id] = hero
      save.player.permBoost = REBIRTH.PERM_BOOST_CAP
    })

    expect(store.teamPower).toBeGreaterThanOrEqual(nextStage.powerRequired)
    expect(store.arenaHash).toBe(arenaHash)
    now += BATTLE.SECONDS_PER_BATTLE * 1000
    expect(await store.tickIdle(1)).toMatchObject({ lastClearedStage: 1, nextTargetStage: nextStage.id })
  })
})

describe('服务端权威：失败即原子', () => {
  it('余额不足 → 动作失败，存档一字节未变', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    const store = await registerAndLoad('saver')
    await store.pull('standard', 10)
    await store.pull('standard', 10)

    // 固定服务端时钟，排除入口正常计量挂机时间；只检验失败动作原子性。
    const before = JSON.stringify(store.save)
    const res = await store.pull('standard', 10)
    expect(res).toBeNull()
    expect(JSON.stringify(store.save)).toBe(before)
  })
})

describe('服务端权威：重置与离线', () => {
  it('重置进度 → 服务端换一份新档（本地缓存也跟着换）', async () => {
    const store = await registerAndLoad('saver')
    await store.pull('standard', 10)
    expect(store.save.player.crystals).toBe(0)

    await store.reset()
    expect(store.save.player.crystals).toBe(3000)
    expect(store.save.gacha.history).toHaveLength(0)
    expect((cached() as { player?: { crystals: number } }).player?.crystals).toBe(3000)
  })

  it('服务端不可达 → 离线只读：动作被拒绝，进度不变', async () => {
    const store = await registerAndLoad('saver')
    await store.pull('standard', 10)
    const before = JSON.stringify(store.save)

    // 后端挂掉（用 fetch 抛错模拟「连不上」，不依赖真有端口在监听）
    await harness.close()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })

    const res = await store.pull('standard', 10)
    expect(res).toBeNull()
    expect(store.offline).toBe(true)
    expect(JSON.stringify(store.save)).toBe(before)
    expect(store.toast?.kind).toBe('warn')
  })

  it('服务端不可达时载入 → 进入离线模式，展示本地缓存', async () => {
    const store = await registerAndLoad('saver')
    await store.pull('standard', 10)
    const cachedPayload = mem.get(cachedSlot())

    await harness.close()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })

    // 模拟刷新页面：清掉已载入标记再重新载入（会话仍在）
    store.invalidate()
    await store.load()
    expect(store.offline).toBe(true)
    // 本地缓存里的进度还在（断网也能看到）
    expect(store.save.player.crystals).toBe(0)
    expect(cachedPayload).toBeTruthy()
  })
})

/**
 * 旧档迁移通道（存量单槽位 `sgw.save.main`）。
 *
 * ⚠ 这条通道历史上被**新版客户端自己写脏**过：未登录时（槽位还是
 *   存量单槽位）把一份刚建好的新档写进去 → 第一个账号登录时，
 *   这份新档被当成「旧档」导入服务端，还顺手占掉一次性迁移标记
 *   （`sgw.legacyMigrated`）→ 玩家**真正的旧档**从此再也迁不过来。
 *
 * 迁移契约本身（存量槽位里的内容迁给第一个账号、不迁给第二个）由
 * `cloud-sync.test.ts` 守。
 */
describe('旧档迁移通道', () => {
  it('未登录（登出）时 persist 不写任何存档槽位', async () => {
    const store = await registerAndLoad('saver')
    expect(cachedSlot()).not.toBe('')

    // 登出 → 回到存量单槽位
    store.invalidate()
    await store.persist()

    // 存量单槽位保持干净（迁移通道不能被新档污染）
    expect(mem.has('main')).toBe(false)
  })

  it('正常游玩也不会往存量单槽位写新档', async () => {
    const store = await registerAndLoad('saver')
    await store.pull('standard', 10)
    await store.signInDaily()
    expect(mem.has('main')).toBe(false)
  })
})
