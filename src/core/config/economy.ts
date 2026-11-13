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
  /**
   * 喂经验的档位（单位：经验）。
   *
   * ⚠ 这些是**经济数值**，不是 UI 常量——表现层必须从此处取（铁律 #5）。
   *   最小档 1000 大致对应第 1 章 10 场推征的产出。
   */
  EXP_FEED_OPTIONS: [1000, 10000, 100000] as const,
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
  /**
   * **进入本境界**所需的突破消耗（英灵印记）。null = 起始境界，无需突破。
   *
   * ⚠ 原字段是 `breakMaterial: 'realm_book_famed'` 这类**道具 id**，
   *   但那些 id 在整个项目里没有任何定义、掉落来源或 UI——境界突破因此
   *   从未真正实现过：实测喂经验时英灵卡死在 Lv60（`applyExp` 的硬上限是
   *   `next.minLevel - 1`），玩家经验池喂干也升不了级。
   *   现改为复用**已存在**的通用养成资源「英灵印记」，无需新增道具系统。
   */
  breakCost: { emblems: number } | null
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
 *
 * ⚠ `breakCost` 是**进入本境界**的消耗（进入名阶才付名阶的价）。
 *   印记消耗定为 10 / 20 / 40（单人三次突破共 70 枚，6 人编队共 420 枚），
 *   与印记总投放配套（见 tools/balance/report.ts）：
 *   升星 1200 + 突破 420 = 1620 枚。
 */
