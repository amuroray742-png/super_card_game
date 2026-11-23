/**
 * 副本挑战截图用的**前置存档**（造数据 → 走服务端动作层导入）。
 *
 * ## 为什么必须导入前置
 *
 * ⚠ **手动挑战要队伍非空**（`core/systems/actions.ts` 的 `TEAM_EMPTY`）：
 *   新号十连只会得到**散落的英灵**，编队是空的 ⇒ 点「挑战」直接被拒，
 *   战斗根本不会发生（页面只弹一条 toast，截图等不到任何战斗画面）。
 * ⚠ **技能副本还要「该五行有可升技能的英灵」**（`dungeonUnlocked`）：
 *   金系副本要队里有金属性英灵 ⇒ 十连的随机结果不保证满足。
 *
 *   所以这里直接造一份**满编队伍**（含金属性英灵），
 *   走玩家可用的 `save.import` 动作导入（铁律 #11：只有服务端能改存档）。
 *
 * ⚠ 导入只对「服务端还没有存档」的账号开放（`IMPORT_FORBIDDEN`）：
 *   所以必须**先导入、再打开页面**——页面首屏若先建了档，导入就永远被拒。
 */
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import type { SaveData } from '../../src/core/model/types.ts'

/**
 * 截图用队伍（满编 6 人）。
 *
 * ⚠ 必须**含金属性英灵**（韩信）：技能副本的解锁判定是「该五行有可升技能的英灵」，
 *   没有金系英灵 → 金系副本 15 关全是「未解锁」，截图验不到任何东西。
 * ⚠ 等级要够打：`dgn_skillGold_easy` 的缩放锚点是 1.3635（标定值），
 *   Lv30 满编远高于该关的参考战力 → 稳赢（截图要验的是「打赢 → 写入通关记录」）。
 */
const FIXTURE_TEAM = ['hanxin', 'xiangyu', 'zhugeliang', 'jeannedarc', 'tesla', 'huatuo'] as const

/** 英灵等级（够打副本简易档） */
const FIXTURE_HERO_LEVEL = 30

/** 造前置存档：满编队伍 + 金系英灵（主线未通关，副本也没通关） */
export function buildDungeonFixture(now = Date.now()): SaveData {
  const save = createNewSave(now)

  FIXTURE_TEAM.forEach((id, slot) => {
    save.heroes[id] = { ...createHeroState(id, now), level: FIXTURE_HERO_LEVEL }
    save.team.slots[slot] = id
  })

  save.campaign.clearedStage = 0
  save.campaign.chapterProgress = 1
  // ⚠ 主线通道**跟随最新通关关卡**（`stageId = null`）：首胜前没有可挂目标。
  save.idle.channels.main.target = { kind: 'main', stageId: null }

  return save
}

/** 把前置存档导入隔离后端（走玩家那条 `POST /api/action`） */
export async function importDungeonFixture(
  api: string,
  accessToken: string,
  save: SaveData,
): Promise<void> {
  const res = await fetch(`${api.replace(/\/$/, '')}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      actionId: `shot-dungeon-fixture-${Date.now()}`,
      action: { type: 'save.import', payload: exportSave(save) },
    }),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null
  if (!res.ok || !body?.ok) {
    throw new Error(`导入前置存档失败：HTTP ${res.status} ${body?.message ?? '(无回包)'}`)
  }
}
