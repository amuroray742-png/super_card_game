/**
 * 主线**首通**结晶（账号级）。
 *
 * ## 口径
 *
 * 每关**首次**通关给一笔圣杯结晶：普通关 10、BOSS 300
 * （设计稿 §3「每章 30 个普通关各给 10 结晶、BOSS 给 300」→ 每章 600、十章 6,000）。
 *
 * ## 判定依据：单调高水位
 *
 * `save.campaign.clearedStage` 是**单调高水位**（只会前进，不会回退），
 * `save.campaign.creditedStages` 记「已经发过首通结晶的关卡数」。
 * 结算时 `clearedStage` 从 N 涨到 M ⇒ 第 N+1..M 关就是**本次**首次通关。
 *
 * ⚠ 圣杯重启**不重置**这两个字段（`performRebirth` 从不碰 `campaign`）
 *   → 它们天然是**账号级**记录，跨设备、跨重启都在（实现文档 §2）。
 *
 * ⚠ **副本不写 `campaign`**：副本只发材料，进度与主线记录分别记账。
 */
import { STAGE_INDEX } from '../config/stages.ts'
import { FIRST_CLEAR_CRYSTALS } from '../config/economy.ts'

/**
 * 第 `from`..`to` 关的首通结晶合计（**闭区间**）。
 *
 * @param from 起始关卡（1 起）
 * @param to   结束关卡（含）
 */
export function firstClearCrystalsForRange(from: number, to: number): number {
  if (to < from) return 0
  let total = 0
  for (let id = from; id <= to; id++) {
    const stage = STAGE_INDEX.get(id)
    if (!stage) continue
    total += stage.isBoss ? FIRST_CLEAR_CRYSTALS.boss : FIRST_CLEAR_CRYSTALS.normal
  }
  return total
}

/**
 * 结算首通结晶（**原地改存档的水位**，**不改钱包**）。
 *
 * @returns 本次发放的结晶数（0 = 没有新的首通）
 *
 * ⚠ **本函数只记账，不入账**：结晶必须由调用方放进 `rewards.crystals`，
 *   走 `applyRewardBundle` 这**唯一入库入口**（铁律 #26）。
 *   历史 bug：这里曾经直接 `save.player.crystals += crystals`，
 *   调用方又把它加进奖励包 → **同一笔结晶发两次**
 *   （E2E「挑战类动作重放同一 actionId」实测：首通给了 20 而不是 10）。
 *
 * ⚠ 发放与「记水位」必须**一起做**：先记水位再返回金额，
 *   中途抛异常会重复发；先返回金额再记水位会永久少发。
 *   这里两步都不抛异常（纯数值运算），所以顺序不敏感——
 *   但**幂等性**由 `creditedStages` 保证：同一个水位区间不会发第二次。
 */
export function grantFirstClearCrystals(save: {
  campaign: { clearedStage: number; creditedStages: number }
}): number {
  const before = save.campaign.creditedStages
  const after = save.campaign.clearedStage
  if (after <= before) return 0
  const crystals = firstClearCrystalsForRange(before + 1, after)
  save.campaign.creditedStages = after
  return crystals
}
