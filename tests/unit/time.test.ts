/**
 * 周期口径（Stage A）：日 / 周统一到北京时间。
 *
 * ⚠ 此前 `dayIndex` 按 UTC 零点切日，而竞技周按北京时间周一零点切，
 *   两套口径并存 → 「今日签到」与「本周奖励」在不同时间点翻转。
 *   周期类判定现在同源，都走北京时间。
 */
import { describe, expect, it } from 'vitest'
import { arenaWeekIndex, beijingDayIndex, dayIndex, weekIndex } from '../../src/core/time.ts'

/** 北京时间 2026-03-18 00:00:00 对应的 UTC 时间戳 */
const BJ_2026_03_18_00_00 = Date.UTC(2026, 2, 17, 16, 0, 0)

describe('周期口径：北京时间', () => {
  it('北京时间 00:00 是一天的分界（UTC 16:00）', () => {
    const before = BJ_2026_03_18_00_00 - 1
    const after = BJ_2026_03_18_00_00
    expect(beijingDayIndex(before)).toBe(beijingDayIndex(after) - 1)
  })

  it('dayIndex 与 beijingDayIndex 同源', () => {
    for (const ts of [0, 1_000_000, BJ_2026_03_18_00_00, Date.now()]) {
      expect(dayIndex(ts)).toBe(beijingDayIndex(ts))
    }
  })

  it('北京时间日内不跨日（同一天内 dayIndex 恒定）', () => {
    const base = BJ_2026_03_18_00_00
    expect(dayIndex(base)).toBe(dayIndex(base + 23 * 3_600_000))
  })

  it('周索引与竞技周同源', () => {
    for (const ts of [0, 1_000_000, BJ_2026_03_18_00_00, Date.now()]) {
      expect(weekIndex(ts)).toBe(arenaWeekIndex(ts))
    }
  })

  it('周索引在周一零点切换', () => {
    // 2026-03-16 是周一
    const monday = Date.UTC(2026, 2, 15, 16, 0, 0)
    expect(weekIndex(monday)).toBe(weekIndex(monday - 1) + 1)
  })
})
