/**
 * 注入式时钟 —— 离线结算测试需要伪造"现在"。
 *
 * core 层禁止直接调用 Date.now()（会隐式依赖宿主环境，且难以测试）。
 */
export interface Clock {
  now(): number
}

export const systemClock: Clock = {
  now: () => Date.now(),
}

/**
 * 可手动推进的测试时钟。
 *
 * ⚠ 这里刻意**不用** TypeScript 的参数属性（`constructor(private current: number)`）：
 *   参数属性不是「可擦除语法」，Node 的原生 TS 类型擦除（`node file.ts`）会直接报
 *   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。服务端要 import core（见 AGENTS.md 铁律 #28），
 *   所以 core 里所有类都必须写成「显式字段 + 构造体内赋值」。
 */
export class ManualClock implements Clock {
  private current: number

  constructor(current: number) {
    this.current = current
  }

  now(): number {
    return this.current
  }

  advance(ms: number): void {
    this.current += ms
  }

  set(ms: number): void {
    this.current = ms
  }
}

/** 把秒数转为毫秒 */
export function seconds(ms: number): number {
  return ms * 1000
}

/** 北京时间与 UTC 的偏移（毫秒） */
const BEIJING_OFFSET_MS = 8 * 3_600_000

/**
 * 北京时间自然日编号（用于每日签到 / 每日任务的跨天判定）。
 *
 * ⚠ 口径统一到**北京时间**：
 *   此前 `dayIndex` 按 UTC 零点切日，而竞技周按北京时间周一零点切，
 *   两套口径并存会让「今日签到」与「本周奖励」在不同时间点翻转。
 *   周期类判定（日 / 周）现在**同源**，都走北京时间。
 */
export function beijingDayIndex(timestamp: number): number {
  return Math.floor((timestamp + BEIJING_OFFSET_MS) / 86_400_000)
}

/** 一天的自然日编号（北京时间） */
export function dayIndex(timestamp: number): number {
  return beijingDayIndex(timestamp)
}

/** 北京时间周一零点切周。1970-01-01 为周四，平移三天到周一。 */
export function arenaWeekIndex(timestamp: number): number {
  return Math.floor((timestamp + BEIJING_OFFSET_MS + 3 * 86_400_000) / (7 * 86_400_000))
}

/** 一周的自然周编号（北京时间周一零点）——与竞技周同源，供周期任务复用 */
export function weekIndex(timestamp: number): number {
  return arenaWeekIndex(timestamp)
}
