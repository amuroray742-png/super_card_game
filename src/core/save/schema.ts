/**
 * 存档结构与迁移链（§12.3 铁律 #4）。
 *
 * 存档带版本号与迁移链，保证后续更新不丢档。
 */
import type { SaveData } from '../model/types.ts'
import { START_RESOURCES } from '../config/economy.ts'
import { arenaWeekIndex } from '../time.ts'
import { makeRelicUid, parseLegacyRelicUid, RELIC_DEFS, RELIC_SETS } from '../systems/relic.ts'
import { emptyLadderSquads } from '../config/ladder.ts'
import '../config/relics.ts'

export const SAVE_VERSION = 9

export type Migration = (save: SaveData) => SaveData

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
    save.rng = { seed: 0, counter: 0 }
    return save
  },
  // v5 → v6：旧版曾把权威随机状态发给客户端，载入后轮换该序列。
  5: (save) => {
    save.rng = { seed: 0, counter: 0 }
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
    rng: { seed, counter: 0 },
    player: {
      silver: START_RESOURCES.silver,
      exp: START_RESOURCES.exp,
      shards: {},
      emblems: START_RESOURCES.emblems,
      crystals: START_RESOURCES.crystals,
      tickets: START_RESOURCES.tickets,
      skillStones: START_RESOURCES.skillStones,
      relicStones: START_RESOURCES.relicStones,
      permBoost: 0,
      rebirthCount: 0,
    },
    heroes: {},
    relics: [],
    relicSeq: 0,
    equipped: {},
    team: { slots: [null, null, null, null, null, null], presets: [] },
    gacha: { pitySSR: 0, pity10: 0, history: [], pools: {}, newbieUsed: false },
    campaign: { clearedStage: 0, stageStars: {}, chapterProgress: 1 },
    idle: { currentStage: 1, autoAdvance: true, totalIdleSeconds: 0, measuredAt: now, effectiveMs: 0, offlineElapsedMs: 0, activeUntil: now },
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
 * 规范化存档：补齐缺失字段，保证旧档 / 损坏档也能安全加载。
 */
export function normalizeSave(raw: unknown): SaveData {
  const base = createNewSave(Date.now())
  if (!raw || typeof raw !== 'object') return base
  const save = raw as Partial<SaveData>

  const merged: SaveData = {
    ...base,
    ...save,
    version: SAVE_VERSION,
    // 旧档没有写入时间戳：按 0 处理，保证「旧档首次写入」不会被判成外部更新
    savedAt: typeof save.savedAt === 'number' ? save.savedAt : 0,
    // 旧档没有随机数状态：种子留 0（= 未设置），由服务端补密码学随机种子。
    // 这里**不能用常量种子兜底**——那会让所有旧档玩家共用同一条抽卡序列。
    rng: {
      seed: typeof save.rng?.seed === 'number' ? save.rng.seed : 0,
      counter: typeof save.rng?.counter === 'number' ? save.rng.counter : 0,
    },
    player: { ...base.player, ...(save.player ?? {}) },
    team: { ...base.team, ...(save.team ?? {}) },
    gacha: { ...base.gacha, ...(save.gacha ?? {}) },
    campaign: { ...base.campaign, ...(save.campaign ?? {}) },
    idle: {
      ...base.idle, ...(save.idle ?? {}),
      measuredAt: Number.isFinite(save.idle?.measuredAt) ? save.idle!.measuredAt : (save.lastTickAt ?? base.lastTickAt),
      effectiveMs: Number.isFinite(save.idle?.effectiveMs) ? Math.max(0, save.idle!.effectiveMs!) : 0,
      offlineElapsedMs: Number.isFinite(save.idle?.offlineElapsedMs) ? Math.max(0, save.idle!.offlineElapsedMs!) : 0,
      activeUntil: Number.isFinite(save.idle?.activeUntil) ? save.idle!.activeUntil : (save.lastTickAt ?? base.lastTickAt),
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
  current.version = SAVE_VERSION
  return current
}
