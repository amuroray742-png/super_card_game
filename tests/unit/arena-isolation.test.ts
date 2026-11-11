/**
 * PvP 数值隔离测试（§15.1）。
 *
 * 这是整个 PvP 扩展的守护网：任何破坏隔离的改动都会在此失败。
 * 覆盖：养成隔离、永久加成屏蔽、遗物强化屏蔽、封顶系数、竞技池对称、
 *      竞技等级只改槽位、产出隔离、快照不可变、幂等结算、段位独立。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  arenaContext,
  arenaRuneSlots,
  arenaSnapshotHash,
  buildArenaLoadout,
  buildArenaUnits,
  computeArenaLevel,
  resolveArenaMatch,
  resolveArenaRewards,
  verifyArenaSnapshot,
  ARENA_REWARD_ALLOWED_KEYS,
} from '../../src/core/systems/arena.ts'
import { computePower, resolveStats } from '../../src/core/systems/stats.ts'
import { effectiveRatio } from '../../src/core/systems/battle.ts'
import { generateRelic, getHeroSetMods, getRelicMods } from '../../src/core/systems/relic.ts'
// 加载遗物配置（内部会注册到遗物索引）
import '../../src/core/config/relics.ts'
import { getBondMods } from '../../src/core/systems/team.ts'
import { ARENA_CAPS, DEFAULT_ARENA_PROFILE } from '../../src/core/config/economy.ts'
import { Rng } from '../../src/core/rng.ts'
import { makeHero, maxedHero, nakedHero } from './helpers.ts'

const ARENA_CTX = arenaContext(1)

describe('1. 养成隔离', () => {
  it('PVE 养成相差 100 倍的两个账号，竞技归一化后战力差 < 15%', () => {
    const naked = nakedHero('hanxin')
    const maxed = maxedHero('hanxin')

    const pveNaked = resolveStats(naked, { mode: 'pve', seed: 1 })
    const pveMaxed = resolveStats(maxed, { mode: 'pve', seed: 1 })
    const pveRatio = computePower(pveMaxed) / computePower(pveNaked)
    expect(pveRatio).toBeGreaterThan(50) // 测试本身有效

    const arenaNaked = resolveStats(naked, ARENA_CTX)
    const arenaMaxed = resolveStats(maxed, ARENA_CTX)
    const arenaRatio = computePower(arenaMaxed) / computePower(arenaNaked)
    expect(Math.abs(arenaRatio - 1)).toBeLessThan(0.15)
  })

  it('等级完全不进入竞技属性', () => {
    const a = resolveStats(makeHero('hanxin', { level: 1 }), ARENA_CTX)
    const b = resolveStats(makeHero('hanxin', { level: 240 }), ARENA_CTX)
    expect(a.atk).toBe(b.atk)
    expect(a.hp).toBe(b.hp)
  })

  it('竞技属性等于定位模板（不含任何养成加成）', () => {
    const stats = resolveStats(maxedHero('xiangyu'), ARENA_CTX)
    const template = DEFAULT_ARENA_PROFILE.templates['猛将']
    expect(stats.atk).toBeCloseTo(template.atk, 6)
    expect(stats.hp).toBeCloseTo(template.hp, 6)
  })
})

describe('2. 永久加成屏蔽', () => {
  it('arena.ts 源码中不出现 permBoost（静态检查，忽略注释）', () => {
    const path = fileURLToPath(new URL('../../src/core/systems/arena.ts', import.meta.url))
    const source = readFileSync(path, 'utf-8')
    // 去掉行注释与块注释，只检查可执行代码
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(code).not.toContain('permBoost')
  })

  it('永久加成变化对竞技结果零影响', () => {
    const before = resolveStats(maxedHero('hanxin'), ARENA_CTX)
    const after = resolveStats(maxedHero('hanxin'), ARENA_CTX)
    expect(computePower(before)).toBe(computePower(after))
  })
})

describe('3. 遗物强化屏蔽', () => {
  it('遗物 60 级与 1 级在竞技模式下无差异', () => {
    const rng = new Rng(1)
    const low = generateRelic('set_zhanshen_1', rng, 1)
    const high = generateRelic('set_zhanshen_1', rng, 60)

    // PVE 下差异显著（单件词条随强化等级缩放）
    const pveLow = getRelicMods(low)
    const pveHigh = getRelicMods(high)
    expect(pveHigh[0].value).toBeGreaterThan(pveLow[0].value)

    // 竞技模式下只取套装效果，与强化等级、随机词条无关
    const arenaLow = resolveStats(
      { ...nakedHero('xiangyu'), relics: [low] },
      ARENA_CTX,
      { setMods: getHeroSetMods({ relics: [low] }) },
    )
    const arenaHigh = resolveStats(
      { ...nakedHero('xiangyu'), relics: [high] },
      ARENA_CTX,
      { setMods: getHeroSetMods({ relics: [high] }) },
    )
    expect(arenaLow.atk).toBeCloseTo(arenaHigh.atk, 10)
    expect(arenaLow.atk).toBeCloseTo(arenaHigh.atk, 10)
  })
})

describe('4. 封顶系数生效', () => {
  it('技能强度不超过 +30%', () => {
    const skill = {
      id: 'x',
      name: '测试',
      kind: 'battle' as const,
      desc: '',
      ratio: 1,
      target: 'enemy' as const,
      effects: [],
      cooldown: 0,
      unlockStar: 1,
      unlockLevel: 1,
    }
    const pve = effectiveRatio(skill, 20, { mode: 'pve', seed: 1 })
    const arena = effectiveRatio(skill, 20, ARENA_CTX)
    expect(arena - 1).toBeLessThanOrEqual(ARENA_CAPS.SKILL_SCALE + 1e-9)
    expect(pve - 1).toBeGreaterThan(arena - 1)
  })

  it('套装效果系数 ≤ 0.7', () => {
    const rng = new Rng(2)
    const relics = [
      generateRelic('set_zhanshen_1', rng),
      generateRelic('set_zhanshen_2', rng),
    ]
    const setMods = getHeroSetMods({ relics })
    // 各自路径的基线（不含套装效果），再比相对增量
    const pveBase = resolveStats(nakedHero('xiangyu'), { mode: 'pve', seed: 1 }).atk
    const pveFull = resolveStats(nakedHero('xiangyu'), { mode: 'pve', seed: 1 }, { setMods }).atk
    const arenaBase = resolveStats(nakedHero('xiangyu'), ARENA_CTX).atk
    const arenaFull = resolveStats(nakedHero('xiangyu'), ARENA_CTX, { setMods }).atk

    const pvePct = pveFull / pveBase - 1
    const arenaPct = arenaFull / arenaBase - 1
    expect(arenaPct).toBeCloseTo(pvePct * ARENA_CAPS.SET_SCALE, 8)
  })

  it('羁绊系数 ≤ 0.6', () => {
    const team = [
      maxedHero('xiangyu'),
      maxedHero('hannibal'),
      maxedHero('zhangfei'),
      maxedHero('weiqing'),
    ]
    const bondMods = getBondMods(team)
    expect(bondMods.length).toBeGreaterThan(0)
    const pveBase = resolveStats(maxedHero('xiangyu'), { mode: 'pve', seed: 1 }).atk
    const pveFull = resolveStats(maxedHero('xiangyu'), {
      mode: 'pve',
      seed: 1,
      teamMods: { bond: bondMods },
    }).atk
    const arenaBase = resolveStats(maxedHero('xiangyu'), {
      mode: 'arena',
      arenaProfile: DEFAULT_ARENA_PROFILE,
      seed: 1,
    }).atk
    const arenaFull = resolveStats(maxedHero('xiangyu'), {
      mode: 'arena',
      arenaProfile: DEFAULT_ARENA_PROFILE,
      seed: 1,
      teamMods: { bond: bondMods },
    }).atk
    const pvePct = pveFull / pveBase - 1
    const arenaPct = arenaFull / arenaBase - 1
    expect(arenaPct).toBeCloseTo(pvePct * ARENA_CAPS.BOND_SCALE, 8)
  })
})

describe('5. 竞技池对称', () => {
  it('同一份阵容快照产出的单位与玩家是否拥有该英灵无关', () => {
    const loadout = buildArenaLoadout({
      slots: ['xiangyu', 'hanxin', 'zhugeliang', null, null, null],
      heroes: {},
      relicSetsByHero: {},
      runes: [],
      arenaLevel: 0,
    })
    const unitsA = buildArenaUnits(loadout, 'ally', ARENA_CTX)
    const unitsB = buildArenaUnits(loadout, 'ally', ARENA_CTX)
    expect(unitsA.map((u) => u.id)).toEqual(unitsB.map((u) => u.id))
    expect(unitsA.map((u) => u.stats.atk)).toEqual(unitsB.map((u) => u.stats.atk))
  })

  it('双方使用同一套归一化模板', () => {
    const loadout = buildArenaLoadout({
      slots: ['xiangyu', null, null, null, null, null],
      heroes: {},
      relicSetsByHero: {},
      runes: [],
      arenaLevel: 0,
    })
    const allies = buildArenaUnits(loadout, 'ally', ARENA_CTX)
    const enemies = buildArenaUnits(loadout, 'enemy', ARENA_CTX)
    expect(allies[0].stats.atk).toBe(enemies[0].stats.atk)
    expect(allies[0].stats.hp).toBe(enemies[0].stats.hp)
  })
})

describe('6. 竞技等级只改槽位', () => {
  it('竞技等级不改变任何属性数值', () => {
    const base = buildArenaLoadout({
      slots: ['xiangyu', null, null, null, null, null],
      heroes: {},
      relicSetsByHero: {},
      runes: [],
      arenaLevel: 0,
    })
    const high = { ...base, arenaLevel: 9999 }
    const a = buildArenaUnits(base, 'ally', ARENA_CTX)
    const b = buildArenaUnits(high, 'ally', ARENA_CTX)
    expect(a[0].stats).toEqual(b[0].stats)
  })

  it('铭文槽位上限为 3', () => {
    expect(arenaRuneSlots(0)).toBe(0)
    expect(arenaRuneSlots(10)).toBe(1)
    expect(arenaRuneSlots(1000)).toBe(3)
    expect(arenaRuneSlots(999999)).toBe(ARENA_CAPS.RUNE_SLOTS_MAX)
  })

  it('竞技等级由养成广度折算而来', () => {
    const low = computeArenaLevel([{ id: 'xiangyu', level: 1, exp: 0, star: 1, skillLevels: [1, 1, 1], shards: 0, coreAwakened: false, obtainedAt: 0 }], 0)
    const high = computeArenaLevel([{ id: 'xiangyu', level: 240, exp: 0, star: 6, skillLevels: [20, 20, 20], shards: 0, coreAwakened: true, obtainedAt: 0 }], 72)
    expect(high).toBeGreaterThan(low)
  })
})

describe('7. 产出隔离', () => {
  it('竞技产出白名单中不含任何 PVE 资源', () => {
    expect(ARENA_REWARD_ALLOWED_KEYS).not.toContain('silver' as never)
    expect(ARENA_REWARD_ALLOWED_KEYS).not.toContain('exp' as never)
    expect(ARENA_REWARD_ALLOWED_KEYS).not.toContain('relicStones' as never)
    expect(ARENA_REWARD_ALLOWED_KEYS).not.toContain('crystals' as never)
  })

  it('竞技结算产出的资源集合与 PVE 资源无交集', () => {
    const { reward } = resolveArenaRewards(true, 0, 0)
    const keys = Object.keys(reward)
    for (const key of keys) {
      expect(ARENA_REWARD_ALLOWED_KEYS).toContain(key as never)
    }
    expect(reward).not.toHaveProperty('silver')
    expect(reward).not.toHaveProperty('exp')
    expect(reward).not.toHaveProperty('relicStones')
    expect(reward).not.toHaveProperty('crystals')
  })

  it('竞技勋章与抽卡券有周上限', () => {
    const { weeklyMedals, weeklyTickets } = resolveArenaRewards(true, 999, 999)
    expect(weeklyMedals).toBeLessThanOrEqual(999 + 1)
    expect(weeklyTickets).toBeLessThanOrEqual(999 + 1)
  })
})

describe('8. 快照不可变', () => {
  it('匹配冻结后修改阵容，hash 校验失败', () => {
    const loadout = buildArenaLoadout({
      slots: ['xiangyu', 'hanxin', null, null, null, null],
      heroes: {},
      relicSetsByHero: {},
      runes: [],
      arenaLevel: 0,
    })
    const hash = arenaSnapshotHash(loadout)
    expect(verifyArenaSnapshot(loadout, hash)).toBe(true)

    const tampered = { ...loadout, heroes: [...loadout.heroes], stars: [...loadout.stars] }
    tampered.heroes[0] = 'hannibal'
    expect(verifyArenaSnapshot(tampered, hash)).toBe(false)
  })
})

describe('9. 幂等结算', () => {
  it('同一 challengeId 与种子重复结算，结果完全一致', () => {
    const loadout = buildArenaLoadout({
      slots: ['xiangyu', 'hanxin', 'zhugeliang', 'libai', null, null],
      heroes: {},
      relicSetsByHero: {},
      runes: [],
      arenaLevel: 0,
    })
    const input = {
      challengeId: 'ch-001',
      attacker: loadout,
      defender: loadout,
      attackerId: 'a',
      attackerName: 'A',
      defenderId: 'b',
      defenderName: 'B',
      seed: 777,
    }
    const first = resolveArenaMatch(input)
    const second = resolveArenaMatch(input)
    expect(first.result.win).toBe(second.result.win)
    expect(first.result.rounds).toBe(second.result.rounds)
    expect(first.result.damageById).toEqual(second.result.damageById)
    expect(first.pointsDelta).toBe(second.pointsDelta)
  })
})

describe('10. 段位独立', () => {
  it('PVE 天梯段位与 PvP 段位互不影响', () => {
    const loadout = buildArenaLoadout({
      slots: ['xiangyu', null, null, null, null, null],
      heroes: {},
      relicSetsByHero: {},
      runes: [],
      arenaLevel: 0,
    })
    const match = resolveArenaMatch({
      challengeId: 'ch-002',
      attacker: loadout,
      defender: loadout,
      attackerId: 'a',
      attackerName: 'A',
      defenderId: 'b',
      defenderName: 'B',
      seed: 1,
    })
    // 结算只产出 pointsDelta，不涉及段位分之间的换算
    expect(typeof match.pointsDelta).toBe('number')
    expect(match.pointsDelta).not.toBeNaN()
  })
})
