/**
 * 存档结构与迁移链（§12.3 铁律 #4）。
 *
 * 存档带版本号与迁移链，保证后续更新不丢档。
 */
import type { IdleChannelKind, IdleChannelTarget, SaveData } from '../model/types.ts'
import { IDLE_CHANNEL_KINDS, type ChannelRngState } from '../model/types.ts'
import type { ItemId } from '../config/items.ts'
import {
  START_ITEMS,
  START_RESOURCES,
  LEGACY_CONVERSION,
  EXP_BOOK,
} from '../config/economy.ts'
import { ITEM_IDS } from '../config/items.ts'
import { STAGE_INDEX } from '../config/stages.ts'
import { DUNGEON_INDEX, DUNGEON_STAGE_INDEX } from '../config/dungeons.ts'
import { arenaWeekIndex } from '../time.ts'
import { Rng, hashSeed } from '../rng.ts'
import { makeRelicUid, parseLegacyRelicUid, RELIC_DEFS, RELIC_SETS } from '../systems/relic.ts'
import { emptyLadderSquads } from '../config/ladder.ts'
import '../config/relics.ts'

export const SAVE_VERSION = 12

export type Migration = (save: SaveData) => SaveData

/** 已登记的道具 id 集合（O(1) 判定） */
const ITEM_ID_SET = new Set<string>(ITEM_IDS)

/**
 * 四条挂机通道**各自**的随机序列（挂机改版 v11 · 设计稿 §3.3；存档 v12 加遗物通道）。
 *
 * ⚠ 通道种子由**存档根种子**派生：四条序列互不相同，但都随存档落盘。
 *   根种子轮换（服务端补种子 / 迁移轮换）时四条通道的序列一起换，
 *   不会「一个玩家一条固定序列」（铁律 #24）。
 *
 * ⚠ 这份状态住在**私有随机块** `save.rng` 里 —— 公开快照 / 缓存 / 导出串
 *   一律省略整个 `rng`，所以通道种子绝不会下发客户端。
 */
export function createChannelRng(seed: number): Record<IdleChannelKind, ChannelRngState> {
  const root = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 0
  const out = {} as Record<IdleChannelKind, ChannelRngState>
  for (const kind of IDLE_CHANNEL_KINDS) {
    const derived = new Rng((root ^ hashSeed(`sgw:idle:${kind}`)) >>> 0).nextSeed()
    out[kind] = { seed: derived || 0x9e3779b9, counter: 0 }
  }
  return out
}

/**
 * 规范化通道随机状态：缺字段 / 非法值 → 按**根种子**重新派生。
 *
 * ⚠ 合法值**原样保留**（计数器必须落盘，否则刷新页面就回到序列开头）。
 */
export function normalizeChannelRng(
  raw: unknown,
  seed: number,
): Record<IdleChannelKind, ChannelRngState> {
  const fallback = createChannelRng(seed)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const src = raw as Record<string, unknown>
  const out = {} as Record<IdleChannelKind, ChannelRngState>
  for (const kind of IDLE_CHANNEL_KINDS) {
    const entry = src[kind]
    const s = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).seed : undefined
    const c = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).counter : undefined
    const ok =
      typeof s === 'number' &&
      Number.isSafeInteger(s) &&
      s > 0 &&
      typeof c === 'number' &&
      Number.isSafeInteger(c) &&
      c >= 0
    out[kind] = ok ? { seed: s as number, counter: c as number } : fallback[kind]
  }
  return out
}

/**
 * 读取存档里的数值字段（旧档可能缺字段 / 类型不对）。
 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * 剔除**退役**的玩家字段（v10 起不再存在）。
 *
 * ⚠ 这些字段在 v9 及更早存在：抽卡券 / 英灵印记 / 玩家经验池 /
 *   术式结晶 / 遗物强化石。迁移（`MIGRATIONS[9]`）负责把它们折算进新结构，
 *   本函数在迁移**之后**收尾，保证它们不会残留在 v10 存档里
 *   （手工构造 / 畸形导入也无法复活它们）。
 */
function stripRetiredPlayerFields(save: SaveData): void {
  const player = save.player as unknown as Record<string, unknown>
  delete player.tickets
  delete player.emblems
  delete player.exp
  delete player.skillStones
  delete player.relicStones
}

