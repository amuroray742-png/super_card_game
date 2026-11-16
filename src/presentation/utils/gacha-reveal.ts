/**
 * 抽卡演出时间轴（纯逻辑，**零 DOM 依赖**，可在 Node 下单测）。
 *
 * 铁律 #20：演出是时间的纯函数 `f(t)`。抽卡演出同样如此——
 * 整段演出先由 `planReveal()` 排成**事件表**，任意时刻的画面由
 * `projectReveal(t)` **推导**出来，不做增量累积状态。因此：
 * - 跳过 = 直接把 `t` 设到末尾；
 * - 倍速 = 时间缩放；
 * - 重播 = 清零。
 *
 * 节奏常量属**表现层**，放本文件（不进 `core/config/economy.ts`，铁律 #20）。
 *
 * 分级演出（按稀有度）：
 * - `N` / `R`：安静翻开；
 * - `SR`：金色/蓝色光晕 + 轻音效；
 * - `SSR`：**全屏爆点**（光爆 + 放射光束 + 粒子爆炸 + 震屏），并**独占时间**——
 *   爆点没演完，后面的卡牌不翻（爆点必须是全场焦点）。
 *
 * SSR 爆点之后还有一段**驻留**（`BURST_HOLD_MS`）：画面停住让玩家看清
 * 「谁 · 什么稀有度 · 是不是新获得」，同时提示可点击继续——
 * 玩家可以自己跳过（点画面任意处 / 右上角「跳过」）。
 */
import type { Rarity } from '../../core/model/types.ts'
import { Rng } from '../../core/rng.ts'

// ─────────────────────────── 类型 ───────────────────────────

/** 演出中的一张卡（事实由 core 的抽卡结果给出，表现层不自行推导） */
export interface RevealItem {
  heroId: string
  rarity: Rarity
  /** 是否首次获得 */
  isNew: boolean
}

/** 特效档位 */
export type RevealTier = 'plain' | 'glow' | 'burst'

export type RevealPhase = 'charge' | 'flip' | 'burst' | 'hold' | 'settle' | 'done'

export interface RevealEvent {
  /** 卡序（0 起） */
  index: number
  item: RevealItem
  tier: RevealTier
  /** 翻牌开始时刻 */
  startAt: number
  /** 翻牌结束时刻（卡面完全可见） */
  flipEndAt: number
  /** 特效起始时刻（glow / burst） */
  fxAt: number
  /** 特效**动画**结束时刻 */
  fxEndAt: number
  /** 爆点驻留结束时刻（仅 burst 有值；其余等于 fxEndAt） */
  holdEndAt: number
}

export interface RevealPlan {
  events: RevealEvent[]
  /** 参与全屏爆点的 SSR 事件（按时间序） */
  burstEvents: RevealEvent[]
  /** 整段演出总时长（ms） */
  duration: number
}

export interface RevealCardState {
  /** 翻转进度 0..1（0 = 卡背，1 = 正面） */
  flip: number
  /** 正面是否已完全可见 */
  revealed: boolean
  /** 光效强度 0..1（无光效为 0） */
  glow: number
  tier: RevealTier
}

export interface RevealState {
  phase: RevealPhase
  /** 蓄力进度 0..1 */
  charge: number
  cards: RevealCardState[]
  /** 当前进行中的全屏爆点（SSR）：progress = 动画进度，hold = 驻留进度 */
  burst: { event: RevealEvent; progress: number; hold: number } | null
  /** 收尾进度 0..1 */
  settle: number
  done: boolean
}

// ─────────────────────────── 节奏常量 ───────────────────────────

export const REVEAL_TIMING = {
  /** 蓄力（光柱聚拢）时长 */
  CHARGE_MS: 600,
  /** 单张卡牌翻开时长 */
  FLIP_MS: 300,
  /** 相邻卡牌的翻开间隔 */
  FLIP_STAGGER_MS: 120,
  /** SR 光效时长（与后续翻牌重叠，不阻塞） */
  GLOW_MS: 560,
  /** SSR 全屏爆点**动画**时长（**独占时间**，阻塞后续翻牌） */
  BURST_MS: 1150,
  /**
   * SSR 爆点后的**驻留**时长。
   *
   * 爆点动画放完不立刻切走，画面停住让玩家看清是谁出的；
   * 玩家也可以随时点击继续（点画面任意处 / 右上角「跳过」）。
   */
  BURST_HOLD_MS: 1800,
  /** 收尾（光效落定）时长 */
  SETTLE_MS: 200,
} as const

/** 震屏最大位移（px） */
export const SHAKE_MAX_PX = 9

