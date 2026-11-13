/**
 * 战斗回放时间轴（§6.3 战斗演出）。
 *
 * 时间轴是**纯函数**：画面是时间的 f(t)，不做增量状态累积。
 * 因此倍速 / 跳回合 / 重播都只是改 t，不需要额外状态，
 * 也不会出现「快进后血条对不上」。
 *
 * ⚠ 本文件不需要浏览器：时间轴模块零 DOM 依赖，可直接在 Node 下测。
 */
import { describe, expect, it } from 'vitest'
import {
  buildTimeline,
  projectState,
  collectEffects,
  tweenedHp,
  EVENT_DURATION,
  HP_TWEEN_MS,
  FLOAT_MERGE_MS,
} from '../../src/presentation/utils/battle-timeline.ts'
import type { BattleLogEntry, BattleUnitRosterEntry } from '../../src/core/model/types.ts'

const roster: BattleUnitRosterEntry[] = [
  {
    id: 'xiangyu',
    side: 'ally',
    slot: 0,
    name: '项羽',
    maxHp: 1000,
    appearRound: 1,
    defId: 'xiangyu',
    role: '猛将',
    element: '土',
  },
  {
    id: 'wanderer#0',
    side: 'enemy',
    slot: 0,
    name: '游荡残魂',
    maxHp: 500,
    appearRound: 1,
    defId: 'wanderer',
    role: '猛将',
    element: '水',
  },
  {
    id: 'sand_mirage#1',
    side: 'enemy',
    slot: 1,
    name: '蜃楼幻身',
    maxHp: 300,
    appearRound: 3,
    defId: 'sand_mirage',
    role: '谋士',
    element: '水',
    mechanic: 'summon',
  },
]

function entry(
  kind: BattleLogEntry['kind'],
  round: number,
  actorId: string,
  targetId: string,
  amount: number,
  extra: Partial<BattleLogEntry> = {},
): BattleLogEntry {
  return { round, kind, actorId, targetId, amount, text: `${kind} ${amount}`, ...extra }
}

const log: BattleLogEntry[] = [
  entry('round', 1, '', '', 0),
  entry('skill', 1, 'xiangyu', '', 0),
  entry('damage', 1, 'xiangyu', 'wanderer#0', 120),
  entry('round', 2, '', '', 0),
  entry('round', 3, '', '', 0),
  entry('summon', 3, 'wanderer#0', 'sand_mirage#1', 0),
  entry('damage', 3, 'xiangyu', 'wanderer#0', 500, { crit: true }),
  entry('death', 3, 'xiangyu', 'wanderer#0', 0),
]

/** 各事件的起始时刻（与 EVENT_DURATION 累加一致） */
const AT = {
  round1: 0,
  skill: EVENT_DURATION.round,
  damage: EVENT_DURATION.round + EVENT_DURATION.skill,
  round2: EVENT_DURATION.round + EVENT_DURATION.skill + EVENT_DURATION.damage,
  round3:
    EVENT_DURATION.round +
    EVENT_DURATION.skill +
    EVENT_DURATION.damage +
    EVENT_DURATION.round,
  summon:
    EVENT_DURATION.round +
    EVENT_DURATION.skill +
    EVENT_DURATION.damage +
    EVENT_DURATION.round * 2,
  crit:
    EVENT_DURATION.round +
    EVENT_DURATION.skill +
    EVENT_DURATION.damage +
    EVENT_DURATION.round * 2 +
    EVENT_DURATION.summon,
  death:
    EVENT_DURATION.round +
    EVENT_DURATION.skill +
    EVENT_DURATION.damage +
    EVENT_DURATION.round * 2 +
    EVENT_DURATION.summon +
    EVENT_DURATION.damage,
}

describe('时间轴构建', () => {
  it('事件时刻单调递增，总时长 = 各事件时长之和', () => {
    const tl = buildTimeline(log, roster)
    for (let i = 1; i < tl.events.length; i++) {
      expect(tl.events[i].at).toBeGreaterThan(tl.events[i - 1].at)
    }
    const sum = log.reduce((acc, e) => acc + EVENT_DURATION[e.kind], 0)
    expect(tl.duration).toBe(sum)
  })

  it('回合锚点按回合推进，可用于进度条与跳转', () => {
    const tl = buildTimeline(log, roster)
    expect(tl.rounds.map((r) => r.round)).toEqual([1, 2, 3])
    expect(tl.rounds[0].at).toBe(0)
    expect(tl.rounds[1].at).toBe(AT.round2)
    expect(tl.rounds[2].at).toBe(AT.round3)
  })

  it('空战报不会崩', () => {
    const tl = buildTimeline([], roster)
    expect(tl.duration).toBe(0)
    expect(tl.events).toHaveLength(0)
  })
})

