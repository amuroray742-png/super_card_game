/**
 * 遗物系统（§5.4）：生成、强化、分解、套装。
 *
 * 遗物是最大的乘区来源（zone 'relic'）。
 * 竞技模式下：只取套装效果（×0.7），随机词条与强化等级一律无效（§6.8）。
 */
import type { RelicDef, RelicInstance, RelicSetDef, SaveData, StatMod } from '../model/types.ts'
import { RELIC } from '../config/economy.ts'
import { Rng } from '../rng.ts'

/** 遗物定义索引（由 config/relics.ts 在加载时注册） */
export const RELIC_DEFS = new Map<string, RelicDef>()
export const RELIC_SETS = new Map<string, RelicSetDef>()

export function registerRelics(defs: readonly RelicDef[], sets: readonly RelicSetDef[]) {
  for (const d of defs) RELIC_DEFS.set(d.id, d)
  for (const s of sets) RELIC_SETS.set(s.id, s)
}

// ─────────────────────────── uid ───────────────────────────

/**
 * 由序号生成遗物 uid（**纯函数**）。
 *
 * 存档内的遗物 uid 一律经 `nextRelicUid(save)` 派生；
 * 本函数供**模拟 / 测试**等不入存档的场景使用。
 */
export function makeRelicUid(seq: number): string {
  return `r${seq.toString(36)}`
}

/**
 * 存档内的下一个遗物 uid（**自增，恒唯一**）。
 *
 * ⚠ 为什么不用随机后缀：随机后缀空间有限，遗物量级上千后必然碰撞；
 *   碰撞会让 `save.relics.find(r => r.uid === uid)` 命中**错误遗物**。
 *   存档内自增序号 → 唯一性由构造保证，且不依赖任何平台随机源（铁律 #1）。
 */
export function nextRelicUid(save: SaveData): string {
  save.relicSeq = (save.relicSeq ?? 0) + 1
  return makeRelicUid(save.relicSeq)
}

/**
 * 解析**旧格式** uid 里的计数器（迁移用）。
 *
 * 旧格式 = `r` + 计数器(36 进制) + 随机后缀(36 进制)，两段长度不定 → 无法唯一切分。
 * 这里返回**可能的最大计数器**（把除末位外的都当计数器），宁可高估也不低估，
 * 保证迁移后的新序号不会与任何旧 uid 撞上。
 */
export function parseLegacyRelicUid(uid: string): number | null {
  if (!uid.startsWith('r')) return null
  const rest = uid.slice(1)
  if (rest.length < 2) return null
  const counter = rest.slice(0, -1)
  const value = parseInt(counter, 36)
  return Number.isFinite(value) ? value : null
}

// ─────────────────────────── 生成 ───────────────────────────

/**
 * 生成一件遗物实例。
 * 主词条来自定义（固定），副词条从词条池随机抽取并定值（生成后不变）。
 *
 * @param uid 实例 id —— **由调用方从存档派生**（`nextRelicUid(save)`），
 *            本函数不生成 id，保证「生成遗物」是纯函数。
 */
export function generateRelic(
  defId: string,
  rng: Rng,
  level: number = RELIC.MIN_LEVEL,
  uid: string,
): RelicInstance {
  const def = RELIC_DEFS.get(defId)
  if (!def) throw new Error(`未知遗物定义：${defId}`)

  const pool = [...def.subStatPool]
  rng.shuffle(pool)
  const subStats: StatMod[] = pool.slice(0, Math.min(RELIC.SUB_COUNT, pool.length)).map((m) => ({
    ...m,
    value: roundMod(m.value * rng.float(0.8, 1.2)),
  }))

  return {
    uid,
    defId,
    level: clampLevel(level),
    subStats,
    locked: false,
  }
}

/** 批量生成（uid 由调用方按顺序给出） */
export function generateRelics(
  defIds: readonly string[],
  rng: Rng,
  uids: readonly string[],
): RelicInstance[] {
  return defIds.map((id, i) => generateRelic(id, rng, RELIC.MIN_LEVEL, uids[i] ?? makeRelicUid(i + 1)))
}

// ─────────────────────────── 属性 ───────────────────────────

/**
 * 遗物主词条倍率（按强化等级累计）。
 *
 * ⚠ **两段口径**（实施修正 · roadmap P1-2 后期资源过剩）：
 *   - Lv1 → `OVER_SEGMENT_START`（60）：每级 +`PCT_PER_LEVEL`（+3%）。
 *     **这一段与旧版逐位相同** —— Lv60 的倍率仍是 1 + 59×0.03 = 2.77，
 *     所以难度标定的参考队伍（relic ≤ 60）战力不变，锚点口径不受牵连。
 *   - Lv > `OVER_SEGMENT_START`：每级 +`PCT_PER_LEVEL_OVER`（+0.6%，**递减**）。
 *     淬炼段是**回收阀门**而不是新的战力来源：若这里仍按 +3% 递增，
 *     推到 Lv160 就是 ×4.6 倍遗物倍率，难度曲线会被单方面拉爆。
 */
