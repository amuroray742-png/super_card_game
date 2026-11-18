import { afterEach, expect, it, vi } from 'vitest'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'
import { GameService } from '../../../server/src/game/service.ts'
import { UserLock } from '../../../server/src/game/lock.ts'
import { writeSave } from '../../../server/src/game/repo.ts'
import { createNewSave } from '../../../src/core/save/schema.ts'
import { createHeroState } from '../../../src/core/systems/growth.ts'
import { serialize } from '../../../src/core/save/serialize.ts'
import { readServerSave } from '../helpers/server-save.ts'

let bundle: AppBundle | undefined
afterEach(async () => { vi.restoreAllMocks(); await bundle?.close() })
it('服务端载入和动作使用同一账本，保留余数并写回真实通关进度', async () => {
  let now = 1700000000000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  bundle = buildApp({ dbPath: ':memory:', jwtSecret: 'idle-test-secret', accessTokenTtlSec: 900, refreshTokenTtlSec: 3600, corsOrigins: [] })
  const register = await bundle.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'idle_account', password: 'correct-horse-1' } })
  const id = register.json().user.id as number
  const save = createNewSave(now, 123)
  save.heroes.xiangyu = { ...createHeroState('xiangyu', now), level: 240, star: 6 }
  save.team.slots[0] = 'xiangyu'
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
  expect(after.campaign.clearedStage).toBe(1)
  expect(after.idle.currentStage).toBe(2)
  expect(after.lastTickAt).toBe(now - 500)
  expect(after.relics).toHaveLength(1)
  const tick = await service.execute(id, { actionId: 'idle-zero', action: { type: 'idle.tick', battles: 100 } })
  expect((tick.result as { battles: number }).battles).toBe(0)
  expect(readServerSave(bundle.db, id).relics).toHaveLength(1)
  now += 5500
  const next = await service.execute(id, { actionId: 'idle-next', action: { type: 'idle.tick', battles: 1 } })
  expect((next.result as { battles: number }).battles).toBe(1)
  expect(readServerSave(bundle.db, id).relics).toHaveLength(2)
})
