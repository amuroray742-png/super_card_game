/**
 * 抽卡演出时间轴（纯逻辑，零 DOM —— 铁律 #20）。
 *
 * 覆盖：排期规则（蓄力 / SR 不阻塞 / SSR 独占）、状态推导、
 * 震屏窗口、粒子可复现与衰减、跳过语义。
 */
import { describe, expect, it } from 'vitest'
import {
  burstParticles,
  chargeMotes,
  glowEnvelope,
  moteAt,
  particleAt,
  planReveal,
  projectReveal,
  REVEAL_TIMING,
  revealTier,
  shakeOffset,
  type RevealItem,
} from '../../src/presentation/utils/gacha-reveal.ts'

const item = (heroId: string, rarity: RevealItem['rarity'], isNew = true): RevealItem => ({
  heroId,
  rarity,
  isNew,
})

describe('抽卡演出 · 档位', () => {
  it('SSR 走全屏爆点、SR 走光晕、其余安静翻开', () => {
    expect(revealTier('SSR')).toBe('burst')
    expect(revealTier('SR')).toBe('glow')
    expect(revealTier('R')).toBe('plain')
    expect(revealTier('N')).toBe('plain')
  })
})

describe('抽卡演出 · 排期', () => {
  it('蓄力结束后才开始翻第一张牌', () => {
    const plan = planReveal([item('a', 'R'), item('b', 'R')])
    expect(plan.events[0].startAt).toBe(REVEAL_TIMING.CHARGE_MS)
    expect(plan.events[1].startAt).toBe(REVEAL_TIMING.CHARGE_MS + REVEAL_TIMING.FLIP_MS)
  })

  it('SSR 爆点独占时间：下一张卡等爆点（含驻留）结束才翻', () => {
    const plan = planReveal([item('a', 'SSR'), item('b', 'R')])
    const [first, second] = plan.events
    expect(first.tier).toBe('burst')
    expect(first.fxEndAt).toBe(first.flipEndAt + REVEAL_TIMING.BURST_MS)
    // 驻留：动画放完后画面停住一段
    expect(first.holdEndAt).toBe(first.fxEndAt + REVEAL_TIMING.BURST_HOLD_MS)
    expect(second.startAt).toBe(first.holdEndAt)
  })

  it('非爆点卡没有驻留（holdEndAt = fxEndAt）', () => {
    const plan = planReveal([item('a', 'SR'), item('b', 'R')])
    expect(plan.events[0].holdEndAt).toBe(plan.events[0].fxEndAt)
    expect(plan.events[1].holdEndAt).toBe(plan.events[1].fxEndAt)
  })

  it('SR 光效不阻塞后续翻牌', () => {
    const plan = planReveal([item('a', 'SR'), item('b', 'R')])
    const [first, second] = plan.events
    expect(first.fxEndAt).toBe(first.flipEndAt + REVEAL_TIMING.GLOW_MS)
    expect(second.startAt).toBe(first.flipEndAt)
  })

  it('十连的总时长 = 末张卡结束 + 收尾', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`h${i}`, 'R'))
    const plan = planReveal(items)
    const last = plan.events[9]
    expect(plan.duration).toBe(last.flipEndAt + REVEAL_TIMING.SETTLE_MS)
  })

  it('空名册不会崩，且仍有一段蓄力时长', () => {
    const plan = planReveal([])
    expect(plan.events).toHaveLength(0)
    expect(plan.duration).toBe(REVEAL_TIMING.CHARGE_MS + REVEAL_TIMING.SETTLE_MS)
  })
})

