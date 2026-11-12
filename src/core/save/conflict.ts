/**
 * 存档并发写入的冲突判定（纯逻辑，不碰存储）。
 *
 * 背景：存档只有一个槽位（`sgw.save.main`），但可能同时存在多个写入方——
 * 玩家开了两个标签页、自动化脚本访问了同一 origin、或者浏览器恢复了旧会话。
 * 后写入的一方手里可能握着一份**过期**的存档，直接覆盖会把另一方的进度整份抹掉
 * （历史教训：存档曾被非预期改动，且无任何提示）。
 *
 * 策略：**先读后写 + 外部优先**。
 * - 每次写入都盖一个单调递增的时间戳 `savedAt`；
 * - 写入前比对存储里的版本：若存储里的版本比本进程「上次读到的版本」更新，
 *   说明**别人在我们之后改过存档**，此时本进程不得覆盖，而是采纳对方版本；
 * - 本次改动随之作废（整份存档是原子的，不存在扣了费却没出货的中间态）。
 *
 * 纯函数放 core，便于单测覆盖；存储读写在 platform 层。
 */
import type { SaveData } from '../model/types.ts'

/**
 * 计算下一次写入使用的时间戳。
 *
 * 单调递增：`now` 可能因为系统时钟回拨或同一毫秒内的连续写入而不大于
 * `knownStamp`，此时用 `knownStamp + 1` 保证严格递增，
 * 否则「后写入」的判定会退化成「先写入」。
 */
export function nextStamp(now: number, knownStamp: number): number {
  return Math.max(now, knownStamp + 1)
}

/**
 * 存储中的存档是否比本进程已知的更新。
 *
 * @param stored    当前存储里的存档（null = 还没有存档）
 * @param knownStamp 本进程最后一次「读到」或「写入」时看到的时间戳
 */
export function hasExternalUpdate(stored: SaveData | null, knownStamp: number): boolean {
  if (!stored) return false
  return (stored.savedAt ?? 0) > knownStamp
}

/**
 * 本地存档与云端存档，哪一份更新。
 *
 * 与 `hasExternalUpdate` 同一口径：**时间戳大者胜**。
 * 相同则算本地胜（本地版本会被推上去，服务端接受等值写入）。
 *
 * 不做字段级合并：挂机游戏全量覆盖可接受，合并成本高收益低。
 */
export function pickNewer(
  local: SaveData | null,
  cloud: SaveData | null,
): 'cloud' | 'local' | 'empty' {
  if (!local && !cloud) return 'empty'
  if (!local) return 'cloud'
  if (!cloud) return 'local'
  return (cloud.savedAt ?? 0) > (local.savedAt ?? 0) ? 'cloud' : 'local'
}
