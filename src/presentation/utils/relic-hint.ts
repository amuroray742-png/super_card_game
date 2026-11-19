/**
 * 遗物强化的**规则提示文案**（表现层唯一出处）。
 *
 * ⚠ 为什么要有这个模块（AGENTS.md 铁律 #27）：
 *   「强化价格随等级递增」是一条**会改变战斗结果**的养成规则——
 *   玩家在 Lv60 之后每点一级都要多花一截银两与强化石，收益却是递减的。
 *   规则不写在界面上，玩家只会看到「价格莫名其妙变贵了」。
 *
 * ⚠ 文案里的数字一律取 core 配置（铁律 #5）：
 *   表现层不自己写 `0.6%` / `×1.10` 这类数值，改配置时提示会跟着变。
 *   强化页与遗物详情页共用这一份文案，不各写一套（铁律 #4）。
 */
import { RELIC } from '../../core/config/economy.ts'

/**
 * 淬炼段（Lv > `OVER_SEGMENT_START`）的规则提示。
 *
 * @param level 当前强化等级
 * @returns 标准段返回空串（不打扰玩家），淬炼段返回一行提示
 */
export function relicTemperRuleHint(level: number): string {
  if (level < RELIC.OVER_SEGMENT_START) return ''
  return (
    `淬炼段（Lv${RELIC.OVER_SEGMENT_START} 起）：价格每级 ×${RELIC.COST_GROWTH.toFixed(2)}` +
    `（强化石 ×${RELIC.STONE_COST_GROWTH.toFixed(2)}），` +
    `主词条每级 +${(RELIC.PCT_PER_LEVEL_OVER * 100).toFixed(1)}%`
  )
}
