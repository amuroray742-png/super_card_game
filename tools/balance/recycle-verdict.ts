/**
 * **投放回收比的判定口径**（§5.8「产出速度 vs 消耗速度」）。
 *
 * ⚠ 为什么要单独抽出来：
 *   回收阀门建好之后，逐章回收比会**贴着 1.0 上下摆动**——
 *   因为产出与消耗都是**离散动作**（一次遗物强化 = 500 银两 + 2 石、
 *   一次喂经验 = 1,000 经验），「差一次动作」不是缺钱，而是**出口已饱和**：
 *   玩家的钱正好用来买了下一次升级，剩下的不够再买一次。
 *
 *   这种「擦着 1.0 摆动」正是阀门在工作的证据，**不是**卡手。
 *   历史上只有一句「回收比 ≥1」的软判定，看不出这个区别，
 *   于是要么误报卡手（让人去调经济参数），要么被随手加个 epsilon 放过去。
 *
 * ⚠ 判定是**两条件**，缺一不可：
 *   ① **累计净额 ≥ 0**（玩家从未入不敷出）——硬条件；
 *   ② 逐章欠账不超过**容差 `step`**——软条件。
 *
 * ⚠ **`step`（容差）由调用方给，口径是「差一步」的量**：
 *   - **存量资源**（银两 / 五行材料 / 强化石 / 碎片）：
 *     玩家把资源**存在背包/钱包**里，可以跨章结转 ⇒ 容差取
 *     「一次消费动作」与「**一个挂机会话的产出**」的较大者。
 *     理由：副本模型下产出按**夜**结算（副本夜不产银两），
 *     消耗按**结算批量**发生（一次夜间把余额花光），
 *     逐章流量比天然会失真——玩家可以靠上一章的结余撑过去（并没有卡住）。
 *     「差一个会话的量」= 下一夜就能补回来 ⇒ 不算卡手。
 *   - **流量资源**（经验）：经验书到账即喂（喂书动作是贪婪的），
 *     经验维度天然贴着 1.0 走 ⇒ 容差取「一次喂书」的面值即可。
 *
 * ⚠ 本模块是**纯函数**（无 DOM / 无时钟 / 无随机），
 *   判定口径只有这一份，`tools/balance/recalibrate.ts` 与单测共用
 *   （铁律 #4：单一数据源；铁律 #29：编排下沉后两端同源）。
 */

/** 一个「章 × 资源」的收支格子 */
export interface RecycleCell {
  /** 本章产出 */
  produced: number
  /** 本章消耗 */
  spent: number
  /** **截至本章末**的累计净额（此前各章 + 本章的净余额；正 = 玩家仍有余额） */
  cumNet: number
  /** 「一次消费动作」的粒度（容差） */
  step: number
}

export interface RecycleVerdict {
  /** 产出速度 ÷ 消耗速度（消耗为 0 时视为 ∞） */
  ratio: number
  /** 本章净余额（正 = 盈余，负 = 欠账） */
  net: number
  /** 是否只是「差一次动作」（出口饱和，不算卡手） */
  saturated: boolean
  /** 是否通过（玩家没有被资源卡住） */
  ok: boolean
  /** 不通过的原因（`ok` 为 true 时为空串） */
  reason: string
}

/**
 * 判定一个「章 × 资源」格子的回收健康度。
 *
 * @param cell 该格的收支与累计余额
 * @returns 比值、饱和标记与通过与否
 */
export function judgeRecycle(cell: RecycleCell): RecycleVerdict {
  const { produced, spent, cumNet, step } = cell
  const ratio = spent > 0 ? produced / spent : Number.POSITIVE_INFINITY
  const net = produced - spent
  const deficit = -net
  const saturated = deficit > 0 && deficit <= step

  let reason = ''
  if (cumNet < 0) {
    reason = `累计余额 ${cumNet}（入不敷出）`
  } else if (ratio < 1 && !saturated) {
    reason = `欠账 ${deficit}（超过一次动作 ${step}）`
  }
  return { ratio, net, saturated, ok: reason === '', reason }
}
