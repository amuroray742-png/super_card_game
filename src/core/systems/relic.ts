/**
 * 遗物系统（§5.4）：生成、强化、分解、套装。
 *
 * 遗物是最大的乘区来源（zone 'relic'）。
 * 竞技模式下：只取套装效果（×0.7），随机词条与强化等级一律无效（§6.8）。
 */
import type { Rarity, RelicDef, RelicInstance, RelicSetDef, SaveData, StatMod } from '../model/types.ts'
import type { ItemId } from '../config/items.ts'
import { RELIC, RELIC_DROP, type DungeonDifficultyId } from '../config/economy.ts'
import type { RelicStoneTier } from '../config/economy.ts'
import { Rng } from '../rng.ts'

/** 遗物定义索引（由 config/relics.ts 在加载时注册） */
export const RELIC_DEFS = new Map<string, RelicDef>()
export const RELIC_SETS = new Map<string, RelicSetDef>()

export function registerRelics(defs: readonly RelicDef[], sets: readonly RelicSetDef[]) {
  for (const d of defs) RELIC_DEFS.set(d.id, d)
  for (const s of sets) RELIC_SETS.set(s.id, s)
}

// ─────────────────────── 遗物副本掉落（唯一一份口径） ───────────────────────

/**
 * 遗物稀有度档序（祈愿抽签与概率公示共用，**唯一一份**）。
 */
export const RELIC_RARITY_ORDER: readonly Rarity[] = ['N', 'R', 'SR', 'SSR']

/**
 * **遗物副本的稀有度概率表**（遗物唯一获取入口 `dungeon.challenge` 的公示口径）。
 *
 * ⚠ **唯一一份**：实际抽签（`rollRelicDrop`）与界面公示都读这个函数
 *   ⇒ 「公示的百分比」与「实际抽到的分布」必然一致（铁律 #4）。
 *
 * ⚠ 表现层**禁止**自己拿 `RELIC_DROP.RATES` 换算百分比——
 *   两处各算一套，换了权重就有一处对不上（合规硬要求：公示 = 实际）。
 */
export function relicDropRates(difficulty: DungeonDifficultyId): {
  rarity: Rarity
  weight: number
  percent: number
}[] {
  const rates = RELIC_DROP.RATES[difficulty]
  const total = RELIC_RARITY_ORDER.reduce((sum, r) => sum + (rates[r] ?? 0), 0)
  return RELIC_RARITY_ORDER.map((rarity) => {
    const weight = rates[rarity] ?? 0
    return { rarity, weight, percent: total > 0 ? weight / total : 0 }
  })
}

/** 按权重抽一个稀有度档（唯一一份抽签口径） */
function rollRarity(difficulty: DungeonDifficultyId, rng: Rng): Rarity {
  const rates = RELIC_DROP.RATES[difficulty]
  const entries = RELIC_RARITY_ORDER.map((rarity) => ({ rarity, weight: rates[rarity] ?? 0 }))
  const total = entries.reduce((sum, e) => sum + e.weight, 0)
  if (total <= 0) return 'N'
  let roll = rng.next() * total
  for (const entry of entries) {
    roll -= entry.weight
    if (roll < 0) return entry.rarity
  }
  return entries[entries.length - 1].rarity
}

/**
 * **遗物副本的一次掉落**（唯一一份产出逻辑，手动挑战与挂机通道共用）。
 *
 * 流程：
 *   ① 件数 = 难度档区间（`RELIC_DROP.COUNT`），并被 `maxCount` 裁剪；
 *   ② 稀有度 = 按权重抽（`RELIC_DROP.RATES`）；
 *   ③ 具体遗物 = 在该副本候选池里、该稀有度的候选里**等概率**抽一件；
 *   ④ **保底**：连续未出 SSR 达 `RELIC_DROP.PITY_SSR` **件** ⇒ 下一件必出 SSR。
 *
 * ⚠ **保底按「件」计**（不是按「场」）：一件遗物 = 一次抽签。
 *   所以「连续 10 件未出 SSR ⇒ 第 11 件必出 SSR」，
 *   且保底计数**逐件**累加 / 归零（一次掉 3 件就可能把计数推满 3）。
 *
 * ⚠ **保底计数必须随存档落盘**（`save.relicPity`）：
 *   否则刷新页面就重置 ⇒ 保底形同虚设，玩家可以无限「刷新重抽」（铁律 #24）。
 *
 * @param pool 该副本的候选遗物池（遗物定义 id）
 * @param pity 连续未出 SSR 的件数（跨场次累计，随存档落盘）
 * @param maxCount 本次最多产出几件（挂机通道用它按**每日额度**裁剪；
 *                手动挑战传默认上限＝不限）
 * @returns 掉落的遗物定义 id 列表 + 更新后的保底计数
 */