/**
 * 迁移链：键为"从该版本升级"，值为迁移函数。
 * 升级时按版本号从小到大依次执行。
 */
export const MIGRATIONS: Record<number, Migration> = {
  // v1 → v2：补齐竞技场字段
  1: (save) => {
    save.arena = emptyArena()
    return save
  },
  // v2 → v3：补齐日常任务字段
  2: (save) => {
    save.daily = {
      signInStreak: 0,
      lastSignInDay: 0,
      taskProgress: {},
      taskClaimed: [],
      taskDay: 0,
      taskWeek: 0,
    }
    return save
  },
  // v3 → v4：补齐存档写入时间戳（多上下文冲突检测用）
  //
  // 旧档没有这个字段，一律按 0 处理——0 永远「不比别人新」，
  // 因此旧档在首次写入时不会被误判成外部更新。
  3: (save) => {
    save.savedAt = typeof save.savedAt === 'number' ? save.savedAt : 0
    return save
  },
  // v4 → v5：补齐随机数状态快照（种子 + 计数器）
  //
  // 种子留 0（= 未设置）：由服务端在载入时补一个随机种子。
  // 若在这里用常量种子兜底，所有旧档玩家会共用同一条抽卡序列（铁律 #24）。
  4: (save) => {
    save.rng = { seed: 0, counter: 0, channels: createChannelRng(0) }
    return save
  },
  // v5 → v6：旧版曾把权威随机状态发给客户端，载入后轮换该序列。
  5: (save) => {
    // ⚠ 挂机改版 v11 / 遗物副本 v12：四条通道的序列也一起轮换（服务端补根种子时会再派生一次）
    save.rng = { seed: 0, counter: 0, channels: createChannelRng(0) }
    return save
  },
  // v6 → v7：遗物 uid 改为**存档内自增**。
  //
  // 旧 uid = `r` + 计数器(36 进制) + 随机后缀(36 进制)，两段长度不定 → 无法唯一切分，
  // 而且计数器是**模块级全局变量**（进程重启即归零）→ 会与存档里已有 uid 重复，
  // `find(uid)` 命中错误遗物（强化 / 分解错件）。
  //
  // 迁移策略：给每件遗物**重新编号**成 `r` + 新序号（序号从「所有旧 uid 可能的最大计数器」之后开始），
  // 并同步改写 `save.equipped` 里的 relicId 引用（装备关系不能丢）。
  6: (save) => {
    // 旧格式后缀至少 1 位 → 计数器最大只能取「除末位以外」的那段
    let maxCounter = 0
    for (const relic of save.relics) {
      const counter = parseLegacyRelicUid(relic.uid)
      if (counter !== null && counter > maxCounter) maxCounter = counter
    }
    const remap = new Map<string, string>()
    let seq = maxCounter
    for (const relic of save.relics) {
      seq += 1
      const next = makeRelicUid(seq)
      remap.set(relic.uid, next)
      relic.uid = next
    }
    for (const entry of Object.values(save.equipped)) {
      const mapped = remap.get(entry.relicId)
      if (mapped) entry.relicId = mapped
    }
    save.relicSeq = seq
    return save
  },
  // v7 → v8：任务计数改为**按周期分桶**（每日任务 / 周目标）
  //
  // 旧结构只有一个 `taskProgress` 字典，且从来没有内容（页面上的「每日任务」
  // 一直是占位）。现在计数按 `metric:period` 分桶：
  // 同一个行为同时计入每日与每周两个口径，但两者的重置边界不同。
  //
  // 迁移策略：清空旧计数与旧领取记录（本来就没有内容），
  // 并补上周期归属字段（0 = 不属于任何一天 / 任何一周 → 首次动作时自动滚动）。
  7: (save) => {
    save.daily = {
      signInStreak: save.daily?.signInStreak ?? 0,
      lastSignInDay: save.daily?.lastSignInDay ?? 0,
      taskProgress: {},
      taskClaimed: [],
      taskDay: 0,
      taskWeek: 0,
    }
    return save
  },
  // v8 → v9：新增 PVE 长线挑战 · 三队天梯（§9.1 / roadmap P2-2）
  //
  // 新增 `arena.ladder`（三队阵容 / 赛季 / 回流）与 `arena.arenaMaterials`、
  // `arena.weeklyMaterials`（竞技专属材料此前只出现在结算结果里，从未入库）。
  //
  // 迁移策略：
  // - 三队阵容**留空**（旧档没有编过队，不能凭空生成）；
  // - 赛季初始化为「未初始化」（season = 0），首次动作时按当前周自动开赛季；
  // - `lastActiveAt` 置 0 = 「从未活跃」→ 不被判成回流（避免老玩家一上线就领回流奖励）。
  8: (save) => {
    save.arena = {
      ...emptyArena(save.savedAt || save.lastTickAt || save.createdAt || 0),
      ...save.arena,
      arenaMaterials: save.arena?.arenaMaterials ?? 0,
      weeklyMaterials: save.arena?.weeklyMaterials ?? 0,
      ladder: emptyLadder(),
    }
    return save
  },
  // v9 → v10：**资源/背包版本**（钱包收敛 + 通用道具系统）
  //
  // 折算口径见 `economy.ts` 的 `LEGACY_CONVERSION`；数值待策划确认
  // （实现文档 §5）。⚠ 本迁移必须**幂等**——`migrate()` 每次载入都会跑一遍。
  //
  // ⚠ 术式结晶 / 遗物强化石**不自动折算**，而是记进 `save.legacy` 的一次性
  //   分配权益，由玩家自己选一个五行 / 一个石档（避免强塞无用材料）。
  9: (save) => {
    const player = save.player as unknown as Record<string, unknown>

    // ① 抽卡券 → 圣杯结晶（设计稿 §2「原券按每张 300 结晶折算」）
    const tickets = num(player.tickets)
    if (tickets > 0) save.player.crystals += tickets * LEGACY_CONVERSION.ticketToCrystals

    // ② 英灵印记 → 银两（按旧突破购买力折算，实现文档 §2）
    const emblems = num(player.emblems)
    if (emblems > 0) save.player.silver += emblems * LEGACY_CONVERSION.emblemToSilver

    // ③ 玩家经验池 → 经验书（大书优先，尾差向上补足一本小书）
    const pool = num(player.exp)
    if (pool > 0) {
      const smallExp = EXP_BOOK.small.exp
      const largeExp = EXP_BOOK.large.exp
      const largeCount = Math.floor(pool / largeExp)
      let rest = pool - largeCount * largeExp
      const smallCount = Math.floor(rest / smallExp)
      rest -= smallCount * smallExp
      // 尾差向上补足一本小书（补差不超过一本小书）
      const smallTotal = smallCount + (rest > 0 ? 1 : 0)
      save.items[EXP_BOOK.small.id] = (save.items[EXP_BOOK.small.id] ?? 0) + smallTotal
      if (largeCount > 0) {
        save.items[EXP_BOOK.large.id] = (save.items[EXP_BOOK.large.id] ?? 0) + largeCount
      }
    }

    // ④ 术式结晶 / 遗物强化石 → 一次性分配权益（只加不清零 ⇒ 幂等）
    save.legacy.skillStones += num(player.skillStones)
    save.legacy.relicStones += num(player.relicStones)

    return save
  },
  // v10 → v11：**挂机改版**（三通道并行 + 已通关直挂 + 副本独立关卡）
  //
  // 旧结构：三个去向**共用一份时间账本**（`idle.measuredAt` / `effectiveMs` / …），
  //   外加 `idle.target` / `idle.currentStage` / `idle.farm` / `idle.autoAdvance`。
  // 新结构：**三条通道各自独立账本**（`idle.channels.{main,skill,enhance}`），
  //   挂机**不再跑战斗**，只按掉落表掷奖；主线推进改为**纯手动挑战**。
  //
  // 迁移策略：
  // - 主线通道恢复「**跟随最新通关关卡**」（`stageId = null`）；
  // - 技能 / 强化通道**关闭**（旧档的副本去向在 v11 已无对应语义）；
  // - 三条通道的有效预算 / 离线累计 / 待报告时长**全部清零**：
  //   旧档的预算口径是「回放战斗的场次」，与新的「掷奖次数」不是同一件事，
  //   直接继承会让玩家凭空多拿一次结算；
  // - 副本通关记录清空（副本改为独立关卡，旧档没有可继承的通关状态）。
  10: (save) => {
    // ⚠ v10 的 `idle` 是**旧形状**（单一账本），TS 里已不存在 ⇒ 用局部类型描述它
    const legacyIdle = save.idle as unknown as {
      measuredAt?: number
      activeUntil?: number
      totalIdleSeconds?: number
    } | undefined
    const measuredAt = Number.isFinite(legacyIdle?.measuredAt)
      ? (legacyIdle!.measuredAt as number)
      : save.lastTickAt
    save.idle = {
      channels: {
        main: emptyIdleChannel({ kind: 'main', stageId: null }, measuredAt),
        skill: emptyIdleChannel(null, measuredAt),
        enhance: emptyIdleChannel(null, measuredAt),
        // ⚠ 遗物通道在 v12 才存在，这里先占位（保持类型完整）；
        //   随后的 `MIGRATIONS[11]` 会**重建**它（关闭、无预算），
        //   所以这里填什么都不影响最终结果。
        relic: emptyIdleChannel(null, measuredAt),
      },
      activeUntil: Number.isFinite(legacyIdle?.activeUntil)
        ? (legacyIdle!.activeUntil as number)
        : measuredAt,
      totalIdleSeconds: Math.max(
        0,
        Number.isFinite(legacyIdle?.totalIdleSeconds) ? (legacyIdle!.totalIdleSeconds as number) : 0,
      ),
    }
    save.dungeons = { cleared: {} }
    return save
  },
  // v11 → v12：**遗物副本**（遗物的唯一来源从「银两祈愿」改为「遗物副本」）
  //
  // 旧结构：三条挂机通道（`idle.channels.{main,skill,enhance}`），
  //   遗物来自独立动作 `relic.acquire`（花 5000 银两祈愿）。
  // 新结构：**第四条通道** `idle.channels.relic`（遗物副本专属），
  //   外加遗物副本的**保底计数**与**每日产出计数**。
  //
  // 迁移策略：
  // - 新增遗物通道，**关闭**（旧档没有遗物副本目标可继承）；
  // - 其余三条通道**原样保留**（它们的账本与随机序列语义没变）；
  // - 保底计数清空（旧档的遗物来自祈愿，没有副本保底概念）；
  // - 每日产出计数清零（额度从 v12 起算）。
  11: (save) => {
    const measuredAt = Number.isFinite(save.idle?.channels?.main?.measuredAt)
      ? (save.idle!.channels!.main!.measuredAt as number)
      : save.lastTickAt
    save.idle = {
      ...save.idle,
      channels: {
        ...save.idle.channels,
        relic: emptyIdleChannel(null, measuredAt),
      },
    }
    save.relicPity = {}
    save.relicDaily = { date: '', count: 0 }
    return save
  },
}

