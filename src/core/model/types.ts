/**
 * 全局类型契约 —— 本文件是所有模块的唯一接口来源。
 * 新增系统只在此扩展类型，业务代码不得自行发明结构。
 */

// ─────────────────────────── 基础标签 ───────────────────────────

/** 五行相性。相克环：金 → 木 → 土 → 水 → 火 → 金 */
export type Element = '金' | '木' | '水' | '火' | '土'

/** 五维定位 */
export type Role = '猛将' | '统帅' | '谋士' | '医者' | '器者'

export type Rarity = 'SSR' | 'SR' | 'R' | 'N'

export const RARITY_ORDER: readonly Rarity[] = ['N', 'R', 'SR', 'SSR'] as const

export const ELEMENTS: readonly Element[] = ['金', '木', '水', '火', '土'] as const
export const ROLES: readonly Role[] = ['猛将', '统帅', '谋士', '医者', '器者'] as const

/** 阵位类型：前排承伤 / 后排输出 */
export type SlotKind = 'front' | 'back'

// ─────────────────────────── 属性 ───────────────────────────

/** 基础六维 */
export interface Stats {
  atk: number
  def: number
  hp: number
  spd: number
  crit: number
  cdmg: number
}

/** 衍生三性（由基础值换算，不占养成位） */
export interface DerivedStats {
  dodge: number
  hit: number
  res: number
}

export interface FinalStats extends Stats, DerivedStats {}

/**
 * 属性修正。zone 决定归属哪个独立乘区（§5.3 独立乘区原则）。
 * 不同 zone 的加成相乘而非相加，避免数值膨胀失控。
 */
export type MultiplierZone = 'relic' | 'skill' | 'bond' | 'realm' | 'progress'

export type StatKey = keyof Stats

export interface StatMod {
  stat: StatKey
  /** 'pct' 百分比加成（0.15 = +15%）；'flat' 固定加值 */
  kind: 'pct' | 'flat'
  value: number
  zone: MultiplierZone
}

// ─────────────────────────── 技能 ───────────────────────────

export type SkillKind = 'normal' | 'battle' | 'ultimate'

export type SkillTarget =
  | 'enemy'
  | 'allEnemies'
  | 'ally'
  | 'allAllies'
  | 'self'

export type SkillEffect =
  | { type: 'damage'; ratio: number }
  | { type: 'heal'; ratio: number }
  | { type: 'shield'; ratio: number }
  | { type: 'buff'; stat: StatKey; value: number; turns: number }
  | { type: 'debuff'; stat: StatKey; value: number; turns: number }
  | { type: 'control'; kind: 'stun' | 'silence'; turns: number }
  | { type: 'dot'; kind: 'poison' | 'burn'; ratio: number; turns: number }

export interface SkillDef {
  id: string
  name: string
  kind: SkillKind
  desc: string
  /** 伤害 / 治疗倍率基准（1.0 = 100% atk / hp） */
  ratio: number
  target: SkillTarget
  effects: SkillEffect[]
  /** 冷却回合数，0 表示无冷却 */
  cooldown: number
  /** 解锁所需星级 */
  unlockStar: number
  /** 解锁所需等级 */
  unlockLevel: number
}

/** 星级被动。每条被动归属一个乘区。 */
export interface PassiveDef {
  id: string
  name: string
  desc: string
  unlockStar: number
  mods: StatMod[]
}

// ─────────────────────────── 英灵 ───────────────────────────

export interface HeroDef {
  id: string
  name: string
  pinyin: string
  era: string
  region: string
  rarity: Rarity
  role: Role
  element: Element
  baseStats: Stats
  growth: { atk: number; def: number; hp: number; spd: number }
  skills: SkillDef[]
  passives: PassiveDef[]
  relicAffinity: string[]
  bio: string[]
  portrait: string
  accent: string
  preferredSlots: SlotKind[]
}

/** 玩家持有的英灵实例 */
export interface HeroState {
  id: string
  level: number
  exp: number
  star: number
  /** 3 个技能等级，长度与 def.skills 对齐 */
  skillLevels: number[]
  shards: number
  /** 核心是否觉醒（觉醒后解锁终极技强化） */
  coreAwakened: boolean
  obtainedAt: number
}

