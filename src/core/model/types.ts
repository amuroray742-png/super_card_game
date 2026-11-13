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
  /** 6 槽遗物所属的套装 id（只取套装效果，不含词条与强化等级） */
  relicSets: (string | null)[]
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
    currentStage: number
    autoAdvance: boolean
    totalIdleSeconds: number
  }
  codes: string[]
  settings: { speed: number; sfx: boolean; skipAnim: boolean }
  stats: { firstStartAt: number; totalPulls: number; totalPower: number }
  /** 竞技场（Phase 11；首发仅为 PVE 天梯段位数据） */
  arena: {
    tierPoints: number
    pvpPoints: number
    medals: number
    /** 本周已获得的竞技勋章（用于周上限封顶，跨会话累计） */
    weeklyMedals: number
    /** 本周已兑换的竞技抽卡券（用于周上限封顶，跨会话累计） */
    weeklyTickets: number
    arenaLevel: number
    runes: string[]
    defenseLoadout: ArenaLoadout | null
    snapshotHash: string | null
  }
  daily: {
    signInStreak: number
    lastSignInDay: number
    taskProgress: Record<string, number>
    taskClaimed: string[]
  }
}
