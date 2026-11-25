/**
 * 遗物 / 背包截图用的前置存档（造数据 → 走服务端动作层导入）。
 *
 * ## 为什么是「导入前置」而不是「真去刷遗物副本」
 *
 * ⚠ **存档 v12**：遗物**已彻底下线祈愿**，唯一来源是**遗物副本**
 *   （`dungeon.challenge` → `rewards.relics`，稀有度权重 + 保底都在 core 里）。
 *   真去刷的问题：
 *   - 一场遗物副本要**真实打一场战斗**（不是掷奖），60 件要刷上百场；
 *   - 掉落是**随机稀有度** ⇒ 刷不出「12 套各 5 件」这种整齐库存；
 *   - 截图要验的是「图标齐不齐 / 套装档位显不显眼 / 额度与保底显不显眼」，
 *     不是玩家运气 ⇒ 只能造数据。
 *
 *   （旧版靠挂机攒遗物：挂机一次要**真实等时间**（`IDLE.SECONDS_PER_ROLL`），
 *   「推征 10 场」的 10 只是**领取上限**，客户端不创造时间——
 *   三次点击累计的时间连一次都不够 → 仓库仍然是空的 → `.relic-cell` 永远等不到。
 *   `tests/e2e/relic.spec.ts` 的 `collectRelics()` 为此写了 180 秒重试循环，
 *   截图脚本没有这一层。）
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
import { RELIC_STONE_ITEM_BY_TIER, ITEM_BY_ELEMENT } from '../../src/core/config/items.ts'
import { RELIC, RELIC_DROP } from '../../src/core/config/economy.ts'
import {
  DUNGEON_INDEX,
  DUNGEON_VARIANT_ORDER,
  dungeonStagesOfVariant,
  relicPoolOf,
} from '../../src/core/config/dungeons.ts'
import { relicDailyKey, rollRelicDrop } from '../../src/core/systems/relic.ts'
import { Rng } from '../../src/core/rng.ts'
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
 * 前置存档的主线进度。
 *
 * ⚠ 必须**足够深**：遗物副本按「主线通关第 N 关」解锁（`RELIC_DROP.UNLOCK_STAGE`），
 *   而仓库里 12 套齐全 ⇒ 6 个遗物副本都该是「已解锁且已通关」状态，
 *   否则会出现「套装 5/5 件齐全，但它产出自己的副本还锁着」的矛盾画面。
 */
const FIXTURE_CLEARED_STAGE = 70

/**
 * 固定种子 ⇒ **同一张截图每次跑出来一样**。
 *
 * ⚠ 截图是**验收凭据**：每次随机 ⇒ 两张截图对不上 ⇒ 没法判断「图标变了没有」。
 */
const FIXTURE_SEED = 20260105

/**
 * 单个遗物副本最多刷多少轮（防呆）。
 *
 * ⚠ 正常 ~60 轮就能把一个副本的 10 件刷齐（SSR 靠保底必出，SR 靠 15% 概率）。
 *   这里给一个很大的上限：真到了上限就**报错**，而不是悄悄少几件
 *   （少几件 ⇒ 截图少几张图标 ⇒ 验收「漏掉了」也没人知道）。
 */
const MAX_GRINDS = 4000

/**
 * 按**遗物副本的产出规则**生成前置遗物。
 *
 * ⚠ 用的是 core 的 `rollRelicDrop`（**与实际掉落同一份逻辑**：稀有度权重 + 保底），
 *   池子取 `relicPoolOf(variant)`（该副本覆盖的 2 个套装的全部遗物）——
 *   **不在工具里另写一份概率表**（铁律 #4）。
 *
 * ⚠ **重复件不入库**：仓库每页 60 格（表现层 `pageSize`），
 *   截图要「60 张图标在同一屏里全部验收」⇒ 每种遗物只留**第一件**。
 *   （真实游戏里重复件是保留的；这里是为了截图可验收而刻意去重。）
 */