/** 空的天梯状态 */
export function emptyLadder(): SaveData['arena']['ladder'] {
  return {
    squads: emptyLadderSquads(),
    lastSettledWeek: null,
    seasonPoints: 0,
    season: 0,
    seasonStartWeek: 0,
    seasonTitles: [],
    lastActiveAt: 0,
    lastReturnAt: 0,
    returnPending: false,
    returnDays: 0,
  }
}

export function emptyArena(now = 0): SaveData['arena'] {
  return {
    tierPoints: 0,
    pvpPoints: 0,
    medals: 0,
    arenaMaterials: 0,
    weeklyMedals: 0,
    weeklyMaterials: 0,
    weeklyTickets: 0,
    rewardWeek: arenaWeekIndex(now),
    arenaLevel: 0,
    runes: [],
    defenseLoadout: null,
    snapshotHash: null,
    ladder: emptyLadder(),
  }
}

/**
 * 空的挂机通道状态（新建 / 迁移的起点）。
 *
 * ⚠ 计量水位 = 建档时刻（服务端当前时刻）；有效预算、离线累计、
 *   待报告时长一律为 0（还没有任何时间被计量过）。
 */
export function emptyIdleChannel(
  target: SaveData['idle']['channels']['main']['target'],
  measuredAt: number,
): SaveData['idle']['channels']['main'] {
  return { target, measuredAt, effectiveMs: 0, offlineElapsedMs: 0, pendingOfflineMs: 0 }
}