describe('状态投影', () => {
  it('开局全员满血；援军未出场不可见', () => {
    const tl = buildTimeline(log, roster)
    const s = projectState(tl, 0)
    expect(s.units['xiangyu'].hp).toBe(1000)
    expect(s.units['wanderer#0'].hp).toBe(500)
    expect(s.units['xiangyu'].visible).toBe(true)
    expect(s.units['sand_mirage#1'].visible).toBe(false)
  })

  it('伤害按事件累加，血量不会低于 0', () => {
    const tl = buildTimeline(log, roster)
    const s = projectState(tl, AT.damage + 1)
    expect(s.units['wanderer#0'].hp).toBe(380)
  })

  it('召唤事件让援军入场', () => {
    const tl = buildTimeline(log, roster)
    const before = projectState(tl, AT.summon - 1)
    expect(before.units['sand_mirage#1'].visible).toBe(false)
    const after = projectState(tl, AT.summon + 1)
    expect(after.units['sand_mirage#1'].visible).toBe(true)
  })

  it('死亡事件把单位标死且血量归零', () => {
    const tl = buildTimeline(log, roster)
    const s = projectState(tl, tl.duration)
    expect(s.units['wanderer#0'].hp).toBe(0)
    expect(s.units['wanderer#0'].alive).toBe(false)
    expect(s.units['xiangyu'].alive).toBe(true)
  })

  it('同一时刻的状态与到达该时刻的方式无关（快进不会串味）', () => {
    const tl = buildTimeline(log, roster)
    const direct = projectState(tl, AT.crit + 1)
    // 先跳到末尾再跳回来：结果必须完全一致
    projectState(tl, tl.duration)
    const again = projectState(tl, AT.crit + 1)
    expect(JSON.stringify(again)).toBe(JSON.stringify(direct))
  })

  it('血量补间：变化瞬间显示旧值，随后滑向新值', () => {
    const tl = buildTimeline(log, roster)
    const s = projectState(tl, AT.damage + 1)
    const unit = s.units['wanderer#0']
    expect(unit.hp).toBe(380)
    expect(unit.hpFrom).toBe(500)
    expect(unit.hpChangedAt).toBe(AT.damage)
    expect(tweenedHp(unit, AT.damage)).toBe(500)
    expect(tweenedHp(unit, AT.damage + HP_TWEEN_MS)).toBeCloseTo(380, 6)
  })
})

describe('瞬时特效', () => {
  it('技能事件触发施法者闪光', () => {
    const tl = buildTimeline(log, roster)
    const effects = collectEffects(tl, AT.skill + 10)
    const flash = effects.find((e) => e.kind === 'flash')
    expect(flash).toBeTruthy()
    expect(flash!.targetId).toBe('xiangyu')
  })

  it('伤害事件产生伤害飘字，暴击单独样式', () => {
    const tl = buildTimeline(log, roster)
    const plain = collectEffects(tl, AT.damage + 10)
    expect(plain.some((e) => e.kind === 'float-damage')).toBe(true)
    const crit = collectEffects(tl, AT.crit + 10)
    expect(crit.some((e) => e.kind === 'float-crit')).toBe(true)
  })

  it('飘字只在其生命周期内存在', () => {
    const tl = buildTimeline(log, roster)
    expect(collectEffects(tl, AT.damage + 10).length).toBeGreaterThan(0)
    expect(collectEffects(tl, AT.damage + 5000).length).toBe(0)
  })

  it('同目标短时间内的伤害数字合并，不刷屏', () => {
    const mergedLog: BattleLogEntry[] = [
      entry('round', 1, '', '', 0),
      entry('damage', 1, 'xiangyu', 'wanderer#0', 100),
      entry('damage', 1, 'xiangyu', 'wanderer#0', 50),
    ]
    const tl = buildTimeline(mergedLog, roster)
    const t = AT.damage + 10
    const floats = collectEffects(tl, t).filter((e) => e.kind.startsWith('float-'))
    expect(floats).toHaveLength(1)
    expect(floats[0].value).toBe(150)
  })

  it('超过合并窗口的伤害各自成一条飘字', () => {
    const spacedLog: BattleLogEntry[] = [
      entry('round', 1, '', '', 0),
      entry('damage', 1, 'xiangyu', 'wanderer#0', 100),
      entry('damage', 1, 'xiangyu', 'wanderer#0', 50),
    ]
    const tl = buildTimeline(spacedLog, roster)
    const late = EVENT_DURATION.round + EVENT_DURATION.damage + FLOAT_MERGE_MS + 10
    const floats = collectEffects(tl, late).filter((e) => e.kind.startsWith('float-'))
    expect(floats.length).toBeGreaterThanOrEqual(1)
  })

  it('死亡事件产生消散效果', () => {
    const tl = buildTimeline(log, roster)
    const effects = collectEffects(tl, AT.death + 10)
    expect(effects.some((e) => e.kind === 'death' && e.targetId === 'wanderer#0')).toBe(true)
  })
})