// ─────────────────────────── 工具 ───────────────────────────

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 缓动函数集合（纯函数，供表现层取用） */
export const ease = {
  outCubic: (p: number): number => 1 - Math.pow(1 - p, 3),
  inCubic: (p: number): number => p * p * p,
  inOutSine: (p: number): number => -(Math.cos(Math.PI * p) - 1) / 2,
  /** 带回弹的入场 */
  outBack: (p: number): number => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
  },
  /** 光爆强度：瞬间冲到顶再缓慢落下 */
  burst: (p: number): number => {
    const x = clamp01(p)
    if (x < 0.12) return x / 0.12
    return Math.pow(1 - (x - 0.12) / 0.88, 1.7)
  },
}

/** 稀有度 → 特效档位 */
export function revealTier(rarity: Rarity): RevealTier {
  if (rarity === 'SSR') return 'burst'
  if (rarity === 'SR') return 'glow'
  return 'plain'
}

// ─────────────────────────── 事件表 ───────────────────────────

/**
 * 把抽卡结果排成演出事件表。
 *
 * 排期规则：
 * - 蓄力结束后开始逐张翻牌；
 * - `SR` 的光效与后续翻牌**重叠**（不阻塞）；
 * - `SSR` 的全屏爆点**独占**时间：爆点结束前，下一张卡不翻；
 * - 爆点动画放完后进入**驻留**（画面停住），驻留结束才算这一张翻完。
 */
export function planReveal(items: readonly RevealItem[]): RevealPlan {
  const events: RevealEvent[] = []
  let t: number = REVEAL_TIMING.CHARGE_MS

  for (const [index, item] of items.entries()) {
    const tier = revealTier(item.rarity)
    const startAt = t
    const flipEndAt = startAt + REVEAL_TIMING.FLIP_MS
    const fxAt = flipEndAt
    const fxEndAt =
      tier === 'burst'
        ? fxAt + REVEAL_TIMING.BURST_MS
        : tier === 'glow'
          ? fxAt + REVEAL_TIMING.GLOW_MS
          : fxAt
    // 爆点动画放完后进入驻留：画面停住让玩家看清，玩家也可点击继续
    const holdEndAt = tier === 'burst' ? fxEndAt + REVEAL_TIMING.BURST_HOLD_MS : fxEndAt
    events.push({ index, item, tier, startAt, flipEndAt, fxAt, fxEndAt, holdEndAt })
    // 爆点独占时间（含驻留）；其余情况下一张紧接翻牌
    t = tier === 'burst' ? holdEndAt : flipEndAt
  }

  const last = events[events.length - 1]
  const tail = last ? Math.max(last.flipEndAt, last.holdEndAt) : REVEAL_TIMING.CHARGE_MS
  return {
    events,
    burstEvents: events.filter((e) => e.tier === 'burst'),
    duration: tail + REVEAL_TIMING.SETTLE_MS,
  }
}

// ─────────────────────────── 状态推导 ───────────────────────────

/** SR 光效包络：快起慢落 */
export function glowEnvelope(age: number, dur = REVEAL_TIMING.GLOW_MS): number {
  if (age < 0 || age > dur) return 0
  return Math.sin(Math.PI * Math.pow(age / dur, 0.45))
}

/**
 * 推导 `t` 时刻的演出状态。
 *
 * ⚠ 这是**唯一**的状态来源——组件只维护时间量 `t`，画面全部由本函数算出。
 */
export function projectReveal(t: number, plan: RevealPlan): RevealState {
  const cards: RevealCardState[] = plan.events.map((e) => ({
    flip: clamp01((t - e.startAt) / REVEAL_TIMING.FLIP_MS),
    revealed: t >= e.flipEndAt,
    glow: e.tier === 'glow' ? glowEnvelope(t - e.fxAt) : 0,
    tier: e.tier,
  }))

  let burst: RevealState['burst'] = null
  for (const e of plan.burstEvents) {
    if (t >= e.fxAt && t < e.holdEndAt) {
      burst = {
        event: e,
        // 动画进度：驻留期间停在 1
        progress: clamp01((t - e.fxAt) / REVEAL_TIMING.BURST_MS),
        // 驻留进度：0 = 动画刚放完，1 = 驻留结束
        hold: clamp01((t - e.fxEndAt) / REVEAL_TIMING.BURST_HOLD_MS),
      }
    }
  }

  const charge = clamp01(t / REVEAL_TIMING.CHARGE_MS)
  const settle = clamp01((t - (plan.duration - REVEAL_TIMING.SETTLE_MS)) / REVEAL_TIMING.SETTLE_MS)

  let phase: RevealPhase
  if (burst) phase = burst.hold > 0 ? 'hold' : 'burst'
  else if (t < REVEAL_TIMING.CHARGE_MS) phase = 'charge'
  else if (t >= plan.duration) phase = 'done'
  else if (t >= plan.duration - REVEAL_TIMING.SETTLE_MS) phase = 'settle'
  else phase = 'flip'

  return { phase, charge, cards, burst, settle, done: phase === 'done' }
}

