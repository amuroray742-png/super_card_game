/**
 * 竞技场（§6.6–§6.12 / §9）。
 *
 * 三条隔离原则的落地：
 * 1. 归一化：竞技单位属性一律经 `resolveStats(hero, {mode:'arena'})` 解析，
 *    基础属性取定位模板，不继承等级 / 遗物强化 / 随机词条 / 永久加成。
 * 2. 策略化：只保留星级被动（×0.6）、技能等级（+30% 封顶）、套装效果（×0.7）、羁绊（×0.6）。
 * 3. 产出隔离：竞技产出只进竞技专属池，**不回流 PVE 经济**。
 *
 * ⚠ 本文件禁止出现 `permBoost`（PVE 永久加成）。由 tests/unit/arena-isolation.test.ts 静态检查。
 */
import type {
  ArenaLoadout,
  ArenaMatch,
  BattleContext,
  BattleUnit,
  HeroState,
  Rarity,
  Tier,
} from '../model/types.ts'
import { ARENA, ARENA_CAPS, DEFAULT_ARENA_PROFILE, TIERS } from '../config/economy.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { hashSeed } from '../rng.ts'
import { simulateBattle } from './battle.ts'
import { resolveStats } from './stats.ts'
import { getSetModsBySetIds } from './relic.ts'
import { getBondMods } from './team.ts'

// ─────────────────────────── 竞技等级与铭文 ───────────────────────────

/**
 * 竞技等级 = 被动数 / 技能数 / 套装数 / 图鉴广度的加权。
 * 它**不直接给任何属性加成**，只决定战术铭文槽位数量。
 */
export function computeArenaLevel(
  heroes: HeroState[],
  codexCount: number,
): number {
  let passives = 0
  let skills = 0
  for (const hero of heroes) {
    const def = HERO_INDEX.get(hero.id)
    if (!def) continue
    passives += def.passives.filter((p) => hero.star >= p.unlockStar).length
    skills += hero.skillLevels.filter((l) => l > 1).length
  }
  const sets = new Set<string>()
  for (const hero of heroes) {
    const def = HERO_INDEX.get(hero.id)
    if (!def) continue
    for (const s of def.relicAffinity) sets.add(s)
  }
  return (
    passives * ARENA.ARENA_LEVEL_FROM_PASSIVES +
    skills * ARENA.ARENA_LEVEL_FROM_SKILLS +
    sets.size * ARENA.ARENA_LEVEL_FROM_SETS +
    codexCount * ARENA.ARENA_LEVEL_FROM_CODEX
  )
}

/** 铭文槽位数量（硬上限 3） */
export function arenaRuneSlots(arenaLevel: number): number {
  return Math.min(
    ARENA_CAPS.RUNE_SLOTS_MAX,
    Math.floor(arenaLevel / ARENA_CAPS.RUNE_SLOTS_PER_LEVEL),
  )
}

// ─────────────────────────── 快照 ───────────────────────────

/**
 * 生成竞技阵容快照。
 * 只读取策略性字段，**不读取**等级 / 经验 / 遗物强化等级 / 永久加成。
 */
export function buildArenaLoadout(input: {
  slots: (string | null)[]
  heroes: Record<string, HeroState>
  relicSetsByHero: Record<string, (string | null)[]>
  runes: string[]
  arenaLevel: number
}): ArenaLoadout {
  const heroes: (string | null)[] = []
  const stars: number[] = []
  const skills: number[][] = []
  const relicSets: (string | null)[] = []

  for (const heroId of input.slots.slice(0, 6)) {
    heroes.push(heroId)
    if (!heroId) {
      stars.push(1)
      skills.push([1, 1, 1])
      relicSets.push(null)
      continue
    }
    const state = input.heroes[heroId]
    stars.push(state?.star ?? 1)
    skills.push(state ? [...state.skillLevels] : [1, 1, 1])
    const sets = input.relicSetsByHero[heroId] ?? []
    relicSets.push(sets.length > 0 ? sets[0] : null)
  }

  return {
    heroes,
    stars,
    skills,
    relicSets,
    runes: input.runes.slice(0, ARENA_CAPS.RUNE_SLOTS_MAX),
    arenaLevel: input.arenaLevel,
  }
}

/** 快照 hash —— 匹配后冻结，防换阵 */
export function arenaSnapshotHash(loadout: ArenaLoadout): string {
  const canonical = JSON.stringify([
    loadout.heroes,
    loadout.stars,
    loadout.skills,
    loadout.relicSets,
    loadout.runes,
  ])
  return hashSeed(canonical).toString(16).padStart(8, '0')
}

/** 校验快照是否被改动 */
export function verifyArenaSnapshot(loadout: ArenaLoadout, hash: string): boolean {
  return arenaSnapshotHash(loadout) === hash
}

// ─────────────────────────── 竞技单位构建 ───────────────────────────

/**
 * 由快照构建竞技单位。
 * 属性一律经 resolveStats(mode:'arena')，走归一化分支。
 */
