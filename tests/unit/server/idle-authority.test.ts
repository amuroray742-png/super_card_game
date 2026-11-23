/**
 * **服务端权威 · 三通道账本**（挂机改版 v11）。
 *
 * ⚠ 守的是什么：
 *   1. 服务端**载入**与**动作**用**同一份**三通道账本（`save.idle.channels`）——
 *      客户端另存一份就会两台设备进度不一致（铁律 #11 / #28）。
 *   2. 结算**余数写回**：不足一次的毫秒留在 `effectiveMs` 里，
 *      下次结算继续累积（分批领取 == 一次领取的前提）。
 *   3. 离线结算**弹窗**有阈值（`IDLE.OFFLINE_SETTLE_THRESHOLD_SEC = 60` 秒）：
 *      在线累积的收益不该弹「离线结算」，但收益**照算照落库**。
 *   4. 挂机**不再跑战斗** ⇒ 不再自动推进关卡、不再从掉落表掉遗物。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'
import { GameService } from '../../../server/src/game/service.ts'
import { UserLock } from '../../../server/src/game/lock.ts'
import { writeSave } from '../../../server/src/game/repo.ts'
import { createNewSave } from '../../../src/core/save/schema.ts'
import { createHeroState } from '../../../src/core/systems/growth.ts'
import { serialize } from '../../../src/core/save/serialize.ts'
import { IDLE } from '../../../src/core/config/economy.ts'
import { readServerSave } from '../helpers/server-save.ts'

let bundle: AppBundle | undefined
afterEach(async () => { vi.restoreAllMocks(); await bundle?.close() })

it('服务端载入和动作使用同一账本，保留余数并写回真实产出', async () => {
  let now = 1700000000000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  bundle = buildApp({ dbPath: ':memory:', jwtSecret: 'idle-test-secret', accessTokenTtlSec: 900, refreshTokenTtlSec: 3600, corsOrigins: [] })
  const register = await bundle.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'idle_account', password: 'correct-horse-1' } })
  const id = register.json().user.id as number
  const save = createNewSave(now, 123)
  save.heroes.xiangyu = { ...createHeroState('xiangyu', now), level: 240, star: 6 }
  save.team.slots[0] = 'xiangyu'
  // ⚠ 挂机改版 v11：主线通道**跟随最新通关关卡**；首胜前没有可挂的目标。
  //   这里预置「已通关第 1 关」，主线通道才有产出可测。
  save.campaign.clearedStage = 1
  save.idle.channels.main.target = { kind: 'main', stageId: null }
  writeSave(bundle.db, id, serialize(save), now, now)
  const service = new GameService(bundle.db, new UserLock())
  now += 6500
  const loaded = await service.load(id)
  // ⚠ 离线结算**弹窗**有阈值（IDLE.OFFLINE_SETTLE_THRESHOLD_SEC = 60 秒）：
  //   6.5 秒的间隔不够弹窗——在线累积的收益不该弹「离线结算」。
  //   但收益照算照落库（下面的服务端状态已经推进了）。
  expect(loaded?.offline).toBeNull()
  // ⚠ 存档分包：遗物在 `relic_instances` 表里，payload 里没有 → 必须从服务端读
  const after = readServerSave(bundle.db, id)
  // ⚠ 挂机**不再跑战斗** ⇒ 关卡进度**不会**自己往前走（只剩手动挑战能推进）
  expect(after.campaign.clearedStage).toBe(1)
  expect(after.relics).toHaveLength(0)
  // 三通道账本都在存档里（服务端唯一权威）
  expect(Object.keys(after.idle.channels).sort()).toEqual(['enhance', 'main', 'skill'])
  expect(after.idle.channels.main.target).toEqual({ kind: 'main', stageId: null })

  // ⚠ `idle.tick` **不带次数**（旧版是 `{ battles }`）：
  //   次数由服务端按各通道的 `effectiveMs` 决定，客户端创造不出时间。
  //   6.5 秒的间隔不足以攒够一次掷奖（`IDLE.SECONDS_PER_ROLL = 6` 秒）
  //   ⇒ 刚好不到一次 ⇒ 本次结算 0 次。
  const tick = await service.execute(id, { actionId: 'idle-zero', action: { type: 'idle.tick' } })
  expect((tick.result as { rolls: number }).rolls).toBe(0)
  expect(readServerSave(bundle.db, id).relics).toHaveLength(0)

  // 再过 5.5 秒 ⇒ 累计满 12 秒 = 2 次掷奖
  now += 5500
  const next = await service.execute(id, { actionId: 'idle-next', action: { type: 'idle.tick' } })
  const rolls = (next.result as { rolls: number }).rolls
  expect(rolls).toBeGreaterThan(0)
  // ⚠ 产出真的入账了（服务端读到的银两 > 0）
  expect(readServerSave(bundle.db, id).player.silver).toBeGreaterThan(0)
})

it('三通道的预算各自独立：结算一条通道不动另外两条', async () => {
  let now = 1700000000000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  bundle = buildApp({ dbPath: ':memory:', jwtSecret: 'idle-test-secret', accessTokenTtlSec: 900, refreshTokenTtlSec: 3600, corsOrigins: [] })
  const register = await bundle.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'idle_channels', password: 'correct-horse-1' } })
  const id = register.json().user.id as number
  const save = createNewSave(now, 321)
  save.heroes.xiangyu = { ...createHeroState('xiangyu', now), level: 240, star: 6 }
  save.team.slots[0] = 'xiangyu'
  save.campaign.clearedStage = 1
  writeSave(bundle.db, id, serialize(save), now, now)
  const service = new GameService(bundle.db, new UserLock())

  // 25 秒 ⇒ 4 次掷奖（24 秒）+ 1 秒余数（余数要留在 effectiveMs 里）
  now += 25_000
  await service.execute(id, { actionId: 'warmup', action: { type: 'idle.tick' } })
  const after = readServerSave(bundle.db, id)
  // 主线通道有预算（有目标），技能 / 强化通道没目标 ⇒ 预算为 0
  expect(after.idle.channels.main.effectiveMs).toBeGreaterThan(0)
  expect(after.idle.channels.skill.effectiveMs).toBe(0)
  expect(after.idle.channels.enhance.effectiveMs).toBe(0)
  // 技能 / 强化通道没目标 ⇒ 关卡 id 为 null
  expect(after.idle.channels.skill.target).toBeNull()
  expect(after.idle.channels.enhance.target).toBeNull()
  // 结算上限按每通道 2000 次（IDLE.MAX_ROLLS_PER_SETTLEMENT）
  expect(IDLE.MAX_ROLLS_PER_SETTLEMENT).toBe(2000)
})
