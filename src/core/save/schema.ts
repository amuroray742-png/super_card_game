/**
 * 存档结构与迁移链（§12.3 铁律 #4）。
 *
 * 存档带版本号与迁移链，保证后续更新不丢档。
 */
import type { SaveData } from '../model/types.ts'
import { START_RESOURCES } from '../config/economy.ts'

export const SAVE_VERSION = 4

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
}

export function emptyArena(): SaveData['arena'] {
  return {
    tierPoints: 0,
    pvpPoints: 0,
    medals: 0,
    weeklyMedals: 0,
    weeklyTickets: 0,
    arenaLevel: 0,
    runes: [],
    defenseLoadout: null,
    snapshotHash: null,
  }
}

/** 新建存档 */
export function createNewSave(now: number): SaveData {
  return {
    version: SAVE_VERSION,
    createdAt: now,
    lastTickAt: now,
    // 新建存档尚未写入存储，时间戳由 store 在首次 persist 时盖上
    savedAt: 0,
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
    equipped: {},
    team: { slots: [null, null, null, null, null, null], presets: [] },
    gacha: { pitySSR: 0, pity10: 0, history: [], pools: {}, newbieUsed: false },
    campaign: { clearedStage: 0, stageStars: {}, chapterProgress: 1 },
    idle: { currentStage: 1, autoAdvance: true, totalIdleSeconds: 0 },
    codes: [],
    settings: { speed: 1, sfx: true, skipAnim: false },
    stats: { firstStartAt: now, totalPulls: 0, totalPower: 0 },
    arena: emptyArena(),
    daily: {
      signInStreak: 0,
      lastSignInDay: 0,
      taskProgress: {},
      taskClaimed: [],
    },
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
    player: { ...base.player, ...(save.player ?? {}) },
    team: { ...base.team, ...(save.team ?? {}) },
    gacha: { ...base.gacha, ...(save.gacha ?? {}) },
    campaign: { ...base.campaign, ...(save.campaign ?? {}) },
    idle: { ...base.idle, ...(save.idle ?? {}) },
    settings: { ...base.settings, ...(save.settings ?? {}) },
    stats: { ...base.stats, ...(save.stats ?? {}) },
    arena: { ...base.arena, ...(save.arena ?? {}) },
    daily: { ...base.daily, ...(save.daily ?? {}) },
    heroes: save.heroes ?? {},
    relics: Array.isArray(save.relics) ? save.relics : [],
    equipped: save.equipped ?? {},
    codes: Array.isArray(save.codes) ? save.codes : [],
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
