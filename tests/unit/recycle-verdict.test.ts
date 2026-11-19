/**
 * 投放回收比的**判定口径**守护（实施修正 · roadmap P1-2 后期资源过剩）。
 *
 * ⚠ 守的是什么：
 *   回收阀门（遗物淬炼段）建好之后，逐章回收比会**贴着 1.0 上下摆动**——
 *   产出与消耗都是离散动作，「差一次动作」不是缺钱，而是**出口已饱和**。
 *   这时候闸门必须**判过**，否则会误报一个不存在的卡手，
 *   让人去调经济参数（而那恰恰是阀门在工作的证据）。
 *
 * ⚠ 同时守住反向的坑：
 *   - **累计净额转负**必须判红（玩家真的入不敷出了）；
 *   - **欠账超过一次消费动作**必须判红（玩家攒不够一次升级，只能干等）。
 *
 * 判定口径只有一份：`tools/balance/recycle-verdict.ts`
 * （铁律 #4：工具与单测不得各写一套）。
 */
import { describe, expect, it } from 'vitest'
import { judgeRecycle } from '../../tools/balance/recycle-verdict.ts'

describe('投放回收比判定（§5.8 速度口径）', () => {
  it('产出跟得上消耗 → 通过', () => {
    const v = judgeRecycle({ produced: 1000, spent: 500, cumNet: 500, step: 500 })
    expect(v.ratio).toBe(2)
    expect(v.ok).toBe(true)
    expect(v.saturated).toBe(false)
  })

  it('产出略少于消耗，但只差「一次动作」且累计仍为正 → 判过（出口饱和）', () => {
    // 实测形态：回收阀门建好后第 3 章银两 0.99995×，差 507 银两。
    // 该章遗物已在淬炼段（Lv70~90），一次强化的真实单价 ≈ 500×1.1¹⁰ = 1,293，
    // 所以 507 连「一次动作」都不到 → 出口饱和，判过。
    const v = judgeRecycle({ produced: 4336700, spent: 4337207, cumNet: 84, step: 1293 })
    expect(v.ratio).toBeLessThan(1)
    expect(v.saturated).toBe(true)
    expect(v.ok).toBe(true)
  })

  it('欠账超过一次动作 → 判红（玩家攒不够一次升级）', () => {
    const v = judgeRecycle({ produced: 1000, spent: 1200, cumNet: 100, step: 100 })
    expect(v.ratio).toBeLessThan(1)
    expect(v.saturated).toBe(false)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('欠账')
  })

  it('累计净额转负 → 判红（哪怕本章产出高于消耗）', () => {
    // 本章赚了 1000，但历史欠账 5000 ⇒ 玩家已经入不敷出
    const v = judgeRecycle({ produced: 1000, spent: 0, cumNet: -5000, step: 500 })
    expect(v.ratio).toBe(Number.POSITIVE_INFINITY)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('入不敷出')
  })

  it('容差按「玩家实际付过的最贵一次」取，淬炼段的大单价不会误判', () => {
    // 淬炼段一次强化要 23 万银两：差 9,866 银两只是「差一步」
    const v = judgeRecycle({ produced: 1000000, spent: 1009866, cumNet: 5000, step: 230000 })
    expect(v.saturated).toBe(true)
    expect(v.ok).toBe(true)
    // 同一笔欠账，若按基础价 500 当粒度就会被误判成卡手
    const strict = judgeRecycle({ produced: 1000000, spent: 1009866, cumNet: 5000, step: 500 })
    expect(strict.ok).toBe(false)
  })

  it('消耗为 0 的格子（该章没花）不算卡手', () => {
    const v = judgeRecycle({ produced: 0, spent: 0, cumNet: 0, step: 500 })
    expect(v.ok).toBe(true)
    expect(v.ratio).toBe(Number.POSITIVE_INFINITY)
  })
})
