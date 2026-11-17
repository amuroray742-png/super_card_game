/**
 * 按账号串行化（同一账号的动作排队执行）。
 *
 * 为什么需要：服务端权威化后，「读存档 → 校验 → 改存档 → 写回」是一串
 * **必须原子**的操作。两个请求同时进来（玩家在两台设备上各点一下，
 * 或脚本并发重试）时，若都读到同一份旧存档再各自写回，就会出现
 * 「扣了两次费只发一次货」或「后写的覆盖先写的」这类丢档问题。
 *
 * 实现：每个 userId 一条 Promise 链，后到的动作等前一个跑完再执行；
 * 不同账号之间互不阻塞（单进程 SQLite 下天然并行度也有限，
 * 但至少不会互相拖慢）。
 *
 * ⚠ Node 原生 TS 剥离模式（strip-only）不支持构造函数参数属性，
 *   这里显式声明字段并在构造体内赋值（与 `core/rng.ts` 同一处理）。
 */
export class UserLock {
  /** userId → 该账号当前的动作链尾 */
  private readonly tails = new Map<number, Promise<void>>()

  /**
   * 在该账号的串行队列里执行 `fn`。
   *
   * 前一个动作失败也会继续执行下一个（失败不等于队列中毒）。
   */
  run<T>(userId: number, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tails.get(userId) ?? Promise.resolve()
    const result = prev.then(
      () => fn(),
      () => fn(),
    )
    // 队列尾永远「成功结算」，避免一个失败把后续全部卡死
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(userId, tail)
    void tail.then(() => {
      // 队列空了就把条目删掉，避免 Map 无限增长
      if (this.tails.get(userId) === tail) this.tails.delete(userId)
    })
    return result
  }

  /** 当前排队中的动作数（测试与诊断用） */
  get pending(): number {
    return this.tails.size
  }
}
