/**
 * 云存档同步单测（presentation/stores/game.ts）。
 *
 * 覆盖：
 * - 存档槽位按账号隔离（换账号不串号）
 * - 云端与本地按时间戳择新（云端新 → 采纳云端；本地新 → 推上去）
 * - 存量单槽位 `main` 只迁给**第一个**登录的账号
 * - 推送冲突时采纳服务端版本
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/** 模拟存储：key = slot */
const mem = vi.hoisted(() => new Map<string, string>())
/** 模拟标记（存量迁移标记等） */
const flags = vi.hoisted(() => new Set<string>())

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
    async getFlag(key: string) {
      return flags.has(key)
    },
    async setFlag(key: string, value: boolean) {
      if (value) flags.add(key)
      else flags.delete(key)
    },
  },
}))

/** 可控的假后端 */
const fake = vi.hoisted(() => ({
  user: null as { id: number; username: string } | null,
  clouds: new Map<number, { payload: string; savedAt: number }>(),
  pushed: [] as { payload: string; savedAt: number }[],
  /** 非空时推送一律返回冲突，并回传该版本 */
  conflictWith: null as { payload: string; savedAt: number } | null,
}))

vi.mock('../../src/platform/account.ts', () => ({
  AccountError: class AccountError extends Error {},
  accountClient: {
    async refresh() {
      if (!fake.user) throw new Error('未登录')
      return {
        user: fake.user,
        accessToken: 'at',
        refreshToken: 'rt',
        expiresIn: 900,
      }
    },
    async pullSave() {
      return fake.clouds.get(fake.user?.id ?? 0) ?? null
    },
    async pushSave(_token: string, payload: string, savedAt: number) {
      fake.pushed.push({ payload, savedAt })
      if (fake.conflictWith) {
        return { ok: false as const, conflict: true as const, server: fake.conflictWith }
      }
      fake.clouds.set(fake.user?.id ?? 0, { payload, savedAt })
      return { ok: true as const, savedAt }
    },
  },
  readStoredSession: () => (fake.user ? { refreshToken: 'rt', user: fake.user } : null),
  writeStoredSession: () => {},
  clearStoredSession: () => {},
  resolveApiBase: () => 'http://127.0.0.1:0',
}))

const { useGameStore } = await import('../../src/presentation/stores/game.ts')
const { useAccountStore } = await import('../../src/presentation/stores/account.ts')

/** 造一份带版本时间戳的存档 */
function makeSave(savedAt: number, crystals = 100) {
  return {
    version: 4,
    savedAt,
    player: { crystals, tickets: 0, silver: 0 },
    gacha: { history: [], newbieUsed: false },
    stats: { totalPulls: 0 },
  }
}

async function loginAs(id: number) {
  fake.user = { id, username: `user${id}` }
  const account = useAccountStore()
  // 用 restore 而不是 ensureRestored：后者在已登录时会直接返回，切不了账号
  await account.restore()
  expect(account.isAuthenticated).toBe(true)
}

beforeEach(() => {
  mem.clear()
  flags.clear()
  fake.user = null
  fake.clouds.clear()
  fake.pushed = []
  fake.conflictWith = null
  setActivePinia(createPinia())
})

describe('槽位按账号隔离', () => {
  it('登录后使用账号 id 作为本地槽位', async () => {
    await loginAs(42)
    const store = useGameStore()
    await store.load()
    expect(store.slot).toBe('42')
    expect(mem.has('42')).toBe(true)
    expect(mem.has('main')).toBe(false)
  })

  it('换账号使用不同槽位，不串号', async () => {
    await loginAs(42)
    const store = useGameStore()
    await store.load()
    store.save.player.crystals = 111
    await store.persist()

    // 换账号
    store.invalidate()
    await loginAs(43)
    await store.load()
    expect(store.slot).toBe('43')
    expect(store.save.player.crystals).not.toBe(111)
  })
})

describe('云端与本地择新', () => {
  it('云端更新 → 采纳云端版本', async () => {
    fake.clouds.set(42, { payload: JSON.stringify(makeSave(5000, 777)), savedAt: 5000 })
    await loginAs(42)
    const store = useGameStore()
    await store.load()
    expect(store.save.player.crystals).toBe(777)
    expect(store.save.savedAt).toBe(5000)
  })

  it('本地更新 → 保留本地并推上云端', async () => {
    mem.set('42', JSON.stringify(makeSave(5000, 111)))
    fake.clouds.set(42, { payload: JSON.stringify(makeSave(1000, 222)), savedAt: 1000 })
    await loginAs(42)
    const store = useGameStore()
    await store.load()
    expect(store.save.player.crystals).toBe(111)
    expect(fake.pushed.length).toBeGreaterThan(0)
    expect(fake.pushed[fake.pushed.length - 1].savedAt).toBe(5000)
  })

  it('云端还没有存档时，本地存档会被推上去', async () => {
    mem.set('42', JSON.stringify(makeSave(2000, 333)))
    await loginAs(42)
    const store = useGameStore()
    await store.load()
    expect(fake.clouds.get(42)?.savedAt).toBe(2000)
  })
})

describe('推送冲突', () => {
  it('服务端版本更新 → 采纳服务端版本并落盘', async () => {
    await loginAs(42)
    const store = useGameStore()
    await store.load()

    fake.conflictWith = { payload: JSON.stringify(makeSave(9000, 888)), savedAt: 9000 }
    store.save.player.crystals = 555
    await store.persist(true)

    expect(store.save.player.crystals).toBe(888)
    expect(store.save.savedAt).toBe(9000)
    const local = JSON.parse(mem.get('42') ?? '{}')
    expect(local.player.crystals).toBe(888)
  })
})

describe('存量单槽位迁移', () => {
  it('旧档迁入第一个登录的账号', async () => {
    mem.set('main', JSON.stringify(makeSave(1000, 1234)))
    await loginAs(42)
    const store = useGameStore()
    await store.load()
    expect(store.save.player.crystals).toBe(1234)
    expect(store.slot).toBe('42')
    expect(flags.has('sgw.legacyMigrated')).toBe(true)
  })

  it('旧档不会迁给第二个账号', async () => {
    mem.set('main', JSON.stringify(makeSave(1000, 1234)))
    await loginAs(42)
    const store = useGameStore()
    await store.load()

    // 换第二个账号
    store.invalidate()
    await loginAs(43)
    await store.load()
    expect(store.save.player.crystals).not.toBe(1234)
  })
})