export function rollRelicDrop(
  pool: readonly string[],
  difficulty: DungeonDifficultyId,
  rng: Rng,
  pity: number,
  maxCount: number = Number.POSITIVE_INFINITY,
): { defIds: string[]; pity: number } {
  if (pool.length === 0) return { defIds: [], pity }
  const range = RELIC_DROP.COUNT[difficulty]
  const limit = Math.max(0, Math.floor(maxCount))
  const count = Math.min(rng.int(range.min, range.max), limit)
  if (count <= 0) return { defIds: [], pity }
  const defIds: string[] = []
  let curPity = pity

  for (let i = 0; i < count; i++) {
    // ⚠ 保底优先：连续未出 SSR 达阈值 ⇒ 这件必出 SSR
    const forced = curPity >= RELIC_DROP.PITY_SSR
    const rarity = forced ? 'SSR' : rollRarity(difficulty, rng)
    const candidates = pool.filter((id) => RELIC_DEFS.get(id)?.rarity === rarity)
    const defId =
      candidates.length > 0 ? rng.pick(candidates) : rng.pick([...pool])
    defIds.push(defId)
    // ⚠ 按**实际落地的稀有度**更新保底（兜底分支可能落到别的稀有度）
    const actual = RELIC_DEFS.get(defId)?.rarity ?? rarity
    curPity = actual === 'SSR' ? 0 : curPity + 1
  }

  return { defIds, pity: curPity }
}

// ─────────────────────── 每日额度（防通胀闸门） ───────────────────────

/**
 * 遗物产出的**日期键**（由注入的时钟推导，core 不读 `Date.now()`，铁律 #1）。
 *
 * ⚠ 用 **UTC**：客户端与服务端时区可能不同，UTC 保证「哪一天」的判定
 *   在任何设备上一致（额度是服务端权威的，但展示要与判定同源）。
 */
