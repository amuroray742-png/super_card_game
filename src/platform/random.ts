/**
 * 平台适配层：随机种子来源（首发实现）。
 *
 * 表现层禁止直接访问 `crypto` / `Math.random` 等平台 API，一律经此接口（§12.3 铁律 #6）。
 *
 * 用途：给存档的随机数发生器一个**不可预测**的初始种子。
 * 种子若写死常量，所有玩家会抽到完全相同的序列，
 * 概率公示宣称的 SSR 0.60% 在实际游戏里会退化成固定脚本（铁律 #24）。
 */
export interface RandomSource {
  /** 生成一个 32 位无符号整数种子 */
  nextSeed(): number
}

/** 浏览器 / Node 内置加密随机源（crypto.getRandomValues 不要求安全上下文） */
export class CryptoRandomSource implements RandomSource {
  nextSeed(): number {
    const buf = new Uint32Array(1)
    globalThis.crypto.getRandomValues(buf)
    return buf[0] >>> 0
  }
}

/**
 * 降级随机源：环境没有 `crypto.getRandomValues` 时使用。
 * 只影响「种子是否可预测」，不影响抽卡概率计算本身。
 */
export class FallbackRandomSource implements RandomSource {
  nextSeed(): number {
    return Math.floor(Math.random() * 0x1_0000_0000) >>> 0
  }
}

function createSource(): RandomSource {
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') return new CryptoRandomSource()
  return new FallbackRandomSource()
}

export const randomSource: RandomSource = createSource()

/** 取一个 32 位随机种子 */
export function randomSeed(): number {
  return randomSource.nextSeed() >>> 0
}

/**
 * 生成动作幂等键（`POST /api/action` 的 `actionId`）。
 *
 * 客户端本地生成，服务端只当**去重键**用：同一个 actionId 重放时
 * 服务端直接回放上次结果，不会重复扣费（断网重试的安全网）。
 *
 * ⚠ 不用 `Math.random()` 直接拼——走平台的加密随机源，
 *   避免不同会话生成同一串 id（那样会被误判成重放）。
 */
export function newActionId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // 降级：随机数 + 时间戳 + 计数器
  actionCounter += 1
  return `a${Date.now().toString(36)}-${actionCounter.toString(36)}-${randomSeed().toString(36)}`
}

/** 降级路径的计数器（保证同一毫秒内也不撞 id） */
let actionCounter = 0
