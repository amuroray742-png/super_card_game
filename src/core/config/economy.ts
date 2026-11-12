/**
 * 经济与数值常数 —— 全局唯一来源。
 *
 * 铁律：任何系统都不得就地写数字，必须引用本文件。
 * 数值调参只改本文件（Phase 10 调参流程）。
 */
import type { ArenaProfile, Element, Rarity, Role, Stats } from '../model/types.ts'

// ─────────────────────────── 战力公式（§5.2） ───────────────────────────

export const POWER = {
  ATK_WEIGHT: 2.2,
  DEF_WEIGHT: 1.6,
  HP_WEIGHT: 0.28,
  /** 速度乘区上限，防止速度成为唯一最优解 */
  SPD_CAP: 600,
  SPD_COEFF: 0.0012,
} as const

// ─────────────────────────── 等级与境界（§5.4） ───────────────────────────

export const LEVEL = {
  MIN: 1,
  MAX: 240,
  /**
   * expToNext(L) = EXP_BASE × EXP_GROWTH^(L-1) × realm.expScale
   *
   * 指数项使用**全局等级**（见 growth.ts 的说明：局部指数会让境界切换
   * 处的经验需求断崖下跌，境界门槛失效）。
   * 因此 EXP_GROWTH 需要按全局 239 级重新标定：
   *   单人 Lv1→240 累计经验 ≈ 3.0×10⁷，6 人编队总需求 1.8×10⁸，
   *   与主线经验投放 4.0×10⁸ 同量级（回收率 ≈ 2.2×，见 tools/balance/report.ts）。
   */
  EXP_BASE: 60,
  EXP_GROWTH: 1.025,
  /**
   * 等级的**指数**倍率：每级基础属性 ×1.03。
   *
   * ⚠ 若等级成长是线性的（base + growth×L），240 级只有约 22 倍增长，
   * 而关卡难度跨度是 2.7×10⁵ 倍——玩家永远追不上难度曲线。
   * 数值挂机游戏的标准做法是让等级成长同为指数，才能与指数难度对齐。
   */
  MULT: 1.03,
} as const

/** 境界分段。每个境界给 realm 乘区一份累计加成。 */
export interface Realm {
  id: string
  name: string
  minLevel: number
  maxLevel: number
  /** realm 乘区累计百分比 */
  bonusPct: number
  /** 经验曲线基准缩放（境界间重置基准） */
  expScale: number
  /** 突破所需材料 id（用于制造周期性目标） */
  breakMaterial: string | null
  breakCount: number
}

/**
 * 境界分段。每个境界给 realm 乘区一份累计加成。
 *
 * expScale 是**经验台阶系数**（绝对值，不是相对于上一境界的倍率）：
 *   expToNext(L) = EXP_BASE × EXP_GROWTH^(L-1) × expScale(境界)
 * 境界切换处因此是 expScale 带来的向上台阶（真正的境界门槛）。
 *
 * ⚠ 原值 1 / 8 / 40 / 200 在全局指数下会让神阶（Lv181-240）吞掉
 * 约 87% 的总经验，末阶漫长且与关卡投放严重脱节。
 * 重新标定为 1 / 5 / 15 / 40：单人 Lv1→240 累计 ≈ 3.0×10⁷，
 * 与 6 人编队总需求 1.8×10⁸ 同关卡经验投放（4.0×10⁸）同量级。
 */
export const REALMS: readonly Realm[] = [
  { id: 'mortal', name: '凡阶', minLevel: 1, maxLevel: 60, bonusPct: 0, expScale: 1, breakMaterial: null, breakCount: 0 },
  { id: 'famed', name: '名阶', minLevel: 61, maxLevel: 120, bonusPct: 0.15, expScale: 5, breakMaterial: 'realm_book_famed', breakCount: 1 },
  { id: 'saint', name: '圣阶', minLevel: 121, maxLevel: 180, bonusPct: 0.35, expScale: 15, breakMaterial: 'realm_book_saint', breakCount: 2 },
  { id: 'divine', name: '神阶', minLevel: 181, maxLevel: 240, bonusPct: 0.6, expScale: 40, breakMaterial: 'realm_book_divine', breakCount: 3 },
] as const

