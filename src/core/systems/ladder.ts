/**
 * PVE 长线挑战 · 三队天梯（§9.1 / roadmap P2-2）。
 *
 * ── 玩法 ──────────────────────────────────────────────────────────────
 * 玩家用自己收集的英灵组成 **3 队**（每队最多 6 人），依次挑战 **3 个敌方梯队**。
 * 一轮 = 3 场战斗；每周一轮（北京时区周一零点切换）。
 *
 * ── 三条口径 ──────────────────────────────────────────────────────────
 * 1. **PVE 完整数值**（§9.1）：本模式走 `resolveStats(mode:'pve')`——
 *    等级 / 星级 / 遗物强化 / 羁绊 / 永久加成全部生效。
 *    它是玩家检验养成成果的舞台，与归一化的竞技场（`mode:'arena'`）是两套结算。
 * 2. **敌方全部非历史人物**：梯队由灵体 / 妖异 / 器械造物组成（合规红线），
 *    定位是「演武场投影」，UI 必须标注为架空演武。
 * 3. **产出隔离**（§6.11）：天梯产出只进竞技专属池（勋章 / 竞技材料 / 称号），
 *    **不回流**银两 / 经验 / 强化石 / 术式结晶 / 圣杯结晶。
 *    唯一例外是**回流奖励**——它属于留存经济，与日常任务同一把尺（投放预算闸门），
 *    且**不含**圣杯结晶 / 抽卡券（不冲击抽卡间隔）。
 *
 * ⚠ 本文件是**纯函数层**：不读 DOM、不读平台 API，时间与随机都由入参注入。
 */
import type {
  BattleContext,
  BattleResult,
  HeroRuntime,
  LadderReward,
  LadderRoundResult,
  LadderSquadResult,
  SaveData,
  StatMod,
} from '../model/types.ts'
import { ARENA, LADDER, LADDER_RETURN_REWARDS, LADDER_SEASON_REWARDS, TIERS } from '../config/economy.ts'
import { LADDER_TIERS, emptyLadderSquads } from '../config/ladder.ts'
import { getEnemy } from '../config/enemies.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { getEquippedRelics } from './loadout.ts'
import { getBondMods } from './team.ts'
import { runBattle } from './battle.ts'
import { arenaWeekIndex } from '../time.ts'

// ─────────────────────────── 段位 ───────────────────────────

/** 段位分 → 段位下标（0 = 黑铁） */
export function ladderTierIndex(points: number): number {
  let index = 0
  for (let i = 0; i < TIERS.length; i++) {
    if (points >= TIERS[i].min) index = i
  }
  return index
}

/** 段位分 → 段位名 */
export function ladderTierName(points: number): string {
  return TIERS[ladderTierIndex(points)].name
}

/** 段位下标 → 梯队层定义（越界时夹到最外层） */
function tierDef(index: number) {
  const clamped = Math.min(Math.max(index, 0), LADDER_TIERS.length - 1)
  return LADDER_TIERS[clamped]
}

// ─────────────────────────── 阵容 ───────────────────────────

/** 空的三队阵容（实现在配置层，存档 schema 共用同一份） */
export { emptyLadderSquads }

/**
 * 存档 → 三队运行时对象。
 *
 * 槽位号沿用**真实槽位**（0-2 前排 / 3-5 后排），空槽位跳过（铁律 #16）。
 * 同一名英灵**可以**出现在多支队伍里——这是玩家的省钱选择，
 * 代价是后两梯队更难打（三队养成成本由此可调，见 plan.md §12.10）。
 */
export function buildLadderSquads(save: SaveData): HeroRuntime[][] {
  const squads: HeroRuntime[][] = []
  const raw = save.arena.ladder?.squads ?? []
  for (let s = 0; s < LADDER.SQUAD_COUNT; s++) {
    const heroes: HeroRuntime[] = []
    const ids = raw[s] ?? []
    for (let slot = 0; slot < LADDER.SQUAD_SIZE; slot++) {
      const id = ids[slot]
      if (!id) continue
      const def = HERO_INDEX.get(id)
      const state = save.heroes[id]
      if (!def || !state) continue
      heroes.push({ def, state, relics: getEquippedRelics(save, id), slot })
    }
    squads.push(heroes)
  }
  return squads
}

/** 校验一支队伍的英灵 id（必须已拥有；同一队内不重复） */
export function validateSquad(save: SaveData, ids: (string | null)[]): string | null {
  if (ids.length !== LADDER.SQUAD_SIZE) return '每队必须恰好 6 个槽位'
  const seen = new Set<string>()
  for (const id of ids) {
    if (id === null) continue
    if (!HERO_INDEX.has(id)) return '存在未知英灵'
    if (!save.heroes[id]) return '存在尚未获得的英灵'
    if (seen.has(id)) return '同一队内不能重复上阵'
    seen.add(id)
  }
  return null
}

// ─────────────────────────── 战斗上下文 ───────────────────────────

