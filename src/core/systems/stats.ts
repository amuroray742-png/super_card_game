/**
 * 属性解析 —— 全局唯一入口（架构铁律 #2 / #7）。
 *
 * 所有战斗必须经 `resolveStats(hero, ctx)` 取属性。
 * 战斗系统内部禁止直接读取 hero.level / relic.level / player.permBoost。
 *
 * 两条路径：
 *   pve / tower → 基础属性(等级, 星级) × 独立乘区（遗物/技能/羁绊/境界/进度）
 *   arena       → 定位模板 × 封顶后的策略修正（被动×0.6 / 套装×0.7 / 羁绊×0.6）
 *
 * arena 分支**不得**引用任何 PVE 养成数值——这是 PvP 公平性的根本保证，
 * 由 tests/unit/arena-isolation.test.ts 守护。
 */
import type {
  BattleContext,
  DerivedStats,
  Element,
  FinalStats,
  HeroRuntime,
  MultiplierZone,
  Role,
  StatKey,
  StatMod,
  Stats,
} from '../model/types.ts'
import { ARENA_CAPS, LEVEL, POWER, REALMS, STAR, ZONE } from '../config/economy.ts'
import { getRelicMods } from './relic.ts'

const STAT_KEYS: readonly StatKey[] = ['atk', 'def', 'hp', 'spd', 'crit', 'cdmg']

/** 乘区应用顺序（固定，保证结果可复现） */
const ZONE_ORDER: readonly MultiplierZone[] = ['realm', 'relic', 'skill', 'bond', 'progress']

// ─────────────────────────── 境界 ───────────────────────────

export function getRealm(level: number) {
  for (const realm of REALMS) {
    if (level >= realm.minLevel && level <= realm.maxLevel) return realm
  }
  return REALMS[REALMS.length - 1]
}

/** 下一个境界（已满级返回 null） */
export function nextRealm(level: number) {
  const realm = getRealm(level)
  const idx = REALMS.findIndex((r) => r.id === realm.id)
  return idx >= 0 && idx < REALMS.length - 1 ? REALMS[idx + 1] : null
}

/** 升到下一境界所需等级 */
export function levelForNextRealm(level: number): number | null {
  const next = nextRealm(level)
  return next ? next.minLevel : null
}

// ─────────────────────────── 基础属性 ───────────────────────────

/** 等级 + 星级决定的基础属性 */
export function computeBaseStats(hero: HeroRuntime): Stats {
  const { def, state } = hero
  const lv = Math.max(0, state.level - 1)
  const starMult = 1 + (Math.max(STAR.MIN, state.star) - STAR.MIN) * STAR.BASE_PCT_PER_STAR
  // 等级成长是指数的（与指数难度曲线对齐），线性项只作为低等级的平滑补充
  const lvMult = Math.pow(LEVEL.MULT, lv)
  return {
    atk: (def.baseStats.atk * lvMult + def.growth.atk * lv) * starMult,
    def: (def.baseStats.def * lvMult + def.growth.def * lv) * starMult,
    hp: (def.baseStats.hp * lvMult + def.growth.hp * lv) * starMult,
    spd: def.baseStats.spd + def.growth.spd * lv,
    crit: def.baseStats.crit,
    cdmg: def.baseStats.cdmg,
  }
}

// ─────────────────────────── 乘区应用 ───────────────────────────

interface ZoneBundle {
  pct: number[]
  flat: number[]
}

function emptyBundle(): ZoneBundle {
  return {
    pct: STAT_KEYS.map(() => 0),
    flat: STAT_KEYS.map(() => 0),
  }
}

/**
 * 按独立乘区合成属性。
 * 每个乘区内部：先加固定值，再乘百分比；乘区之间连乘。
 * 任一乘区百分比上限 +300%（ZONE.MAX_PCT）。
 */
export function applyZones(base: Stats, mods: StatMod[], scale = 1): Stats {
  const bundles = new Map<MultiplierZone, ZoneBundle>()
  for (const zone of ZONE_ORDER) bundles.set(zone, emptyBundle())

  for (const mod of mods) {
    const bundle = bundles.get(mod.zone)
    if (!bundle) continue
    const idx = STAT_KEYS.indexOf(mod.stat)
    if (idx < 0) continue
    if (mod.kind === 'pct') bundle.pct[idx] += mod.value * scale
    else bundle.flat[idx] += mod.value * scale
  }

  const out = { ...base }
  for (const zone of ZONE_ORDER) {
    const bundle = bundles.get(zone)!
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const key = STAT_KEYS[i]
      const pct = Math.min(bundle.pct[i], ZONE.MAX_PCT)
      const flat = bundle.flat[i]
      out[key] = (out[key] + flat) * (1 + pct)
    }
  }
  return out
}

// ─────────────────────────── 衍生属性 ───────────────────────────

/** 闪避 / 命中 / 抵抗 由基础值换算，不占养成位 */
export function deriveStats(stats: Stats): DerivedStats {
  return {
    dodge: clamp(stats.spd * 0.0008 + 0.02, 0, 0.35),
    hit: clamp(0.7 + stats.spd * 0.0015, 0, 1),
    res: clamp(0.05 + stats.def * 0.0006, 0, 0.6),
  }
}