/** 星级 → 基础属性倍率。重复抽卡不直接走这条路（合规 §2.1），只走印记兑换。 */
export const STAR = {
  MIN: 1,
  MAX: 6,
  /** 每星 +8% 基础属性 */
  BASE_PCT_PER_STAR: 0.08,
  /** 升星所需同名碎片 */
  SHARDS_PER_STAR: 20,
} as const

// ─────────────────────────── 技能（§5.4） ───────────────────────────

export const SKILL = {
  MIN_LEVEL: 1,
  MAX_LEVEL: 20,
  /** 每级技能效果强度 +2% */
  PCT_PER_LEVEL: 0.02,
  /** 升 1 级所需术式结晶 */
  CRYSTALS_PER_LEVEL: 12,
  /** 升 1 级所需银两 */
  SILVER_PER_LEVEL: 800,
} as const

// ─────────────────────────── 遗物（§5.4） ───────────────────────────

export const RELIC = {
  MIN_LEVEL: 1,
  MAX_LEVEL: 60,
  /** 主词条数量 */
  MAIN_COUNT: 3,
  /** 副词条数量（§17 决策 3：3 主 / 2 副起步） */
  SUB_COUNT: 2,
  /** 副词条随机词条池大小 */
  SUB_POOL_SIZE: 2,
  /** 主词条每级 +3% */
  PCT_PER_LEVEL: 0.03,
  /** 强化 1 级所需银两 */
  SILVER_PER_LEVEL: 500,
  /** 强化 1 级所需遗物强化石 */
  STONES_PER_LEVEL: 2,
  /** 分解返还 */
  DECOMPOSE_RETURN_PCT: 0.5,
} as const

// ─────────────────────────── 乘区（§5.3） ───────────────────────────

export const ZONE = {
  /** 任一乘区系数上限 +300% */
  MAX_PCT: 3.0,
} as const

// ─────────────────────────── 战斗（§6.1 / §6.2） ───────────────────────────

export const BATTLE = {
  /** 单场战斗耗时（秒），用于挂机推进与离线回放 */
  SECONDS_PER_BATTLE: 6,
  MAX_ROUNDS: 30,
  /** 减伤率上限 75% */
  MAX_DAMAGE_REDUCTION: 0.75,
  /** 相性系数 */
  ELEMENT_ADVANTAGE: 1.25,
  ELEMENT_NEUTRAL: 1.0,
  ELEMENT_DISADVANTAGE: 0.85,
  /** 随机因子区间 */
  RANDOM_MIN: 0.95,
  RANDOM_MAX: 1.05,
  /** 暴击基础伤害倍率加成 */
  CRIT_DAMAGE_BASE: 1.5,
  /** 战斗速度档位 */
  SPEED_OPTIONS: [1, 2, 4, 8] as const,
  /**
   * 召唤物的属性缩放系数（§6.5 BOSS 召唤机制）。
   *
   * 援军是模板怪物的**削弱版**：攻防血都按此系数折算。
   * 只砍血不砍攻会造出「满攻玻璃炮」——第 2 章 BOSS 实测
   * 召唤开 0% 通关 / 召唤关 100% 通关，直接把队伍秒了。
   */
  SUMMON_STAT_RATIO: 0.4,
  /**
   * 场上同时存活的召唤物上限。
   * AoE BOSS 每 3 回合召唤 2 个，不封顶会滚雪球（30 回合最多叠 20 个），
   * 难度会失控——封顶后援军是「持续压力」而非「无限叠加」。
   */
  MAX_LIVE_SUMMONS: 4,
} as const

/** 五行相克：金 → 木 → 土 → 水 → 火 → 金 */
export const ELEMENT_BEATS: Record<Element, Element> = {
  金: '木',
  木: '土',
  土: '水',
  水: '火',
  火: '金',
}

// ─────────────────────────── 离线收益（§5.7） ───────────────────────────

export const IDLE = {
  /** 满额效率小时数 */
  FULL_EFFICIENCY_HOURS: 8,
  /** 收益封顶小时数 */
  CAP_HOURS: 12,
  /** 8~12h 区间末端效率 */
  TAIL_RATE: 0.6,
  /** 在线效率 = 离线效率 × 3 */
  ONLINE_MULTIPLIER: 3,
  /** 离线回放的最大场次（防卡顿） */
  MAX_REPLAY_BATTLES: 2000,
} as const