export function relicMainMultiplier(level: number): number {
  const l = Math.max(RELIC.MIN_LEVEL, Math.floor(level))
  const standard = Math.min(l - RELIC.MIN_LEVEL, RELIC.OVER_SEGMENT_START - RELIC.MIN_LEVEL)
  const over = Math.max(0, l - RELIC.MIN_LEVEL - standard)
  return 1 + standard * RELIC.PCT_PER_LEVEL + over * RELIC.PCT_PER_LEVEL_OVER
}

/**
 * 遗物主词条按强化等级缩放；副词条固定不变。
 * 副词条是"随机词条"——竞技模式下会被忽略（见 getHeroSetMods）。
 */
export function getRelicMods(instance: RelicInstance): StatMod[] {
  const def = RELIC_DEFS.get(instance.defId)
  if (!def) return []
  const mult = relicMainMultiplier(instance.level)
  const main: StatMod[] = def.mainStats.map((m) => ({
    ...m,
    value: m.kind === 'pct' ? roundMod(m.value * mult) : roundMod(m.value * mult),
  }))
  const sub: StatMod[] = instance.subStats.map((m) => ({ ...m }))
  return [...main, ...sub]
}

/**
 * 已装备遗物的套装效果（zone 'relic'）。
 * PVE：全强度。竞技：由 resolveStats 按 setScale 打折后套用。
 */
export function getSetMods(instances: (RelicInstance | null)[]): StatMod[] {
  const counts = new Map<string, number>()
  for (const inst of instances) {
    if (!inst) continue
    const def = RELIC_DEFS.get(inst.defId)
    if (!def) continue
    counts.set(def.setId, (counts.get(def.setId) ?? 0) + 1)
  }

  const mods: StatMod[] = []
  for (const [setId, count] of counts) {
    const set = RELIC_SETS.get(setId)
    if (!set) continue
    for (const bonus of set.bonuses) {
      if (count >= bonus.pieces) mods.push(...bonus.mods)
    }
  }
  return mods
}

/** 某英灵身上的套装修正（不含单件词条） */
export function getHeroSetMods(hero: { relics: (RelicInstance | null)[] }): StatMod[] {
  return getSetMods(hero.relics)
}

/**
 * 按套装 id 列表计算套装效果。
 *
 * 竞技场专用：快照只记录"装备了哪几件套"，不含强化等级与随机词条，
 * 因此套装效果在竞技场中以固定标准强度生效（再由 resolveStats 按 setScale 打折）。
 */
export function getSetModsBySetIds(setIds: (string | null)[]): StatMod[] {
  const counts = new Map<string, number>()
  for (const setId of setIds) {
    if (!setId) continue
    counts.set(setId, (counts.get(setId) ?? 0) + 1)
  }
  const mods: StatMod[] = []
  for (const [setId, count] of counts) {
    const set = RELIC_SETS.get(setId)
    if (!set) continue
    for (const bonus of set.bonuses) {
      if (count >= bonus.pieces) mods.push(...bonus.mods)
    }
  }
  return mods
}

// ─────────────────────────── 强化 / 分解 ───────────────────────────

export interface RelicUpgradeCost {
  silver: number
  stones: number
}

/**
 * 强化 1 级的花费（从 `level` 升到 `level + 1`）。
 *
 * ⚠ **标准段（Lv1 → `OVER_SEGMENT_START`）价格恒定**，
 *   **淬炼段（Lv > `OVER_SEGMENT_START`）按等级指数上升**：
 *   银两 = `SILVER_PER_LEVEL × COST_GROWTH^(淬炼级数)`，
 *   强化石 = `STONES_PER_LEVEL × STONE_COST_GROWTH^(淬炼级数)`。
 *
 *   恒定价格 ⇒ 出口总量恒定（36 件 × 60 级 × 500 = 1.06×10⁶ 银两），
 *   而银两产出是 2.7×/章 的指数增长 ⇒ 恒定出口必然过剩。
 *   淬炼段的指数价格让「攒了多少银两」直接决定「遗物能推到多少级」，
 *   收入自动变成出口（回收阀门，§10.2）。
 *
 * ⚠ **标准段刻意不动**：早期经济逐位不变（玩家前几章的养成节奏不受影响）。
 *   淬炼段的价格在 Lv61 处与标准段**连续**（不跳价）。
 *
 * ⚠ 银两与强化石用**两个底数**：石头产出只 1.3×/章、银两 2.7×/章，
 *   共用一个底数会让强化石先见底。
 */
