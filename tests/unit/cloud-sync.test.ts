/**
 * 服务端权威同步（presentation/stores/game.ts + 服务端）。
 *
 * 服务端权威后，「云端与本地择新」「推送冲突」这套客户端逻辑**整体退役**：
 * 存档只有一份，在服务端；本地那份只是缓存。
 *
 * 这里守的是新的同步语义：
 *   - 多设备一致：一端改了进度，另一端重新载入看到的是同一份
 *   - 槽位按账号隔离（本地缓存不串号）
 *   - 存量旧档只迁给**第一个**登录的账号（本地标记 + 服务端标记各拦一道）
 *   - 客户端**不再**整份上传存档（没有 PUT /api/save 这条路）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { startServerHarness, type ServerHarness } from './helpers/server-harness.ts'
import { readServerSave } from './helpers/server-save.ts'
import { registerAndLoad, TEST_PASSWORD } from './helpers/store-harness.ts'

/** 模拟存储：key = slot */
const mem = vi.hoisted(() => new Map<string, string>())
/** 模拟标记（存量迁移标记等） */
const flags = vi.hoisted(() => new Set<string>())

vi.mock('../../src/platform/storage.ts', async () => {
  // 用真实的 base64 导出/导入（服务端存档导入动作吃的就是这个格式）
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
      async export(data: never) {
        return exportSave(data)
      },
      async import(text: string) {
        return importSave(text)
      },
      async clear(slot: string) {
        mem.delete(slot)
      },
      async getFlag(key: string) {
        return flags.has(key)
      },
      async setFlag(key: string, value: boolean) {
        if (value) flags.add(key)
        else flags.delete(key)
      },
    },
  }
})

const { useGameStore } = await import('../../src/presentation/stores/game.ts')
const { useAccountStore } = await import('../../src/presentation/stores/account.ts')
const { createNewSave } = await import('../../src/core/save/schema.ts')
const { serialize } = await import('../../src/core/save/serialize.ts')

let harness: ServerHarness

beforeEach(async () => {
  mem.clear()
  flags.clear()
  setActivePinia(createPinia())
  harness = startServerHarness()
})

afterEach(async () => {
  await harness.close()
})

/** 造一份带版本时间戳的存档 */
function makeSave(savedAt: number, crystals = 100) {
  return {
    ...createNewSave(savedAt, 4242),
    savedAt,
    player: { ...createNewSave(savedAt, 4242).player, crystals },
  }
}

describe('槽位按账号隔离', () => {
  it('登录后使用账号 id 作为本地缓存槽位', async () => {
    const store = await registerAndLoad('sync_user')
    expect(store.slot).not.toBe('main')
    expect(store.slot).toMatch(/^\d+$/)
    expect(mem.has(store.slot)).toBe(true)
    expect(mem.has('main')).toBe(false)
  })

  it('换账号使用不同槽位，不串号', async () => {
    const store = await registerAndLoad('sync_user')
    const slotA = store.slot

    // 换账号
    store.invalidate()
    const account = useAccountStore()
    await account.register('sync_user2', TEST_PASSWORD)
    await store.load()

    expect(store.slot).not.toBe(slotA)
    // 新账号是全新的档，不是上一个账号的进度
    expect(store.save.player.crystals).toBe(3000)
  })
})

describe('多设备一致', () => {
  it('一端抽卡，另一端重新载入看到同样的进度', async () => {
    const store = await registerAndLoad('sync_user')
    await store.pull('standard', 10)
    expect(store.save.stats.totalPulls).toBe(10)

    // 模拟「另一台设备」：重新载入 → 拉服务端权威版本
    store.invalidate()
    await store.load()
    expect(store.save.stats.totalPulls).toBe(10)
    expect(store.save.gacha.history).toHaveLength(10)
    expect(store.save.player.crystals).toBe(0)
  })

  it('存档在服务端落库（本地缓存删掉也能恢复）', async () => {
    const store = await registerAndLoad('sync_user')
    await store.pull('standard', 10)

    // 清掉本地缓存（模拟换设备 / 清缓存）
    mem.clear()
    store.invalidate()
    await store.load()

    expect(store.save.stats.totalPulls).toBe(10)
    expect(store.save.gacha.history).toHaveLength(10)
  })
})

describe('在线租约心跳', () => {
  it('载入后可发送独立心跳且并发只提交一次', async () => {
    const store = await registerAndLoad('sync_user')
    const before = store.save.player.silver
    const realFetch = globalThis.fetch
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(r => { release = r })
    const started = new Promise<void>(r => { entered = r })
    let heartbeats = 0
    vi.stubGlobal('fetch', async (input: any, init: any) => {
      if (init?.body && JSON.parse(init.body).action?.type === 'idle.heartbeat') { heartbeats++; entered(); await gate }
      return realFetch(input, init)
    })
    const a = store.heartbeat()
    const b = store.heartbeat()
    await started
    release()
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(heartbeats).toBe(1)
    // ⚠ 心跳是「轻量心跳」：只续约租约，**不回传存档主体**
    //   → 客户端镜像不刷新（镜像里的 activeUntil 是旧值，属正常）。
    //   租约真的续上了要去**服务端**看（客户端不得自己改 save.*，铁律 #28）。
    const serverSave = readServerSave(harness.bundle.db, useAccountStore().user!.id)
    expect(serverSave.idle.activeUntil).toBeGreaterThan(Date.now())
    expect(store.save.player.silver).toBe(before)
    store.invalidate()
    expect(await store.heartbeat()).toBeNull()
  })
})