// ─────────────────────────── 关卡难度（§5.8） ───────────────────────────

export const STAGE = {
  CHAPTERS: 10,
  /** 每章普通关卡数（不含 BOSS） */
  STAGES_PER_CHAPTER: 30,
  /**
   * 关卡战力需求：
   *   E(章c, 关i) = BASE × CHAPTER_GROWTH^(c-1) × IN_CHAPTER_GROWTH^(i-1)
   *   章末 BOSS 再 × BOSS_MULTIPLIER
   *
   * ⚠ 方案原文写作 `120 × 1.18^(章内关卡) × 3.0^(章序-1)`，但这两个常数**互相矛盾**：
   * 章内 30 关增长 1.18^29 ≈ 143×，章间倍率却只有 3×，
   * 于是每章开头会出现约 48 倍的**难度倒挂**（第 2 章第 1 关比第 1 章末关更简单），
   * 且章末 BOSS ×2.2 的尖峰也无法被下一章接住。
   *
   * 修正（保持方案的设计意图：单调递增 + 章末 BOSS 尖峰 + 总跨度与玩家成长对齐）：
   *   - 章内增长 IN_CHAPTER_GROWTH 由章间倍率与 BOSS 倍率导出：
   *       IN_CHAPTER_GROWTH = (CHAPTER_GROWTH / BOSS_MULTIPLIER)^(1/31)
   *     （指数取 1/31 = 每章 31 关；这样第 N 章首关严格高于第 N-1 章 BOSS）
   *   - 章间倍率与 BOSS 倍率共同决定总跨度。跨度必须与**玩家成长跨度**对齐：
   *     玩家从 Lv1 到满养成（含圣杯重启 +60%）约 9.1×10³ 倍，
   *     且满养成必须**能通关第 310 关并留出余量**（实战中玩家还会有更好的
   *     英灵/遗物/星级组合，配置里用的是保守模板值）。
   *     → CHAPTER_GROWTH = 3.5 时末关 ≈ 3.2×10⁷，满养成 6.76×10⁷ ≈ 2.1× 余量。
   *   - BOSS 倍率由 2.2 降为 1.5：10 章各留一个 2.2 倍尖峰，
   *     会把最小可能跨度顶到 2.2^10 ≈ 2.7×10³ 以上，与玩家成长无法对齐。
   */
  BASE_POWER: 120,
  /** 章间倍率（决定总跨度） */
  CHAPTER_GROWTH: 3.5,
  /** 章内每关增长（导出值，保证章边界严格递增） */
  IN_CHAPTER_GROWTH: Math.pow(3.5 / 1.5, 1 / 31),
  /** 章末 BOSS 额外倍率 */
  BOSS_MULTIPLIER: 1.5,
} as const

// ─────────────────────────── 抽卡（§7） ───────────────────────────

/** 基础概率（百分比，和为 100）。公示与抽卡执行共用此对象。 */
export const BASE_RATES: Record<Rarity, number> = {
  SSR: 0.6,
  SR: 5.1,
  R: 24.3,
  N: 70.0,
}

export const GACHA = {
  /** 大保底上限 */
  PITY_SSR_MAX: 90,
  /** 软保底起点：从第 71 抽起概率线性提升 */
  SOFT_PITY_START: 71,
  /** 十连保底最低稀有度 */
  TEN_PULL_FLOOR: 'SR' as Rarity,
  /** 单抽消耗圣杯结晶 */
  COST_SINGLE: 300,
  /** 十连消耗圣杯结晶 */
  COST_TEN: 3000,
  /** 抽卡券消耗 */
  TICKET_PER_PULL: 1,
  /** 重复转化（§7.4） */
  DUPLICATE_EMBLEM: {
    SSR: 50,
    SR: 12,
    R: 3,
    N: 1,
  } as Record<Rarity, number>,
  /** 重复 SSR 额外返还同名碎片 */
  DUPLICATE_SSR_SHARDS: 10,
  /** 重复 SSR 额外返还银两 */
  DUPLICATE_N_SILVER: 500,
} as const