export function relicUpgradeCost(level: number): RelicUpgradeCost | null {
  if (level >= RELIC.MAX_LEVEL) return null
  const steps = Math.max(0, Math.floor(level) - RELIC.MIN_LEVEL)
  // ⚠ 指数只作用在「**目标等级**越过淬炼段起点」的那一次升级上：
  //   升到 Lv61 的那一次（Lv60 → Lv61）是淬炼段的第一级，价格已经开始上涨；
  //   Lv1 → Lv60 的标准段升级价格**恒定**（早期经济逐位不变）。
  const overSteps = Math.max(0, steps + 1 - (RELIC.OVER_SEGMENT_START - RELIC.MIN_LEVEL))
  return {
    silver: Math.round(RELIC.SILVER_PER_LEVEL * Math.pow(RELIC.COST_GROWTH, overSteps)),
    stones: Math.max(
      1,
      Math.round(RELIC.STONES_PER_LEVEL * Math.pow(RELIC.STONE_COST_GROWTH, overSteps)),
    ),
  }
}

/**
 * 强化到 `level` 为止的**累计投入**。
 *
 * ⚠ 按**逐级实际价格**累加（不是等比数列的解析式），
 *   这样「批量强化扣多少」与「分解返还多少」与玩家逐级点的账**完全对得上**
 *   （铁律 #4：扣费口径只有一份）。
 */
export function relicTotalCost(level: number): { silver: number; stones: number } {
  let silver = 0
  let stones = 0
  const target = Math.max(RELIC.MIN_LEVEL, Math.min(RELIC.MAX_LEVEL, Math.floor(level)))
  for (let l = RELIC.MIN_LEVEL; l < target; l++) {
    const cost = relicUpgradeCost(l)
    if (!cost) break
    silver += cost.silver
    stones += cost.stones
  }
  return { silver, stones }
}

export function applyRelicUpgrade(instance: RelicInstance): boolean {
  if (instance.level >= RELIC.MAX_LEVEL) return false
  instance.level++
  return true
}

/**
 * 分解返还 = (累计投入 + 稀有度残值) × `DECOMPOSE_RETURN_PCT`。
 *
 * ⚠ 口径由「500 × 等级 × 稀有度系数」改为**按累计投入折算**：
 *   旧公式让 SSR 遗物「强化到 60 级再分解」净赚 2.54×
 *   （投入 29,500 银两、返还 75,000 银两 + 150 强化石）——
 *   那是**造币漏洞**，不是回收阀门。成本指数上升后若沿用旧公式，
 *   返还额会相对投入彻底失控（Lv160 的投入是 Lv60 的 200 倍）。
 *
 * ⚠ 稀有度残值 = 「一件 1 级该稀有度遗物的价值」：
 *   ① 仓库溢出自动分解的**废件**仍有回收（不会变成纯惩罚）；
 *   ② 1 级遗物的分解返还与旧口径**逐位相同**（低等级经济不受影响）。
 */
export function decomposeValue(instance: RelicInstance): { silver: number; stones: number } {
  const def = RELIC_DEFS.get(instance.defId)
  const factor = def ? rarityWeight(def.rarity) : 1
  const invested = relicTotalCost(instance.level)
  const silver = Math.floor(
    (invested.silver + RELIC.SILVER_PER_LEVEL * factor) * RELIC.DECOMPOSE_RETURN_PCT,
  )
  const stones = Math.floor((invested.stones + factor) * RELIC.DECOMPOSE_RETURN_PCT)
  return { silver, stones }
}

function rarityWeight(rarity: string): number {
  switch (rarity) {
    case 'SSR':
      return 5
    case 'SR':
      return 3
    case 'R':
      return 1.5
    default:
      return 1
  }
}

// ─────────────────────────── 工具 ───────────────────────────

export function clampLevel(level: number): number {
  return Math.max(RELIC.MIN_LEVEL, Math.min(RELIC.MAX_LEVEL, Math.floor(level)))
}

function roundMod(v: number): number {
  return Math.round(v * 10000) / 10000
}

/** 遗物评分（用于列表排序与"是否更强"提示） */
export function relicScore(instance: RelicInstance): number {
  return getRelicMods(instance).reduce((sum, m) => {
    const weight = m.stat === 'hp' ? 0.28 : m.stat === 'atk' ? 2.2 : m.stat === 'def' ? 1.6 : 1
    return sum + (m.kind === 'pct' ? m.value * 100 * weight : m.value * weight)
  }, 0)
}
