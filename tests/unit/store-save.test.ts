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
import { startServerHarness, type ServerHarness } from './helpers/server-harness.ts'
import { registerAndLoad } from './helpers/store-harness.ts'

/** 模拟存储：key = slot，value = 序列化后的存档（只读缓存） */
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

let harness: ServerHarness

beforeEach(async () => {
  mem.clear()
  setActivePinia(createPinia())
  harness = startServerHarness()
})

afterEach(async () => {
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

describe('服务端权威：失败即原子', () => {
  it('余额不足 → 动作失败，存档一字节未变', async () => {
    const store = await registerAndLoad('saver')
    await store.pull('standard', 10)
    await store.pull('standard', 10)

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