/** 十连内的稀有度排序（用于判定"是否 SR+"） */
export const RARITY_RANK: Record<Rarity, number> = { N: 0, R: 1, SR: 2, SSR: 3 }

// ─────────────────────────── 竞技归一化（§6.8） ───────────────────────────

/** 各定位的竞技模板属性。竞技模式下所有英灵的基础属性重置为此。 */
export const ARENA_TEMPLATES: Record<Role, Stats> = {
  猛将: { atk: 100, def: 50, hp: 1000, spd: 100, crit: 0.05, cdmg: 0.5 },
  统帅: { atk: 70, def: 60, hp: 1300, spd: 110, crit: 0.05, cdmg: 0.5 },
  谋士: { atk: 85, def: 45, hp: 950, spd: 130, crit: 0.05, cdmg: 0.5 },
  医者: { atk: 60, def: 50, hp: 1200, spd: 115, crit: 0.05, cdmg: 0.5 },
  器者: { atk: 90, def: 45, hp: 1000, spd: 120, crit: 0.05, cdmg: 0.5 },
}

/** 竞技模式下的封顶系数（§6.8 映射表） */
export const ARENA_CAPS = {
  /** 星级被动系数 */
  PASSIVE_SCALE: 0.6,
  /** 技能等级 / 宝具强度上限 */
  SKILL_SCALE: 0.3,
  /** 遗物套装效果系数 */
  SET_SCALE: 0.7,
  /** 羁绊系数 */
  BOND_SCALE: 0.6,
  /** 战术铭文槽位硬上限 */
  RUNE_SLOTS_MAX: 3,
  /** 竞技等级每多少点换 1 个铭文槽 */
  RUNE_SLOTS_PER_LEVEL: 10,
} as const

/** 默认竞技配置。匹配与结算只允许使用本配置或其缩放版本。 */
export const DEFAULT_ARENA_PROFILE: ArenaProfile = {
  runeSlots: 3,
  passiveScale: ARENA_CAPS.PASSIVE_SCALE,
  skillScale: ARENA_CAPS.SKILL_SCALE,
  setScale: ARENA_CAPS.SET_SCALE,
  bondScale: ARENA_CAPS.BOND_SCALE,
  templates: ARENA_TEMPLATES,
}

// ─────────────────────────── 圣杯重启（§10.2） ───────────────────────────

export const REBIRTH = {
  /** 每轮永久加成 */
  PERM_BOOST_PER_ROUND: 0.03,
  /** 永久加成上限 +60% */
  PERM_BOOST_CAP: 0.6,
  /** 等级门槛 */
  MIN_LEVEL: 120,
  /** 通关章节门槛 */
  MIN_CHAPTER: 5,
  /** 返还比例 */
  KEEP_SKILL_LEVEL_PCT: 0,
} as const

// ─────────────────────────── 段位（§9.1） ───────────────────────────

export const TIERS = [
  { name: '黑铁', min: 0 },
  { name: '青铜', min: 300 },
  { name: '白银', min: 900 },
  { name: '黄金', min: 1800 },
  { name: '铂金', min: 3600 },
  { name: '钻石', min: 7200 },
  { name: '大师', min: 14400 },
  { name: '王者', min: 28800 },
] as const

export const ARENA = {
  /** 段位匹配容差（±N 段） */
  MATCH_TIER_TOLERANCE: 1,
  /** 竞技勋章周获取上限（防止 PvP 成为免费抽卡主渠道，§6.11） */
  MEDAL_WEEKLY_CAP: 300,
  /** 竞技兑换抽卡券周上限 */
  TICKET_WEEKLY_CAP: 10,
  /** 竞技等级来源权重 */
  ARENA_LEVEL_FROM_PASSIVES: 4,
  ARENA_LEVEL_FROM_SKILLS: 2,
  ARENA_LEVEL_FROM_SETS: 3,
  ARENA_LEVEL_FROM_CODEX: 1,
} as const

// ─────────────────────────── 日常（§11） ───────────────────────────

/** 每日签到奖励条目（各条字段可缺省，调用方按存在性取用） */
export interface DailyReward {
  crystals?: number
  silver?: number
  tickets?: number
  skillStones?: number
  relicStones?: number
}

