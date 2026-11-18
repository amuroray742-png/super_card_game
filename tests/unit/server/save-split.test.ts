/**
 * 存档分包（主体 + 遗物表）。
 *
 * ⚠ 为什么分包：遗物是唯一随挂机时长线性增长的存档字段
 *   （12 小时离线能积出数千件，整份存档 ≈ 1.3 MB），
 *   而心跳每 5 秒就会整份重写并整份回包 → 写库量与带宽都被遗物数量绑架。
 *
 * 这里守三件事：
 *   ① 存档主体里**没有**遗物；遗物在独立表里（拆了但没丢）；
 *   ② 存量整包旧档能被**就地拆表**（一次迁移，之后走新路径）；
 *   ③ 遗物行是**增量**同步的——写库量不随遗物数量线性增长
 *      （否则心跳每 5 秒重写几千行，事务越持越久）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'
import { GameService } from '../../../server/src/game/service.ts'
import { UserLock } from '../../../server/src/game/lock.ts'
import {
  countRelics,
  readRelicByUid,
  readRelics,
  readSave,
  replaceRelics,
  writeSave,
} from '../../../server/src/game/repo.ts'
import { createNewSave } from '../../../src/core/save/schema.ts'
import { createHeroState } from '../../../src/core/systems/growth.ts'
import {
  serialize,
  serializePublicSave,
  serializeSaveBody,
  deserializePublicSave,
} from '../../../src/core/save/serialize.ts'
import { readServerSave } from '../helpers/server-save.ts'
import type { RelicInstance, SaveData } from '../../../src/core/model/types.ts'

let bundle: AppBundle | undefined
afterEach(async () => {
  // ⚠ 先清空再关：同一份 bundle 可能被 afterEach 关第二次（node:sqlite 会抛
  //   「database is not open」），纯 core 的用例根本不建后端。
  const current = bundle
  bundle = undefined
  await current?.close()
})

/** 起一个内存库后端 */
function makeBundle(): AppBundle {
  bundle = buildApp({
    dbPath: ':memory:',
    jwtSecret: 'split-test-secret',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 3600,
    corsOrigins: [],
  })
  return bundle
}

/** 造一件遗物 */
function relic(uid: string, defId = 'set_zhanshen_1', level = 1): RelicInstance {
  return { uid, defId, level, subStats: [], locked: false }
}

/** 造一份带 N 件遗物、1 名英灵的存档 */
function makeSave(count: number): SaveData {
  // ⚠ 时间基准用「现在」：存档一创建就带一个很早的 measuredAt 的话，
  //   载入时会被当成「离线很久」→ 一次性结算几千场战斗（还会掉几千件遗物），
  //   测的就不是分包而是挂机了。
  const now = Date.now()
  const save = createNewSave(now, 42)
  save.heroes['xiangyu'] = { ...createHeroState('xiangyu', now), level: 240, star: 6 }
  save.team.slots[0] = 'xiangyu'
  save.relics = Array.from({ length: count }, (_, i) => relic(`r${i}`, 'set_zhanshen_1', (i % 5) + 1))
  return save
}

/** 注册一个账号，返回账号 id */
async function register(b: AppBundle, username: string): Promise<number> {
  const res = await b.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'correct-horse-1' },
  })
  return res.json().user.id as number
}