export const REALMS: readonly Realm[] = [
  { id: 'mortal', name: '凡阶', minLevel: 1, maxLevel: 60, bonusPct: 0, expScale: 1, breakCost: null },
  { id: 'famed', name: '名阶', minLevel: 61, maxLevel: 120, bonusPct: 0.15, expScale: 5, breakCost: { emblems: 10 } },
  { id: 'saint', name: '圣阶', minLevel: 121, maxLevel: 180, bonusPct: 0.35, expScale: 15, breakCost: { emblems: 20 } },
  { id: 'divine', name: '神阶', minLevel: 181, maxLevel: 240, bonusPct: 0.6, expScale: 40, breakCost: { emblems: 40 } },
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
  /** 升 1 级所需**术式结晶**（skillStones，不是圣杯结晶） */
  SKILL_STONES_PER_LEVEL: 12,
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
   * ── 敌方属性缩放（真实难度曲线）──────────────────────────────
   *
   * 每章一个**锚点**：`SCALE_ANCHORS[c-1]` = 该章**首关**的敌人属性缩放倍率。
   * 章内 30 个普通关按 `IN_CHAPTER_SPAN` 等比铺开，章末 BOSS 再乘 `BOSS_MULTIPLIER`，
   * 于是该章 BOSS 的缩放 = 锚点 × IN_CHAPTER_SPAN × BOSS_MULTIPLIER = 锚点 × 1.25。
   *
   * ⚠ 旧公式 `BASE_POWER × CHAPTER_GROWTH^(章序-1) × IN_CHAPTER_GROWTH^(关序-1)`
   *   的章间倍率 3.5 让缩放总跨度达到 **2.4×10⁵**，而玩家战力从 Lv1 到满养成
   *   只有约 **4.9×10³** 倍——敌方强度比养成快 50 倍。这就是「战力模型说能过
   *   第 310 关、实战只到第 246 关、第 7~10 章 BOSS 通关率 0%」的根因。
   *
   * 现在改为**逐章锚点**，锚点由**真实战斗模拟**标定（`npm run balance:battle`）：
   *   1. 玩家水平取自**经验投放模型**推出的等级阶梯
   *      （Lv10/31/62/78/108/133/164/193/225/240，见 DROP_GROWTH 的掉落曲线）；
   *   2. 对该章 BOSS 二分出「此水平下能稳过(≥90%)的最大缩放」；
   *   3. 取其一半作为目标缩放（BOSS 战落在 6~16 回合，不至于秒杀也不至于耗死）；
   *   4. 除以章内总跨度 1.25 → 章首锚点；
   *   5. 逐章递增修正，保证相邻章锚点比 ≥ 1.30（章内总跨度 1.25 必须小于它）。
   *
   * 各章 BOSS 机制（护盾 / 召唤 / 狂暴 / 反伤 / 治疗 / 属性免疫）带来的
   * ±2~4 倍难度差异是设计的一部分，这里只保证**缩放曲线单调递增**。
   */
  SCALE_ANCHORS: [3.36, 6.55, 12.56, 21.6, 33.87, 44.03, 99.53, 291.68, 792.52, 1030.27],

  /**
   * ── 关卡战力门槛（软提示 + 挂机放行线）──────────────────────
   *
   * 每章一个**锚点**：`POWER_ANCHORS[c-1]` = 该章 **BOSS 关**的战力门槛。
   * 章内按等比曲线从「上一章 BOSS 门槛 × CHAPTER_GATE_GAP」升到本章 BOSS 门槛。
   *
   * 门槛只干两件事：
   *   ① 告诉玩家「还差多少战力」；
   *   ② 挂机自动推进时判断**要不要放行到下一关**（`systems/idle.ts`）。
   * 第 ② 条是硬约束：放行**必须不晚于**该关真正打得赢的时刻。
   * 否则挂机会推进到打不过的关卡 → 打输 → 结算中断 → 玩家零收益卡死。
   * 所以门槛取「**刚能稳过该章 BOSS**」时的编队战力（实测通关率 ≥90%），
   * 宁可略紧不可略松。
   *
   * 末关门槛 2.29×10⁷，满养成战力 3.60×10⁷ → 余量 1.57×（≥ 1.5× 不变量）。
   *
   * ⚠ 这两个锚点表是**标定值**：英灵 / 成长 / 掉落数值变动后必须重跑
   *   `npm run balance:battle` 重新标定，否则门槛会与真实难度脱节。
   */
  POWER_ANCHORS: [
    7400, 17224, 59098, 82673, 166973, 372128, 1217281, 3800443, 12091058, 22872143,
  ],
  /** 章内普通关的缩放跨度（章首 → 章末普通关，30 步等比铺开） */
  IN_CHAPTER_SPAN: 1.087,
  /** 章末 BOSS 的额外缩放倍率（章内总跨度 = 1.087 × 1.15 = 1.25） */
  BOSS_MULTIPLIER: 1.15,
  /** 下一章首关门槛 = 上一章 BOSS 门槛 × 该值（章边界严格递增） */
  CHAPTER_GATE_GAP: 1.05,
  /** 第 1 章首关门槛（新手队伍远弱于标定用的满编 SSR 队伍，这里刻意放低） */
  FIRST_STAGE_POWER: 1000,
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
 * 掉落（银两 / 经验）随章节的增长倍率。
 *
 * ⚠ 这条曲线**不是**关卡难度曲线：它是「玩家养成速度」的来源，
 *   难度曲线（STAGE.SCALE_ANCHORS）反过来是按这条曲线推出的玩家水平标定的。
 *   两者必须解耦——旧实现把难度倍率（3.5）直接拿来当掉落倍率，
 *   导致掉落跟着难度一起暴涨，养成曲线与难度曲线互相绑死，无法单独调整。
 */
const DROP_GROWTH = 3.5

/**
 * 每章一张普通关卡表 + 一张 BOSS 表。
 * 银两 / 经验随章节增长；进阶资源按 ADVANCE_GROWTH 增长。
 *
 * ⚠ 印记投放（2.5a / 4a~11a）是为**境界突破**让路的：
 *   印记是继升星之后的第二大出口（单人 70 枚，6 人编队 420 枚），
 *   原投放（2a / 3a~8a）扣掉突破消耗后回收率只有 0.98×——直接是缺口。
 *   上调后回收率回到 1.2× 以上（见 tools/balance/report.ts）。
 */
export const DROP_TABLES: Record<string, DropTableDef> = (() => {
  const tables: Record<string, DropTableDef> = {}
  for (let chapter = 1; chapter <= STAGE.CHAPTERS; chapter++) {
    const k = Math.pow(DROP_GROWTH, chapter - 1)
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
      emblems: [0, Math.ceil(2.5 * a)],
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
      emblems: [Math.ceil(4 * a), Math.ceil(11 * a)],
    }
  }
  return tables
})()
