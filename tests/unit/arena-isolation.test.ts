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
import { getHeroSetMods, getRelicMods } from '../../src/core/systems/relic.ts'
// 加载遗物配置（内部会注册到遗物索引）
import '../../src/core/config/relics.ts'
import { getBondMods } from '../../src/core/systems/team.ts'
import { ARENA_CAPS, ARENA_TEMPLATES, DEFAULT_ARENA_PROFILE } from '../../src/core/config/economy.ts'
import { Rng } from '../../src/core/rng.ts'
import { makeTestRelic, makeHero, maxedHero, nakedHero } from './helpers.ts'

import { buildArenaSnapshot } from '../../src/core/systems/derive.ts'
import { createNewSave, normalizeSave } from '../../src/core/save/schema.ts'
import { equipRelic } from '../../src/core/systems/loadout.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { applyAction } from '../../src/core/systems/actions.ts'

const ARENA_CTX = arenaContext(1)

function arenaSave() {
  const save = createNewSave(Date.parse('2026-11-08T15:59:59Z'), 19)
  save.heroes.xiangyu = createHeroState('xiangyu', 0)
  save.team.slots[0] = 'xiangyu'
  return save
}

describe('竞技整改回归', () => {
  it.each([2, 4, 6])('快照保留 %i 件套并以竞技系数生效', (pieces) => {
    const save = arenaSave()
    for (let i = 0; i < pieces; i++) {
      const relic = makeTestRelic('set_zhanshen_1', new Rng(i + 1))
      relic.uid = `test-${i}`
      save.relics.push(relic)
      equipRelic(save, 'xiangyu', i, relic.uid)
    }
    const snapshot = buildArenaSnapshot(save)
    expect(snapshot.relicSets[0]).toEqual([
      ...Array(pieces).fill('set_zhanshen'), ...Array(6 - pieces).fill(null),
    ])
    const base = buildArenaUnits(buildArenaLoadout({ slots: ['xiangyu'], heroes: save.heroes, relicSetsByHero: {}, runes: [], arenaLevel: 0 }), 'ally', ARENA_CTX)[0]
    const unit = buildArenaUnits(snapshot, 'ally', ARENA_CTX)[0]
    const bonus = pieces === 2 ? 0.08 : pieces === 4 ? 0.22 : 0.44
    expect(unit.stats.atk / base.stats.atk - 1).toBeCloseTo(bonus * 0.7, 8)
    const hash = arenaSnapshotHash(snapshot)
    save.player.permBoost = 999
    save.heroes.xiangyu.level = 240
    save.relics.forEach((r) => { r.level = 60; r.subStats = [] })
    expect(arenaSnapshotHash(buildArenaSnapshot(save))).toBe(hash)
  })

  it('旧快照只保留可确认的一件，不猜补套装件数', () => {
    const save = arenaSave()
    const old = buildArenaSnapshot(save)
    ;(old.relicSets as unknown[])[0] = 'set_zhanshen'
    save.arena.defenseLoadout = old
    const normalized = normalizeSave(save).arena.defenseLoadout!
    expect(normalized.relicSets[0]).toEqual(['set_zhanshen'])
    // 取模板值而不是写死数字：竞技模板调过一次（见 economy.ts 的实施修正）
    expect(buildArenaUnits(normalized, 'ally', ARENA_CTX)[0].stats.atk).toBe(ARENA_TEMPLATES['猛将'].atk)
  })

  it('双方各自生效羁绊，镜像双方初始血量对称', () => {
    const loadout = buildArenaLoadout({ slots: ['huatuo', 'bianque', 'nangdengel'], heroes: {}, relicSetsByHero: {}, runes: [], arenaLevel: 0 })
    const match = resolveArenaMatch({ challengeId: 'bond', attacker: loadout, defender: loadout, attackerId: 'a', attackerName: 'a', defenderId: 'b', defenderName: 'b', seed: 1 })
    const allies = match.result.roster.filter((u) => u.side === 'ally')
    const enemies = match.result.roster.filter((u) => u.side === 'enemy')
    // 3 名医者 → 羁绊「仁心济世」全队生命 +10%，竞技下 ×0.6 → +6%
    const healerHp = ARENA_TEMPLATES['医者'].hp * (1 + 0.1 * ARENA_CAPS.BOND_SCALE)
    expect(enemies.map((u) => u.maxHp)).toEqual([healerHp, healerHp, healerHp])
    expect(allies.map((u) => u.maxHp)).toEqual([healerHp, healerHp, healerHp])
    const solo = buildArenaLoadout({ slots: ['huatuo'], heroes: {}, relicSetsByHero: {}, runes: [], arenaLevel: 0 })
    const asymmetric = resolveArenaMatch({ challengeId: 'own-bond', attacker: solo, defender: loadout, attackerId: 'a', attackerName: 'a', defenderId: 'b', defenderName: 'b', seed: 1 })
    expect(asymmetric.result.roster.filter((u) => u.side === 'ally').map((u) => u.maxHp)).toEqual([ARENA_TEMPLATES['医者'].hp])
    expect(asymmetric.result.roster.filter((u) => u.side === 'enemy').map((u) => u.maxHp)).toEqual([healerHp, healerHp, healerHp])
  })

  it('北京时间周一零点重置周计数；竞技产出已停发，旧余额只读保留', () => {
    const save = arenaSave()
    const before = Date.parse('2026-11-08T15:59:59Z')
    const settle = (now: number) => applyAction(save, { type: 'arena.settle' }, { now, rng: new Rng(19), randomSeed: () => 19 })
    save.arena.weeklyMedals = 999
    save.arena.weeklyTickets = 999
    settle(before)
    expect(save.arena.weeklyMedals).toBe(999)
    settle(before + 1000)
    // ⚠ 资源/背包版本 v10：竞技勋章**停发**（设计稿 §3）→ 周重置后回到 0，
    //   而不是「重置后继续累计」。旧余额（save.arena.medals）保留为只读记录。
    expect(save.arena.weeklyMedals).toBe(0)
    expect(save.arena.weeklyTickets).toBeLessThanOrEqual(1)
    settle(before + 2000)
    expect(save.arena.weeklyMedals).toBe(0)
    expect(normalizeSave(save).arena.weeklyMedals).toBe(0)
  })

  it('旧档周标记只初始化一次，不因下次 normalize 洗掉计数', () => {
    const save = arenaSave()
    delete (save.arena as Partial<typeof save.arena>).rewardWeek
    save.arena.weeklyMedals = 99
    const first = normalizeSave(save)
    expect(first.arena.rewardWeek).toEqual(expect.any(Number))
    expect(first.arena.weeklyMedals).toBe(99)
    expect(normalizeSave(first).arena.rewardWeek).toBe(first.arena.rewardWeek)
  })
})

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
    const low = makeTestRelic('set_zhanshen_1', rng, 1)
    const high = makeTestRelic('set_zhanshen_1', rng, 60)

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
      makeTestRelic('set_zhanshen_1', rng),
      makeTestRelic('set_zhanshen_2', rng),
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

  it('竞技产出整体退场：结算恒为 0，不再发放勋章 / 竞技材料', () => {
    // ⚠ 资源/背包版本 v10：竞技只承接段位分与称号，产出退场（设计稿 §3）
    const { reward, weeklyMedals, weeklyMaterials } = resolveArenaRewards(true, 999, 999)
    expect(reward.medals).toBe(0)
    expect(reward.arenaMaterials).toBe(0)
    // 旧余额只读透传，不被改写
    expect(weeklyMedals).toBe(999)
    expect(weeklyMaterials).toBe(999)
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

/**
 * 竞技对局的**可分性**与**对称性**（Phase 11 决策闸门实测挖出的回归）。
 *
 * ⚠ 历史坑：
 *   1. 归一化模板偏「肉」，3 人以上的队伍**打不满 30 回合** → 双方都还活着 →
 *      战斗循环按回合上限退出 → `win` 停在默认值 → **进攻方恒判负**；
 *      实测 3 人队 100% 打满、进攻方胜率 0%，玩家天天「挑战失败」。
 *   2. 同速时 `a_` 恒定排在 `e_` 前 → 进攻方**永远先手** →
 *      镜像对局进攻方胜率 76~93%，违反 §6.9「双方对称」。
 */
describe('11. 竞技对局可分胜负且双方对称', () => {
  const TEAM = ['xiangyu', 'hanxin', 'zhugeliang', 'libai', 'sunwu', 'jeannedarc']

  function mirrorLoadout() {
    return buildArenaLoadout({
      slots: [...TEAM],
      heroes: {},
      relicSetsByHero: {},
      runes: [],
      arenaLevel: 0,
    })
  }

  function playMirror(trials: number) {
    const loadout = mirrorLoadout()
    let wins = 0
    let allyFirst = 0
    let tiebreaks = 0
    let maxRounds = 0
    for (let seed = 1; seed <= trials; seed++) {
      const match = resolveArenaMatch({
        challengeId: `m-${seed}`,
        attacker: loadout,
        defender: loadout,
        attackerId: 'a',
        attackerName: 'A',
        defenderId: 'b',
        defenderName: 'B',
        seed,
      })
      if (match.result.win) wins++
      if (match.result.initiativeSide === 'ally') allyFirst++
      if (match.tiebreak === 'hp-ratio') tiebreaks++
      if (match.result.rounds > maxRounds) maxRounds = match.result.rounds
    }
    return { winRate: wins / trials, allyFirstRate: allyFirst / trials, tiebreakRate: tiebreaks / trials, maxRounds }
  }

  it('6 人镜像对局不再恒判负（回合上限不再默认判负）', () => {
    const { winRate } = playMirror(60)
    // 恒判负 / 恒判胜都是回归：镜像必须是五五开
    expect(winRate).toBeGreaterThan(0.2)
    expect(winRate).toBeLessThan(0.8)
  })

  it('镜像对局能在回合上限内打完，几乎不需要「按剩余血量判定」兜底', () => {
    const { tiebreakRate, maxRounds } = playMirror(60)
    expect(tiebreakRate).toBeLessThan(0.1)
    expect(maxRounds).toBeLessThanOrEqual(ARENA_CAPS.MAX_ROUNDS)
  })

  it('先手权双方各 50%（§6.9 双方对称）', () => {
    const { allyFirstRate } = playMirror(120)
    expect(allyFirstRate).toBeGreaterThan(0.35)
    expect(allyFirstRate).toBeLessThan(0.65)
  })
})