export function relicDailyKey(now: number): string {
  const d = new Date(now)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 遗物**今日剩余额度**（件）。
 *
 * ⚠ 这是**防通胀闸门**：遗物是零成本产出，而仓库溢出时会被自动分解
 *   并折算成银两 ⇒ 没有额度，挂机遗物通道就是印钞机。
 *
 * ⚠ 跨日自动重置（`date` 与今天不一致 ⇒ 当日计数按 0 算）。
 */
export function relicQuotaLeft(save: SaveData, now: number): number {
  const key = relicDailyKey(now)
  const daily = save.relicDaily
  const used = daily && daily.date === key ? daily.count : 0
  return Math.max(0, RELIC_DROP.DAILY_CAP - used)
}

/** 记一次遗物产出（跨日自动重置计数） */
export function recordRelicOutput(save: SaveData, now: number, count: number): void {
  if (count <= 0) return
  const key = relicDailyKey(now)
  const daily = save.relicDaily
  if (!daily || daily.date !== key) {
    save.relicDaily = { date: key, count }
    return
  }
  daily.count += count
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

/**
 * 强化石消耗（**按档位拆分**）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：强化石分三档（初阶 / 中阶 / 高阶），
 *   档位由「**目标等级**」决定（设计稿 §2「一次从 59 升到 62，
 *   消耗 1 个初阶段升级步骤和 2 个中阶段升级步骤对应的石量」）。
 *   单级升级恰好跨一档 → 本 map **只有一个 key**；批量跨档时按档累加。
 */
export type RelicStoneCosts = Partial<Record<ItemId, number>>

export interface RelicUpgradeCost {
  silver: number
  /** 强化石（按档位拆分） */
  stones: RelicStoneCosts
}

/**
 * 目标等级落在哪一档强化石。
 *
 * ⚠ 档位区间与淬炼段边界**刻意不对齐**：淬炼段（成本指数段）从 Lv61 起算，
 *   三档石从 Lv61~130 算——两者是**两套口径**（成本曲线 vs 材料种类）。
 */
export function relicStoneTierForLevel(targetLevel: number): RelicStoneTier | null {
  const target = Math.floor(targetLevel)
  for (const tier of RELIC.STONE_TIERS) {
    if (target >= tier.minLevel && target <= tier.maxLevel) return tier
  }
  return null
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
  const tier = relicStoneTierForLevel(Math.floor(level) + 1)
  if (!tier) return null
  const stoneCount = Math.max(
    1,
    Math.round(RELIC.STONES_PER_LEVEL * Math.pow(RELIC.STONE_COST_GROWTH, overSteps)),
  )
  return {
    silver: Math.round(RELIC.SILVER_PER_LEVEL * Math.pow(RELIC.COST_GROWTH, overSteps)),
    stones: { [tier.id]: stoneCount },
  }
}

/**
 * 强化到 `level` 为止的**累计投入**。
 *
 * ⚠ 按**逐级实际价格**累加（不是等比数列的解析式），
 *   这样「批量强化扣多少」与「分解返还多少」与玩家逐级点的账**完全对得上**
 *   （铁律 #4：扣费口径只有一份）。
 */
export function relicTotalCost(level: number): { silver: number; stones: RelicStoneCosts } {
  let silver = 0
  const stones: RelicStoneCosts = {}
  const target = Math.max(RELIC.MIN_LEVEL, Math.min(RELIC.MAX_LEVEL, Math.floor(level)))
  for (let l = RELIC.MIN_LEVEL; l < target; l++) {
    const cost = relicUpgradeCost(l)
    if (!cost) break
    silver += cost.silver
    for (const [id, n] of Object.entries(cost.stones)) {
      const key = id as ItemId
      stones[key] = (stones[key] ?? 0) + (n ?? 0)
    }
  }
  return { silver, stones }
}

/**
 * 从 `fromLevel` 强化到 `toLevel` 的**增量花费**（逐档差值）。
 *
 * ⚠ 批量强化跨档时（59 → 62）必须走这里：**逐档差值**
 *   = Lv60 步初阶 + Lv61/Lv62 步中阶（铁律 #44：逐级点的账与批量按钮的账要对得上）。
 */
export function relicCostDelta(
  fromLevel: number,
  toLevel: number,
): { silver: number; stones: RelicStoneCosts } {
  const from = relicTotalCost(fromLevel)
  const to = relicTotalCost(toLevel)
  const stones: RelicStoneCosts = {}
  const ids = new Set([...Object.keys(from.stones), ...Object.keys(to.stones)])
  for (const id of ids) {
    const key = id as ItemId
    const diff = (to.stones[key] ?? 0) - (from.stones[key] ?? 0)
    if (diff > 0) stones[key] = diff
  }
  return { silver: to.silver - from.silver, stones }
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
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：**只返银两**，不返强化石
 *   （设计稿 §2「建议分解只返银两，获得遗物到满仓处理均不携带副本材料」）。
 *   强化石是**副本专属产出**，分解若返还它就等于凭空造出副本材料。
 */
export function decomposeValue(instance: RelicInstance): { silver: number } {
  const def = RELIC_DEFS.get(instance.defId)
  const factor = def ? rarityWeight(def.rarity) : 1
  const invested = relicTotalCost(instance.level)
  const silver = Math.floor(
    (invested.silver + RELIC.SILVER_PER_LEVEL * factor) * RELIC.DECOMPOSE_RETURN_PCT,
  )
  return { silver }
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
