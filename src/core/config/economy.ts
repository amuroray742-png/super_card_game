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
   * 分解返还比例（占「累计投入 + 稀有度残值」）。
   *
   * ⚠ 口径由「500 × 等级 × 稀有度系数」改为**按累计投入折算**：
   *   旧公式让 SSR 遗物「强化到 60 级再分解」净赚 2.54×
   *   （投入 29,500 银两、返还 75,000）——那是**造币漏洞**，
   *   不是回收阀门。成本指数上升后若仍按旧公式，返还会相对投入失控。
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
  /** 离线回放的最大场次（防卡顿） */
  MAX_REPLAY_BATTLES: 2000,
  /** 挑战战败后先完成这些刷取胜场，再自动重试原目标。 */
  FARM_WINS_BEFORE_RETRY: 10,
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
  /** 每抽消耗的抽卡券数量（1 张券恰好抵 1 抽） */
  TICKET_PER_PULL: 1,
  /** 重复转化（§7.4） */
  DUPLICATE_EMBLEM: {
    SSR: 50,
    SR: 12,
    R: 3,
    N: 1,
  } as Record<Rarity, number>,
  /**
   * 重复 SSR 额外返还同名碎片。
   *
   * ⚠ 原值 10：600 枚碎片（6 人满星）= 60 张重复 SSR ≈ 全收藏时 3,643 抽
   *   （109 万圣杯结晶），实测「六人满星」是不可达目标。
   *   提到 30 后：600 枚碎片 = 20 张重复 SSR ≈ 1,215 抽（36 万结晶），
   *   单人满星从 10 张重复降到 3~4 张重复，收集党的养成目标变得可追。
   */
  DUPLICATE_SSR_SHARDS: 30,
  /** 重复 SSR 额外返还银两 */
  DUPLICATE_N_SILVER: 500,
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
  /** 竞技勋章周获取上限（防止 PvP 成为免费抽卡主渠道，§6.11） */
  MEDAL_WEEKLY_CAP: 300,
  /**
   * 竞技专属材料周获取上限。
   *
   * ⚠ 镜像试炼与三队天梯**共用同一份周预算**（`arena.weeklyMedals` /
   *   `arena.weeklyMaterials`）——两个模式各发一份却各算各的上限，
   *   玩家一周实际能拿到的就是上限的两倍（铁律 #4：单一数据源）。
   */
  MATERIAL_WEEKLY_CAP: 200,
  /** 竞技兑换抽卡券周上限 */
  TICKET_WEEKLY_CAP: 10,
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
 * ⚠ 奖励只含**竞技专属资源**与**外观**：勋章 / 竞技材料 / 称号。
 *   **绝不**含银两 / 经验 / 强化石 / 术式结晶 / 圣杯结晶 / 抽卡券（§6.11 产出隔离）。
 */
export const LADDER_SEASON_REWARDS = [
  { minPoints: 6000, medals: 400, arenaMaterials: 200, titleTier: 'gold' },
  { minPoints: 2400, medals: 200, arenaMaterials: 100, titleTier: 'silver' },
  { minPoints: 800, medals: 80, arenaMaterials: 40, titleTier: 'bronze' },
  { minPoints: 0, medals: 30, arenaMaterials: 10, titleTier: null },
] as const

/**
 * 回流奖励分档（按离线天数）。
 *
 * ⚠ 回流奖励属于**留存经济**，不是竞技产出：
 *   - 含养成材料（术式结晶 / 遗物强化石）→ 计入「日常投放」预算闸门；
 *   - **不含**圣杯结晶 / 抽卡券 → 不冲击抽卡间隔（与铁律 #38 同一把尺）。
 */
export const LADDER_RETURN_REWARDS = [
  { minDays: 14, skillStones: 200, relicStones: 150, medals: 80 },
  { minDays: 7, skillStones: 120, relicStones: 80, medals: 40 },
  { minDays: 3, skillStones: 60, relicStones: 40, medals: 20 },
] as const

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
const DROP_GROWTH = 2.7

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