/**
 * 新建存档。
 *
 * @param now  创建时间（毫秒）
 * @param seed 随机数种子。**不得写死常量**——写死会让所有玩家抽到
 *             完全相同的序列（铁律 #24）。传 0 表示「未设置」，
 *             由服务端在载入时补种子。
 */
export function createNewSave(now: number, seed = 0): SaveData {
  return {
    version: SAVE_VERSION,
    createdAt: now,
    lastTickAt: now,
    // 新建存档尚未写入存储，时间戳由 store 在首次 persist 时盖上
    savedAt: 0,
    rng: { seed, counter: 0, channels: createChannelRng(seed) },
    player: {
      silver: START_RESOURCES.silver,
      crystals: START_RESOURCES.crystals,
      shards: {},
      permBoost: 0,
      rebirthCount: 0,
    },
    items: { ...START_ITEMS },
    legacy: { skillStones: 0, relicStones: 0, allocated: false },
    heroes: {},
    relics: [],
    relicSeq: 0,
    equipped: {},
    team: { slots: [null, null, null, null, null, null], presets: [] },
    gacha: { pitySSR: 0, pity10: 0, history: [], pools: {}, newbieUsed: false },
    campaign: { clearedStage: 0, stageStars: {}, chapterProgress: 1, creditedStages: 0 },
    idle: {
      channels: {
        // 主线通道默认「跟随最新通关关卡」；首胜前没有可挂的目标 → 不计收益
        main: emptyIdleChannel({ kind: 'main', stageId: null }, now),
        // 技能 / 强化 / 遗物通道开局关闭，玩家在首胜后主动设置目标
        skill: emptyIdleChannel(null, now),
        enhance: emptyIdleChannel(null, now),
        relic: emptyIdleChannel(null, now),
      },
      activeUntil: now,
      totalIdleSeconds: 0,
    },
    relicPity: {},
    relicDaily: { date: '', count: 0 },
    dungeons: { cleared: {} },
    codes: [],
    settings: { speed: 1, sfx: true, skipAnim: false },
    stats: { firstStartAt: now, totalPulls: 0, totalPower: 0 },
    arena: emptyArena(now),
    daily: {
      signInStreak: 0,
      lastSignInDay: 0,
      taskProgress: {},
      taskClaimed: [],
      taskDay: 0,
      taskWeek: 0,
    },
  }
}