/** 战斗/养成用的英灵运行时对象 */
export interface HeroRuntime {
  def: HeroDef
  state: HeroState
  /** 6 个遗物槽，与部位对应 */
  relics: (RelicInstance | null)[]
  /**
   * 编队槽位号（0-5）：**0-2 = 前排（近战位），3-5 = 后排（远程位）**。
   *
   * 这不是装饰字段，两处都依赖它：
   * - 战斗目标选择的并列判定（并列时按槽位序 → 前排先挨打）
   * - 战斗回放的站位（决定谁画在前、谁画在后）
   *
   * ⚠ 必须是**真实槽位号**，不能用「队伍里的第几个」。
   * 队伍会跳过空槽位，用紧凑序号会让后排的人被当成前排。
   */
  slot: number
}

// ─────────────────────────── 遗物 ───────────────────────────

export interface RelicDef {
  id: string
  name: string
  setId: string
  rarity: Rarity
  mainStats: StatMod[]
  /** 副词条池，生成时从中随机抽取 */
  subStatPool: StatMod[]
  desc: string
}

export interface RelicSetBonus {
  pieces: number
  desc: string
  mods: StatMod[]
}

export interface RelicSetDef {
  id: string
  name: string
  desc: string
  bonuses: RelicSetBonus[]
}

export interface RelicInstance {
  uid: string
  defId: string
  level: number
  /** 随机生成的副词条（数值已定） */
  subStats: StatMod[]
  locked: boolean
}

// ─────────────────────────── 羁绊 ───────────────────────────

export type BondCondition =
  | { type: 'role'; role: Role; count: number }
  | { type: 'element'; element: Element; count: number }
  | { type: 'distinctElements'; count: number }
  | { type: 'rarity'; rarity: Rarity; count: number }

export interface BondEffect {
  desc: string
  mods: StatMod[]
  /** 额外战斗规则修正（非属性） */
  extra?:
    | { type: 'healingBonus'; value: number }
    | { type: 'dotDamage'; value: number }
    | { type: 'cooldownReduction'; value: number }
}

export interface BondDef {
  id: string
  name: string
  desc: string
  condition: BondCondition
  effects: BondEffect[]
}

// ─────────────────────────── 敌人 / 关卡 ───────────────────────────

export type BossMechanic =
  | { type: 'shieldPhase'; threshold: number }
  | { type: 'enrage'; threshold: number; atkBonus: number }
  | { type: 'summon'; everyTurns: number; enemyId: string; count: number }
  | { type: 'elementImmunity'; element: Element }
  | { type: 'thorns'; ratio: number }
  | { type: 'regen'; ratio: number }

export interface EnemyDef {
  id: string
  /** 敌人一律为非历史人物：灵体 / 妖异 / 幻想体 / 器械造物 */
  name: string
  element: Element
  role: Role
  baseStats: Stats
  skills: SkillDef[]
  bossMechanic?: BossMechanic
}

export interface ChapterDef {
  id: number
  name: string
  /** 环境氛围主题（不指向真实历史人物或族群） */
  theme: string
  intro: string
  stageCount: number
  bossEnemyId: string
}

export interface StageDef {
  /** 全局序号 1..310 */
  id: number
  chapter: number
  /** 章内序号 1..30 */
  index: number
  isBoss: boolean
  name: string
  enemyIds: string[]
  /** 敌人属性缩放倍率（与关卡难度同曲线） */
  enemyScale: number
  /** 关卡战力门槛 */
  powerRequired: number
  expReward: number
  silverReward: number
  dropTableId: string
}

// ─────────────────────────── 卡池 ───────────────────────────

export interface PoolSelection {
  rarity?: Rarity[]
  region?: string[]
}

export interface PoolDef {
  id: string
  name: string
  desc: string
  /** 显式指定英灵；为空时按 selection 规则动态选取 */
  heroIds: string[]
  selection?: PoolSelection
  /** 基础概率（百分比，和为 100） */
  rates: Record<Rarity, number>
  /** 新手池指定保底角色 */
  guaranteedHeroId?: string
  /** 仅新手可见 */
  newbieOnly?: boolean
}

