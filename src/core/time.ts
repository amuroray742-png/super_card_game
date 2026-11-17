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

/** 一天的自然日编号（用于每日签到跨天判定） */
export function dayIndex(timestamp: number): number {
  return Math.floor(timestamp / 86_400_000)
}
