import { afterEach, expect, it, vi } from 'vitest'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'
import { GameService } from '../../../server/src/game/service.ts'
import { UserLock } from '../../../server/src/game/lock.ts'
import { writeSave } from '../../../server/src/game/repo.ts'
import { createNewSave } from '../../../src/core/save/schema.ts'
import { createHeroState } from '../../../src/core/systems/growth.ts'
import { serialize, deserialize } from '../../../src/core/save/serialize.ts'

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
  expect(loaded?.offline?.battles).toBe(1)
  const after = deserialize(loaded!.save.payload)
  expect(after.campaign.clearedStage).toBe(1)
  expect(after.idle.currentStage).toBe(2)
  expect(after.lastTickAt).toBe(now - 500)
  const tick = await service.execute(id, { actionId: 'idle-zero', action: { type: 'idle.tick', battles: 100 } })
  expect((tick.result as { battles: number }).battles).toBe(0)
  expect(deserialize(tick.save!.payload).relics).toHaveLength(1)
  now += 5500
  const next = await service.execute(id, { actionId: 'idle-next', action: { type: 'idle.tick', battles: 1 } })
  expect((next.result as { battles: number }).battles).toBe(1)
  expect(deserialize(next.save!.payload).relics).toHaveLength(2)
})