/**
 * 天梯战斗上下文：**PVE 完整数值**。
 *
 * 与 `buildPveContext` 同一套乘区（境界 / 遗物 / 技能 / 羁绊 / 永久加成），
 * 区别只是羁绊按**本队**计算而不是主线编队。
 */
export function ladderContext(save: SaveData, heroes: HeroRuntime[], seed: number): BattleContext {
  const progress: StatMod[] = (['hp', 'atk', 'def', 'spd'] as const).map((stat) => ({
    stat, value: save.player.permBoost, kind: 'pct', zone: 'progress',
  }))
  return { mode: 'pve', seed, teamMods: { bond: getBondMods(heroes), progress } }
}

/**
 * 该梯队层的敌方属性缩放（逐梯队独立标定，见 `LADDER.SCALE_ANCHORS`）。
 */
export function ladderScale(tierIndex: number, squadIndex: number): number {
  const row = LADDER.SCALE_ANCHORS[tierIndex] ?? LADDER.SCALE_ANCHORS[0]
  return row[squadIndex] ?? row[0] ?? 1
}

// ─────────────────────────── 一轮挑战 ───────────────────────────

/**
 * 跑一轮（3 队 × 3 梯队）。
 *
 * @param nextSeed 随机种子提供器（每场战斗取一个，保证可复现）
 */
export function resolveLadderRound(
  save: SaveData,
  nextSeed: () => number,
): LadderRoundResult {
  const tierIndex = ladderTierIndex(save.arena.tierPoints ?? 0)
  const tier = tierDef(tierIndex)
  const squads = buildLadderSquads(save)

  const results: LadderSquadResult[] = []
  for (let s = 0; s < LADDER.SQUAD_COUNT; s++) {
    const def = tier.squads[s]
    const heroes = squads[s] ?? []
    // 空队直接判负（不消耗随机序列，也不产生战报）
    if (heroes.length === 0) {
      results.push({
        index: s,
        enemySquadId: def.id,
        enemySquadName: def.name,
        win: false,
        result: emptyBattleResult(),
      })
      continue
    }
    const seed = nextSeed()
    const ctx = ladderContext(save, heroes, seed)
    const enemies = def.enemyIds.map((id) => getEnemy(id))
    const result: BattleResult = runBattle({
      allies: heroes,
      enemies,
      enemyScale: ladderScale(tierIndex, s),
      ctx,
    })
    results.push({
      index: s,
      enemySquadId: def.id,
      enemySquadName: def.name,
      win: result.win,
      result,
    })
  }

  const wins = results.filter((r) => r.win).length
  const points = ladderPointsFor(wins)
  return {
    tierIndex,
    tierName: tier.name,
    squads: results,
    wins,
    points,
    reward: { medals: 0, arenaMaterials: 0 },
  }
}

/** 空队伍的占位战报（不参与回放，只让界面有个统一形状） */
function emptyBattleResult(): BattleResult {
  return {
    win: false,
    rounds: 0,
    log: [],
    damageById: {},
    healById: {},
    hpById: {},
    initiativeSide: 'ally',
    mvpId: null,
    survivors: [],
    roster: [],
  }
}

/** 胜场数 → 段位分 */
export function ladderPointsFor(wins: number): number {
  if (wins <= 0) return 0
  return wins * LADDER.POINTS_PER_SQUAD + (wins >= LADDER.SQUAD_COUNT ? LADDER.POINTS_CLEAR_BONUS : 0)
}

// ─────────────────────────── 产出 ───────────────────────────

/**
 * 天梯产出（**只含竞技专属资源**）。
 *
 * ⚠ 周上限与镜像试炼**共用**同一份预算（`arena.weeklyMedals`）——
 *   两个模式各发一份勋章却各算各的上限，玩家一周能拿到的勋章就是上限的两倍。
 *   共享预算是「竞技产出有上限」这条约束的唯一口径（铁律 #4）。
 */
export function resolveLadderRewards(
  wins: number,
  weeklyMedals: number,
  weeklyMaterials: number,
): { reward: LadderReward; weeklyMedals: number; weeklyMaterials: number } {
  const baseMedals = wins * 30 + (wins >= LADDER.SQUAD_COUNT ? 60 : 0)
  const baseMaterials = wins * 10 + (wins >= LADDER.SQUAD_COUNT ? 30 : 0)
  const medals = Math.min(baseMedals, Math.max(0, ARENA.MEDAL_WEEKLY_CAP - weeklyMedals))
  const arenaMaterials = Math.min(baseMaterials, Math.max(0, ARENA.MATERIAL_WEEKLY_CAP - weeklyMaterials))
  return {
    reward: { medals, arenaMaterials },
    weeklyMedals: weeklyMedals + medals,
    weeklyMaterials: weeklyMaterials + arenaMaterials,
  }
}

/** 天梯产出允许的资源键白名单（测试用） */
export const LADDER_REWARD_ALLOWED_KEYS: readonly (keyof LadderReward)[] = [
  'medals',
  'arenaMaterials',
]

// ─────────────────────────── 赛季 ───────────────────────────

