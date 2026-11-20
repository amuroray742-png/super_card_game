/**
 * 背包堆叠物的**流量口径**（资源/背包版本 v10）。
 *
 * ⚠ 为什么单独一份：
 *   经验书 → 经验的折算、五行技能材料 / 三档强化石的分类汇总，
 *   在 `report.ts` / `newplayer.ts` / `recalibrate.ts` 三处都要用到——
 *   各写一份必然对不上（铁律 #4 单一数据源）。
 *   口径全部取自 `core/config/items.ts`（面额与分类的唯一出处），本模块**不复算**任何数值。
 */
import { EXP_BOOK } from '../../src/core/config/economy.ts'
import { EXP_BOOK_ITEM_EXP, ITEM_DEFS, type ItemId } from '../../src/core/config/items.ts'
import { applyAction, type ActionContext } from '../../src/core/systems/actions.ts'
import { expToNext } from '../../src/core/systems/growth.ts'
import type { SaveData } from '../../src/core/model/types.ts'

/** 道具的分类（与 `config/items.ts` 的 `ItemCategory` 同口径） */
export type FlowCategory = 'skillMat' | 'relicStone' | 'expBook'

/** 道具 id → 展示名（取 `ITEM_DEFS`，禁止就地写中文名——铁律 #8） */
export function itemName(id: ItemId): string {
  return ITEM_DEFS[id].name
}

/**
 * 一批道具 → 折算经验。
 *
 * ⚠ 经验不再是独立资源：它只以「经验书的面值」存在（`EXP_BOOK_ITEM_EXP` 是唯一出处）。
 */
export function itemsToExp(items: Partial<Record<ItemId, number>> | undefined): number {
  if (!items) return 0
  let exp = 0
  for (const [id, count] of Object.entries(items)) {
    const bookExp = EXP_BOOK_ITEM_EXP[id as ItemId]
    if (!bookExp) continue
    exp += (count ?? 0) * bookExp
  }
  return exp
}

/** 道具表里某个分类的合计 */
export function categoryTotal(
  items: Partial<Record<ItemId, number>> | undefined,
  category: FlowCategory,
): number {
  if (!items) return 0
  let sum = 0
  for (const [id, count] of Object.entries(items)) {
    if (ITEM_DEFS[id as ItemId]?.category !== category) continue
    sum += count ?? 0
  }
  return sum
}

/** 道具表里某个分类的**逐 id** 明细 */
export function categoryDetail(
  items: Partial<Record<ItemId, number>> | undefined,
  category: FlowCategory,
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!items) return out
  for (const [id, count] of Object.entries(items)) {
    if (ITEM_DEFS[id as ItemId]?.category !== category) continue
    out[id] = count ?? 0
  }
  return out
}

/**
 * 背包里两类**副本材料**的合计。
 *
 * ⚠ 五行技能材料与三档强化石是**副本专属产出**——主线只掉经验书与银两，
 *   所以这两个合计恒为 0 就说明「没有副本就没有材料」（设计稿 §3）。
 */
export function materialTotals(items: Partial<Record<ItemId, number>> | undefined): {
  skillMats: number
  relicStones: number
} {
  return {
    skillMats: categoryTotal(items, 'skillMat'),
    relicStones: categoryTotal(items, 'relicStone'),
  }
}

/** 某个道具 id 的分类（未登记返回 null） */
export function categoryOf(id: string): FlowCategory | null {
  return ITEM_DEFS[id as ItemId]?.category ?? null
}

// ─────────────────────────── 喂经验书 ───────────────────────────

/**
 * 喂一本（批）经验书给某个英灵。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：玩家经验池退役 → 经验改由**经验书**承载。
 *   喂书动作用 `hero.feedBooks`（payload `{ heroId, bookId, count }`），
 *   旧动作 `hero.feedExp` 已作废（服务端返回 `CLIENT_OUTDATED`）。
 *
 * ⚠ 选本的逻辑：需要的经验够一本大书就用大书（用的本数少），
 *   否则用小书（避免一次喂太多、卡在境界门槛上存着）。
 *   无论哪种，**多喂的部分会存进 `hero.exp`**（`applyExp` 的硬上限是境界门槛），
 *   突破后立刻兑现——所以「多喂」不等于「浪费」。
 *
 * ⚠ 两个模拟脚本（`newplayer.ts` / `recalibrate.ts`）共用这一份：
 *   喂书口径只有一份（铁律 #4）。
 *
 * ⚠ **返回的经验是「真正投进去的」= booksUsed × 面值**，不是动作回包里的 `applied`：
 *   `applied` = 本次升掉的 + 英灵**身上存着的全部**经验，
 *   每喂一次就把存量重报一遍（喂 10 次就虚报 10 倍）——
 *   拿它当「消耗」会让回收比误判成「入不敷出」。
 */
export function feedBooks(
  save: SaveData,
  ctx: ActionContext,
  heroId: string,
): { fed: boolean; exp: number } {
  const state = save.heroes[heroId]
  if (!state) return { fed: false, exp: 0 }
  const need = Math.max(1, expToNext(state.level) - state.exp)
  const largeExp = EXP_BOOK_ITEM_EXP[EXP_BOOK.large.id] ?? 0
  const order: ItemId[] =
    need >= largeExp
      ? [EXP_BOOK.large.id, EXP_BOOK.small.id]
      : [EXP_BOOK.small.id, EXP_BOOK.large.id]
  for (const bookId of order) {
    const owned = save.items[bookId] ?? 0
    if (owned <= 0) continue
    const bookExp = EXP_BOOK_ITEM_EXP[bookId] ?? 0
    if (bookExp <= 0) continue
    const count = Math.min(owned, Math.max(1, Math.ceil(need / bookExp)))
    const fed = applyAction(save, { type: 'hero.feedBooks', heroId, bookId, count }, ctx)
    if (!fed.ok) continue
    // 真正投进去的经验 = 消耗的本数 × 面值（面额口径唯一出处 `EXP_BOOK_ITEM_EXP`）
    return { fed: true, exp: fed.result.booksUsed * bookExp }
  }
  return { fed: false, exp: 0 }
}

/**
 * 英灵身上**存着**的经验合计（`hero.exp`）。
 *
 * ⚠ 这部分经验**已经投入但还没兑现成等级**——它是玩家可用的经验，
 *   算净余额时必须算进去，否则会误报「入不敷出」。
 */
export function storedExp(save: SaveData): number {
  let exp = 0
  for (const state of Object.values(save.heroes)) {
    exp += state.exp ?? 0
  }
  return exp
}
