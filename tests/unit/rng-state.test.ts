/**
 * 随机数状态持久化（铁律 #24）。
 *
 * 历史教训：store 曾写死 `new Rng(0x5eed)`，且计数器只在内存里 →
 * ① 所有玩家抽到的英灵序列**完全相同**（公示的 SSR 0.60% 退化成固定脚本）；
 * ② 刷新页面后计数器归零 → 序列从头复现，玩家可以无限「刷新重抽」。
 *
 * 现在种子与计数器随存档持久化，载入时据此复原，序列只前进不复现。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { Rng } from '../../src/core/rng.ts'
import { createNewSave, normalizeSave, SAVE_VERSION } from '../../src/core/save/schema.ts'
import { deserialize, exportSave, serialize } from '../../src/core/save/serialize.ts'
import { ACCOUNT_STORAGE_KEYS, accountSlotKey } from '../../src/core/config/account.ts'
import { readSave } from '../../server/src/game/repo.ts'
import { startServerHarness, type ServerHarness } from './helpers/server-harness.ts'
import { registerAndLoad } from './helpers/store-harness.ts'

/** 模拟存储：key = slot，value = 序列化后的存档 */
const mem = vi.hoisted(() => new Map<string, string>())

vi.mock('../../src/platform/storage.ts', async () => {
  const { serializePublicSave } = await import('../../src/core/save/serialize.ts')
  return {
    storage: {
      async load(slot: string) {
        const text = mem.get(slot)
        return text ? JSON.parse(text) : null
      },
      async save(slot: string, data: Parameters<typeof serializePublicSave>[0]) {
        mem.set(slot, serializePublicSave(data))
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
  }
})

const { useGameStore } = await import('../../src/presentation/stores/game.ts')

/** 后端夹具（服务端持有随机序列） */
let harness: ServerHarness

describe('core：RNG 快照忠实复原', () => {
  it('snapshot 记的是初始种子 + 已消耗个数', () => {
    const rng = new Rng(777)
    expect(rng.snapshot()).toEqual({ seed: 777, counter: 0 })
    rng.next()
    rng.next()
    expect(rng.snapshot()).toEqual({ seed: 777, counter: 2 })
  })

  it('fromSnapshot 复原后接着往下取，与原序列完全一致', () => {
    const rng = new Rng(12345)
    rng.next()
    rng.next()
    const snap = rng.snapshot()

    const restored = Rng.fromSnapshot(snap.seed, snap.counter)
    expect(restored.snapshot()).toEqual(snap)
    // 复原后的后续取值 === 原 rng 的后续取值
    expect([restored.next(), restored.next(), restored.next()]).toEqual([
      rng.next(),
      rng.next(),
      rng.next(),
    ])
  })

  it('不同种子给出不同序列（种子不得写死）', () => {
    const a = new Rng(1)
    const b = new Rng(2)
    expect(a.next()).not.toBe(b.next())
  })

  it('浮点种子不能被截断成同一个兜底种子（根因回归）', () => {
    // [0,1) 的浮点若直接 `>>> 0` 会变成 0 → 全部落到同一个兜底种子
    // → 抽卡 / 战斗 / 挂机掉落的结果永远固定。
    const a = new Rng(0.1)
    const b = new Rng(0.2)
    expect(a.snapshot().seed).not.toBe(b.snapshot().seed)
    expect(a.next()).not.toBe(b.next())
  })

  it('nextSeed() 给出 32 位整数种子', () => {
    const rng = new Rng(2024)
    for (let i = 0; i < 50; i++) {
      const seed = rng.nextSeed()
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(0x1_0000_0000)
    }
    // 消耗一个浮点 → 计数器 +1（与快照计数口径一致）
    expect(rng.snapshot().counter).toBe(50)
  })
})

describe('存档：随机数状态字段', () => {
  it('存档版本已升级（新增 rng 字段）', () => {
    expect(SAVE_VERSION).toBe(7)
  })

  it('新建存档带随机种子', () => {
    expect(createNewSave(1, 42).rng).toEqual({ seed: 42, counter: 0 })
  })

  it('旧档（无 rng 字段）规范化后种子为 0，等待服务端补种子', () => {
    const legacy = { ...createNewSave(1) } as Record<string, unknown>
    delete legacy.rng
    expect(normalizeSave(legacy).rng).toEqual({ seed: 0, counter: 0 })
  })

  it('已有 rng 的存档规范化后原样保留', () => {
    const save = createNewSave(1, 99)
    save.rng.counter = 5
    expect(normalizeSave(save).rng).toEqual({ seed: 99, counter: 5 })
  })

  it('旧版随机状态失效，导出串省略随机字段', () => {
    const save = createNewSave(1, 99)
    save.rng.counter = 5
    expect(deserialize(serialize({ ...save, version: 5 })).rng).toEqual({ seed: 0, counter: 0 })
    expect(JSON.parse(atob(exportSave(save)))).not.toHaveProperty('rng')
  })

  it('首次读取会清理账号缓存的随机字段并保留旧档迁移通道', async () => {
    const { LocalStorageAdapter } = await vi.importActual<typeof import('../../src/platform/storage.ts')>('../../src/platform/storage.ts')
    const slot = accountSlotKey(11)
    const prefix = ACCOUNT_STORAGE_KEYS.SAVE_SLOT_PREFIX
    const legacySlot = ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT
    const old = serialize({ ...createNewSave(1, 99), version: 5 })
    const data = new Map([[prefix + slot, old], [prefix + legacySlot, old]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    })
    try {
      const adapter = new LocalStorageAdapter()
      expect(await adapter.load(slot)).toMatchObject({ rng: { seed: 0, counter: 0 }, player: { crystals: 3000 } })
      expect(JSON.parse(data.get(prefix + slot)!)).not.toHaveProperty('rng')
      await adapter.load(legacySlot)
      expect(data.get(prefix + legacySlot)).toBe(old)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('抽卡随机序列（铁律 #24 · 服务端持有）', () => {
  beforeEach(async () => {
    mem.clear()
    setActivePinia(createPinia())
    harness = startServerHarness()
    await registerAndLoad('rng_user')
  })

  afterEach(async () => {
    await harness.close()
  })

  function storedRng() {
    const row = harness.bundle.db.prepare('SELECT user_id FROM saves').get() as { user_id: number }
    return deserialize(readSave(harness.bundle.db, row.user_id)!.payload).rng
  }

  it('新档随机状态只在服务端持久化，浏览器镜像与缓存无权威随机状态', () => {
    const store = useGameStore()
    expect(storedRng().seed).not.toBe(0)
    expect(store.save.rng).toEqual({ seed: 0, counter: 0 })
    const [cached] = mem.values()
    expect(JSON.parse(cached)).not.toHaveProperty('rng')
  })

  it('两次十连抽到的序列不同（不再是固定脚本）', async () => {
    const store = useGameStore()
    await store.pull('standard', 10)
    const first = store.save.gacha.history.slice(0, 9).map((h) => h.heroId)
    await store.pull('standard', 10)
    const second = store.save.gacha.history.slice(10, 19).map((h) => h.heroId)

    expect(first).toHaveLength(9)
    expect(second).toHaveLength(9)
    // 前 9 张是纯随机产出（新手保底只替换第 10 张），必须互不相同
    expect(second).not.toEqual(first)
  })

  it('刷新页面（重新载入同一份存档）后序列继续前进，不复现上一批', async () => {
    const store = useGameStore()
    await store.pull('standard', 10)
    const first = store.save.gacha.history.slice(0, 9).map((h) => h.heroId)
    const counter = storedRng().counter
    expect(counter).toBeGreaterThan(0)

    // 模拟刷新页面：重新载入（服务端存档里的计数器继续往前）
    store.invalidate()
    await store.load()
    expect(storedRng().counter).toBe(counter)
    expect(store.save.rng.counter).toBe(0)

    await store.pull('standard', 10)
    const second = store.save.gacha.history.slice(10, 19).map((h) => h.heroId)
    expect(second).not.toEqual(first)
    expect(storedRng().counter).toBeGreaterThan(counter)
  })
})
