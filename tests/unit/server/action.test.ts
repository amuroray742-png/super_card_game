/**
 * 服务端权威动作接口单测（真实后端 + 临时内存库）。
 *
 * 覆盖：
 * - 建档 / 重复建档 / 无存档动作
 * - 抽卡扣费（服务端记账）
 * - **幂等**：同一个 actionId 重放只扣一次费
 * - **串行**：同账号并发动作排队执行，不丢档
 * - **失败即原子**：业务失败 → 存档一字节未变
 * - 离线收益补算（断网不损失挂机收益）
 * - 存量档导入（迁移路径）
 * - 协议级失败：400 / 401 / 429
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'
import { dispatchAction } from '../../../server/src/game/dispatcher.ts'
import { GameService } from '../../../server/src/game/service.ts'
import { UserLock } from '../../../server/src/game/lock.ts'
import { WindowLimiter } from '../../../server/src/rateLimit.ts'
import { createNewSave } from '../../../src/core/save/schema.ts'
import { writeSave, writeFlag } from '../../../server/src/game/repo.ts'
import { LEGACY_MIGRATED_FLAG } from '../../../src/core/config/account.ts'
import { serialize, exportSave } from '../../../src/core/save/serialize.ts'
import { grantHero } from '../../../src/core/systems/actions.ts'
import type { PullActionResult } from '../../../src/core/systems/actions.ts'
import type { ActionResponse } from '../../../src/core/systems/action-protocol.ts'

let bundle: AppBundle

const PASSWORD = 'correct-horse-1'

beforeEach(() => {
  bundle = buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    corsOrigins: ['http://127.0.0.1:4173'],
  })
})

afterEach(async () => {
  await bundle.close()
})

async function signUp(username: string) {
  const res = await bundle.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  })
  return res.json() as { accessToken: string; user: { id: number; username: string } }
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

/** 发一个动作 */
async function post(
  token: string,
  actionId: string,
  action: unknown,
): Promise<{ status: number; body: ActionResponse }> {
  const res = await bundle.app.inject({
    method: 'POST',
    url: '/api/action',
    headers: auth(token),
    payload: { actionId, action },
  })
  return { status: res.statusCode, body: res.json() as ActionResponse }
}

/** 拉取服务端存档（服务端权威版本） */
async function pullSave(token: string) {
  const res = await bundle.app.inject({ method: 'GET', url: '/api/save', headers: auth(token) })
  if (res.statusCode !== 200) return null
  const body = res.json() as { payload: string; savedAt: number; offline?: unknown }
  return { ...JSON.parse(body.payload), savedAt: body.savedAt, offline: body.offline }
}

/** 取抽卡结果（响应里的 result 是所有动作结果的联合类型） */
function pullResult(body: ActionResponse): PullActionResult {
  return body.result as PullActionResult
}

/** 建档并返回令牌 */
async function withSave(username: string) {
  const acc = await signUp(username)
  const created = await post(acc.accessToken, 'create-1', { type: 'save.create' })
  expect(created.body.ok).toBe(true)
  return acc
}

