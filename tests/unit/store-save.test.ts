/**
 * 表现层存档写入的并发保护（presentation/stores/game.ts）。
 *
 * 用一个内存版 storage 适配器模拟「另一个上下文改了存档」，
 * 断言本进程**不会**用过期存档覆盖对方，且本次改动整体作废
 * （不会出现「扣了费却没出货」的中间态）。
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

const SLOT = 'main'

/** 存储里存档的最小结构（只取断言用到的字段） */
interface StoredSave {
  savedAt: number
  player: { crystals: number; tickets: number }
  gacha: { history: unknown[]; newbieUsed: boolean }
  stats: { totalPulls: number }
}

/** 读取存储里的原始存档 */
function stored(): StoredSave {
  return JSON.parse(mem.get(SLOT) ?? '{}') as StoredSave
}

/** 模拟「另一个上下文写了更新的存档」 */
function externalWrite(patch: Record<string, unknown>) {
  const current = stored()
  const next = {
    ...current,
    ...patch,
    savedAt: current.savedAt + 10_000,
  }
  mem.set(SLOT, JSON.stringify(next))
  return next
}

describe('存档并发保护', () => {
  beforeEach(() => {
    mem.clear()
    setActivePinia(createPinia())
  })

  it('首次加载会落盘一份新存档', async () => {
    const store = useGameStore()
    await store.load()
    expect(mem.has(SLOT)).toBe(true)
    expect(store.save.player.crystals).toBe(3000)
    expect(stored().savedAt).toBeGreaterThan(0)
  })

  it('十连：扣费 + 记录 10 条历史 + 消耗新手保底资格', async () => {
    const store = useGameStore()
    await store.load()
    const summary = await store.pull('standard', 10)
    expect(summary).not.toBeNull()
    expect(store.save.player.crystals).toBe(0)
    expect(store.save.gacha.history).toHaveLength(10)
    expect(store.save.stats.totalPulls).toBe(10)
    expect(store.save.gacha.newbieUsed).toBe(true)
  })

  it('外部更新时不覆盖对方存档，改为采纳外部版本', async () => {
    const store = useGameStore()
    await store.load()
    const external = externalWrite({ player: { ...store.save.player, crystals: 777 } })

    const ok = await store.persist()
    expect(ok).toBe(false)
    // 本进程已采纳外部版本
    expect(store.save.player.crystals).toBe(777)
    // 且存储里的内容没有被本进程的旧状态覆盖
    expect(stored().player.crystals).toBe(777)
    expect(stored().savedAt).toBe(external.savedAt)
  })

  it('冲突时抽卡整体作废：不扣费、不出货、不留半截状态', async () => {
    const store = useGameStore()
    await store.load()
    externalWrite({ player: { ...store.save.player, crystals: 777 } })

    const summary = await store.pull('standard', 10)
    expect(summary).toBeNull()
    // 外部版本原样保留：没有扣结晶、没有新增历史
    expect(store.save.player.crystals).toBe(777)
    expect(store.save.gacha.history).toHaveLength(0)
    expect(store.save.stats.totalPulls).toBe(0)
    expect(store.save.gacha.newbieUsed).toBe(false)
  })

  it('重置进度是玩家主动操作，允许强行写入（不受冲突保护限制）', async () => {
    const store = useGameStore()
    await store.load()
    externalWrite({ player: { ...store.save.player, crystals: 777 } })

    await store.reset()
    expect(store.save.player.crystals).toBe(3000)
    expect(stored().player.crystals).toBe(3000)
  })

  it('存档写入时间戳随每次写入递增', async () => {
    const store = useGameStore()
    await store.load()
    const first = stored().savedAt as number
    await store.persist()
    const second = stored().savedAt as number
    expect(second).toBeGreaterThan(first)
  })
})