/** 赛季结算奖励（按赛季内累计段位分分档） */
export function resolveSeasonReward(
  seasonPoints: number,
  season: number,
): { medals: number; arenaMaterials: number; title: string | null; tier: string | null } {
  const spec = LADDER_SEASON_REWARDS.find((r) => seasonPoints >= r.minPoints)
    ?? LADDER_SEASON_REWARDS[LADDER_SEASON_REWARDS.length - 1]
  return {
    medals: spec.medals,
    arenaMaterials: spec.arenaMaterials,
    title: spec.titleTier ? `ladder_title_${season}_${spec.titleTier}` : null,
    tier: spec.titleTier,
  }
}

/** 赛季结算明细（写进战报 / 提示） */
export interface SeasonSettlement {
  /** 结算掉的赛季号 */
  season: number
  /** 赛季内累计段位分 */
  seasonPoints: number
  /** 发放的勋章 */
  medals: number
  /** 发放的竞技材料 */
  arenaMaterials: number
  /** 发放的称号 id（无 = 只发资源） */
  title: string | null
  /** 赛季重置后保留的段位分 */
  carryPoints: number
  /** 重置前的段位分 */
  tierPointsBefore: number
}

// ─────────────────────────── 周期滚动（周 / 赛季 / 回流） ───────────────────────────

/**
 * 滚动天梯的周 / 赛季周期，并判定回流。
 *
 * ⚠ **惰性结算**：不需要后台定时任务——每次服务端入口（载入 / 动作）都调一次，
 *   跨了几个赛季就结算几个赛季（`settlements` 逐个返回）。
 *
 * @param now 服务端时间（毫秒）
 */
export function rollLadderPeriods(
  save: SaveData,
  now: number,
): { changed: boolean; settlements: SeasonSettlement[]; returnDays: number } {
  const ladder = save.arena.ladder
  const settlements: SeasonSettlement[] = []
  let changed = false

  const week = arenaWeekIndex(now)

  // ── 赛季初始化 ──
  if (ladder.season <= 0) {
    ladder.season = 1
    ladder.seasonStartWeek = week
    changed = true
  }

  // ── 赛季结算（可能跨多个赛季）──
  while (week >= ladder.seasonStartWeek + LADDER.SEASON_WEEKS) {
    const reward = resolveSeasonReward(ladder.seasonPoints, ladder.season)
    const tierPointsBefore = save.arena.tierPoints ?? 0
    const carryPoints = Math.floor(tierPointsBefore * LADDER.SEASON_CARRY_PCT)
    save.arena.tierPoints = carryPoints
    save.arena.medals = (save.arena.medals ?? 0) + reward.medals
    save.arena.arenaMaterials = (save.arena.arenaMaterials ?? 0) + reward.arenaMaterials
    if (reward.title && !ladder.seasonTitles.includes(reward.title)) {
      ladder.seasonTitles.push(reward.title)
    }
    settlements.push({
      season: ladder.season,
      seasonPoints: ladder.seasonPoints,
      medals: reward.medals,
      arenaMaterials: reward.arenaMaterials,
      title: reward.title,
      carryPoints,
      tierPointsBefore,
    })
    ladder.seasonPoints = 0
    ladder.season += 1
    ladder.seasonStartWeek += LADDER.SEASON_WEEKS
    changed = true
  }

  // ── 回流判定 ──
  const returnDays = detectReturnDays(save, now)
  if (returnDays > 0 && !ladder.returnPending) {
    ladder.returnPending = true
    ladder.returnDays = returnDays
    changed = true
  }

  // ── 活跃时间戳（只更新，不算「实质变更」）──
  ladder.lastActiveAt = now

  return { changed, settlements, returnDays }
}

/**
 * 回流天数（0 = 不是回流）。
 *
 * 口径：**距上次活跃**的天数 ≥ `LADDER.RETURN_MIN_OFFLINE_DAYS`，
 * 且距上次领取回流奖励已过冷却期。
 */
export function detectReturnDays(save: SaveData, now: number): number {
  const ladder = save.arena.ladder
  const lastActive = ladder.lastActiveAt ?? 0
  // 从未活跃过（刚建档）→ 不算回流
  if (!lastActive) return 0
  const days = Math.floor((now - lastActive) / 86_400_000)
  if (days < LADDER.RETURN_MIN_OFFLINE_DAYS) return 0
  const sinceReturn = now - (ladder.lastReturnAt ?? 0)
  if (sinceReturn < LADDER.RETURN_COOLDOWN_DAYS * 86_400_000) return 0
  return days
}

/** 回流奖励（按离线天数分档；null = 不满足条件） */
export function resolveReturnReward(
  offlineDays: number,
): { skillStones: number; relicStones: number; medals: number } | null {
  if (offlineDays < LADDER.RETURN_MIN_OFFLINE_DAYS) return null
  const spec = LADDER_RETURN_REWARDS.find((r) => offlineDays >= r.minDays)
  if (!spec) return null
  return {
    skillStones: spec.skillStones,
    relicStones: spec.relicStones,
    medals: spec.medals,
  }
}