function grindRelicInventory(): RelicInstance[] {
  const rng = new Rng(FIXTURE_SEED)
  const out: RelicInstance[] = []
  const owned = new Set<string>()

  for (const variantId of DUNGEON_VARIANT_ORDER) {
    const variant = DUNGEON_INDEX.get(variantId)
    if (!variant || variant.kind !== 'relic') continue
    const pool = relicPoolOf(variant)
    if (!pool || pool.length === 0) continue

    // 刷到「这个副本的候选池全部在场」为止
    const need = new Set(pool)
    let pity = 0
    let rounds = 0
    while (need.size > 0) {
      rounds++
      if (rounds > MAX_GRINDS) {
        throw new Error(
          `遗物副本 ${variant.id} 刷了 ${MAX_GRINDS} 轮仍未刷齐，缺：${[...need].join(', ')}`,
        )
      }
      const rolled = rollRelicDrop(pool, 'easy', rng, pity)
      pity = rolled.pity
      for (const defId of rolled.defIds) {
        if (owned.has(defId)) continue
        owned.add(defId)
        const def = RELIC_INDEX.get(defId)
        const index = out.length
        out.push({
          uid: `shot-${defId}`,
          defId,
          // 等级 / 锁定 / 副词条按序错开，避免截图里 60 个格子长得一模一样
          level: RELIC.MIN_LEVEL + (index % 12),
          locked: index % 7 === 0,
          subStats: (def?.subStatPool ?? []).slice(0, 2),
        })
      }
      for (const id of [...need]) {
        if (owned.has(id)) need.delete(id)
      }
    }
  }

  return out
}

