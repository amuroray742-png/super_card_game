/**
 * 遗物截图用的前置存档（造数据 → 走服务端动作层导入）。
 *
 * ## 为什么是「导入前置」而不是「挂机攒遗物」
 *
 * 遗物只从推征（挂机）与离线结算产出，而挂机一场要**真实等时间**
 * （`BATTLE.SECONDS_PER_BATTLE` = 6 秒/场）。截图脚本原来点 3 次「推征 10 场」
 * 就等遗物出现，但按钮上的「10 场」只是**领取上限**，客户端不创造时间：
 * 三次点击累计的时间连一场都不够 → 仓库仍然是空的 → `.relic-cell` 永远等不到
 * （`tests/e2e/relic.spec.ts` 的 `collectRelics()` 为此写了 180 秒重试循环，
 * 截图脚本没有这一层）。
 *
 * 现在改用**玩家可用的 `save.import` 动作**导入前置存档——
 * 与 `tests/e2e/authority.spec.ts` 造前置同一口径（走服务端动作层，不碰数据库）：
 * - 一次到位，不依赖真实时间、挂机效率与随机掉落；
 * - 60 件遗物（12 套 × 5）**全部在场** → 一张仓库截图就能验收全部图标。
 *
 * ⚠ 导入只能对「服务端还没有存档」的账号做（`IMPORT_FORBIDDEN`）：
 *   所以必须**先导入、再打开页面**——页面首屏若先建了档，导入就永远被拒。
 */
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { RELIC_INDEX } from '../../src/core/config/relics.ts'
import { RELIC } from '../../src/core/config/economy.ts'
import { STAGES } from '../../src/core/config/stages.ts'
import type { RelicInstance, SaveData } from '../../src/core/model/types.ts'

/**
 * 截图用队伍（满编 6 人）。
 *
 * ⚠ 人数不够会被卡在第 1 关（`tests/e2e/relic.spec.ts` 实测 2 人队只打 3 场就卡关），
 *   卡关后不再有掉落 —— 满编是「能刷出遗物」的前提。
 */
const FIXTURE_TEAM = ['xiangyu', 'hanxin', 'zhugeliang', 'jeannedarc', 'tesla', 'huatuo'] as const

/** 英灵等级（够打，也够让「一键推荐装备」的增量看得见） */
const FIXTURE_HERO_LEVEL = 30

/**
 * 造前置存档。
 *
 * - **遗物**：12 套 × 5 件全部在场（= 本次新增的 60 张图标一次性验收）；
 *   等级 / 锁定 / 副词条按序错开，避免截图里 60 个格子长得一模一样。
 * - **副词条**：直接取自定义表的 `subStatPool`——
 *   导入校验要求副词条与词条池**逐字段相等**（`stat/kind/zone/value`），
 *   自己编数值会被判成非法存档。
 */
export function buildRelicFixture(now = Date.now()): SaveData {
  const save = createNewSave(now)

  FIXTURE_TEAM.forEach((id, slot) => {
    save.heroes[id] = { ...createHeroState(id, now), level: FIXTURE_HERO_LEVEL }
    save.team.slots[slot] = id
  })

  save.relics = Array.from(RELIC_INDEX.values()).map((def, index): RelicInstance => ({
    uid: `shot-${def.id}`,
    defId: def.id,
    level: RELIC.MIN_LEVEL + (index % 12),
    locked: index % 7 === 0,
    subStats: def.subStatPool.slice(0, 2),
  }))
  save.relicSeq = save.relics.length

  // 银两 / 强化石给足：强化按钮必须可点（否则截出来的是禁用态）。
  save.player.silver = 5_000_000
  save.player.relicStones = 200_000

  save.campaign.clearedStage = 0
  save.campaign.chapterProgress = 1
  save.idle.currentStage = STAGES[0].id
  save.idle.autoAdvance = false

  return save
}

/**
 * 把前置存档导入隔离后端。
 *
 * ⚠ 走的是**玩家那条** `POST /api/action`（铁律 #11：只有服务端能改存档），
 *   动作负载与响应口径复用 core 的 `action-protocol.ts`。
 */
export async function importRelicFixture(
  api: string,
  accessToken: string,
  save: SaveData,
): Promise<void> {
  const res = await fetch(`${api.replace(/\/$/, '')}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      actionId: `shot-relic-fixture-${Date.now()}`,
      action: { type: 'save.import', payload: exportSave(save) },
    }),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null
  if (!res.ok || !body?.ok) {
    throw new Error(`导入前置存档失败：HTTP ${res.status} ${body?.message ?? '(无回包)'}`)
  }
}
