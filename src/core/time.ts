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

/** 可手动推进的测试时钟 */
export class ManualClock implements Clock {
  constructor(private current: number) {}

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

/** 一天的自然日编号（用于每日签到跨天判定） */
export function dayIndex(timestamp: number): number {
  return Math.floor(timestamp / 86_400_000)
}
