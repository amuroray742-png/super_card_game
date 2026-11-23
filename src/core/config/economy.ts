/**
 * 经济与数值常数 —— 全局唯一来源。
 *
 * 铁律：任何系统都不得就地写数字，必须引用本文件。
 * 数值调参只改本文件（Phase 10 调参流程）。
 */
import type { ArenaProfile, Element, Rarity, Role, Stats } from '../model/types.ts'
import type { ItemId } from './items.ts'

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
   * 因此 EXP_GROWTH 需要按全局 239 级重新标定。
   *
   * ⚠ **实施修正（roadmap P1-2 难度曲线重标定）**：EXP_BASE 由 60 抬到 900（×15）。
   *   原值下「第 1 章一场战斗的经验（60~140）≈ 一名英灵升 1 级所需（60~254）」
   *   ——早期「1~2 场升 1 级」，首日 5 小时就顶到 Lv240（实测见
   *   artifacts/baselines/newplayer.json），经验与银两彻底贬值。
   *   抬到 900 后第 1 章约「9 场升 1 级」，配合收窄后的挂机预算与
   *   章内跨度（见 IDLE / STAGE.IN_CHAPTER_SPAN），主线变成约两周的长线节奏。
   *
   *   当前口径下单人 Lv1→240 累计经验 ≈ 4.42×10⁸，6 人编队总需求 ≈ 2.65×10⁹；
   *   产出来自**挂机刷取**（不是主线 310 次首通，那只有 4.4×10⁷）。
   *   回收比必须按**速度口径**判（逐章产出速度 ÷ 标准养成曲线的消耗速度），
   *   存量比在这里必然失真——见 tools/balance/report.ts 的「速度口径」段
   *   与 plan.md §5.8 实施修正。
   */
  EXP_BASE: 900,
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

/**
 * 经验书（**喂经验的唯一来源**）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：玩家经验池（`player.exp`）已退役，
 *   经验改由「主线掉落经验书 → 手动喂给英灵」产出（设计稿 §2）。
 *   书是**离散单位**，所以掉落表必须按「期望经验」换算成书的投放概率与数量
 *   （见 `DROP_TABLES` 的 `items` 口径）。
 *
 * ⚠ 面值待策划确认（实现文档 §5）：本轮取 1,000 / 10,000，
 *   与旧 `EXP_FEED_OPTIONS` 的前两档对齐（喂一次的量级不变）。
 */