/**
 * 造前置存档。
 *
 * - **遗物**：按遗物副本的产出规则刷出来的 12 套 × 5 件（= 本次新增的 60 张图标一次性验收）；
 * - **套装进度**：12 套都在仓库里（进度行会显示「5 / 5 件」）；
 * - **保底进度**：各遗物副本关卡的 `save.relicPity` 错开取值 ⇒ 截图里几行「再 N 件」不同；
 * - **每日额度**：今日已产出的件数非 0 ⇒ 额度行显示「剩余 N 件」而不是满额；
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

  save.relics = grindRelicInventory()
  save.relicSeq = save.relics.length

  // ── 保底进度（存档 v12：随存档落盘，刷新页面不会重置）──
  //
  // ⚠ 保底**按「件」计**（不是按「场」）：连续 N 件未出 SSR ⇒ 下一件必出 SSR。
  //   这里按关卡下标错开取值 ⇒ 截图里几行的「再 N 件必出 SSR」不一样，
  //   看得出是**按关卡分别记**的，而不是全场一个数。
  for (const variantId of DUNGEON_VARIANT_ORDER) {
    const variant = DUNGEON_INDEX.get(variantId)
    if (!variant || variant.kind !== 'relic') continue
    const stages = dungeonStagesOfVariant(variant.id)
    stages.forEach((stage, index) => {
      save.relicPity[stage.id] = (index + 1) % RELIC_DROP.PITY_SSR
    })
  }

  // ── 每日额度（挂机通道的防通胀闸门）──
  //
  // ⚠ 额度按 **UTC 日期键** 判定（core 的 `relicDailyKey`），跨日自动重置。
  //   这里把「今日已产出」设成非 0，截图才看得到「剩余 N 件」而不是满额 15。
  save.relicDaily = { date: relicDailyKey(now), count: 5 }

  // 银两 / 强化石给足：强化按钮必须可点（否则截出来的是禁用态）。
  //
  // ⚠ **实施修正（资源/背包版本 v10）**：强化石不再是钱包字段（`player.relicStones`
  //   已退役），而是**背包里的堆叠道具**（`save.items[<道具 id>]`），且分三档。
  //   本 fixture 的目的只是「让强化按钮可点」——遗物从 Lv1 升到 Lv60 用的是
  //   **初阶强化石**，所以塞初阶石即可（道具 id 走唯一口径 `RELIC_STONE_ITEM_BY_TIER`，
  //   禁止就地写字符串 id）。
  save.player.silver = 5_000_000
  save.items[RELIC_STONE_ITEM_BY_TIER.relicStoneTier1] = 200_000

  save.campaign.clearedStage = FIXTURE_CLEARED_STAGE
  save.campaign.chapterProgress = 3
  // ⚠ **挂机改版 v11**：主线通道**跟随最新通关关卡**（`stageId = null`）。
  //   首胜前（`clearedStage = 0`）没有可挂的目标 ⇒ 通道不计量、不产出，
  //   但页面要能正常显示「跟随最新通关关卡」的状态。
  save.idle.channels.main.target = { kind: 'main', stageId: null }

  // ── 遗物副本关卡：全部**已通关** ──
  //
  // ⚠ 挂机只挂**已通关**的副本关卡（核心的 `idle.setChannel` 会拒未通关的关卡），
  //   仓库页的保底进度行也按关卡列 ⇒ 标成已通关，截图里不会出现「未通关」的空态。
  for (const variantId of DUNGEON_VARIANT_ORDER) {
    const variant = DUNGEON_INDEX.get(variantId)
    if (!variant || variant.kind !== 'relic') continue
    for (const stage of dungeonStagesOfVariant(variant.id)) {
      save.dungeons.cleared[stage.id] = true
    }
  }
  // ⚠ 遗物通道也挂上（第四通道）：截图要能看到「遗物通道已挂在某关」。
  // ⚠ 变体 id **不写死**：取变体顺序表里的**第一个遗物变体**
  //   （铁律 #3：禁止硬编码变体 id 列表）。
  const firstRelicVariantId = DUNGEON_VARIANT_ORDER.find(
    (id) => DUNGEON_INDEX.get(id)?.kind === 'relic',
  )
  const firstRelicStage = firstRelicVariantId
    ? dungeonStagesOfVariant(firstRelicVariantId)[0]
    : undefined
  if (firstRelicStage) {
    save.idle.channels.relic.target = { kind: 'relic', dungeonStageId: firstRelicStage.id }
  }

  return save
}

/**
 * 背包场景用的前置存档。
 *
 * ⚠ 资源/背包版本 v10：背包有 **5 个分类**（遗物 / 技能材料 / 强化材料 / 经验书 / 卡碎片），
 *   每个分类都得**有货可看**才验得了「数量、名称、直达入口」——
 *   空分类截出来只是一行「暂无」，看不出任何东西。
 *
 * - **五行技能材料**：每个五行都给（数量刻意错开，看得出五行筛选在起作用）；
 * - **强化石**：三档都给（初阶 / 中阶 / 高阶）；
 * - **经验书**：小书 + 大书都放（投喂预览要看面额）；
 * - **同名碎片**：给队里两名英灵（碎片页点一下要能跳到英灵页）。
 *
 * 道具 id 一律走 `ITEM_IDS` / `ITEM_BY_ELEMENT` 的唯一口径，**禁止就地写字符串**。
 */
export function buildBackpackFixture(now = Date.now()): SaveData {
  const save = buildRelicFixture(now)

  // 五行技能材料：数量错开 → 五行筛选切换时能看出差异
  const elementAmounts: Record<string, number> = {
    金: 240, 木: 180, 水: 150, 火: 96, 土: 64,
  }
  for (const [element, amount] of Object.entries(elementAmounts)) {
    const itemId = ITEM_BY_ELEMENT[element as keyof typeof ITEM_BY_ELEMENT]
    if (!itemId) throw new Error(`五行材料映射缺失：${element}`)
    save.items[itemId] = amount
  }

  // 强化石三档（初阶已有，这里补中阶 / 高阶）
  save.items[RELIC_STONE_ITEM_BY_TIER.relicStoneTier2] = 40
  save.items[RELIC_STONE_ITEM_BY_TIER.relicStoneTier3] = 12

  // 经验书：两种面额都放，投喂预览才看得出差异
  save.items.expBookSmall = 360
  save.items.expBookLarge = 24

  // 同名碎片：队里两名英灵（碎片页点一下要能跳到英灵页）
  save.player.shards = {
    [FIXTURE_TEAM[0]]: 240,
    [FIXTURE_TEAM[1]]: 60,
  }

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
