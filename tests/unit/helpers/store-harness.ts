/**
 * store 单测的公共夹具（服务端权威版）。
 *
 * 服务端权威后，store 的动作全走服务端 → 单测必须把 store 接到一个
 * **真实后端**上（见 `server-harness.ts`）。这里提供两件常用的事：
 *
 * - `registerAndLoad`：注册 → 载入存档（服务端建档）
 * - `seedSave`：造一份存档并通过「导入存档」动作推到服务端
 *   （玩家主动导入是唯一能整份替换存档的入口，与真实玩法一致）
 */
import { useAccountStore } from '../../../src/presentation/stores/account.ts'
import { useGameStore } from '../../../src/presentation/stores/game.ts'
import { createNewSave } from '../../../src/core/save/schema.ts'
import { exportSave } from '../../../src/core/save/serialize.ts'
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
  save.player.skillStones = 21_000
  save.player.relicStones = 500
  patch?.(save)
  const ok = await store.importSaveText(exportSave(save))
  if (!ok) throw new Error('导入存档失败')
  return save
}