/**
 * 天梯状态兜底：逐字段补齐，形状永远是「3 队 × 6 槽」。
 *
 * ⚠ 旧档的 `ladder` 整个不存在（v8 及以前）→ 走 `emptyLadder()`。
 */
function normalizeLadder(raw: Partial<SaveData['arena']['ladder']> | undefined): SaveData['arena']['ladder'] {
  const base = emptyLadder()
  if (!raw) return base
  const squads = raw.squads
  const normalized: (string | null)[][] = emptyLadderSquads()
  if (Array.isArray(squads)) {
    for (let s = 0; s < normalized.length; s++) {
      const row = squads[s]
      if (!Array.isArray(row)) continue
      for (let i = 0; i < normalized[s].length; i++) {
        const id = row[i]
        normalized[s][i] = typeof id === 'string' && id.length > 0 ? id : null
      }
    }
  }
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    squads: normalized,
    lastSettledWeek: Number.isInteger(raw.lastSettledWeek) ? (raw.lastSettledWeek as number) : null,
    seasonPoints: Math.max(0, num(raw.seasonPoints, 0)),
    season: Math.max(0, Math.floor(num(raw.season, 0))),
    seasonStartWeek: Math.floor(num(raw.seasonStartWeek, 0)),
    seasonTitles: Array.isArray(raw.seasonTitles) ? raw.seasonTitles.filter((t) => typeof t === 'string') : [],
    lastActiveAt: num(raw.lastActiveAt, 0),
    lastReturnAt: num(raw.lastReturnAt, 0),
    returnPending: raw.returnPending === true,
    returnDays: Math.max(0, num(raw.returnDays, 0)),
  }
}