describe('抽卡演出 · 状态推导', () => {
  const plan = planReveal([item('a', 'SSR'), item('b', 'R'), item('c', 'SR')])

  it('t=0 处于蓄力阶段，卡牌未翻开', () => {
    const st = projectReveal(0, plan)
    expect(st.phase).toBe('charge')
    expect(st.charge).toBe(0)
    expect(st.cards.every((c) => c.flip === 0 && !c.revealed)).toBe(true)
  })

  it('翻牌进度随时间推进，翻完即 revealed', () => {
    const mid = projectReveal(REVEAL_TIMING.CHARGE_MS + REVEAL_TIMING.FLIP_MS / 2, plan)
    expect(mid.cards[0].flip).toBeCloseTo(0.5, 3)
    expect(mid.cards[0].revealed).toBe(false)

    const done = projectReveal(REVEAL_TIMING.CHARGE_MS + REVEAL_TIMING.FLIP_MS, plan)
    expect(done.cards[0].flip).toBe(1)
    expect(done.cards[0].revealed).toBe(true)
  })

  it('SSR 爆点窗口内有 burst，驻留结束后没有', () => {
    const inside = projectReveal(plan.events[0].fxAt + 100, plan)
    expect(inside.burst).not.toBeNull()
    expect(inside.phase).toBe('burst')
    expect(inside.burst?.event.index).toBe(0)

    const after = projectReveal(plan.events[0].holdEndAt + 10, plan)
    expect(after.burst).toBeNull()
  })

  it('SSR 爆点后会驻留：画面停住、进度停 1、提示玩家可继续', () => {
    const ev = plan.events[0]
    // 动画刚放完 → 进入驻留
    const justAfter = projectReveal(ev.fxEndAt + 1, plan)
    expect(justAfter.phase).toBe('hold')
    expect(justAfter.burst).not.toBeNull()
    expect(justAfter.burst?.progress).toBe(1)
    expect(justAfter.burst?.hold).toBeGreaterThan(0)
    expect(justAfter.burst?.hold).toBeLessThan(1)

    // 驻留中段：画面仍在（玩家看得清），进度仍在推进
    const mid = projectReveal(ev.fxEndAt + REVEAL_TIMING.BURST_HOLD_MS * 0.5, plan)
    expect(mid.phase).toBe('hold')
    expect(mid.burst?.progress).toBe(1)
    expect(mid.burst?.hold).toBeCloseTo(0.5, 2)

    // 驻留结束 → 爆点层撤掉
    const end = projectReveal(ev.holdEndAt, plan)
    expect(end.burst).toBeNull()
    expect(end.phase).not.toBe('hold')
  })

  it('驻留计入总时长（玩家看得到的那几秒不能被吃掉）', () => {
    const plan = planReveal([item('a', 'SSR')])
    const ev = plan.events[0]
    expect(plan.duration).toBe(ev.holdEndAt + REVEAL_TIMING.SETTLE_MS)
  })

  it('SR 光效强度先起后落', () => {
    const glowEvent = plan.events.find((e) => e.tier === 'glow')!
    const peak = projectReveal(glowEvent.fxAt + REVEAL_TIMING.GLOW_MS * 0.24, plan)
    const idx = glowEvent.index
    expect(peak.cards[idx].glow).toBeGreaterThan(0.6)
    expect(projectReveal(glowEvent.fxAt, plan).cards[idx].glow).toBeCloseTo(0, 3)
    expect(projectReveal(glowEvent.fxEndAt + 1, plan).cards[idx].glow).toBe(0)
  })

  it('跳过 = 把 t 设到末尾即为 done', () => {
    const st = projectReveal(plan.duration, plan)
    expect(st.phase).toBe('done')
    expect(st.done).toBe(true)
    expect(st.cards.every((c) => c.revealed)).toBe(true)
  })

  it('光效包络在窗口外恒为 0', () => {
    expect(glowEnvelope(-1)).toBe(0)
    expect(glowEnvelope(REVEAL_TIMING.GLOW_MS + 1)).toBe(0)
    expect(glowEnvelope(REVEAL_TIMING.GLOW_MS / 2)).toBeGreaterThan(0)
  })
})

describe('抽卡演出 · 震屏', () => {
  const plan = planReveal([item('a', 'SSR')])

  it('只在爆点窗口内震，且爆点外位移为 0', () => {
    expect(shakeOffset(0, plan)).toEqual({ x: 0, y: 0 })
    const s = shakeOffset(plan.events[0].fxAt + 60, plan)
    expect(Math.abs(s.x) + Math.abs(s.y)).toBeGreaterThan(0)
    expect(shakeOffset(plan.events[0].fxEndAt + 1, plan)).toEqual({ x: 0, y: 0 })
  })

  it('同一时刻的位移可复现（纯函数）', () => {
    const t = plan.events[0].fxAt + 137
    expect(shakeOffset(t, plan)).toEqual(shakeOffset(t, plan))
  })
})

describe('抽卡演出 · 粒子', () => {
  it('同一 seed 生成同一组参数', () => {
    expect(burstParticles(1234, 20)).toEqual(burstParticles(1234, 20))
    expect(burstParticles(1234, 20)).not.toEqual(burstParticles(1235, 20))
  })

  it('粒子随时间扩散、透明度衰减到 0', () => {
    const p = burstParticles(7, 12)[0]
    // 粒子有随机延迟，必须过了 delay 才出现
    const early = particleAt(p, p.delay + 20)
    const mid = particleAt(p, p.delay + 300)
    expect(early.alpha).toBeGreaterThan(0)
    expect(mid.alpha).toBeLessThan(early.alpha)
    expect(Math.hypot(mid.x, mid.y)).toBeGreaterThan(Math.hypot(early.x, early.y))
    expect(particleAt(p, 5000).alpha).toBe(0)
  })

  it('延迟未到的粒子不可见', () => {
    const p = { ...burstParticles(9, 4)[0], delay: 200 }
    expect(particleAt(p, 100).alpha).toBe(0)
    expect(particleAt(p, 260).alpha).toBeGreaterThan(0)
  })

  it('蓄力光点按自身周期循环上升且始终在画面内', () => {
    const m = chargeMotes(11, 5)[0]
    const period = 1000 / m.speed
    expect(moteAt(m, 0).y).toBeCloseTo(moteAt(m, period).y, 6)
    for (let t = 0; t < 4000; t += 137) {
      const f = moteAt(m, t)
      expect(f.y).toBeGreaterThanOrEqual(0)
      expect(f.y).toBeLessThanOrEqual(1)
      expect(f.alpha).toBeGreaterThanOrEqual(0)
    }
  })
})