export function buildArenaUnits(
  loadout: ArenaLoadout,
  side: 'ally' | 'enemy',
  ctx: BattleContext,
): BattleUnit[] {
  const units: BattleUnit[] = []

  for (let i = 0; i < loadout.heroes.length; i++) {
    const heroId = loadout.heroes[i]
    if (!heroId) continue
    const def = HERO_INDEX.get(heroId)
    if (!def) continue

    const star = loadout.stars[i] ?? 1
    const skillLevels = loadout.skills[i] ?? [1, 1, 1]

    // 星级被动（按 star 解锁），竞技下由 resolveStats 打折
    const passives = def.passives
      .filter((p) => star >= p.unlockStar)
      .flatMap((p) => p.mods)

    // 套装效果（只取套装 id，不含词条与强化等级）
    const setMods = getSetModsBySetIds([loadout.relicSets[i]])

    // 构造一个仅供竞技使用的最小运行时对象
    const runtime = {
      def,
      state: { id: heroId, level: 1, exp: 0, star, skillLevels, shards: 0, coreAwakened: false, obtainedAt: 0 },
      relics: [],
    }

    const stats = resolveStats(runtime, ctx, { passives, setMods })

    units.push({
      id: `${side === 'ally' ? 'a' : 'e'}_${heroId}`,
      side,
      slot: i,
      name: def.name,
      element: def.element,
      role: def.role,
      stats,
      skills: def.skills,
      skillLevels,
      alive: true,
      hp: stats.hp,
      maxHp: stats.hp,
      shield: 0,
      statuses: [],
      cooldowns: def.skills.map(() => 0),
      runes: loadout.runes,
    })
  }

  return units
}

/** 竞技场的战斗上下文（归一化配置） */
export function arenaContext(seed: number): BattleContext {
  return {
    mode: 'arena',
    arenaProfile: { ...DEFAULT_ARENA_PROFILE },
    seed,
  }
}

// ─────────────────────────── 对局 ───────────────────────────

/**
 * 解析一场竞技对局。
 * 双方使用**同一套竞技池**（系统统一开放全部英灵），属性全部归一化。
 */
export function resolveArenaMatch(input: {
  challengeId: string
  attacker: ArenaLoadout
  defender: ArenaLoadout
  attackerId: string
  attackerName: string
  defenderId: string
  defenderName: string
  seed: number
}): ArenaMatch {
  const ctx = arenaContext(input.seed)

  // 羁绊按各自阵容计算（各自独立，互不影响）
  const attackerHeroes = input.attacker.heroes.map((id) =>
    id ? HERO_INDEX.get(id) : undefined,
  )
  const bondMods = getBondMods(
    attackerHeroes.map((def, i) =>
      def
        ? {
            def,
            state: {
              id: def.id,
              level: 1,
              exp: 0,
              star: input.attacker.stars[i] ?? 1,
              skillLevels: input.attacker.skills[i] ?? [1, 1, 1],
              shards: 0,
              coreAwakened: false,
              obtainedAt: 0,
            },
            relics: [],
          }
        : null,
    ),
  )

  const ctxWithBonds: BattleContext = {
    ...ctx,
    teamMods: { bond: bondMods },
  }

  const allies = buildArenaUnits(input.attacker, 'ally', ctxWithBonds)
  const enemies = buildArenaUnits(input.defender, 'enemy', ctx)

  const result = simulateBattle(allies, enemies, ctxWithBonds, input.seed, input.attacker.runes)

  const pointsDelta = result.win ? tierPointsFor(1) : -Math.round(tierPointsFor(1) * 0.5)

  return {
    challengeId: input.challengeId,
    opponentId: input.defenderId,
    opponentName: input.defenderName,
    opponentLoadout: input.defender,
    result,
    pointsDelta,
  }
}

// ─────────────────────────── 段位 ───────────────────────────

export function tierForPoints(points: number): Tier {
  let current: Tier = TIERS[0].name
  for (const tier of TIERS) {
    if (points >= tier.min) current = tier.name
  }
  return current
}

export function tierIndex(tier: Tier): number {
  return TIERS.findIndex((t) => t.name === tier)
}

/** 一次胜利的段位分 */
export function tierPointsFor(multiplier: number): number {
  return Math.round(12 * multiplier)
}

// ─────────────────────────── 产出隔离（§6.11） ───────────────────────────

/**
 * 竞技产出清单。
 *
 * ⚠ 此处**只允许**竞技专属资源。
 * 银两 / 英灵经验 / 遗物强化石 / 圣杯结晶 一律不得出现——
 * 由 tests/unit/arena-isolation.test.ts 断言。
 */
export interface ArenaReward {
  /** 竞技勋章（竞技专属） */
  medals: number
  /** 竞技专属材料（仅用于铭文） */
  arenaMaterials: number
  /** 抽卡券（有周上限） */
  tickets: number
}

export const ARENA_WEEKLY_CAP = {
  medals: ARENA.MEDAL_WEEKLY_CAP,
  tickets: ARENA.TICKET_WEEKLY_CAP,
}

/**
 * 结算竞技奖励（周上限保护）。
 * @param weeklyMedals 本周已获得的勋章
 * @param weeklyTickets 本周已获得的抽卡券
 */
export function resolveArenaRewards(
  win: boolean,
  weeklyMedals: number,
  weeklyTickets: number,
): { reward: ArenaReward; weeklyMedals: number; weeklyTickets: number } {
  const baseMedals = win ? 12 : 3
  const medals = Math.min(baseMedals, Math.max(0, ARENA_WEEKLY_CAP.medals - weeklyMedals))
  const tickets =
    win && weeklyTickets < ARENA_WEEKLY_CAP.tickets ? 1 : 0
  return {
    reward: { medals, arenaMaterials: win ? 2 : 0, tickets },
    weeklyMedals: weeklyMedals + medals,
    weeklyTickets: weeklyTickets + tickets,
  }
}

/** 竞技产出允许的资源键白名单（测试用） */
export const ARENA_REWARD_ALLOWED_KEYS: readonly (keyof ArenaReward)[] = [
  'medals',
  'arenaMaterials',
  'tickets',
]

export type { Rarity }