export const DAILY = {
  SIGN_IN_CYCLE: 7,
  SIGN_IN_REWARDS: [
    { crystals: 300, silver: 5000 },
    { crystals: 300, silver: 5000 },
    { crystals: 500, tickets: 1 },
    { crystals: 500, silver: 10000 },
    { crystals: 800, skillStones: 20 },
    { crystals: 800, relicStones: 20 },
    { crystals: 1500, tickets: 2 },
  ] as readonly DailyReward[],
} as const

// ─────────────────────────── 初始资源 ───────────────────────────

export const START_RESOURCES = {
  silver: 50000,
  exp: 0,
  emblems: 0,
  crystals: 3000,
  tickets: 10,
  skillStones: 30,
  relicStones: 30,
} as const

/** 内置一次性兑换码表（§13 首发替代方案） */
export const REDEEM_CODES: Record<string, { crystals?: number; tickets?: number; emblems?: number; silver?: number; note: string }> = {
  'SGW-WELCOME-2026': { crystals: 3000, tickets: 10, note: '开服体验' },
  'SGW-TEST-001': { crystals: 600, note: '内部测试' },
}

// ─────────────────────────── 掉落表（§10.1） ───────────────────────────

export interface DropTableDef {
  silver: [number, number]
  exp: [number, number]
  skillStones: [number, number]
  relicStones: [number, number]
  /** 遗物掉落：稀有度 → 权重 */
  relicDrop: { rarity: Rarity; weight: number }[]
  /** 英灵印记掉落数量区间 */
  emblems: [number, number]
}

/**
 * 进阶资源（术式结晶 / 遗物强化石 / 英灵印记）的**章节成长底数**。
 *
 * ⚠ 原实现这三类掉落是恒定值（1-3 / 1-2 / 0-1），而养成消耗是固定的，
 * 于是主线推到最后也养不起一队满养成英灵（见 tools/balance/report.ts）：
 *   术式结晶 0.49×、遗物强化石 0.12×、英灵印记 0.16×。
 * 根因是「线性消耗 vs 恒定投放」。改为随章节增长后投放与消耗同量级，
 * 同时符合「越深的关卡资源越丰厚」这一挂机游戏标准设计。
 */
const ADVANCE_GROWTH = 1.3

/**
 * 每章一张普通关卡表 + 一张 BOSS 表。
 * 银两 / 经验随关卡难度指数增长；进阶资源按 ADVANCE_GROWTH 增长。
 */
export const DROP_TABLES: Record<string, DropTableDef> = (() => {
  const tables: Record<string, DropTableDef> = {}
  for (let chapter = 1; chapter <= STAGE.CHAPTERS; chapter++) {
    const k = Math.pow(STAGE.CHAPTER_GROWTH, chapter - 1)
    /** 进阶资源成长因子 */
    const a = Math.pow(ADVANCE_GROWTH, chapter - 1)
    tables[`stage_${chapter}`] = {
      silver: [Math.round(20 * k), Math.round(45 * k)],
      exp: [Math.round(60 * k), Math.round(140 * k)],
      skillStones: [Math.ceil(1 * a), Math.ceil(3 * a)],
      relicStones: [Math.ceil(3 * a), Math.ceil(6 * a)],
      relicDrop: [
        { rarity: 'N', weight: 60 },
        { rarity: 'R', weight: 30 },
        { rarity: 'SR', weight: 10 },
      ],
      emblems: [0, Math.ceil(2 * a)],
    }
    tables[`boss_${chapter}`] = {
      silver: [Math.round(120 * k), Math.round(260 * k)],
      exp: [Math.round(400 * k), Math.round(840 * k)],
      skillStones: [Math.ceil(2 * a), Math.ceil(7 * a)],
      relicStones: [Math.ceil(9 * a), Math.ceil(27 * a)],
      relicDrop: [
        { rarity: 'R', weight: 45 },
        { rarity: 'SR', weight: 40 },
        { rarity: 'SSR', weight: 15 },
      ],
      emblems: [Math.ceil(3 * a), Math.ceil(8 * a)],
    }
  }
  return tables
})()
