/**
 * 登录 / 注册频率限制（进程内计数）。
 *
 * 已知限制：计数随进程重启清零，防不住分布式撞库；首发单机部署可接受。
 */
export class RateLimiter {
  /**
   * 窗口内允许的最大失败次数。
   *
   * 这里用普通字段而不是构造函数参数属性（`private readonly limit`）——
   * Node 原生 TS 剥离模式（strip-only）不支持参数属性，
   * 服务端要能直接用 `node server/src/index.ts` 启动。
   */
  private readonly limit: number
  /** 失败计数窗口（毫秒） */
  private readonly windowMs: number
  private buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** 当前是否已被限流 */
  isBlocked(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key)
    if (!bucket) return false
    if (now >= bucket.resetAt) {
      this.buckets.delete(key)
      return false
    }
    return bucket.count >= this.limit
  }

  /** 记录一次失败 */
  recordFailure(key: string, now = Date.now()): void {
    const bucket = this.buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return
    }
    bucket.count += 1
  }

  /** 成功后清零 */
  clear(key: string): void {
    this.buckets.delete(key)
  }

  /** 剩余等待秒数（用于 429 响应） */
  retryAfterSec(key: string, now = Date.now()): number {
    const bucket = this.buckets.get(key)
    if (!bucket) return 0
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  }
}