describe('动作接口：建档', () => {
  it('没有存档时执行动作 → 200 + ok:false + SAVE_MISSING', async () => {
    const acc = await signUp('alice')
    const res = await post(acc.accessToken, 'a1', { type: 'daily.signIn' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('SAVE_MISSING')
  })

  it('save.create 建档成功，随后 GET /api/save 能取到', async () => {
    const acc = await signUp('alice')
    const res = await post(acc.accessToken, 'a1', { type: 'save.create' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.save?.payload).toBeTruthy()

    const save = await pullSave(acc.accessToken)
    expect(save).not.toBeNull()
    expect(save?.player.crystals).toBe(3000)
  })

  it('重复 save.create → ok:false SAVE_EXISTS（不覆盖已有进度）', async () => {
    const acc = await withSave('alice')
    const res = await post(acc.accessToken, 'a2', { type: 'save.create' })
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('SAVE_EXISTS')
  })

  it('服务端生成的随机种子非零且各账号不同（不得用常量种子）', async () => {
    const a = await withSave('alice')
    const b = await withSave('bob')
    const saveA = await pullSave(a.accessToken)
    const saveB = await pullSave(b.accessToken)
    expect(saveA?.rng.seed).not.toBe(0)
    expect(saveA?.rng.seed).not.toBe(saveB?.rng.seed)
  })
})

describe('动作接口：扣费与幂等', () => {
  it('十连抽卡：服务端扣结晶（3000 → 0），且不产生负数', async () => {
    const acc = await withSave('alice')
    const res = await post(acc.accessToken, 'pull-1', {
      type: 'gacha.pull',
      poolId: 'standard',
      count: 10,
    })
    expect(res.body.ok).toBe(true)
    expect(pullResult(res.body).items).toHaveLength(10)

    const save = await pullSave(acc.accessToken)
    expect(save?.player.crystals).toBe(0)
    expect(save?.player.tickets).toBe(10)
    expect(save?.player.crystals).toBeGreaterThanOrEqual(0)
  })

  it('同一个 actionId 重放 → 结果一致且**只扣一次费**', async () => {
    const acc = await withSave('alice')
    const first = await post(acc.accessToken, 'same-id', {
      type: 'gacha.pull',
      poolId: 'standard',
      count: 10,
    })
    expect(first.body.ok).toBe(true)
    expect(first.body.replayed).toBeUndefined()

    const second = await post(acc.accessToken, 'same-id', {
      type: 'gacha.pull',
      poolId: 'standard',
      count: 10,
    })
    expect(second.status).toBe(200)
    expect(second.body.ok).toBe(true)
    expect(second.body.replayed).toBe(true)
    expect(pullResult(second.body).items).toEqual(pullResult(first.body).items)

    const save = await pullSave(acc.accessToken)
    // 只扣了一次：结晶 3000 → 0，抽卡券 10 → 10（没被第二次抽走）
    expect(save?.player.crystals).toBe(0)
    expect(save?.player.tickets).toBe(10)
  })

  it('不同 actionId → 各自扣费（结晶见底后改用抽卡券）', async () => {
    const acc = await withSave('alice')
    await post(acc.accessToken, 'pull-1', { type: 'gacha.pull', poolId: 'standard', count: 10 })
    const res = await post(acc.accessToken, 'pull-2', {
      type: 'gacha.pull',
      poolId: 'standard',
      count: 10,
    })
    expect(res.body.ok).toBe(true)
    expect(res.body.result).toMatchObject({ crystalsUsed: 0, ticketsUsed: 10 })

    const save = await pullSave(acc.accessToken)
    expect(save?.player.crystals).toBe(0)
    expect(save?.player.tickets).toBe(0)
  })

  it('余额不足 → ok:false INSUFFICIENT_FUNDS，且存档一字节未变', async () => {
    const acc = await withSave('alice')
    await post(acc.accessToken, 'pull-1', { type: 'gacha.pull', poolId: 'standard', count: 10 })
    await post(acc.accessToken, 'pull-2', { type: 'gacha.pull', poolId: 'standard', count: 10 })

    const before = await pullSave(acc.accessToken)
    const res = await post(acc.accessToken, 'pull-3', {
      type: 'gacha.pull',
      poolId: 'standard',
      count: 10,
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS')

    const after = await pullSave(acc.accessToken)
    expect(after?.player.crystals).toBe(before?.player.crystals)
    expect(after?.player.tickets).toBe(before?.player.tickets)
    expect(after?.stats.totalPulls).toBe(before?.stats.totalPulls)
  })

  it('失败的 actionId 不写幂等日志 → 可以重试', async () => {
    const acc = await withSave('alice')
    // 先把结晶与抽卡券花光，下一次召唤才会失败
    await post(acc.accessToken, 'pull-1', { type: 'gacha.pull', poolId: 'standard', count: 10 })
    await post(acc.accessToken, 'pull-2', { type: 'gacha.pull', poolId: 'standard', count: 10 })

    const fail = await post(acc.accessToken, 'retry-id', {
      type: 'gacha.pull',
      poolId: 'standard',
      count: 10,
    })
    expect(fail.body.ok).toBe(false)
    const rows = bundle.db
      .prepare('SELECT * FROM action_log WHERE action_id = ?')
      .all('retry-id')
    expect(rows).toHaveLength(0)
  })
})

describe('动作接口：串行与幂等', () => {
  it('同账号并发两个不同 actionId → 串行执行，进度不丢', async () => {
    const acc = await withSave('alice')
    const [a, b] = await Promise.all([
      post(acc.accessToken, 'c-1', { type: 'gacha.pull', poolId: 'standard', count: 10 }),
      post(acc.accessToken, 'c-2', { type: 'gacha.pull', poolId: 'standard', count: 10 }),
    ])
    expect(a.body.ok).toBe(true)
    expect(b.body.ok).toBe(true)

    const save = await pullSave(acc.accessToken)
    expect(save?.player.crystals).toBe(0)
    expect(save?.player.tickets).toBe(0)
    expect(save?.stats.totalPulls).toBe(20)
  })

  it('同账号并发同一个 actionId → 只扣一次费', async () => {
    const acc = await withSave('alice')
    const [a, b] = await Promise.all([
      post(acc.accessToken, 'same', { type: 'gacha.pull', poolId: 'standard', count: 10 }),
      post(acc.accessToken, 'same', { type: 'gacha.pull', poolId: 'standard', count: 10 }),
    ])
    expect(a.body.ok).toBe(true)
    expect(b.body.ok).toBe(true)

    const save = await pullSave(acc.accessToken)
    expect(save?.stats.totalPulls).toBe(10)
    expect(save?.player.crystals).toBe(0)
    expect(save?.player.tickets).toBe(10)
  })
})

describe('动作接口：离线补算与导入', () => {
  it('离线超过阈值 → 载入时补算挂机收益并落库', async () => {
    const acc = await withSave('alice')
    // 造一份「两小时前、带编队」的存档
    const old = createNewSave(Date.now() - 2 * 3600 * 1000, 987654321)
    grantHero(old, 'xiangyu', Date.now())
    grantHero(old, 'hanxin', Date.now())
    old.team.slots[0] = 'xiangyu'
    old.team.slots[1] = 'hanxin'
    old.lastTickAt = Date.now() - 2 * 3600 * 1000

    writeSave(bundle.db, acc.user.id, serialize(old), old.savedAt, Date.now())

    const save = await pullSave(acc.accessToken)
    expect(save?.offline).toBeTruthy()
    const offline = save?.offline as { battles: number; rewards: { silver?: number } }
    expect(offline.battles).toBeGreaterThan(0)
    expect(save?.player.silver).toBeGreaterThan(old.player.silver)
    // 结算后 lastTickAt 推进，不会重复结算
    const again = await pullSave(acc.accessToken)
    expect(again?.offline).toBeFalsy()
  })

  it('已有云档禁止导入，即使声明legacy也不授权', async () => {
    const acc = await withSave('alice')
    const before = await pullSave(acc.accessToken)
    const res = await post(acc.accessToken, 'blocked-import', {
      type: 'save.import', legacy: true, payload: exportSave(createNewSave(Date.now(), 42)),
    })
    expect(res.body.code).toBe('IMPORT_FORBIDDEN')
    expect((await pullSave(acc.accessToken))?.rng).toEqual(before?.rng)
  })

  it('无云档首次迁移，随机与时间由服务端重建', async () => {
    const acc = await signUp('alice')
    const payload = exportSave(createNewSave(Date.now(), 42))
    const res = await post(acc.accessToken, 'import-2', { type: 'save.import', payload })
    expect(res.body.ok).toBe(true)
    const save = await pullSave(acc.accessToken)
    expect(save?.rng.seed).not.toBe(42)
    expect(save?.rng.counter).toBe(0)
    expect(save?.lastTickAt).toBeGreaterThan(Date.now() - 5000)
    expect(bundle.db.prepare('SELECT * FROM user_flags WHERE user_id = ?').all(acc.user.id)).toHaveLength(1)
  })

  it('迁移标记阻止删云档后重新迁移', async () => {
    const acc = await signUp('alice')
    writeFlag(bundle.db, acc.user.id, LEGACY_MIGRATED_FLAG, 1)
    const res = await post(acc.accessToken, 'again', { type: 'save.import', payload: exportSave(createNewSave(Date.now(), 42)) })
    expect(res.body.code).toBe('IMPORT_FORBIDDEN')
    expect(await pullSave(acc.accessToken)).toBeNull()
  })

  it('事务写标记失败时存档与动作日志一起回滚', async () => {
    const acc = await signUp('alice')
    bundle.db.exec("CREATE TRIGGER reject_migration BEFORE INSERT ON user_flags BEGIN SELECT RAISE(ABORT, 'reject'); END")
    const res = await post(acc.accessToken, 'rollback', { type: 'save.import', payload: exportSave(createNewSave(Date.now(), 42)) })
    expect(res.status).toBe(500)
    expect(await pullSave(acc.accessToken)).toBeNull()
    expect(bundle.db.prepare('SELECT * FROM action_log WHERE user_id = ?').all(acc.user.id)).toHaveLength(0)
  })

  it('导入非法存档 → ok:false IMPORT_INVALID，不建档不占资格', async () => {
    const acc = await signUp('alice')
    const res = await post(acc.accessToken, 'import-3', { type: 'save.import', payload: 'not-base64!!' })
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('IMPORT_INVALID')
    expect(await pullSave(acc.accessToken)).toBeNull()
    expect(bundle.db.prepare('SELECT * FROM user_flags WHERE user_id = ?').all(acc.user.id)).toHaveLength(0)
  })
})

describe('动作接口：协议级失败', () => {
  it('未登录 → 401', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/action',
      payload: { actionId: 'x', action: { type: 'daily.signIn' } },
    })
    expect(res.statusCode).toBe(401)
  })

  it('负载不合法 → 400', async () => {
    const acc = await withSave('alice')
    const bad = await bundle.app.inject({
      method: 'POST',
      url: '/api/action',
      headers: auth(acc.accessToken),
      payload: { actionId: 'x', action: { type: 'nope.nope' } },
    })
    expect(bad.statusCode).toBe(400)

    const noId = await bundle.app.inject({
      method: 'POST',
      url: '/api/action',
      headers: auth(acc.accessToken),
      payload: { action: { type: 'daily.signIn' } },
    })
    expect(noId.statusCode).toBe(400)
  })

  it('超出窗口配额 → 429', async () => {
    const service = new GameService(bundle.db, new UserLock())
    const limiter = new WindowLimiter(2, 60_000)
    const ctx = { service, limiter }
    const body = { actionId: 'rl-1', action: { type: 'daily.signIn' } }

    await dispatchAction(ctx, 1, body)
    await dispatchAction(ctx, 1, { ...body, actionId: 'rl-2' })
    await expect(dispatchAction(ctx, 1, { ...body, actionId: 'rl-3' })).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
    })
  })
})