export interface DrawRecord {
  poolId: string
  heroId: string
  rarity: Rarity
  isNew: boolean
  at: number
}

// ─────────────────────────── 战斗 ───────────────────────────

export type BattleMode = 'pve' | 'arena' | 'tower'

/**
 * 竞技归一化配置（§6.8）。
 * 竞技模式下所有数值贡献只经由本文件的封顶系数进入，不存在其他路径。
 */
export interface ArenaProfile {
  /** 战术铭文槽位数量上限（硬上限 3） */
  runeSlots: number
  /** 星级被动系数 */
  passiveScale: number
  /** 技能等级 / 宝具系数上限 */
  skillScale: number
  /** 遗物套装效果系数 */
  setScale: number
  /** 羁绊系数 */
  bondScale: number
  /** 各定位的竞技模板属性 */
  templates: Record<Role, Stats>
}

/**
 * 战斗上下文。属性解析的唯一分流依据（§6.7）。
 */
export interface BattleContext {
  mode: BattleMode
  /** 竞技模式下的归一化配置；pve / tower 为 undefined */
  arenaProfile?: ArenaProfile
  seed: number
  /**
   * 编队级修正，由上层系统（team / relic）计算后注入。
   * 竞技模式下 set / bond 会被封顶系数打折，progress 直接忽略。
   */
  teamMods?: {
    bond?: StatMod[]
    set?: StatMod[]
    progress?: StatMod[]
  }
}

export interface StatusEffect {
  kind: 'buff' | 'debuff' | 'control' | 'dot'
  stat?: StatKey
  value: number
  turns: number
  /** dot 类型 */
  dotKind?: 'poison' | 'burn'
  /** control 类型 */
  controlKind?: 'stun' | 'silence'
  sourceId: string
}

export interface BattleUnit {
  id: string
  side: 'ally' | 'enemy'
  slot: number
  name: string
  element: Element
  role: Role
  stats: FinalStats
  skills: SkillDef[]
  skillLevels: number[]
  alive: boolean
  hp: number
  maxHp: number
  shield: number
  statuses: StatusEffect[]
  cooldowns: number[]
  bossMechanic?: BossMechanic
  /** 是否为 BOSS 召唤出来的援军（§6.5） */
  summoned?: boolean
  /** 出场回合（1 起）。召唤的援军 > 1，回放时出场前不应显示。 */
  appearRound?: number
  /**
   * 护盾阶段是否已经发过盾（§6.5）。
   *
   * ⚠ 护盾**只挂一次**：破盾后不再回复。
   *   历史教训：原实现每次伤害都检查「盾为空且血量 > 阈值」→ 盾被打掉后
   *   下一发伤害又补一面，血量永远打不下去 → BOSS 实际无敌，
   *   且「单次伤害必须大于盾值」使难度对缩放极度敏感
   *   （实测第 10 章 BOSS 在缩放 733 → 1500 之间通关率从 83% 掉到 0%）。
   */
  shieldPhaseUsed?: boolean
  /** 竞技模式下的铭文 */
  runes?: string[]
}

export type BattleLogKind =
  | 'damage'
  | 'heal'
  | 'shield'
  | 'buff'
  | 'debuff'
  | 'control'
  | 'dot'
  | 'skill'
  /** 单位被击败（§6.3 战斗演出） */
  | 'death'
  /** BOSS 召唤援军（§6.5） */
  | 'summon'
  | 'round'
  | 'end'

export interface BattleLogEntry {
  round: number
  kind: BattleLogKind
  actorId: string
  targetId: string
  amount: number
  crit?: boolean
  /**
   * 本次伤害被**护盾吸收**（伤害未落到血量上）。
   *
   * 战斗演出据此把飘字显示成「吸收」样式（§6.3）；
   * 表现层不得靠文案猜测。
   */
  absorbed?: boolean
  text: string
}