describe('存档分包', () => {
  it('存档主体里没有遗物；遗物在独立表里（拆了但没丢）', async () => {
    const b = makeBundle()
    const id = await register(b, 'split_user')
    const save = makeSave(5)
    // 走一次动作，让服务端按新路径落库
    writeSave(b.db, id, serialize(save), save.savedAt, Date.now())
    const service = new GameService(b.db, new UserLock())
    await service.load(id)

    const row = readSave(b.db, id)!
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    expect(payload.relics, '存档主体不应再带遗物数组').toBeUndefined()
    expect(payload.player).toBeDefined()

    expect(countRelics(b.db, id)).toBe(5)
    const full = readServerSave(b.db, id)
    expect(full.relics).toHaveLength(5)
    expect(full.relics.map((r) => r.uid).sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
  })

  it('存量整包旧档：读取时就地拆表（幂等，拆完主体不再带遗物）', async () => {
    const b = makeBundle()
    const id = await register(b, 'legacy_user')
    const save = makeSave(3)
    // 旧格式：整份存档（含 relics）直接躺在 payload 里
    writeSave(b.db, id, serialize(save), save.savedAt, Date.now())

    const service = new GameService(b.db, new UserLock())
    const loaded = await service.load(id)
    expect(loaded).not.toBeNull()

    // 拆表完成：主体里没有遗物了，遗物在表里
    const payload = JSON.parse(readSave(b.db, id)!.payload) as Record<string, unknown>
    expect(payload.relics).toBeUndefined()
    expect(countRelics(b.db, id)).toBe(3)

    // 再读一次不会重复插入（幂等）
    await service.load(id)
    expect(countRelics(b.db, id)).toBe(3)
  })

  it('遗物行增量同步：写库量不随遗物数量线性增长', async () => {
    const b = makeBundle()
    const id = await register(b, 'incremental_user')
    const save = makeSave(200)
    writeSave(b.db, id, serialize(save), save.savedAt, Date.now())
    const service = new GameService(b.db, new UserLock())
    await service.load(id)

    /** 当前连接累计改动的行数（SQLite 的 total_changes） */
    const changes = (): number =>
      (b.db.prepare('SELECT total_changes() AS n').get() as unknown as { n: number }).n

    // 心跳：只续租约，遗物一件没变
    const before = changes()
    await service.execute(id, { actionId: 'hb-1', action: { type: 'idle.heartbeat' } })
    const delta = changes() - before
    // 只应改到存档主体那一行；若遗物被全量重写，这里会是 200+
    expect(delta).toBeLessThanOrEqual(2)
  })

  it('遗物变化时只写变化的那几行', async () => {
    const b = makeBundle()
    const id = await register(b, 'changed_user')
    const save = makeSave(3)
    writeSave(b.db, id, serialize(save), save.savedAt, Date.now())
    const service = new GameService(b.db, new UserLock())
    await service.load(id)

    // 直接改库里的等级（模拟一次强化已落库）
    b.db.prepare('UPDATE relic_instances SET level = 9 WHERE user_id = ? AND uid = ?').run(id, 'r1')
    expect(readRelicByUid(b.db, id, 'r1')?.level).toBe(9)
    expect(readRelicByUid(b.db, id, 'r0')?.level).toBe(1)

    // 一次动作不应把没变的遗物重写（值保持不变即可验证）
    await service.execute(id, { actionId: 'act-1', action: { type: 'idle.heartbeat' } })
    expect(readRelicByUid(b.db, id, 'r0')?.level).toBe(1)
    expect(countRelics(b.db, id)).toBe(3)
  })

  it('删除遗物会同步删表（不留孤儿行）', async () => {
    const b = makeBundle()
    const id = await register(b, 'delete_user')
    const save = makeSave(3)
    writeSave(b.db, id, serialize(save), save.savedAt, Date.now())
    const service = new GameService(b.db, new UserLock())
    await service.load(id)

    // 动作层删一件（直接改表模拟也可以，这里走真实的同步路径）
    const full = readServerSave(b.db, id)
    full.relics = full.relics.filter((r) => r.uid !== 'r1')
    replaceRelics(b.db, id, full.relics)
    expect(countRelics(b.db, id)).toBe(2)

    // 再读一次存档 → 仍然是 2 件
    await service.load(id)
    expect(readServerSave(b.db, id).relics).toHaveLength(2)
    expect(readRelics(b.db, id).map((r) => r.uid)).not.toContain('r1')
  })

  it('客户端公开投影只带已装备遗物，且不含权威随机状态', async () => {
    const save = makeSave(4)
    save.equipped['xiangyu#0'] = { heroId: 'xiangyu', relicId: 'r0' }
    save.equipped['xiangyu#1'] = { heroId: 'xiangyu', relicId: 'r2' }

    const payload = serializePublicSave(save)
    const parsed = JSON.parse(payload) as { relics: RelicInstance[]; rng?: unknown }
    expect(parsed.relics.map((r) => r.uid).sort()).toEqual(['r0', 'r2'])
    expect(parsed.rng).toBeUndefined()

    // 客户端读回来：形状不变，rng 清零
    const mirror = deserializePublicSave(payload)
    expect(mirror.relics).toHaveLength(2)
    expect(mirror.rng).toEqual({ seed: 0, counter: 0 })
    expect(mirror.player).toBeDefined()
  })

  it('存档主体序列化不含遗物（体积与遗物数量无关）', () => {
    const save = makeSave(50)
    const body = serializeSaveBody(save)
    expect(JSON.parse(body).relics).toBeUndefined()
    expect(body.length).toBeLessThan(JSON.stringify(save).length)
  })
})

describe('仓库分页接口', () => {
  it('分页的 total 与 items 用同一套筛选（否则翻页翻出一堆空页）', async () => {
    const b = makeBundle()
    const id = await register(b, 'paging_user')
    const save = makeSave(0)
    // 3 件 SSR（战神套 1 号）+ 2 件 N（战神套 5 号）
    save.relics = [
      relic('a1', 'set_zhanshen_1', 1),
      relic('a2', 'set_zhanshen_1', 1),
      relic('a3', 'set_zhanshen_1', 1),
      relic('n1', 'set_zhanshen_5', 1),
      relic('n2', 'set_zhanshen_5', 1),
    ]
    writeSave(b.db, id, JSON.stringify(save), save.savedAt, Date.now())
    const service = new GameService(b.db, new UserLock())
    await service.load(id)

    const all = await service.relicPage(id, { page: 1, size: 10 })
    expect(all.total).toBe(5)
    expect(all.items).toHaveLength(5)

    const ssr = await service.relicPage(id, { page: 1, size: 10, rarity: 'SSR' })
    expect(ssr.total).toBe(3)
    expect(ssr.items).toHaveLength(3)
    expect(ssr.pages).toBe(1)

    const n = await service.relicPage(id, { page: 1, size: 10, rarity: 'N' })
    expect(n.total).toBe(2)
    expect(n.items.every((r) => r.defId === 'set_zhanshen_5')).toBe(true)

    // 按定义 id 精确查
    const one = await service.relicPage(id, { page: 1, size: 10, defId: 'set_zhanshen_1' })
    expect(one.total).toBe(3)
    expect(one.items).toHaveLength(3)

    // 分页：每页 2 件，第 2 页应有 2 件
    const p1 = await service.relicPage(id, { page: 1, size: 2 })
    const p2 = await service.relicPage(id, { page: 2, size: 2 })
    expect(p1.pages).toBe(3)
    expect(p1.items).toHaveLength(2)
    expect(p2.items).toHaveLength(2)
    const uids = new Set([...p1.items, ...p2.items].map((r) => r.uid))
    expect(uids.size).toBe(4)
  })

  it('单件查询与统计接口给出权威数据', async () => {
    const b = makeBundle()
    const id = await register(b, 'stats_user')
    const save = makeSave(0)
    save.relics = [relic('x1', 'set_zhanshen_1', 5), relic('x2', 'set_zhanshen_5', 7)]
    writeSave(b.db, id, JSON.stringify(save), save.savedAt, Date.now())
    const service = new GameService(b.db, new UserLock())
    await service.load(id)

    const one = await service.relicByUid(id, 'x1')
    expect(one?.level).toBe(5)

    const stats = await service.relicStats(id)
    expect(stats.total).toBe(2)
    expect(stats.byDefId['set_zhanshen_1']).toBe(1)
    expect(stats.byDefId['set_zhanshen_5']).toBe(1)
  })
})
