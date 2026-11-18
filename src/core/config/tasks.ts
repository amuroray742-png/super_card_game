/**
 * 每日任务与周目标（roadmap P2-1）。
 *
 * ## 为什么单独一个配置文件
 *
 * 任务表是**纯数据**（条目 / 目标数 / 奖励 / 引导路由），与 `economy.ts` 的
 * 「经济常数」不同类：economy 是调参用的标量，任务表是**内容表**，
 * 和 `relics.ts` / `pools.ts` / `stages.ts` 同级。新增任务只加配置，不改逻辑。
 *
 * ## 任务来源（四条主线玩法）
 *
 * | 来源 | 统计口径 | 对应玩法 |
 * |---|---|---|
 * | 推征 | 实际跑掉的战斗场次 | 推征页 |
 * | 召唤 | 抽卡次数 | 召唤页 |
 * | 遗物 | 遗物强化件数 | 铸造页 |
 * | 签到 | 签到次数 | 每日页 |
 *
 * 每条任务都带 `route` → 任务页能**一键跳到对应玩法**
 * （铁律 #10：核心循环入口必须可达，不能只写一句「可前往 XX」）。
 *
 * ## 奖励口径（roadmap 的硬约束）
 *
 * 任务奖励**只允许养成材料**，并且是**类型层面**限死的：
 * `TaskReward` 里没有 `crystals` / `tickets` / `silver` / `emblems` 字段，
 * 想加也得先改这个类型 —— 于是编译器替我们挡住了三条红线：
 *
 * 1. **不冲击抽卡间隔**：任务不发圣杯结晶与抽卡券，
 *    抽卡节奏仍然只由签到（每周 4,700 结晶）决定；
 * 2. **不冲击养成资源回收**：只发强化石与术式结晶，
 *    且总预算 ≤「一小时挂机产出」的 ~1.5%（见 `tools/balance/report.ts` 的日常投放段）；
 * 3. **不冲击竞技产出隔离**：任务不发竞技勋章 / 竞技材料 / 竞技兑换券，
 *    竞技产出仍然只有竞技场一个来源。
 *
 * > 教训：奖励一旦允许「随便加个字段」，就会在某次「让任务更有吸引力」
 * > 的改动里悄悄塞进圣杯结晶，抽卡间隔被悄悄改掉——而公示页不会跟着变。
 */

/** 任务周期 */
export type TaskPeriod = 'daily' | 'weekly'

/** 任务统计口径（决定在哪个动作里累计） */
export type TaskMetric = 'battle' | 'pull' | 'relicUpgrade' | 'signIn'

/**
 * 任务奖励。
 *
 * ⚠ **只允许养成材料**：字段里刻意没有圣杯结晶 / 抽卡券 / 银两 / 印记 / 竞技资源。
 *   这是编译期护栏，不是注释——见文件头的「奖励口径」三条红线。
 */
export interface TaskReward {
  /** 术式结晶（技能升级消耗） */
  skillStones?: number
  /** 遗物强化石（遗物强化消耗） */
  relicStones?: number
}

/** 单条任务定义 */
export interface TaskDef {
  /** 任务 id（存档里用它标记「已领取」） */
  id: string
  /** 展示文案 */
  title: string
  /** 统计口径 */
  metric: TaskMetric
  /** 周期 */
  period: TaskPeriod
  /** 目标计数 */
  target: number
  /** 奖励 */
  rewards: TaskReward
  /**
   * 完成后引导到的**路由名**（vue-router 的 `name`）；空串表示「就在当前页」（如签到）。
   *
   * ⚠ 存路由**名**而不是路径：路由表在表现层（`presentation/router.ts`），
   *   core 不该知道界面长什么样；而 `router.push({ name })` 天然避免写死路径。
   *   路由名对不对，由 E2E「点前往真的跳到对应玩法」守护。
   */
  route: string
}

/**
 * 每日任务（北京时间自然日，0 点重置）。
 *
 * 目标数都取「几分钟内可达」——任务是**引导**，不是**门槛**：
 * 一条每天都要做的事，不该让玩家因为它而卡住。
 */
export const DAILY_TASKS: readonly TaskDef[] = [
  {
    id: 'd_battle',
    title: '推征 30 场',
    metric: 'battle',
    period: 'daily',
    target: 30,
    rewards: { relicStones: 10, skillStones: 4 },
    route: 'expedition',
  },
  {
    id: 'd_pull',
    title: '完成 1 次召唤',
    metric: 'pull',
    period: 'daily',
    target: 1,
    rewards: { relicStones: 6, skillStones: 2 },
    route: 'gacha',
  },
  {
    id: 'd_relic',
    title: '强化遗物 2 件',
    metric: 'relicUpgrade',
    period: 'daily',
    target: 2,
    rewards: { relicStones: 6, skillStones: 2 },
    route: 'forge',
  },
  {
    id: 'd_signin',
    title: '每日签到',
    metric: 'signIn',
    period: 'daily',
    target: 1,
    rewards: { relicStones: 2, skillStones: 2 },
    // 签到就在这一页，不需要跳转
    route: '',
  },
] as const

/**
 * 周目标（北京时间自然周，周一 0 点重置）。
 *
 * 目标数按「一周内每天玩一点」能达成来定；
 * **召唤条数刻意压低**（5 次 ≈ 1,500 结晶）：
 * 周签到本来就给 4,700 结晶，再往上加就等于替玩家改抽卡节奏。
 */
export const WEEKLY_TASKS: readonly TaskDef[] = [
  {
    id: 'w_battle',
    title: '累计推征 200 场',
    metric: 'battle',
    period: 'weekly',
    target: 200,
    rewards: { relicStones: 40, skillStones: 20 },
    route: 'expedition',
  },
  {
    id: 'w_pull',
    title: '累计召唤 5 次',
    metric: 'pull',
    period: 'weekly',
    target: 5,
    rewards: { relicStones: 30, skillStones: 15 },
    route: 'gacha',
  },
  {
    id: 'w_relic',
    title: '累计强化遗物 15 件',
    metric: 'relicUpgrade',
    period: 'weekly',
    target: 15,
    rewards: { relicStones: 30, skillStones: 15 },
    route: 'forge',
  },
] as const

/** 全部任务（按周期分组顺序） */
export const TASKS: readonly TaskDef[] = [...DAILY_TASKS, ...WEEKLY_TASKS]

/** 任务 id → 定义 */
export const TASK_INDEX: ReadonlyMap<string, TaskDef> = new Map(TASKS.map((t) => [t.id, t]))

/** 按周期取任务表 */
export function tasksOfPeriod(period: TaskPeriod): readonly TaskDef[] {
  return period === 'daily' ? DAILY_TASKS : WEEKLY_TASKS
}