/**
 * 规范化背包堆叠物：只保留**已登记**的道具 id，值取非负整数。
 *
 * ⚠ 未知道具 id 一律丢弃——存档里出现未登记的 id 说明数据有问题，
 *   留着会让背包页显示出一个「没有名字也没有图标」的条目（铁律 #22）。
 *
 * ⚠ 返回的是**完整**的道具表（未持有的道具填 0）：
 *   `SaveData.items` 的类型是 `Record<ItemId, number>`，
 *   缺键会让「新增道具」这条链路的类型检查失效。
 *
 * ⚠ **起点是全 0，不是 `START_ITEMS`**：
 *   `START_ITEMS` 是**新号**的起步道具（`createNewSave` 单独发放）。
 *   若规范化时也补上，老玩家每次载入都会白拿一遍起步书；
 *   而且「持有 0 个」与「没有这个键」无法区分 → 玩家清空背包后被自动补回。
 *
 * ⚠ **显式的 0 必须被尊重**：`items` 是完整表，「持有 0 个」与「没有这个键」
 *   是两回事。若把 0 当成缺键，新号起步的 10 本小经验书会在玩家用完之后
 *   被**自动补回**（背包永远清不空）。
 */
function normalizeItems(raw: unknown): SaveData['items'] {
  const out = {} as SaveData['items']
  for (const id of ITEM_IDS) out[id] = 0
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ITEM_ID_SET.has(id as ItemId)) continue
    const n = num(value)
    if (n >= 0) out[id as ItemId] = Math.floor(n)
  }
  return out
}

/**
 * 规范化**单条挂机通道**。
 *
 * ⚠ **逐通道兜底**（挂机改版 v11 / 遗物副本 v12）：四条通道**各自独立**，
 *   一条通道的目标形状非法**只关掉那一条**，不能连累另外两条。
 *
 * ⚠ 形状非法的目标一律置 `null`（= 通道关闭，不计量）——
 *   宁可这条通道不产出，也不能让它挂到不存在的关卡上。
 */
function normalizeIdleChannel(
  raw: unknown,
  kind: IdleChannelKind,
  fallbackMeasuredAt: number,
): SaveData['idle']['channels'][IdleChannelKind] {
  const base = emptyIdleChannel(null, fallbackMeasuredAt)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const ch = raw as Record<string, unknown>
  const measuredAt = Number.isFinite(ch.measuredAt) ? (ch.measuredAt as number) : fallbackMeasuredAt
  const state: SaveData['idle']['channels'][IdleChannelKind] = {
    target: null,
    measuredAt,
    effectiveMs: Number.isFinite(ch.effectiveMs) ? Math.max(0, ch.effectiveMs as number) : 0,
    offlineElapsedMs: Number.isFinite(ch.offlineElapsedMs) ? Math.max(0, ch.offlineElapsedMs as number) : 0,
    pendingOfflineMs: Number.isFinite(ch.pendingOfflineMs) ? Math.max(0, ch.pendingOfflineMs as number) : 0,
  }
  const target = ch.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) return state
  const t = target as Record<string, unknown>
  if (t.kind !== kind) return state
  if (kind === 'main') {
    // 主线：`stageId = null` = 跟随最新通关关卡；给了数字必须是合法关卡
    if (t.stageId === null || t.stageId === undefined) {
      state.target = { kind: 'main', stageId: null }
    } else if (Number.isSafeInteger(t.stageId) && STAGE_INDEX.has(t.stageId as number)) {
      state.target = { kind: 'main', stageId: t.stageId as number }
    }
    return state
  }
  // 技能 / 强化：目标 = 已通关的副本关卡 id
  if (typeof t.dungeonStageId === 'string') {
    const stage = DUNGEON_STAGE_INDEX.get(t.dungeonStageId)
    const stageKind = stage ? DUNGEON_INDEX.get(stage.variantId)?.kind : undefined
    if (stage && stageKind === kind) {
      state.target = { kind, dungeonStageId: t.dungeonStageId } as IdleChannelTarget
    }
  }
  return state
}

/**
 * 规范化**遗物保底计数**（存档 v12）。
 *
 * ⚠ 只保留**合法副本关卡 id** 的非负整数：
 *   非法 key 会让 `save.relicPity` 变成一个可以塞任意字符串的黑洞
 *   （存档体积无上限增长），且保底计数只对真实遗物副本有意义。
 *
 * ⚠ 合法值**原样保留**：保底必须跨会话累计，
 *   每次载入都归零 ⇒ 玩家刷新页面就能重抽（铁律 #24 的同款坑）。
 */
