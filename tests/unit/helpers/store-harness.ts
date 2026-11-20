/**
 * store 单测的公共夹具（服务端权威版）。
 *
 * 服务端权威后，store 的动作全走服务端 → 单测必须把 store 接到一个
 * **真实后端**上（见 `server-harness.ts`）。这里提供两件常用的事：
 *
 * - `registerAndLoad`：注册 → 载入存档（服务端建档）
 * - `seedSave`：直接种入真实临时SQLite夹具，再经权威拉档进入store
 *   （测试造状态不借用生产迁移权限，不增加生产测试接口）
 */
import { useAccountStore } from '../../../src/presentation/stores/account.ts'
import { useGameStore } from '../../../src/presentation/stores/game.ts'
import { createNewSave } from '../../../src/core/save/schema.ts'
import { seedServerSave } from './server-harness.ts'
import { createHeroState } from '../../../src/core/systems/growth.ts'
import type { SaveData } from '../../../src/core/model/types.ts'

export const TEST_PASSWORD = 'correct-horse-1'

/** 注册并登录（真实后端），返回已载入存档的 game store */
export async function registerAndLoad(username: string) {
  const account = useAccountStore()
  await account.register(username, TEST_PASSWORD)
  const store = useGameStore()
  await store.load()
  return store
}

/**
 * 造一份存档并推到服务端。
 *
 * 默认给一支满养成队伍（240 级 / 6★ / 满技能）与充足资源，
 * 让「挂机 / 强化 / 一键推荐」这类链路能真正跑起来。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：术式结晶 / 遗物强化石退役 →
 *   资源改放**背包堆叠物**（`save.items`）：
 *   - 五行技能材料（土系，项羽是土属性）× 21,000；
 *   - 三档强化石各 × 500。
 */
export async function seedSave(patch?: (save: SaveData) => void): Promise<SaveData> {
  const store = useGameStore()
  const save = createNewSave(Date.now(), 20240607)
  save.heroes['xiangyu'] = {
    ...createHeroState('xiangyu', 0),
    level: 240,
    star: 6,
    skillLevels: [20, 20, 20],
  }
  save.team.slots[0] = 'xiangyu'
  save.player.silver = 1_000_000
  save.items.skillMatEarth = 21_000
  save.items.relicStoneTier1 = 500
  save.items.relicStoneTier2 = 500
  save.items.relicStoneTier3 = 500
  patch?.(save)
  const userId = useAccountStore().user?.id
  if (!userId) throw new Error('Seed requires authenticated user')
  seedServerSave(userId, save)
  await store.load()
  return save
}