export interface BattleResult {
  win: boolean
  rounds: number
  log: BattleLogEntry[]
  damageById: Record<string, number>
  healById: Record<string, number>
  /**
   * 每个单位的**剩余血量**（按单位 id）。
   *
   * ⚠ `survivors` 只含**我方**存活单位（历史口径），
   *   要判断「对方还剩多少血」只能看这里——
   *   回合上限用尽时（双方都没被打空）胜负要按剩余血量比例判，
   *   没有这个字段就只能靠默认值，那会把「打不完」直接算成「输」。
   */
  hpById: Record<string, number>
  /**
   * 本场**先手方**（同速时先行动的一方）。
   *
   * - PVE：我方恒定先手 → 恒为 `'ally'`；
   * - 竞技：按对局种子**掷签**决定（§6.9 双方对称）→ 双方各 50%。
   *
   * 公平性判据要量「先手到底值多少」，必须能拿到这一项。
   */
  initiativeSide: 'ally' | 'enemy'
  mvpId: string | null
  survivors: string[]
  /**
   * 参战名单（回放渲染用）。
   *
   * ⚠ `id` 必须与 `log` 里的 `actorId` / `targetId` **完全一致**，
   * 否则表现层查不到单位，血条不会变化。
   *
   * 由 core 产出，表现层不得自行拼接单位 id（AGENTS.md 铁律 #8）。
   */
  roster: BattleUnitRosterEntry[]
}

/** 参战单位名册条目 */
export interface BattleUnitRosterEntry {
  id: string
  side: 'ally' | 'enemy'
  /**
   * 站位槽位号：
   * - 我方 = **真实编队槽位**（0-2 前排 / 3-5 后排）
   * - 敌方 = 该阵营内的出场序号（0 起）
   */
  slot: number
  name: string
  /** 血条分母：满血生命 */
  maxHp: number
  /** 出场回合（1 起）。召唤援军 > 1，回放时出场前不应显示该单位。 */
  appearRound: number
  /**
   * 基础定义 id（§6.3 战斗演出）。
   *
   * ⚠ 敌人 `id` 形如 `boss_abyss#0`（`#序号` 是同一模板的第几个），
   *   **表现层不得自行剥这个后缀**——美术路径必须由 core 按 `defId` 给出。
   *   我方 `id` 即英灵 id，此时 `defId === id`。
   */
  defId: string
  /** 定位（角色色标） */
  role: Role
  /** 五行（元素色） */
  element: Element
  /**
   * BOSS 机制类型；存在即 BOSS。
   *
   * 战斗演出据此加 BOSS 描边与分段血条（§6.3）。
   */
  mechanic?: BossMechanic['type']
}

// ─────────────────────────── 掉落 ───────────────────────────

export interface DropTable {
  id: string
  /** 掉落物 id → 数量区间 [min, max] */
  items: Record<string, [number, number]>
  /** 权重池：每项带权重，命中后按区间给数量 */
  weighted?: { id: string; weight: number; min: number; max: number }[]
}

// ─────────────────────────── 养成 / 收益 ───────────────────────────

export interface RewardBundle {
  silver?: number
  exp?: number
  emblems?: number
  crystals?: number
  tickets?: number
  skillStones?: number
  relicStones?: number
  shards?: Record<string, number>
  relics?: string[]
  heroes?: string[]
}

/** 离线结算明细 */
export interface IdleSettlement {
  seconds: number
  battles: number
  efficiency: number
  rewards: RewardBundle
  stagesAdvanced: number
  blockedAtStage: number | null
}

// ─────────────────────────── 竞技场 ───────────────────────────

export type Tier = '黑铁' | '青铜' | '白银' | '黄金' | '铂金' | '钻石' | '大师' | '王者'

/**
 * 竞技阵容快照。
 *
 * 只保留**策略性**信息：英灵 id、星级、技能等级、遗物所属套装、铭文、竞技等级。
 * 不含任何 PVE 数值（等级、遗物强化等级、随机词条、永久加成）——
 * 从类型层面阻断竞技场的数值泄漏（§6.7 / §12.4）。
 */
export interface ArenaLoadout {
  /** 6 槽英灵 id */
  heroes: (string | null)[]
  /** 与 heroes 对齐的星级 */
  stars: number[]
  /** 与 heroes 对齐的技能等级（3 个） */
  skills: number[][]
  /** 与 heroes 对齐；每名英雄保留全部遗物槽的套装 id（重复项即件数） */
  relicSets: (string | null)[][]
  /** 已装备的战术铭文（最多 3） */
  runes: string[]
  arenaLevel: number
}