describe('恢复连接', () => {
  it('loaded=true断网后仍能独立拉权威档恢复并继续动作', async () => {
    const store = await registerAndLoad('sync_user')
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
    await store.pull('standard', 1)
    expect(store.offline).toBe(true)
    expect(store.loaded).toBe(true)
    vi.stubGlobal('fetch', realFetch)
    expect(await store.reconnect()).toBe(true)
    expect(store.offline).toBe(false)
    expect(useAccountStore().offline).toBe(false)
    expect(await store.pull('standard', 1)).not.toBeNull()
  })

  it('换号后旧load响应不能覆盖新账号镜像', async () => {
    const store = await registerAndLoad('sync_user')
    await store.pull('standard', 10)
    const realFetch = globalThis.fetch
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(r => { release = r })
    const started = new Promise<void>(r => { entered = r })
    let delayed = false
    vi.stubGlobal('fetch', async (input: any, init: any) => {
      const response = await realFetch(input, init)
      if (String(input).endsWith('/api/save') && !delayed) { delayed = true; entered(); await gate }
      return response
    })
    const pending = store.load()
    await started
    store.invalidate()
    await useAccountStore().register('sync_other', TEST_PASSWORD)
    await store.load()
    const ownerSlot = store.slot
    release()
    await pending
    expect(store.slot).toBe(ownerSlot)
    expect(store.save.player.crystals).toBe(3000)
    expect(store.loaded).toBe(true)
  })

  it('换号后旧动作响应不能写入新账号缓存', async () => {
    const store = await registerAndLoad('sync_user')
    const realFetch = globalThis.fetch
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(r => { release = r })
    const started = new Promise<void>(r => { entered = r })
    vi.stubGlobal('fetch', async (input: any, init: any) => {
      const response = await realFetch(input, init)
      if (init?.body && JSON.parse(init.body).action?.type === 'gacha.pull') { entered(); await gate }
      return response
    })
    const pending = store.pull('standard', 1)
    await started
    store.invalidate()
    await useAccountStore().register('sync_other', TEST_PASSWORD)
    release()
    expect(await pending).toBeNull()
    await store.load()
    expect(store.save.stats.totalPulls).toBe(0)
  })

  it('并发恢复只拉一次，换号后旧恢复响应不能污染', async () => {
    const store = await registerAndLoad('sync_user')
    store.offline = true
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const realFetch = globalThis.fetch
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let pulls = 0
    vi.stubGlobal('fetch', async (input: any, init: any) => {
      if (String(input).endsWith('/api/save')) { pulls++; entered(); await gate }
      return realFetch(input, init)
    })
    const a = store.reconnect()
    const b = store.reconnect()
    await started
    store.invalidate()
    await useAccountStore().register('sync_other', TEST_PASSWORD)
    release()
    expect(await a).toBe(false)
    expect(await b).toBe(false)
    expect(pulls).toBe(1)
    expect(store.loaded).toBe(false)
    expect(mem.has(store.slot)).toBe(false)
  })
})

describe('存量单槽位迁移', () => {
  it('迁移失败保留旧档和资格，不静默建新档', async () => {
    const broken = makeSave(1000)
    broken.player.crystals = -1
    mem.set('main', serialize(broken))
    const store = await registerAndLoad('sync_user')
    expect(flags.has('sgw.legacyMigrated')).toBe(false)
    expect(await useAccountStore().pullCloudSave()).toBeNull()
    expect(store.loaded).toBe(false)
    expect(mem.has('main')).toBe(true)
  })

  it('本地标记写失败仍保留已确认云档与旧档', async () => {
    mem.set('main', serialize(makeSave(1000, 1234)))
    const { storage } = await import('../../src/platform/storage.ts')
    const flag = vi.spyOn(storage, 'setFlag').mockRejectedValueOnce(new Error('storage full'))
    const store = await registerAndLoad('sync_user')
    expect(store.loaded).toBe(true)
    expect(store.save.player.crystals).toBe(1234)
    expect(await useAccountStore().pullCloudSave()).not.toBeNull()
    expect(mem.has('main')).toBe(true)
    flag.mockRestore()
  })

  it('迁移响应丢失先拉云档确认，不建新档且保留旧档', async () => {
    mem.set('main', serialize(makeSave(1000, 1234)))
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: any, init: any) => {
      const response = await realFetch(input, init)
      if (init?.body && JSON.parse(init.body).action?.type === 'save.import') throw new TypeError('response lost')
      return response
    })
    const store = await registerAndLoad('sync_user')
    expect(store.save.player.crystals).toBe(1234)
    expect(store.loaded).toBe(true)
    expect(flags.has('sgw.legacyMigrated')).toBe(true)
    expect(mem.has('main')).toBe(true)
  })

  it('旧档迁入第一个登录的账号', async () => {
    mem.set('main', serialize(makeSave(1000, 1234)))
    const store = await registerAndLoad('sync_user')
    expect(store.save.player.crystals).toBe(1234)
    expect(store.slot).not.toBe('main')
    expect(flags.has('sgw.legacyMigrated')).toBe(true)
  })

  it('旧档不会迁给第二个账号', async () => {
    mem.set('main', serialize(makeSave(1000, 1234)))
    const store = await registerAndLoad('sync_user')
    expect(store.save.player.crystals).toBe(1234)

    // 换第二个账号
    store.invalidate()
    const account = useAccountStore()
    await account.register('sync_user2', TEST_PASSWORD)
    await store.load()
    expect(store.save.player.crystals).not.toBe(1234)
  })
})