/**
 * 震屏位移（px）。
 *
 * 用正弦叠加而非 `Math.random`——保证 `f(t)` 可复现、可单测。
 */
export function shakeOffset(t: number, plan: RevealPlan): { x: number; y: number } {
  let amp = 0
  for (const e of plan.burstEvents) {
    if (t >= e.fxAt && t < e.fxEndAt) {
      const p = (t - e.fxAt) / REVEAL_TIMING.BURST_MS
      amp = Math.max(amp, ease.burst(p) * SHAKE_MAX_PX)
    }
  }
  if (amp <= 0.01) return { x: 0, y: 0 }
  return {
    x: (Math.sin(t * 0.037) + Math.sin(t * 0.089) * 0.55) * amp * 0.62,
    y: (Math.cos(t * 0.041) + Math.sin(t * 0.113) * 0.45) * amp * 0.62,
  }
}

// ─────────────────────────── 粒子 ───────────────────────────

export interface BurstParticle {
  /** 初始角度（弧度） */
  angle: number
  /** 初速度（相对舞台短边的比例 / 秒） */
  speed: number
  /** 初始半径（px 基准，由表现层按舞台缩放） */
  size: number
  /** 自转角速度（弧度 / 秒） */
  spin: number
  /** 延迟（ms） */
  delay: number
  /** 色相偏移 0..1（0 = 主色，1 = 高光白） */
  tint: number
}

/** 爆点粒子参数（同一 seed → 同一组参数，可复现） */
export function burstParticles(seed: number, count: number): BurstParticle[] {
  const rng = new Rng(seed)
  const out: BurstParticle[] = []
  for (let i = 0; i < count; i++) {
    // 角度均匀铺开 + 抖动，避免出现规则圆环
    const angle = (i / count) * Math.PI * 2 + rng.float(-0.16, 0.16)
    out.push({
      angle,
      speed: rng.float(0.55, 1.45),
      size: rng.float(2.6, 7),
      spin: rng.float(-7, 7),
      delay: rng.float(0, 130),
      tint: rng.float(0, 1),
    })
  }
  return out
}

export interface ParticleFrame {
  /** 相对舞台中心的偏移（比例，1 = 舞台短边的一半） */
  x: number
  y: number
  alpha: number
  size: number
  rot: number
}

/** 粒子在 `age` 毫秒后的位置（纯函数） */
export function particleAt(p: BurstParticle, age: number, life = 900): ParticleFrame {
  if (age < p.delay) return { x: 0, y: 0, alpha: 0, size: 0, rot: 0 }
  const local = (age - p.delay) / life
  if (local >= 1) return { x: 0, y: 0, alpha: 0, size: 0, rot: 0 }
  const dist = p.speed * local
  // 轻微下坠，让爆点有「炸开再落」的重力感
  const gravity = 0.35 * local * local
  return {
    x: Math.cos(p.angle) * dist,
    y: Math.sin(p.angle) * dist + gravity,
    alpha: Math.pow(1 - local, 1.6),
    size: p.size * (1 - local * 0.55),
    rot: p.spin * (age / 1000),
  }
}

export interface ChargeMote {
  /** 横向位置 0..1 */
  x: number
  /** 上升速度（屏幕高度 / 秒） */
  speed: number
  size: number
  /** 起始相位 0..1 */
  phase: number
  /** 横向漂移 */
  drift: number
}

/** 蓄力阶段的上升光点（同一 seed → 同一组参数） */
export function chargeMotes(seed: number, count: number): ChargeMote[] {
  const rng = new Rng(seed)
  const out: ChargeMote[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      x: rng.float(0.08, 0.92),
      speed: rng.float(0.18, 0.55),
      size: rng.float(1, 2.8),
      phase: rng.float(0, 1),
      drift: rng.float(-0.05, 0.05),
    })
  }
  return out
}

export interface MoteFrame {
  x: number
  y: number
  alpha: number
  size: number
}

/** 光点在 `t` 时刻的位置（纯函数，y 从 1 升到 0） */
export function moteAt(m: ChargeMote, t: number): MoteFrame {
  const phase = (m.phase + (t / 1000) * m.speed) % 1
  const y = 1 - phase
  const fade = Math.min(1, phase * 4) * Math.min(1, (1 - phase) * 3.2)
  return {
    x: m.x + Math.sin((t / 1000) * 1.4 + m.phase * 6.28) * m.drift,
    y,
    alpha: Math.max(0, fade) * 0.9,
    size: m.size,
  }
}
