/**
 * 可复现随机数（种子 + 计数器）。
 *
 * 抽卡与战斗共用同一实现，保证：
 * - 相同种子 → 相同结果（可复现的战斗战报、可审计的抽卡）
 * - 抽卡概率可被蒙特卡洛精确验证
 *
 * 使用 mulberry32 算法：32 位状态、周期 2^32、分布均匀、实现极短。
 */
export class Rng {
  private state: number
  /**
   * **初始**种子（不是当前内部状态）。
   *
   * 快照要能忠实复原，只能记「初始种子 + 已消耗个数」：
   * 内部状态本身不足以反推初始种子，`fromSnapshot` 是靠重放复原的。
   */
  private origin: number
  /** 已消耗的随机数个数，便于快照与复现 */
  private counter = 0

  constructor(seed: number) {
    // 种子可以是整数，也可以是 [0,1) 的浮点（`Rng.next()` 的返回值）。
    //
    // ⚠ 浮点**不能**直接 `>>> 0`——那会把 [0,1) 的浮点截断成 0，
    // 于是所有调用都落到同一个兜底种子，抽卡 / 战斗 / 挂机掉落的结果全部固定
    // （历史教训，铁律 #24）。浮点按 2^32 放大成 32 位整数。
    const s = Number.isFinite(seed) ? seed : 0
    const int = Number.isInteger(s) ? s : Math.floor(s * 0x1_0000_0000)
    // 保证种子为正整数，避免 0 状态下退化
    this.origin = (int >>> 0) || 0x9e3779b9
    this.state = this.origin
  }

  /**
   * 取一个 32 位整数种子（用于派生一条新的随机序列）。
   *
   * 比 `next()` 更适合当种子传下去：整数种子不会被浮点截断。
   */
  nextSeed(): number {
    return Math.floor(this.next() * 0x1_0000_0000) >>> 0
  }

  /** 当前随机数状态快照（可忠实复原：初始种子 + 已消耗个数） */
  snapshot(): { seed: number; counter: number } {
    return { seed: this.origin, counter: this.counter }
  }

  /** 从快照复原：重放 counter 次，序列与快照时刻完全一致 */
  static fromSnapshot(seed: number, counter: number): Rng {
    const rng = new Rng(seed)
    // 快进 counter 次以复现消耗位置
    for (let i = 0; i < counter; i++) rng.next()
    return rng
  }

  /** [0, 1) 均匀分布 */
  next(): number {
    this.counter++
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** [min, max) 浮点 */
  float(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** [min, max] 整数 */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1))
  }

  /** 等概率取一个元素 */
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]
  }

  /** 按权重取一个元素。weights 长度须与 items 一致。 */
  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0
    for (const w of weights) total += w
    let roll = this.next() * total
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i]
      if (roll < 0) return items[i]
    }
    return items[items.length - 1]
  }

  /** 按概率表取索引。rates 之和应为 1（或 100，若用百分数）。 */
  pickByRate(rates: readonly number[]): number {
    let total = 0
    for (const r of rates) total += r
    let roll = this.next() * total
    for (let i = 0; i < rates.length; i++) {
      roll -= rates[i]
      if (roll < 0) return i
    }
    return rates.length - 1
  }

  /** 原地洗牌（Fisher-Yates） */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      const tmp = items[i]
      items[i] = items[j]
      items[j] = tmp
    }
    return items
  }
}

/** 从任意字符串生成稳定种子（用于快照 hash、场景 id 等） */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}