function normalizeRelicPity(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Number.isFinite(value)) continue
    const n = Math.max(0, Math.floor(value as number))
    if (!DUNGEON_STAGE_INDEX.has(id)) continue
    out[id] = n
  }
  return out
}

/**
 * 规范化**副本通关记录**：只保留合法关卡 id 且值恒为 `true`。
 */
function normalizeDungeonCleared(raw: unknown): Record<string, true> {
  const out: Record<string, true> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== true) continue
    if (!DUNGEON_STAGE_INDEX.has(id)) continue
    out[id] = true
  }
  return out
}

/**
 * 规范化存档：补齐缺失字段，保证旧档 / 损坏档也能安全加载。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：不再把 `version` 强制成当前版本——
 *   保留**原始版本号**，让 `migrate()` 能按真实版本走迁移链。
 *   原因：`normalizeSave` 曾把版本改写成 `SAVE_VERSION`，
 *   于是 `validateImportedSave`（导入路径）拿到的已是新版本 →
 *   `migrate()` 对导入档**完全不跑** → 导入的旧档会保留 `player.tickets`
 *   等退役字段，而新代码不认识它们（静默丢档）。
 *   调用方（`restoreSave` / `deserialize` / `validateImportedSave`）负责显式 `migrate()`。
 *
 * ⚠ `player` 仍用展开合并：**退役字段必须活到迁移那一步**才能被折算，
 *   迁移结束后由 `migrate()` 的收尾 `stripRetiredPlayerFields()` 剔除。
 */