export const EXP_BOOK = {
  /** 小经验书 */
  small: { id: 'expBookSmall' as ItemId, exp: 1_000 },
  /** 大经验书 */
  large: { id: 'expBookLarge' as ItemId, exp: 10_000 },
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
   * **进入本境界**所需的突破消耗。null = 起始境界，无需突破。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：消耗品从「英灵印记」改为**银两**。
   *   印记已随钱包收敛而退役（设计稿 §2「升星与突破分开……建议 Lv60、120、180
   *   的境界突破改扣银两，维持低星英灵通往满级的路线」）。
   *
   * ⚠ 银两档位待策划确认（实现文档 §5）：本轮按「旧印记购买力」折算的初值。
   */
  breakCost: { silver: number } | null
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
 *   银两消耗暂定 20,000 / 40,000 / 80,000（单人三次突破共 14 万银两），
 *   与印记总投放配套（见 tools/balance/report.ts）：
 *   升星碎片 + 突破银两。
 */
export const REALMS: readonly Realm[] = [
  { id: 'mortal', name: '凡阶', minLevel: 1, maxLevel: 60, bonusPct: 0, expScale: 1, breakCost: null },
  { id: 'famed', name: '名阶', minLevel: 61, maxLevel: 120, bonusPct: 0.15, expScale: 5, breakCost: { silver: 20_000 } },
  { id: 'saint', name: '圣阶', minLevel: 121, maxLevel: 180, bonusPct: 0.35, expScale: 15, breakCost: { silver: 40_000 } },
  { id: 'divine', name: '神阶', minLevel: 181, maxLevel: 240, bonusPct: 0.6, expScale: 40, breakCost: { silver: 80_000 } },
] as const

/** 星级 → 基础属性倍率。重复抽卡不直接走这条路（合规 §2.1），只走同名碎片。 */
export const STAR = {
  MIN: 1,
  MAX: 6,
  /** 每星 +8% 基础属性 */
  BASE_PCT_PER_STAR: 0.08,
  /**
   * 升星所需同名碎片。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：升星**只**扣同名碎片，印记需求已取消
   *   （设计稿 §2「升星与突破分开。所有稀有度都能靠同名碎片升星。
   *   升星只扣同名碎片」）。
   */
  SHARDS_PER_STAR: 20,
} as const

// ─────────────────────────── 技能（§5.4） ───────────────────────────

export const SKILL = {
  MIN_LEVEL: 1,
  MAX_LEVEL: 20,
  /** 每级技能效果强度 +2% */
  PCT_PER_LEVEL: 0.02,
  /**
   * 升 1 级所需**五行技能材料**数量（另需银两）。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：术式结晶（单一通用材料）已退役，
   *   改为**按英灵五行**匹配的材料（金→金系技能材料 …）。
   *   材料的 id 由 `core/config/items.ts` 的 `ITEM_BY_ELEMENT` 给出。
   */
  MATERIAL_PER_LEVEL: 12,
  /** 升 1 级所需银两 */
  SILVER_PER_LEVEL: 800,
} as const

// ─────────────────────────── 遗物（§5.4） ───────────────────────────

/** 遗物强化石档位 id（全集）。道具 id 与之一一对应。 */
export const RELIC_STONE_TIER_IDS = ['relicStoneTier1', 'relicStoneTier2', 'relicStoneTier3'] as const
export type RelicStoneTierId = (typeof RELIC_STONE_TIER_IDS)[number]

export interface RelicStoneTier {
  id: RelicStoneTierId
  name: string
  /** 该档覆盖的目标等级区间（含） */
  minLevel: number
  maxLevel: number
  /** 该档的解锁线：持有遗物最高等级达到它才可刷（设计稿 §3） */
  unlockRelicLevel: number
}

export const RELIC = {
  MIN_LEVEL: 1,
  /**
   * 强化等级上限。
   *
   * ⚠ **实施修正（roadmap P1-2 · 后期银两 / 强化石过剩）**：由 60 提到 200。
   *   原上限下「理性玩家第 2 章就把 36 件遗物全部顶到 60 级」，
   *   此后遗物强化再无任何出口 → 银两与强化石彻底过剩（实测见
   *   artifacts/baselines/recalibrate.json：累计产出银两 ≈ 4.7×10⁹、
   *   强化石 ≈ 1.5×10⁶，而旧口径的终身出口只有 1.06×10⁶ 银两 + 4248 石，
   *   差 3~4 个数量级）。
   *
   *   新的上限只是**护栏**：强化成本随等级指数上升，玩家在 40 天主线内
   *   大约推到 Lv150~170，**永远碰不到上限**（碰不到才是「出口一直开着」）。
   */
  MAX_LEVEL: 200,
  /** 主词条数量 */
  MAIN_COUNT: 3,
  /** 副词条数量（§17 决策 3：3 主 / 2 副起步） */
  SUB_COUNT: 2,
  /** 副词条随机词条池大小 */
  SUB_POOL_SIZE: 2,
  /**
   * **标准强化段**（Lv1 → OVER_SEGMENT_START）主词条每级 +3%。
   *
   * ⚠ 这一段的口径**一个字都没改**（Lv ≤ 60 的倍率与旧版逐位相同），
   *   所以难度标定的参考队伍（relic ≤ 60）战力不变，锚点口径不受牵连。
   */
  PCT_PER_LEVEL: 0.03,
  /**
   * **淬炼段**（Lv > OVER_SEGMENT_START）主词条每级 +0.6%。
   *
   * ⚠ 为什么要递减：淬炼段是**回收阀门**，不是新的战力来源。
   *   若每级仍 +3%，推到 Lv160 就是 ×4.6 倍遗物倍率，
   *   难度曲线会被单方面拉爆（铁律 #2：战斗数值只经 `resolveStats`，
   *   但标定锚点是按参考队伍的战力量出来的）。
   *   递减后推到上限也只有 ×1.30，锚点漂移在可复标定的范围内。
   */
  PCT_PER_LEVEL_OVER: 0.006,
  /** 淬炼段起点（Lv1~60 为标准段） */
  OVER_SEGMENT_START: 60,
  /**
   * 强化成本的**指数底数**（银两），**只作用于淬炼段**（Lv > OVER_SEGMENT_START）。
   *
   * ⚠ 这是回收阀门的**核心**：单位价格恒定 ⇒ 出口总量恒定
   *   （36 件 × 60 级 × 500 银两 = 1.06×10⁶），而产出是**指数增长**的
   *   （银两 2.7×/章）——恒定出口永远吸收不了指数产出，必然过剩。
   *   淬炼段按等级指数上升后，「玩家攒了多少银两」自动决定
   *   「遗物能推到多少级」：**收入直接变成出口**，过剩从存量问题变成流量问题。
   *
   * ⚠ **标准段价格恒定**（不做指数）：早期经济（Lv1→60）逐位不变，
   *   玩家前几章的养成节奏与本轮之前完全一致。
   *   实测：若从 Lv1 就指数上涨，新号首日遗物只能推到 Lv45 左右
   *   （原本 60），战力不足 → 推进从「第 154~181 关」掉到「第 147 关」。
   *   过剩出在**后期**，出口就只该开在**后期**。
   */
  COST_GROWTH: 1.1,
  /**
   * 强化成本的指数底数（强化石），同样只作用于淬炼段。
   *
   * ⚠ 与银两**分开**：石头产出按 `ADVANCE_GROWTH` 1.3×/章 增长，
   *   银两按 `DROP_GROWTH` 2.7×/章 增长。两个底数用同一个，
   *   石头会比银两先见底（强化石回收比原本是银两的 5 倍）。
   */
  STONE_COST_GROWTH: 1.06,
  /** 强化 1 级所需银两（标准段恒定；淬炼段按 COST_GROWTH 递增） */
  SILVER_PER_LEVEL: 500,
  /** 强化 1 级所需遗物强化石（标准段恒定；淬炼段按 STONE_COST_GROWTH 递增） */
  STONES_PER_LEVEL: 2,
  /**
   * **强化石三档表**（实施修正 · 资源/背包版本 v10）。
   *
   * ⚠ 档位由「**目标等级**」决定：升到 Lv60 用初阶石，升到 Lv61/Lv62 用中阶石
   *   （设计稿 §2「一次从 59 升到 62，消耗 1 个初阶段升级步骤和 2 个中阶段升级步骤
   *   对应的石量」）。
   *
   * ⚠ 档位区间与淬炼段边界**刻意不对齐**：
   *   淬炼段（成本指数段）从 Lv61 起算，三档石从 Lv61~130 算——
   *   两者是**两套口径**（成本曲线 vs 材料种类），不要合并。
   */
  STONE_TIERS: [
    { id: 'relicStoneTier1', name: '初阶强化石', minLevel: 1, maxLevel: 60, unlockRelicLevel: 1 },
    { id: 'relicStoneTier2', name: '中阶强化石', minLevel: 61, maxLevel: 130, unlockRelicLevel: 60 },
    { id: 'relicStoneTier3', name: '高阶强化石', minLevel: 131, maxLevel: 200, unlockRelicLevel: 130 },
  ] as readonly RelicStoneTier[],
  /**
   * 分解返还比例（占「累计投入 + 稀有度残值」）。
   *
   * ⚠ 口径由「500 × 等级 × 稀有度系数」改为**按累计投入折算**：
   *   旧公式让 SSR 遗物「强化到 60 级再分解」净赚 2.54×
   *   （投入 29,500 银两、返还 75,000）——那是**造币漏洞**，
   *   不是回收阀门。成本指数上升后若仍按旧公式，返还会相对投入失控。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：分解**只返银两**，不再返还强化石
   *   （设计稿 §2「建议分解只返银两，获得遗物到满仓处理均不携带副本材料」）。
   *   强化石是**副本专属产出**，分解若返还它就等于凭空造出副本材料。
   */
  DECOMPOSE_RETURN_PCT: 0.5,
  /**
   * 遗物实例库存上限。
   *
   * 遗物是唯一随挂机时长线性增长的存档字段：12 小时离线可积出数千件。
   * 上限既是存档体积的护栏，也是「仓库需要治理」的信号：
   * 超限时自动分解**最没用**的那些（未锁定、未装备、等级低、稀有度低）。
   *
   * ⚠ 锁定件与已装备件**永不**自动分解——宁可突破上限，也不毁掉玩家标记过的物品。
   */
  INVENTORY_CAP: 3000,
  /** 库存超过该比例时，仓库页显示提醒 */
  INVENTORY_WARN_RATIO: 0.9,
  /**
   * 单次批量操作最多处理多少件遗物。
   *
   * 批量动作是**同步执行**的：一次几千件的分解会让服务端事务长时间持锁，
   * 按账号串行的锁会连带卡住该账号的其它动作。
   */
  BATCH_MAX: 200,
} as const

// ─────────────────────────── 乘区（§5.3） ───────────────────────────

export const ZONE = {
  /** 任一乘区系数上限 +300% */
  MAX_PCT: 3.0,
} as const

// ─────────────────────────── 战斗（§6.1 / §6.2） ───────────────────────────

export const BATTLE = {
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
  /**
   * **挂机结算节奏单位（秒 / 次）**。
   *
   * ⚠ 挂机改版 v11：挂机**不再跑战斗**，而是按掉落表**逐次掷奖**。
   *   每 6 秒结算一次掉落 ⇒ 「挂机一场」= 「掷一次掉落」。
   *
   * ⚠ 这里**取代**了旧的 `BATTLE.SECONDS_PER_BATTLE`：
   *   挂机节奏不再是「战斗耗时」，而是「掉落掷奖间隔」——
   *   两者数值相同（6 秒），但语义完全不同（战斗耗时由战斗自己决定）。
   *   不做别名兜底（铁律 #4 / #5：单一数据源）。
   */
  SECONDS_PER_ROLL: 6,
  /**
   * 满额效率小时数。
   *
   * ⚠ **实施修正（roadmap P1-2 难度曲线重标定）**：由 8 收窄到 1。
   *   原值下「一天的挂机预算」= 8h × 600 场/h = 4,800 场，
   *   而**全游戏的内容**（清完 310 关所需的总场次）只有约 1,000 场
   *   ——一天的预算是整个游戏的 4~5 倍，于是新号首日就把等级顶格、
   *   经验与银两彻底贬值（实测见 artifacts/baselines/newplayer.json）。
   *   收窄到 1h / 封顶 3h 后，f(24h) = 2.6h → 一天 ≈ 1,560 场，
   *   主线变成「每天推进一点、约 30 天通关」的长线节奏。
   *   ⚠ 上线频率会放大收益：离线曲线按**累计时长**折算，而累计时长
   *   只在玩家活跃时归零 ⇒「每小时上线一次」与「每天上线一次」相差 9 倍。
   *   模拟挂机必须走真实的「上线 → 心跳 → 领奖」序列（见 tools/balance/newplayer.ts）。
   */
  FULL_EFFICIENCY_HOURS: 1,
  /** 收益封顶小时数 */
  CAP_HOURS: 3,
  /** 1~3h 区间末端效率（离线曲线的尾部，见 §5.7） */
  TAIL_RATE: 0.6,
  /** 仅服务端验证的未来活跃租约享受在线倍率。 */
  ONLINE_MULTIPLIER: 3,
  ACTIVE_LEASE_MS: 15_000,
  HEARTBEAT_INTERVAL_MS: 5_000,
  /**
   * **单次结算的最大掷奖次数（每通道）**（防卡顿 / 防造币）。
   *
   * ⚠ 挂机改版 v11：原名 `MAX_REPLAY_BATTLES`（回放战斗次数上限）。
   *   现在挂机不跑战斗，是「掷奖次数上限」——名字必须跟着语义走，
   *   否则两处各按各的理解用（铁律 #4）。
   *
   * ⚠ 有效预算另按 `CAP_HOURS` 封顶：按 3 小时预算 + 6 秒/次，
   *   纯离线积满时每通道 1,560 次、在线积满时每通道 1,800 次 ⇒
   *   2,000 的保护上限不会先被触到（三通道全开时合计 4,680 次）。
   */
  MAX_ROLLS_PER_SETTLEMENT: 2000,
  /**
   * 离线结算**弹窗**的触发阈值（秒）。
   *
   * 服务端每次进入游戏 / 每次动作都会补算挂机收益（玩家断网期间不损失收益，
   * 且不需要后台常驻 tick 队列）——但只有「距上次计量超过这个阈值」时，
   * 才把结算明细回传给客户端弹窗。
   *
   * ⚠ 少了这道闸门，在线期间每点一下都会弹一次「离线推征结算」：
   *   心跳每 5 秒把在线时长按 3 倍倍率记进时间账本，积累够了就在下一次动作
   *   里一次性结算 → 那明明是在线收益，不该弹「离线结算」。
   */
  OFFLINE_SETTLE_THRESHOLD_SEC: 60,
} as const

// ─────────────────────────── 遗物祈愿（遗物的独立获取入口） ───────────────────────────

/**
 * **遗物祈愿**（挂机改版 v11 §1.3 / U3）。
 *
 * ⚠ 挂机改版把遗物移出了掉落表：三条挂机通道与手动挑战的奖励范围是
 *   「经验书 / 银两 / 圣杯结晶 / 副本材料」（设计稿 §3.1），
 *   遗物改走这个**独立获取入口**。
 *
 * ⚠ **首件遗物必须在初阶强化副本解锁前可达**——初阶强化副本要求持有 Lv1 遗物，
 *   新档的遗物仓库是空的 ⇒ 没有这个入口，整条强化链路从第一步就锁死。
 *
 * ⚠ 数值待策划确认（U3「玩法与投放另行设计」）：这里给的是**最小可用实现**，
 *   成本与权重集中在本处，后续重新设计时只改这一份。
 */
export const RELIC_ACQUIRE = {
  /** 祈愿一件遗物的银两成本（扣费前先校验余额，不产生负数） */
  SILVER_COST: 5_000,
  /** 稀有度权重（抽到什么稀有度的遗物） */
  RARITY_WEIGHTS: {
    N: 55,
    R: 30,
    SR: 12,
    SSR: 3,
  } as Record<Rarity, number>,
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
   * 现在改为**逐章锚点**，锚点由 `npm run balance:recalibrate` **实测标定**
   * （真实战斗二分 + 参考队伍），**不许手填**。标定口径（§6.5）：
   *   1. **设计阶梯** = 每章 24 级（LEVEL.MAX / CHAPTERS）：
   *      第 N 章 BOSS 的目标等级 = 24N → [24, 48, 72, 96, 120, 144, 168, 192, 216, 240]。
   *      章内总跨度 2.03 = 1.03^24，正是「玩家走完一章涨的战力」——
   *      难度曲线与养成速度因此严格对齐（§12.7.5 ②）。
   *   2. 拿**参考队伍**（tools/balance/reference-build.ts）在该档的养成，
   *      对该章 BOSS 二分出「能稳过(≥90%)的最大缩放」；
   *   3. 取其一半作为目标缩放（BOSS 战不至于秒杀也不至于耗死），除以章内总跨度；
   *   4. 门槛取「刚好打得赢」那一档的战力（§6.5：宁可略紧不可略松）。
   *
   * 各章 BOSS 机制（护盾 / 召唤 / 狂暴 / 反伤 / 治疗 / 属性免疫）带来的
   * ±2~4 倍难度差异是设计的一部分，这里只保证**缩放曲线单调递增**。
   */
  SCALE_ANCHORS: [
    4.1338, 6.9214, 10.611, 19.0982, 32.6438, 55.1328, 92.3178, 174.1866, 332.2548, 559.7618,
  ],

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
   * 末关门槛 1.90×10⁷，满养成战力 3.60×10⁷ → 余量 **1.90×**（≥ 1.5× 不变量）。
   *
   * ⚠ 这两个锚点表是**标定值**：英灵 / 成长 / 掉落数值变动后必须重跑
   *   `npm run balance:recalibrate` 重新标定，否则门槛会与真实难度脱节。
   */
  POWER_ANCHORS: [
    13507, 30366, 82673, 116429, 295396, 1029297, 1866869, 3680315, 8170404, 18963679,
  ],
  /**
   * 章内普通关的缩放跨度（章首 → 章末普通关，30 步等比铺开）。
   *
   * ⚠ **实施修正（roadmap P1-2 难度曲线重标定）**：由 1.087 抬到 1.765，
   *   章内总跨度（= IN_CHAPTER_SPAN × BOSS_MULTIPLIER）由 1.25 抬到 **2.03**。
   *   理由：章内难度跨度决定「玩家要长多少级才能走完这一章」
   *   （每级战力 ×1.03，2.03 倍 ⇒ 每章约 24 级）。
   *   原值 1.25 ⇒ 每章只要 7.5 级，而玩家每章的养成投入远不止这点
   *   → 章内偏平、进度全靠门槛放行把关（§6.5 的「已知限制」第 1 条）。
   *
   *   ⚠ 章内总跨度同时是**章边界的下界**：相邻章锚点比必须 ≥ 它 ÷ 敌方基础属性增速，
   *   否则第 N+1 章首关会比第 N 章 BOSS 还简单（章边界倒挂）。
   *   ⚠ **实施修正（roadmap P1-2）**：原规则直接用「锚点比 ≥ 章内总跨度」，
   *   它隐含假设「敌方基础属性不跨章增长」。实际基础属性约 1.25×/章
   *   （§6.5「已知限制」第 1 条：BOSS 血量 2400 → 18000），
   *   字面执行会让难度增速 = 1.25 × 2.03 = 2.54×/章，
   *   而玩家每章只涨 1.03^24 = 2.03× 战力 ⇒ 难度永远跑在养成前面，
   *   标定被下限接管 → 曲线没有不动点（第 7 章后必卡死）。
   *   锚点由 `npm run balance:recalibrate` 实测标定，不手填。
   */
  IN_CHAPTER_SPAN: 1.765,
  /** 章末 BOSS 的额外缩放倍率（章内总跨度 = 1.765 × 1.15 = 2.03） */
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
  /** 每一抽的圣杯结晶价（逐抽计价：单抽与十连共用同一单价） */
  COST_SINGLE: 300,
  /** 十连抽数（十连 = 10 抽，结晶价 = COST_SINGLE × TEN_PULL_COUNT） */
  TEN_PULL_COUNT: 10,
  /**
   * 重复转化（§7.4）——**同名碎片**。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：英灵印记已随钱包收敛而退役，
   *   重复卡**只**转化为该英灵的同名碎片，且**全稀有度适用**
   *   （设计稿 §2「某英灵的同名卡碎片｜抽到该英灵的重复卡，N、R、SR、SSR 均适用
   *   ｜只给该英灵升星」）。
   *
   * ⚠ 满星后碎片仍按同一规则入包，本版不另设兑换货币（设计稿 §2）。
   * ⚠ 数值待策划确认（实现文档 §5）：按「单英雄满星 100 枚」反推的初值。
   */
  DUPLICATE_SHARDS: {
    SSR: 30,
    SR: 12,
    R: 6,
    N: 3,
  } as Record<Rarity, number>,
} as const

/** 十连内的稀有度排序（用于判定"是否 SR+"） */
export const RARITY_RANK: Record<Rarity, number> = { N: 0, R: 1, SR: 2, SSR: 3 }

// ─────────────────────────── 竞技归一化（§6.8） ───────────────────────────

/**
 * 各定位的竞技模板属性。竞技模式下所有英灵的基础属性重置为此。
 *
 * > **实施修正（2026-11，Phase 11 决策闸门实测）**：原表（atk 100 / hp 1000 一档）
 * > 是**从未跑过真实竞技对局**的纸面数值。实测 3 人以上队伍的对局**打不满 30 回合**
 * > （100% 打满、双方都还站着），战斗循环按回合上限退出 → `win` 停在默认值 →
 * > **进攻方被判负**。玩家天天「挑战失败」，勋章只给 3 枚（胜利 12 枚）、永远拿不到抽卡券。
 * >
 * > 标定口径（`npm run balance:pvp`，240 场/组）：把模板整体调到
 * > **攻 ×1.6 / 防 ×1.5 / 血 ×0.65**，让所有阵容的对局都能**真正打完**
 * > （兜底判定 0%）、回合数落在 6~26（6 人满编最长 38）。
 * >
 * > 设计意图不变：定位之间的相对关系保持（猛将爆发高容错低 / 统帅高生存 /
 * > 谋士高出手 / 医者续航 / 器者持续伤害），只改**绝对量级**——
 * > 竞技是「同一套模板给双方」，绝对值不影响公平性，只影响对局长短。
 * > §6.8 的映射表（哪些养成进竞技、封顶多少）**没有动**。
 */
export const ARENA_TEMPLATES: Record<Role, Stats> = {
  猛将: { atk: 160, def: 75, hp: 650, spd: 100, crit: 0.05, cdmg: 0.5 },
  统帅: { atk: 112, def: 90, hp: 845, spd: 110, crit: 0.05, cdmg: 0.5 },
  谋士: { atk: 136, def: 68, hp: 618, spd: 130, crit: 0.05, cdmg: 0.5 },
  医者: { atk: 96, def: 75, hp: 780, spd: 115, crit: 0.05, cdmg: 0.5 },
  器者: { atk: 144, def: 68, hp: 650, spd: 120, crit: 0.05, cdmg: 0.5 },
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
  /**
   * 竞技场的**回合上限**（比主线宽）。
   *
   * ⚠ 为什么竞技场要单独给一个上限：
   *   竞技是**归一化**数值——模板血量高、伤害低，3 人以上的队伍在主线的 30 回合里
   *   打不完（实测满编 6 人队 100% 打满 30 回合，双方都还站着）。
   *   回合用尽时 `win` 会停在默认值 → 进攻方被判负 → 玩家天天「挑战失败」。
   *   给竞技场更宽的上限，让对局能**真正打完**（分出胜负），
   *   「按剩余血量判定」只留作兜底。
   *   竞技的归一化偏「肉」是设计基线 §6.8 的定位模板决定的，
   *   改模板会动 §15.1 的隔离基线，这里选择改回合数而不是改模板。
   */
  MAX_ROUNDS: 45,
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
  /**
   * 竞技勋章周获取上限（**历史遗留**）。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：竞技勋章 / 竞技材料**停止新增**
   *   （设计稿 §3「竞技勋章和竞技材料停止新增，旧余额留记录」），
   *   抽卡券更早已随钱包收敛退役。
   *   这两个上限**不再参与结算**，只作为旧余额的只读记录口径保留
   *   （`save.arena.medals` / `save.arena.arenaMaterials` 照旧存档、照旧展示）。
   */
  MEDAL_WEEKLY_CAP: 300,
  MATERIAL_WEEKLY_CAP: 200,
  /** 竞技等级来源权重 */
  ARENA_LEVEL_FROM_PASSIVES: 4,
  ARENA_LEVEL_FROM_SKILLS: 2,
  ARENA_LEVEL_FROM_SETS: 3,
  ARENA_LEVEL_FROM_CODEX: 1,
} as const

// ─────────────────────────── PVE 长线挑战 · 三队天梯（§9.1） ───────────────────────────

/**
 * 三队天梯（roadmap P2-2）。
 *
 * 玩家用自己收集的英灵组成 **3 队**（每队最多 6 人），依次挑战 **3 个敌方梯队**。
 * 一轮 = 3 场战斗；**每周一轮**（北京时间周一零点切换）。
 *
 * ⚠ 本模式**使用 PVE 完整数值**（§9.1）：等级 / 星级 / 遗物强化 / 羁绊 / 永久加成
 *   全部生效 —— 它是玩家检验养成成果的舞台，与归一化的竞技场（`mode:'arena'`）
 *   是两套完全不同的结算。
 */
export const LADDER = {
  /** 队伍数（玩家组 3 队） */
  SQUAD_COUNT: 3,
  /** 每队人数上限 */
  SQUAD_SIZE: 6,
  /** 每个梯队胜利的段位分 */
  POINTS_PER_SQUAD: 400,
  /** 三队全胜（登顶）的额外段位分 */
  POINTS_CLEAR_BONUS: 800,
  /** 赛季长度（周） */
  SEASON_WEEKS: 4,
  /** 赛季重置时保留的段位分比例（软重置，不清零） */
  SEASON_CARRY_PCT: 0.4,

  /**
   * 梯队层的敌方属性缩放锚点（**逐梯队独立标定**，8 层 × 3 梯队）。
   *
   * 与 `STAGE.SCALE_ANCHORS` 同口径：**由真实战斗模拟标定**，
   * 不是拍脑袋的常数（`npm run balance:ladder -- --calibrate`）。
   *
   * ⚠ 为什么是「逐梯队」而不是「层锚点 × 系数」：
   *   6v6 的战斗对敌方缩放极其敏感——实测把缩放从 0.75× 提到 1.0×，
   *   通关率就从 90% 掉到 0%（敌方血量与攻击同时放大，玩家既打不动也被秒）。
   *   一个层锚点配三个系数根本压不住这个陡度，只能每个梯队各标一个值。
   *
   * 标定口径：对每一层的参考队伍（该层预期养成水平），
   * 二分出「梯队 1 通关率 ≈ 90% / 梯队 2 ≈ 65% / 梯队 3 ≈ 40%」的缩放。
   */
  SCALE_ANCHORS: [
    [8.1, 7.33, 6.51],
    [13.05, 12.84, 12.27],
    [45.46, 45.81, 46.45],
    [55.21, 50.08, 45.31],
    [98.53, 96.48, 100.97],
    [186.82, 181.21, 186.54],
    [402.02, 407.58, 392.57],
    [1099.15, 1064.83, 1028.54],
  ],

  /**
   * 标定用的参考成长水平（每一梯队层对应的主角等级）。
   *
   * 取自主线的等级阶梯（见 `STAGE.SCALE_ANCHORS` 注释）：
   * 梯队层与主线章节一一对应 → 玩家到达该段位时的预期养成水平。
   */
  REFERENCE_LEVELS: [10, 31, 62, 78, 108, 133, 164, 193],

  /** 判定为「回流」的最少离线天数 */
  RETURN_MIN_OFFLINE_DAYS: 3,
  /** 两次回流奖励之间的冷却天数 */
  RETURN_COOLDOWN_DAYS: 30,
} as const

/**
 * 赛季结算奖励分档（按**赛季内累计**的段位分）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：勋章与竞技材料**停止新增**
 *   （设计稿 §3「竞技勋章和竞技材料停止新增，旧余额留记录」），
 *   赛季奖励只剩**称号**。段位分与称号承接竞技成绩（设计稿 §3）。
 */
export const LADDER_SEASON_REWARDS = [
  { minPoints: 6000, titleTier: 'gold' },
  { minPoints: 2400, titleTier: 'silver' },
  { minPoints: 800, titleTier: 'bronze' },
  { minPoints: 0, titleTier: null },
] as const

/**
 * 回流奖励分档（按离线天数）。
 *
 * ⚠ 回流奖励属于**留存经济**，不是竞技产出：
 *   - 含养成材料（经验书）→ 计入「日常投放」预算闸门；
 *   - **不含**圣杯结晶 → 不冲击抽卡间隔（与铁律 #38 同一把尺）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：术式结晶 / 遗物强化石退役，
 *   改发**经验书**；竞技勋章停发（`medals` 恒为 0）。
 */
export const LADDER_RETURN_REWARDS = [
  { minDays: 14, items: { expBookLarge: 20, expBookSmall: 100 } as Record<ItemId, number>, medals: 0 },
  { minDays: 7, items: { expBookLarge: 12, expBookSmall: 60 } as Record<ItemId, number>, medals: 0 },
  { minDays: 3, items: { expBookLarge: 6, expBookSmall: 30 } as Record<ItemId, number>, medals: 0 },
] as const

// ─────────────────────────── 主线首通结晶（资源/背包版本 v10） ───────────────────────────

/**
 * 主线**首通**奖励（圣杯结晶）。
 *
 * ⚠ 口径（设计稿 §3）：每章 30 个普通关各给 10 结晶、BOSS 给 300
 *   → 每章 600、十章共 6,000 = **20 个十连**。
 *
 * ⚠ 判定依据是**账号级首通记录**（`campaign.creditedStages`），
 *   与「本周目进度」分开（实现文档 §2）——圣杯重启不重置它。
 *
 * ⚠ 数值待策划确认（实现文档 §5）。
 */
export const FIRST_CLEAR_CRYSTALS = {
  /** 普通关首通 */
  normal: 10,
  /** 章末 BOSS 首通 */
  boss: 300,
} as const

// ─────────────────────────── 材料副本（资源/背包版本 v10） ───────────────────────────

/** 副本难度档 id（全集） */
export const DUNGEON_DIFFICULTY_IDS = ['easy', 'normal', 'hard'] as const
export type DungeonDifficultyId = (typeof DUNGEON_DIFFICULTY_IDS)[number]

export interface DungeonDifficulty {
  id: DungeonDifficultyId
  name: string
  /**
   * **参考主线章节**（1..10）。
   *
   * ⚠ 挂机改版 v11：副本**不再取材主线波次**——副本是 24 个**独立关卡**
   *   （`(变体 × 难度) = 1 关`），有自己的敌人组合、缩放锚点与战力门槛。
   *   这个字段只用来说明「该难度段的**设计阶梯**对齐主线第几章」，
   *   即 `DUNGEON.DESIGN_LEVELS` 的来源（设计稿 §6.2-U7）。
   */
  chapter: number
  /** 掉落数量倍率（相对基准产量） */
  dropMul: number
}

export const DUNGEON_DIFFICULTIES: readonly DungeonDifficulty[] = [
  { id: 'easy', name: '简易', chapter: 1, dropMul: 1.0 },
  { id: 'normal', name: '普通', chapter: 4, dropMul: 1.6 },
  { id: 'hard', name: '困难', chapter: 8, dropMul: 2.6 },
] as const

/**
 * 副本难度档的**枚举顺序**（用于「降一档难度」建议，§3.8.3）。
 */
export const DUNGEON_DIFFICULTY_ORDER: readonly DungeonDifficultyId[] = ['easy', 'normal', 'hard'] as const

/**
 * 副本基准产量（**每次胜利**）。
 *
 * ⚠ 副本胜利**只**发所选的五行材料 / 石档，不发银两 / 经验 / 遗物
 *   （设计稿 §3「副本胜利只发所选的五行材料或石档」）。
 *
 * ⚠ 只登记**副本会产出的道具**（经验书不参与：它由主线产出）。
 *   键集必须与 `config/dungeons.ts` 的副本变体一一对应。
 *

 * ⚠ 数值待策划确认（实现文档 §5）。
 */
export const DUNGEON_DROPS: Partial<Record<ItemId, { min: number; max: number }>> = {
  skillMatGold: { min: 2, max: 5 },
  skillMatWood: { min: 2, max: 5 },
  skillMatWater: { min: 2, max: 5 },
  skillMatFire: { min: 2, max: 5 },
  skillMatEarth: { min: 2, max: 5 },
  relicStoneTier1: { min: 2, max: 4 },
  relicStoneTier2: { min: 2, max: 4 },
  relicStoneTier3: { min: 1, max: 3 },
}

// ─────────────────────────── 副本关卡锚点（挂机改版 v11） ───────────────────────────

/**
 * **副本 24 关的难度锚点**（挂机改版 v11）。
 *
 * 副本现在是**独立关卡**（`(变体 × 难度) = 1 关`，共 24 关），
 * 不再借用主线波次 ⇒ 它需要**自己的**锚点表，与主线的 `STAGE.*_ANCHORS` 解耦。
 *
 * ⚠ **三张表的长度必须都是 24**，顺序固定为
 *   `[难度段: 简易 → 普通 → 困难] × [变体: 金木水火土 / 初中高三阶]`。
 *   `config/dungeons.ts` 的关卡定义表按同一顺序索引（单一数据源，铁律 #4）。
 *
 * ⚠ **锚点是标定值，不许手填**（铁律 #41）：
 *   由 `npm run balance:recalibrate:dungeon` 实测产出
 *   （与主线同款：参考队伍 + 真实战斗二分「通关率 ≥ 90% 的最大缩放」→ 取其一半）。
 *   改了英灵 / 成长 / 掉落数值后**必须重跑**，否则门槛会与真实难度脱节。
 */
export const DUNGEON = {
  /**
   * 每关的**敌方属性缩放**锚点（标定值，长度 24）。
   *
   * 取值口径与主线 BOSS 同款：稳过上限的一半 ⇒ 既不秒杀也不耗死。
   */
  SCALE_ANCHORS: [
    1.3635, 2.2898, 3.2827, 3.1625, 6.4148, 5.6483, 28.0362, 197.482,
    26.0347, 40.6247, 63.4356, 56.1822, 110.8418, 84.569, 43.8401, 418.5333,
    498.3514, 737.6049, 1190.6128, 1107.3283, 2628.1044, 2033.5434, 1155.9876, 1029.7249,
  ],
  /**
   * 每关的**战力门槛**锚点（标定值，长度 24）。
   *
   * 口径 = **设计等级那一档的参考队伍战力**（`referenceTeam(DESIGN_LEVELS[i])`）。
   *
   * ⚠ 与主线的口径**刻意不同**：主线门槛取「刚好打得赢」那一档（§6.5 的
   *   「宁可略紧不可略松」），因为主线门槛是**挂机自动放行线**；
   *   副本门槛是**手动挑战的放行线**——玩家在设计等级带着参考养成就该能打，
   *   所以取设计等级本身的战力（`tools/balance/recalibrate-dungeon.ts` 标定）。
   */
  POWER_ANCHORS: [
    7400, 8032, 8032, 9351, 10710, 13507, 146893, 1364033,
    150606, 162858, 175518, 189812, 205300, 227752, 246467, 2916279,
    3000798, 3280835, 3575958, 3911553, 5720823, 6263130, 7060867, 7706624,
  ],
  /**
   * 每关的**设计等级**（标定的**外生输入**，长度 24）。
   *
   * ⚠ 设计阶梯必须是**外生常数**（铁律 #41）：拿模拟涌现的阶梯做标定输入
   *   会形成坏不动点（标定被自己的输入吃掉）。
   *
   * 口径（设计稿 §6.2-U7）：
   *   - 难度段对齐主线第 1 / 4 / 8 章的目标等级（Lv24 / Lv96 / Lv192）；
   *   - 段内 8 关按变体顺序在「段起点 ~ 段终点」**等比**铺开；
   *   - 强化副本 tier2 / tier3 按**解锁线**向上取整到最近的 24 级档
   *     （tier2 解锁 Lv60 → Lv72；tier3 解锁 Lv130 → Lv144）。
   */
  DESIGN_LEVELS: [
    1, 2, 2, 4, 6, 10, 72, 144,
    73, 76, 79, 82, 85, 89, 92, 168,
    169, 172, 175, 178, 182, 185, 189, 192,
  ],
} as const

// ─────────────────────────── 旧档折算（资源/背包版本 v10） ───────────────────────────

/**
 * 旧档折算表（v9 → v10）。
 *
 * ⚠ **数值待策划确认**（实现文档 §5）——除「抽卡券按 300 结晶折算」外，
 *   其余均为按「旧购买力」折算的初值。
 *
 * ⚠ 术式结晶 / 遗物强化石**不自动折算**，而是走**一次性分配权益**
 *   （`save.legacy`）：玩家自己选五行 / 石档，避免强塞无用材料
 *   （实现文档 §2「避免强塞无用材料或按件数放大高阶价值」）。
 */
export const LEGACY_CONVERSION = {
  /** 每张未用抽卡券折算的圣杯结晶（设计稿 §2「原券按每张 300 结晶折算」） */
  ticketToCrystals: 300,
  /** 每枚英灵印记折算的银两 */
  emblemToSilver: 1_000,
  /** 术式结晶 → 五行技能材料的折算率（每颗术式结晶折多少材料） */
  skillStoneToMaterial: 1,
  /** 遗物强化石 → 强化材料的折算率（每颗强化石折多少材料） */
  relicStoneToMaterial: 1,
} as const

// ─────────────────────────── 日常（§11） ───────────────────────────

/**
 * 每日签到奖励条目（各条字段可缺省，调用方按存在性取用）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：抽卡券 / 术式结晶 / 遗物强化石退役，
 *   改发**经验书**（`items`）。结晶与银两保留（设计稿 §3「签到保留各自的结晶供给」）。
 */
export interface DailyReward {
  crystals?: number
  silver?: number
  /** 堆叠道具（经验书等） */
  items?: Record<ItemId, number>
}

export const DAILY = {
  SIGN_IN_CYCLE: 7,
  SIGN_IN_REWARDS: [
    { crystals: 300, silver: 5000 },
    { crystals: 300, silver: 5000 },
    { crystals: 500, silver: 5000, items: { expBookSmall: 5 } as Record<ItemId, number> },
    { crystals: 500, silver: 10000 },
    { crystals: 800, items: { expBookSmall: 10 } as Record<ItemId, number> },
    { crystals: 800, items: { expBookLarge: 2 } as Record<ItemId, number> },
    { crystals: 1500, silver: 10000, items: { expBookLarge: 3, expBookSmall: 10 } as Record<ItemId, number> },
  ] as readonly DailyReward[],
} as const

// ─────────────────────────── 初始资源 ───────────────────────────

/**
 * 新号初始资源。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：钱包只有银两与圣杯结晶；
 *   抽卡券 / 印记 / 术式结晶 / 遗物强化石 / 经验池全部退役。
 *
 * ⚠ 结晶起点按设计稿 §3「新号仍有 20 抽购买力」给 6,000（= 20 × 300）。
 */
export const START_RESOURCES = {
  silver: 50_000,
  crystals: 6_000,
} as const

/** 新号初始道具（经验书起步量） */
export const START_ITEMS: Record<ItemId, number> = {
  expBookSmall: 10,
  expBookLarge: 2,
  skillMatGold: 0,
  skillMatWood: 0,
  skillMatWater: 0,
  skillMatFire: 0,
  skillMatEarth: 0,
  relicStoneTier1: 0,
  relicStoneTier2: 0,
  relicStoneTier3: 0,
} as const

/** 内置一次性兑换码表（§13 首发替代方案） */
export const REDEEM_CODES: Record<
  string,
  { crystals?: number; silver?: number; items?: Record<ItemId, number>; note: string }
> = {
  'SGW-WELCOME-2026': {
    crystals: 3_000,
    silver: 100_000,
    items: { expBookLarge: 10, expBookSmall: 50 } as Record<ItemId, number>,
    note: '开服体验',
  },
  'SGW-TEST-001': { crystals: 600, note: '内部测试' },
}

// ─────────────────────────── 掉落表（§10.1） ───────────────────────────

/**
 * 一条道具掉落。
 *
 * ⚠ `chance` 是**掉落概率（百分比，0~100）**，不是权重：
 *   每一类道具**各自独立**掷一次骰子（互不影响）。
 *   数量在 `[min, max]` 之间均匀取。
 *
 * ⚠ 为什么用「概率 + 固定数量」而不是「权重池」：经验书是**离散单位**，
 *   而每场的期望经验是连续值——用概率表达「这本书这一场出不出」，
 *   用数量表达「出了给几本」，两者相乘才等于期望经验（见 `expBookDrop`）。
 */
export interface ItemDrop {
  id: ItemId
  /** 掉落概率（百分比） */
  chance: number
  min: number
  max: number
}

export interface DropTableDef {
  silver: [number, number]
  /** 堆叠道具掉落（各自独立掷概率） */
  items: ItemDrop[]
}

/**
 * 进阶资源的**章节成长底数**。
 *
 * ⚠ 术式结晶 / 遗物强化石退役后，本因子只用于**副本材料**的章节成长参考，
 *   实际副本产量由 `DUNGEON_DROPS` × 难度倍率给出。
 */
export const ADVANCE_GROWTH = 1.3

/**
 * 掉落（银两 / 经验）随章节的增长倍率。
 *
 * ⚠ 这条曲线**不是**关卡难度曲线：它是「玩家养成速度」的来源，
 *   难度曲线（STAGE.SCALE_ANCHORS）反过来是按这条曲线推出的玩家水平标定的。
 *   两者必须解耦——旧实现把难度倍率（3.5）直接当掉落倍率用，
 *   导致掉落跟着难度一起暴涨，养成曲线与难度曲线互相绑死，无法单独调整。
 *
 * ⚠ **实施修正（roadmap P1-2 难度曲线重标定）**：由 3.5 降到 2.7。
 *   §12.7.5 ③ 的结论是「掉落曲线与境界台阶重新对齐」：
 *   玩家每章要涨 24 级，等级成本的**章间几何增速是 2.725**
 *   （= 每章 24 级的成本次方和之比，含境界台阶 1/5/15/40），
 *   而掉落按 3.5×/章 增长 ⇒ 收入永远跑在消耗前面，
 *   于是玩家在第 5 小时就顶格（§12.7.3 ①）。
 *   2.7 与 2.725 基本相等 ⇒ 每章耗时大致均等，
 *   境界台阶所在的第 3/6/8 章自然变成长线关卡（那三章本来就是门槛）。
 */
export const DROP_GROWTH = 2.7

/**
 * 把「每场期望经验」换算成经验书的投放（概率 + 数量）。
 *
 * ⚠ 期望经验必须与旧口径一致，否则整条养成曲线会漂：
 *   旧口径每场经验 = `[60k, 140k]`（普通关）/ `[400k, 840k]`（BOSS），
 *   平均值 = `100k` / `620k`（k = 2.7^(章-1)）。
 *
 * @param avgExp 每场**平均**经验
 * @param largeShare 大书占据的经验预算比例（0 = 全小书）
 */
function expBookDrop(avgExp: number, largeShare: number): ItemDrop[] {
  const out: ItemDrop[] = []
  const smallExp = EXP_BOOK.small.exp
  const largeExp = EXP_BOOK.large.exp

  const largeBudget = avgExp * largeShare
  if (largeBudget > 0) {
    // 数量向上取整 → 概率 ≤ 1；期望 = 概率 × 数量 × 面值 = largeBudget
    const count = Math.max(1, Math.ceil(largeBudget / largeExp))
    out.push({
      id: EXP_BOOK.large.id,
      chance: Math.min(100, (largeBudget / (count * largeExp)) * 100),
      min: count,
      max: count,
    })
  }

  const smallBudget = avgExp * (1 - largeShare)
  const count = Math.max(1, Math.ceil(smallBudget / smallExp))
  out.push({
    id: EXP_BOOK.small.id,
    chance: Math.min(100, (smallBudget / (count * smallExp)) * 100),
    min: count,
    max: count,
  })
  return out
}

/**
 * 每章一张普通关卡表 + 一张 BOSS 表。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：经验池退役 → 掉落**经验书**；
 *   术式结晶 / 遗物强化石 / 英灵印记退役 → 不再投放。
 *   掉落表不再有 `exp` / `skillStones` / `relicStones` / `emblems` 四个字段。
 *
 * ⚠ **实施修正（挂机改版 v11）**：**移除遗物掉落**——
 *   遗物改走独立获取入口（`RELIC_ACQUIRE`，见 §1.3 / U3）。
 *   主线掉落表现在只剩「银两 + 经验书」，这也让挂机（按掉落表掷奖）
 *   与手动挑战共用同一张表、同一套概率口径。
 *
 * ⚠ 大书占比随章节上升（设计稿 §2「大经验书｜主线胜利，中后期提高大书占比」）。
 */
export const DROP_TABLES: Record<string, DropTableDef> = (() => {
  const tables: Record<string, DropTableDef> = {}
  for (let chapter = 1; chapter <= STAGE.CHAPTERS; chapter++) {
    const k = Math.pow(DROP_GROWTH, chapter - 1)
    /** 大书占据的经验预算比例：前期全小书，中后期逐步换成大书 */
    const largeShare = chapter >= 7 ? 0.5 : chapter >= 5 ? 0.35 : chapter >= 4 ? 0.2 : 0
    tables[`stage_${chapter}`] = {
      silver: [Math.round(20 * k), Math.round(45 * k)],
      items: expBookDrop(100 * k, largeShare),
    }
    tables[`boss_${chapter}`] = {
      silver: [Math.round(120 * k), Math.round(260 * k)],
      items: expBookDrop(620 * k, largeShare),
    }
  }
  return tables
})()