export interface ArenaMatch {
  challengeId: string
  opponentId: string
  opponentName: string
  opponentLoadout: ArenaLoadout
  result: BattleResult
  pointsDelta: number
  /**
   * 回合上限用尽时的判定方式。
   *
   * - `'hp-ratio'`：双方都没被打空，按**剩余血量比例**判胜（竞技场专属规则）；
   * - 不存在：正常分出胜负。
   *
   * 界面要写清这条规则——玩家看到「打满回合」却分出胜负时，
   * 得知道是靠什么分的（AGENTS.md 铁律 #27：规则必须在玩家眼前）。
   */
  tiebreak?: 'hp-ratio'
}

// ─────────────────────────── 存档 ───────────────────────────

export interface TeamPreset {
  id: string
  name: string
  slots: (string | null)[]
}

export interface PoolState {
  /** 各池独立的保底计数镜像；实际以 gacha.pitySSR 为准 */
  totalPulls: number
}

export interface SaveData {
  version: number
  createdAt: number
  lastTickAt: number
  /**
   * 本存档最后一次成功写入存储的时间戳（毫秒）。
   *
   * 用途：多上下文（多标签页 / 多实例）并发写入时做冲突检测。
   * 旧档没有该字段时按 0 处理（= 永远「不比别人新」）。
   */
  savedAt: number
  /**
   * 随机数状态快照（初始种子 + 已消耗个数）。
   *
   * **必须随存档持久化**：抽卡序列若不落盘，刷新页面就会从头复现——
   * 玩家可以「刷新重抽」，且所有玩家的抽卡序列完全相同，
   * 概率公示宣称的 SSR 0.60% 在实际游戏里会退化成固定脚本（铁律 #24）。
   */
  rng: { seed: number; counter: number }
  player: {
    silver: number
    exp: number
    shards: Record<string, number>
    emblems: number
    crystals: number
    tickets: number
    skillStones: number
    relicStones: number
    permBoost: number
    rebirthCount: number
  }
  heroes: Record<string, HeroState>
  relics: RelicInstance[]
  /**
   * 遗物实例 uid 自增序号。
   *
   * ⚠ uid 必须由**存档内**的计数器派生（`r` + 序号的 36 进制）。
   *   早前用「模块级全局计数器 + Math.random()」生成：进程重启后计数器归零，
   *   会与存档里已有的 uid 重复 → `find(uid)` 命中**错误遗物**（强化/分解错件）；
   *   且 core 里出现 Math.random() 违反铁律 #1。
   */
  relicSeq: number
  equipped: Record<string, { heroId: string; relicId: string }>
  team: { slots: (string | null)[]; presets: TeamPreset[] }
  gacha: {
    pitySSR: number
    pity10: number
    history: DrawRecord[]
    pools: Record<string, PoolState>
    /** 新手保底资格是否已使用（首次十连保底 1 个 SSR，§7.3） */
    newbieUsed: boolean
  }
  campaign: {
    clearedStage: number
    stageStars: Record<string, number>
    chapterProgress: number
  }
  idle: {
    /** 玩家选定或自动推进的挑战目标。 */
    currentStage: number
    /** 挑战受阻时的刷取关卡及下次重试前所需的胜场。 */
    farm?: { stage: number | null; winsUntilRetry: number }
    autoAdvance: boolean
    totalIdleSeconds: number
    /** 服务端已计量水位/有效预算；旧档缺失时惰性迁移。 */
    measuredAt?: number
    effectiveMs?: number
    offlineElapsedMs?: number
    activeUntil?: number
  }
  codes: string[]
  settings: { speed: number; sfx: boolean; skipAnim: boolean }
  stats: { firstStartAt: number; totalPulls: number; totalPower: number }
  /** 竞技场（Phase 11；首发仅为 PVE 天梯段位数据） */
  arena: {
    tierPoints: number
    pvpPoints: number
    medals: number
    /** 竞技专属材料（仅用于竞技铭文；不回流 PVE 经济） */
    arenaMaterials: number
    /** 本周已获得的竞技勋章（用于周上限封顶，跨会话累计） */
    weeklyMedals: number
    /** 本周已获得的竞技专属材料（与勋章共用周预算口径，跨会话累计） */
    weeklyMaterials: number
    /** 本周已兑换的竞技抽卡券（用于周上限封顶，跨会话累计） */
    weeklyTickets: number
    /** 北京时间周一零点起的奖励周期编号 */
    rewardWeek: number
    arenaLevel: number
    runes: string[]
    defenseLoadout: ArenaLoadout | null
    snapshotHash: string | null
    /** PVE 长线挑战 · 三队天梯（§9.1） */
    ladder: LadderState
  }
  daily: DailyState
}