// ─────────────────────────── 战力 ───────────────────────────

/**
 * 战力公式（§5.2）。只用于横向可比（关卡门槛、排行），不作为战斗输入。
 */
export function computePower(stats: Stats): number {
  const main = stats.atk * POWER.ATK_WEIGHT + stats.def * POWER.DEF_WEIGHT + stats.hp * POWER.HP_WEIGHT
  const critZone = 1 + stats.crit * stats.cdmg
  const spdZone = 1 + Math.min(stats.spd, POWER.SPD_CAP) * POWER.SPD_COEFF
  return main * critZone * spdZone
}

// ─────────────────────────── 核心入口 ───────────────────────────

/**
 * 属性解析唯一入口。
 *
 * @param hero  英灵运行时状态（含等级/星级/技能等级/遗物实例）
 * @param ctx   战斗上下文（mode 决定 PVE / 竞技路径）
 * @param extra 传入已算好的被动与套装修正（由 growth / relic 系统产出）
 */
export function resolveStats(
  hero: HeroRuntime,
  ctx: BattleContext,
  extra?: { passives?: StatMod[]; setMods?: StatMod[] },
): FinalStats {
  if (ctx.mode === 'arena') {
    return resolveArenaStats(hero, ctx, extra)
  }
  return resolvePveStats(hero, ctx, extra)
}

/**
 * PVE 路径：基础属性 × 独立乘区。
 */
function resolvePveStats(
  hero: HeroRuntime,
  ctx: BattleContext,
  extra?: { passives?: StatMod[]; setMods?: StatMod[] },
): FinalStats {
  const base = computeBaseStats(hero)

  const realm = getRealm(hero.state.level)
  const realmMods: StatMod[] = STAT_KEYS.map((stat) => ({
    stat,
    kind: 'pct',
    value: realm.bonusPct,
    zone: 'realm',
  }))

  // 遗物本体词条（主词条随强化等级缩放 + 随机副词条）
  const relicMods: StatMod[] = hero.relics.flatMap((inst) => (inst ? getRelicMods(inst) : []))

  const mods: StatMod[] = [
    ...realmMods,
    ...relicMods,
    ...(extra?.passives ?? []),
    ...(extra?.setMods ?? []),
    ...(ctx.teamMods?.bond ?? []),
    ...(ctx.teamMods?.progress ?? []),
  ]

  const stats = applyZones(base, mods)
  return { ...stats, ...deriveStats(stats) }
}

/**
 * 竞技路径：定位模板 + 封顶后的策略修正。
 *
 * 严格约束（本函数内禁止出现任何 PVE 养成数值）：
 * - 不读 hero.state.level / exp / star 的数值贡献
 * - 不读 relic.level / relic 随机词条
 * - 不读 player.permBoost
 * 星级只通过"被动数量"影响策略宽度，不影响数值大小。
 */
function resolveArenaStats(
  hero: HeroRuntime,
  ctx: BattleContext,
  extra?: { passives?: StatMod[]; setMods?: StatMod[] },
): FinalStats {
  const profile = ctx.arenaProfile
  if (!profile) {
    throw new Error('竞技模式缺少 arenaProfile：BattleContext.arenaProfile 为必填')
  }

  const template = profile.templates[hero.def.role]
  const base: Stats = {
    atk: template.atk,
    def: template.def,
    hp: template.hp,
    spd: template.spd,
    crit: template.crit,
    cdmg: template.cdmg,
  }

  const mods: StatMod[] = [
    // 星级被动：系数打折
    ...(extra?.passives ?? []).map((m) => scaleMod(m, profile.passiveScale)),
    // 遗物套装：固定标准强度
    ...(extra?.setMods ?? []).map((m) => scaleMod(m, profile.setScale)),
    // 羁绊：系数打折
    ...(ctx.teamMods?.bond ?? []).map((m) => scaleMod(m, profile.bondScale)),
  ]

  // 注意：此分支**不读取** hero.relics（遗物本体词条与强化等级）、
  // level / exp / star 的数值贡献、player.permBoost、progress 乘区。
  // 遗物只以"套装效果"的形式进入（由调用方通过 extra.setMods 传入）。
  const stats = applyZones(base, mods)
  return { ...stats, ...deriveStats(stats) }
}

/** 系数缩放（pct 与 flat 同比例缩放） */
function scaleMod(mod: StatMod, scale: number): StatMod {
  return { ...mod, value: mod.value * scale }
}

// ─────────────────────────── 工具 ───────────────────────────

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** 定位默认偏好阵位 */
export function defaultSlotsForRole(role: Role): ('front' | 'back')[] {
  switch (role) {
    case '猛将':
      return ['front']
    case '统帅':
      return ['front', 'back']
    case '谋士':
      return ['back']
    case '医者':
      return ['back']
    case '器者':
      return ['back']
  }
}

/** 相性系数：我克 1.25 / 平 1.0 / 克我 0.85 */
export function elementFactor(attacker: Element, defender: Element, beats: Record<Element, Element>): number {
  if (beats[attacker] === defender) return 1.25
  if (beats[defender] === attacker) return 0.85
  return 1.0
}

export { ARENA_CAPS }
