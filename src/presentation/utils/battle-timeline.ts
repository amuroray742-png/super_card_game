/**
 * 战斗回放时间轴（§6.3 战斗演出）。
 *
 * 设计要点：**画面是时间的纯函数 f(t)**，不做增量状态累积。
 *   - 倍速 = `t += dt × speed`
 *   - 跳回合 = 直接把 t 设为该回合锚点
 *   - 重播 = t = 0
 * 三者都不需要额外状态，也就不会出现「快进后血条对不上」。
 *
 * ⚠ 本模块**零 DOM 依赖**，因此可以直接在 Node 下单测：
 *   渲染器（BattleCanvas.vue）只负责把 `projectState` / `collectEffects`
 *   的结果画出来，不做任何战斗判定。
 *
 * ⚠ 表现层**不得自行推导战斗事实**（AGENTS.md 铁律 #16）：
 *   死亡、职业、五行、是否 BOSS、出场回合全部来自 core 的事件流与名册。
 */
import type { BattleLogEntry, BattleLogKind, BattleUnitRosterEntry } from '../../core/model/types.ts'

/**
 * 每类事件的**基础时长**（毫秒，1× 速度）。
 *
 * 这些是演出节奏，不是游戏数值：伤害要快、死亡要留白、回合要顿一下。
 * 1× 速度下整场战斗落在 25~40 秒。
 */
export const EVENT_DURATION: Record<BattleLogKind, number> = {
  round: 260,
  skill: 300,
  damage: 190,
  heal: 190,
  shield: 190,
  buff: 200,
  debuff: 200,
  control: 240,
  dot: 190,
  death: 320,
  summon: 380,
  end: 400,
}

/** 血条补间时长（毫秒）：血量不是瞬跳，而是滑过去 */
export const HP_TWEEN_MS = 180
/** 技能闪光时长（施法者头像脉冲） */
export const FLASH_MS = 220
/** 受击红闪时长 */
export const HIT_FLASH_MS = 140
/** 飘字存活时长 */
export const FLOAT_MS = 900
/** 同目标飘字合并窗口：窗口内的伤害数字累加，不刷屏 */
export const FLOAT_MERGE_MS = 300

/** 时间轴上的一个事件 */
export interface TimelineEvent {
  entry: BattleLogEntry
  /** 事件开始时刻（毫秒，1× 速度） */
  at: number
}

/** 战斗时间轴 */
export interface BattleTimeline {
  events: TimelineEvent[]
  /** 总时长（毫秒，1× 速度） */
  duration: number
  /** 回合锚点：进度条分段与跳转用 */
  rounds: { round: number; at: number }[]
  /** 名册快照（初始血量、出场回合等） */
  roster: BattleUnitRosterEntry[]
}

/** 某个单位在某一时刻的状态 */
export interface UnitState {
  id: string
  /** 目标血量（事件发生后的值） */
  hp: number
  maxHp: number
  alive: boolean
  /** 援军未出场时为 false（出场回合由 core 的 `appearRound` 给出） */
  visible: boolean
  /** 本次血量变化前的血量（补间起点） */
  hpFrom: number
  /** 本次血量变化发生的时刻 */
  hpChangedAt: number
}

/** 某一时刻的战场状态 */
export interface BattleState {
  units: Record<string, UnitState>
  /** 当前回合 */
  round: number
  /** 已经发生的事件数 */
  eventIndex: number
}

/** 特效类型 */
export type BattleEffectKind =
  | 'float-damage'
  | 'float-crit'
  | 'float-absorb'
  | 'float-heal'
  | 'float-shield'
  | 'flash'
  | 'hit'
  | 'death'
  | 'summon'

/** 一个瞬时特效 */
export interface BattleEffect {
  kind: BattleEffectKind
  /** 承受者 id */
  targetId: string
  /** 施法者 id（闪光用） */
  actorId: string
  /** 数值（飘字内容） */
  value: number
  /** 效果起始时刻 */
  at: number
  /** 效果总时长 */
  duration: number
  /** 归一化进度 0~1（渲染时算，避免各处重复算） */
  progress: number
}

/**
 * 由战报构建时间轴。
 *
 * @param log    core 产出的战斗事件流
 * @param roster core 产出的参战名册（初始血量 / 出场回合 / 职业 / 五行 / BOSS 机制）
 */
export function buildTimeline(log: BattleLogEntry[], roster: BattleUnitRosterEntry[]): BattleTimeline {
  const events: TimelineEvent[] = []
  const rounds: { round: number; at: number }[] = []
  let at = 0
  for (const entry of log) {
    events.push({ entry, at })
    if (entry.kind === 'round') rounds.push({ round: entry.round, at })
    at += EVENT_DURATION[entry.kind] ?? 200
  }
  return { events, duration: at, rounds, roster }
}

/**
 * 时刻 t 的战场状态。
 *
 * 血量按事件累加；「本次变化前 / 变化后 / 变化时刻」一并返回，
 * 由渲染层用 `tweenedHp` 插值出平滑血条。
 */
