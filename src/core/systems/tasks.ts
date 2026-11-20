/**
 * 每日任务与周目标的**纯逻辑**（roadmap P2-1）。
 *
 * ## 职责边界
 *
 * - **配置**（条目 / 目标 / 奖励）在 `core/config/tasks.ts`；
 * - **周期滚动与计数**在本文件（纯函数，无 DOM、无平台 API）；
 * - **执行与发奖**在 `core/systems/actions.ts`（`daily.claimTask` 动作）。
 *
 * 客户端与服务端 import **同一份**（铁律 #4）：界面只读本文件算出来的展示态，
 * 发奖永远走服务端动作。
 *
 * ## 周期口径
 *
 * - **每日任务**：北京时间自然日（`dayIndex`），0 点重置；
 * - **周目标**：北京时间自然周（`weekIndex`，周一 0 点），与竞技周同源。
 *
 * ## 计数键
 *
 * 计数按 `metric:period` 分开存（`battle:daily` / `battle:weekly` …）：
 * 同一个行为（推征 30 场）同时推进**每日**与**每周**两个计数，
 * 但两者的重置边界不同 → 必须分开存，不能共用一个数。
 */
import { dayIndex, weekIndex } from '../time.ts'
import { EXP_BOOK } from '../config/economy.ts'
import {
  TASK_INDEX,
  tasksOfPeriod,
  type TaskDef,
  type TaskMetric,
  type TaskPeriod,
  type TaskReward,
} from '../config/tasks.ts'
import type { DailyState, RewardBundle } from '../model/types.ts'

/** 计数键：`metric:period` */
export function counterKey(metric: TaskMetric, period: TaskPeriod): string {
  return `${metric}:${period}`
}

/**
 * 周期滚动：跨日清掉每日任务的计数与领取记录，跨周清掉周目标的。
 *
 * **纯函数**：返回新对象，不修改入参 → 调用方可以在「校验通过后」才写回，
 * 失败时存档一字节未变（铁律 #29 的原子性要求）。
 */
export function rollTasks(daily: DailyState, now: number): DailyState {
  const today = dayIndex(now)
  const week = weekIndex(now)
  const next: DailyState = {
    ...daily,
    taskProgress: { ...daily.taskProgress },
    taskClaimed: [...daily.taskClaimed],
    taskDay: today,
    taskWeek: week,
  }

  if (daily.taskDay !== today) {
    // 每日任务重置：清掉每日口径的计数，周目标的领取记录保留
    for (const def of tasksOfPeriod('daily')) {
      delete next.taskProgress[counterKey(def.metric, 'daily')]
    }
    const weeklyIds = new Set(tasksOfPeriod('weekly').map((t) => t.id))
    next.taskClaimed = next.taskClaimed.filter((id) => weeklyIds.has(id))
  }

  if (daily.taskWeek !== week) {
    // 周目标重置：清掉周口径的计数，每日的领取记录保留
    for (const def of tasksOfPeriod('weekly')) {
      delete next.taskProgress[counterKey(def.metric, 'weekly')]
    }
    const dailyIds = new Set(tasksOfPeriod('daily').map((t) => t.id))
    next.taskClaimed = next.taskClaimed.filter((id) => dailyIds.has(id))
  }

  return next
}

/**
 * 推进任务计数（先滚动周期，再累加）。
 *
 * 一次行为同时计入**每日**与**每周**两个口径。
 *
 * @param delta 增量（战斗场次 / 抽卡次数 / 强化件数 / 签到次数）；≤0 时只滚动不累加
 */
export function advanceTasks(
  daily: DailyState,
  metric: TaskMetric,
  delta: number,
  now: number,
): DailyState {
  const rolled = rollTasks(daily, now)
  if (delta <= 0) return rolled
  const next: DailyState = { ...rolled, taskProgress: { ...rolled.taskProgress } }
  for (const period of ['daily', 'weekly'] as const) {
    const key = counterKey(metric, period)
    next.taskProgress[key] = (next.taskProgress[key] ?? 0) + delta
  }
  return next
}

/** 单条任务的展示态 */
export interface TaskView {
  def: TaskDef
  /** 当前周期的累计次数 */
  progress: number
  /** 本周期是否已领取 */
  claimed: boolean
  /** 是否已达目标 */
  completed: boolean
}

/** 取某个周期下的全部任务展示态 */
export function taskViews(daily: DailyState, now: number, period: TaskPeriod): TaskView[] {
  const rolled = rollTasks(daily, now)
  return tasksOfPeriod(period).map((def) => {
    const progress = rolled.taskProgress[counterKey(def.metric, period)] ?? 0
    const claimed = rolled.taskClaimed.includes(def.id)
    return { def, progress, claimed, completed: progress >= def.target }
  })
}

/** 取单条任务的展示态（任务 id 不存在时返回 null） */
export function taskView(daily: DailyState, now: number, taskId: string): TaskView | null {
  const def = TASK_INDEX.get(taskId)
  if (!def) return null
  return taskViews(daily, now, def.period).find((v) => v.def.id === taskId) ?? null
}

/**
 * 任务奖励 → 奖励包。
 *
 * ⚠ 任务奖励只可能是**通用经验书**（见 `config/tasks.ts` 的 `TaskReward`），
 *   所以这里**只搬**这两项：将来配置里若混进别的字段，编译期就会报错，
 *   不会悄悄把圣杯结晶发出去。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：奖励进 `items`（堆叠道具），
 *   不再是独立的资源字段（术式结晶 / 遗物强化石已退役）。
 */
export function taskRewardBundle(rewards: TaskReward): RewardBundle {
  const out: RewardBundle = {}
  const books = rewards.expBooks
  if (!books) return out
  const items: Record<string, number> = {}
  if (books.small) items[EXP_BOOK.small.id] = books.small
  if (books.large) items[EXP_BOOK.large.id] = books.large
  if (Object.keys(items).length > 0) {
    out.items = items as RewardBundle['items']
  }
  return out
}