export function normalizeSave(raw: unknown): SaveData {
  const base = createNewSave(Date.now())
  if (!raw || typeof raw !== 'object') return base
  const save = raw as Partial<SaveData>
  // 挂机计量水位的兜底：旧档没有通道结构 ⇒ 用 `lastTickAt` 顶上
  const fallbackMeasuredAt =
    Number.isFinite(save.lastTickAt) ? (save.lastTickAt as number) : base.lastTickAt

  const merged: SaveData = {
    ...base,
    ...save,
    // 保留原始版本号（合法整数则保留，否则回落 1）；迁移由调用方显式执行
    version:
      typeof save.version === 'number' && Number.isSafeInteger(save.version) && save.version > 0
        ? save.version
        : 1,
    // 旧档没有写入时间戳：按 0 处理，保证「旧档首次写入」不会被判成外部更新
    savedAt: typeof save.savedAt === 'number' ? save.savedAt : 0,
    // 旧档没有随机数状态：种子留 0（= 未设置），由服务端补密码学随机种子。
    // 这里**不能用常量种子兜底**——那会让所有旧档玩家共用同一条抽卡序列。
    rng: {
      seed: typeof save.rng?.seed === 'number' ? save.rng.seed : 0,
      counter: typeof save.rng?.counter === 'number' ? save.rng.counter : 0,
      // ⚠ 挂机改版 v11 / 遗物副本 v12：四条通道的随机序列（缺字段时按根种子派生）
      channels: normalizeChannelRng(
        save.rng?.channels,
        typeof save.rng?.seed === 'number' ? save.rng.seed : 0,
      ),
    },
    player: { ...base.player, ...(save.player ?? {}) },
    // 堆叠道具：只保留**已登记**的道具 id，值取非负整数
    items: normalizeItems(save.items),
    // 旧档一次性分配权益：只加不清零（迁移会往里加，两边都不清零 ⇒ 幂等）
    legacy: {
      skillStones: Math.max(0, num(save.legacy?.skillStones)),
      relicStones: Math.max(0, num(save.legacy?.relicStones)),
      allocated: save.legacy?.allocated === true,
    },
    team: { ...base.team, ...(save.team ?? {}) },
    gacha: { ...base.gacha, ...(save.gacha ?? {}) },
    campaign: { ...base.campaign, ...(save.campaign ?? {}) },
    idle: {
      channels: {
        main: normalizeIdleChannel(save.idle?.channels?.main, 'main', fallbackMeasuredAt),
        skill: normalizeIdleChannel(save.idle?.channels?.skill, 'skill', fallbackMeasuredAt),
        enhance: normalizeIdleChannel(save.idle?.channels?.enhance, 'enhance', fallbackMeasuredAt),
        // ⚠ 遗物通道（v12）：漏掉这一行 ⇒ 该通道账本每次载入都被**静默重置**
        //   （表现层看不出任何异常，但玩家会发现「挂机进度一直在原地踏步」）。
        relic: normalizeIdleChannel(save.idle?.channels?.relic, 'relic', fallbackMeasuredAt),
      },
      activeUntil: Number.isFinite(save.idle?.activeUntil) ? save.idle!.activeUntil : fallbackMeasuredAt,
      totalIdleSeconds: Math.max(0, num(save.idle?.totalIdleSeconds)),
    },
    // 遗物副本的保底计数（v12）：只保留**合法关卡 id** 的非负整数
    relicPity: normalizeRelicPity(save.relicPity),
    // 遗物每日产出计数（v12）
    relicDaily: {
      date: typeof save.relicDaily?.date === 'string' ? save.relicDaily.date : '',
      count: Math.max(0, num(save.relicDaily?.count)),
    },
    dungeons: {
      cleared: normalizeDungeonCleared(save.dungeons?.cleared),
    },
    settings: { ...base.settings, ...(save.settings ?? {}) },
    stats: { ...base.stats, ...(save.stats ?? {}) },
    arena: {
      ...base.arena,
      ...(save.arena ?? {}),
      arenaMaterials: Number.isFinite(save.arena?.arenaMaterials) ? save.arena!.arenaMaterials : 0,
      weeklyMaterials: Number.isFinite(save.arena?.weeklyMaterials) ? save.arena!.weeklyMaterials : 0,
      ladder: normalizeLadder(save.arena?.ladder),
    },
    daily: {
      ...base.daily,
      ...(save.daily ?? {}),
      // 任务字段逐个兜底：旧档没有它们，且不能被 undefined 覆盖掉
      taskProgress: { ...(save.daily?.taskProgress ?? {}) },
      taskClaimed: Array.isArray(save.daily?.taskClaimed) ? save.daily.taskClaimed : [],
      taskDay: Number.isFinite(save.daily?.taskDay) ? (save.daily!.taskDay as number) : 0,
      taskWeek: Number.isFinite(save.daily?.taskWeek) ? (save.daily!.taskWeek as number) : 0,
    },
    heroes: save.heroes ?? {},
    relics: Array.isArray(save.relics) ? save.relics : [],
    relicSeq: Number.isFinite(save.relicSeq) ? Math.max(0, Math.floor(save.relicSeq!)) : 0,
    equipped: save.equipped ?? {},
    codes: Array.isArray(save.codes) ? save.codes : [],
  }

  // 旧档缺周期时按最后存档活动时间归属，保留已有计数；后续载入不再改写。
  if (!Number.isInteger(save.arena?.rewardWeek)) {
    merged.arena.rewardWeek = arenaWeekIndex(save.savedAt || save.lastTickAt || save.createdAt || base.createdAt)
  }
  const defense = merged.arena.defenseLoadout
  if (defense) {
    merged.arena.defenseLoadout = {
      ...defense,
      relicSets: defense.heroes.map((_, i) => {
        const entry: unknown = defense.relicSets?.[i]
        const ids = Array.isArray(entry) ? entry : typeof entry === 'string' ? [entry] : []
        // 历史单值最多确认一件；defId 只经配置索引转成 setId，绝不推测件数。
        return ids.map((id) => typeof id === 'string'
          ? RELIC_SETS.has(id) ? id : RELIC_DEFS.get(id)?.setId ?? null
          : null)
      }),
    }
  }

  // 槽位长度补齐
  const slots = merged.team.slots ?? []
  merged.team.slots = Array.from({ length: 6 }, (_, i) => slots[i] ?? null)

  return merged
}

/**
 * 执行迁移链。
 *
 * ⚠ 收尾会**剔除退役的玩家字段**（v10 起不再存在）——
 *   这样即使存档来自手工构造或畸形导入，退役字段也不会残留。
 */
export function migrate(save: SaveData): SaveData {
  let current = save
  let version = current.version ?? 1
  while (version < SAVE_VERSION) {
    const migration = MIGRATIONS[version]
    if (!migration) {
      version++
      continue
    }
    current = migration(current)
    version++
    current.version = version
  }
  stripRetiredPlayerFields(current)
  current.version = SAVE_VERSION
  return current
}