/**
 * 日常状态（签到 + 任务）。
 *
 * 任务计数按 `metric:period` 分开存（见 `core/systems/tasks.ts` 的 `counterKey`）：
 * 同一个行为同时计入每日与每周两个口径，但重置边界不同 → 必须分开。
 */
export interface DailyState {
  /** 连续签到天数（断签归零） */
  signInStreak: number
  /** 最后签到的自然日编号（北京时间） */
  lastSignInDay: number
  /** 任务计数：`metric:period` → 累计次数 */
  taskProgress: Record<string, number>
  /** 本周期已领取的任务 id */
  taskClaimed: string[]
  /** 任务计数所属的自然日（北京时间）；与今天不同 → 每日任务重置 */
  taskDay: number
  /** 任务计数所属的自然周（北京时间）；与本周不同 → 周目标重置 */
  taskWeek: number
}

// ─────────────────────────── PVE 长线挑战 · 三队天梯 ───────────────────────────

/**
 * 天梯状态（存档）。
 *
 * ⚠ 段位分本体存在 `arena.tierPoints`（PVE 天梯段位分，与 `arena.pvpPoints`
 *   独立换算，见 plan.md §9.2）；这里只放**天梯专属**的状态。
 */
export interface LadderState {
  /** 三队阵容：3 队 × 6 槽（存英灵 id，null = 空槽） */
  squads: (string | null)[][]
  /**
   * 本周已结算的周编号（北京时间周一零点）。
   *
   * `null` = 还没结算过（**不用 -1**：存档导入的数值校验要求非负）。
   */
  lastSettledWeek: number | null
  /** 本赛季内累计的段位分（赛季结算时按档位发奖后清零） */
  seasonPoints: number
  /** 当前赛季号（1 起；0 = 尚未初始化） */
  season: number
  /** 当前赛季的起始周编号 */
  seasonStartWeek: number
  /** 已获得的赛季称号 id */
  seasonTitles: string[]
  /** 上次活跃时间（毫秒）；用于回流判定 */
  lastActiveAt: number
  /** 上次领取回流奖励的时间（毫秒） */
  lastReturnAt: number
  /** 回流奖励待领（服务端判定后置位，领取时清零） */
  returnPending: boolean
  /** 本次回流的离线天数（0 = 非回流） */
  returnDays: number
}

/** 天梯产出（**只允许竞技专属资源**） */
export interface LadderReward {
  /** 竞技勋章（竞技专属） */
  medals: number
  /** 竞技专属材料（仅用于竞技铭文） */
  arenaMaterials: number
}

/** 一支队伍挑战一个梯队的结果 */
export interface LadderSquadResult {
  /** 队伍序号（0-2） */
  index: number
  /** 敌方梯队 id */
  enemySquadId: string
  /** 敌方梯队名 */
  enemySquadName: string
  /** 是否胜利 */
  win: boolean
  /** 战斗结果（回放与战报都取自这里） */
  result: BattleResult
}

/** 一轮（3 队）的挑战结果 */
export interface LadderRoundResult {
  /** 梯队层号 */
  tierIndex: number
  /** 梯队层名 */
  tierName: string
  /** 三支队伍的结果 */
  squads: LadderSquadResult[]
  /** 胜场数（0-3） */
  wins: number
  /** 本轮获得的段位分 */
  points: number
  /** 本轮产出 */
  reward: LadderReward
}