export function projectState(timeline: BattleTimeline, t: number): BattleState {
  const units: Record<string, UnitState> = {}
  for (const u of timeline.roster) {
    units[u.id] = {
      id: u.id,
      hp: u.maxHp,
      maxHp: u.maxHp,
      alive: true,
      visible: u.appearRound <= 1,
      hpFrom: u.maxHp,
      hpChangedAt: 0,
    }
  }

  let round = 0
  let eventIndex = 0
  for (const ev of timeline.events) {
    if (ev.at > t) break
    eventIndex++
    const e = ev.entry
    if (e.kind === 'round') {
      round = e.round
      // 兜底：援军若因战报截断而没有出场事件，最迟下一回合也要出现，
      // 否则画面上会永远少一个人。正常情况下由 summon 事件精确控制。
      for (const u of timeline.roster) {
        if (u.appearRound < e.round) units[u.id].visible = true
      }
      continue
    }
    const target = units[e.targetId]
    if (!target) continue
    switch (e.kind) {
      case 'damage':
      case 'dot': {
        setHp(target, Math.max(0, target.hp - e.amount), ev.at)
        if (target.hp <= 0) target.alive = false
        break
      }
      case 'heal': {
        setHp(target, Math.min(target.maxHp, target.hp + e.amount), ev.at)
        break
      }
      case 'death': {
        setHp(target, 0, ev.at)
        target.alive = false
        break
      }
      case 'summon': {
        target.visible = true
        break
      }
      default:
        break
    }
  }
  return { units, round, eventIndex }
}

function setHp(unit: UnitState, hp: number, at: number) {
  if (hp === unit.hp) return
  unit.hpFrom = unit.hp
  unit.hp = hp
  unit.hpChangedAt = at
}

/**
 * 补间后的显示血量（血条用）。
 *
 * 变化发生后按 easeOut 滑向新值，避免血条瞬跳。
 */
export function tweenedHp(unit: UnitState, t: number): number {
  if (unit.hpChangedAt >= t) return unit.hpFrom
  const p = Math.min(1, (t - unit.hpChangedAt) / HP_TWEEN_MS)
  const eased = 1 - (1 - p) * (1 - p)
  return unit.hpFrom + (unit.hp - unit.hpFrom) * eased
}

/**
 * 时刻 t 的瞬时特效（飘字 / 闪光 / 受击 / 死亡 / 入场）。
 *
 * 全部由时间推导（不是累积出来的），因此任意跳转都自洽。
 */
export function collectEffects(timeline: BattleTimeline, t: number): BattleEffect[] {
  const out: BattleEffect[] = []
  const floats: BattleEffect[] = []

  for (const ev of timeline.events) {
    if (ev.at > t) break
    const e = ev.entry
    switch (e.kind) {
      case 'damage':
      case 'dot': {
        // 同目标 300ms 内的伤害数字合并累加，避免刷屏
        const merged = floats.find(
          (f) => f.targetId === e.targetId && ev.at - f.at <= FLOAT_MERGE_MS,
        )
        if (merged) {
          merged.value += e.amount
          merged.duration = Math.max(merged.duration, ev.at + FLOAT_MS - merged.at)
          if (e.crit) merged.kind = 'float-crit'
          break
        }
        const effect: BattleEffect = {
          kind: e.absorbed ? 'float-absorb' : e.crit ? 'float-crit' : 'float-damage',
          targetId: e.targetId,
          actorId: e.actorId,
          value: e.amount,
          at: ev.at,
          duration: FLOAT_MS,
          progress: 0,
        }
        floats.push(effect)
        out.push(effect)
        break
      }
      case 'heal': {
        const effect: BattleEffect = {
          kind: 'float-heal',
          targetId: e.targetId,
          actorId: e.actorId,
          value: e.amount,
          at: ev.at,
          duration: FLOAT_MS,
          progress: 0,
        }
        out.push(effect)
        break
      }
      case 'shield': {
        out.push({
          kind: 'float-shield',
          targetId: e.targetId,
          actorId: e.actorId,
          value: e.amount,
          at: ev.at,
          duration: FLOAT_MS,
          progress: 0,
        })
        break
      }
      case 'skill': {
        out.push({
          kind: 'flash',
          targetId: e.actorId,
          actorId: e.actorId,
          value: 0,
          at: ev.at,
          duration: FLASH_MS,
          progress: 0,
        })
        break
      }
      case 'death': {
        out.push({
          kind: 'death',
          targetId: e.targetId,
          actorId: e.actorId,
          value: 0,
          at: ev.at,
          duration: EVENT_DURATION.death,
          progress: 0,
        })
        break
      }
      case 'summon': {
        out.push({
          kind: 'summon',
          targetId: e.targetId,
          actorId: e.actorId,
          value: 0,
          at: ev.at,
          duration: EVENT_DURATION.summon,
          progress: 0,
        })
        break
      }
      default:
        break
    }
  }

  for (const e of out) {
    e.progress = Math.max(0, Math.min(1, (t - e.at) / e.duration))
  }
  // 只保留还在演的生命周期内的特效
  return out.filter((e) => t < e.at + e.duration)
}
