/**
 * BOSS 召唤机制（§6.5）。
 *
 * ⚠ 历史教训：召唤模板是用**显示名**去查敌人索引的
 *   （`template.name.split('#')[0]` → 「蜃楼幻身」），
 *   而索引的 key 是**敌人 id**（`sand_mirage`）→ 永远查不到 →
 *   `continue` 掉 → **召唤从未触发**，BOSS 阶段只剩本体，机制形同虚设。
 *
 * 本文件同时守护三件容易退化的事：
 * 1. 召唤真的发生（配置里的 enemyId / count / everyTurns 都生效）
 * 2. 援军有属性削弱 + 存活数量上限（不会滚雪球）
 * 3. BOSS 锁定：援军血量必然低于 BOSS，若不锁定就会永远打小怪、BOSS 永远不死
 */
import { describe, expect, it } from 'vitest'
import {
  runBattle,
  simulateBattle,
  registerEnemyTemplates,
} from '../../src/core/systems/battle.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { BATTLE } from '../../src/core/config/economy.ts'
import type { BattleUnit, EnemyDef, SkillDef } from '../../src/core/model/types.ts'
import { makeHero, nakedHero } from './helpers.ts'

const TEAM_IDS = ['xiangyu', 'hanxin', 'zhugeliang', 'caiwenji', 'mayuan', 'wangzhaojun']

/** 一支中低养成队伍（够弱，能和 BOSS 打满几个回合） */
function team(level = 30) {
  return TEAM_IDS.map((id, i) => makeHero(id, { level, star: 2, skillLevels: [5, 5, 5] }, i))
}

const dummySkill: SkillDef = {
  id: 'atk_dummy',
  name: '扑击',
  kind: 'normal',
  desc: '造成 100% 攻击力的伤害。',
  ratio: 1,
  target: 'enemy',
  effects: [{ type: 'damage', ratio: 1 }],
  cooldown: 0,
  unlockStar: 1,
  unlockLevel: 1,
}

/** 构造测试用敌人：默认血厚到打不死、攻低到打不死人 */
function makeEnemy(
  id: string,
  name: string,
  over: Partial<EnemyDef['baseStats']> = {},
  mechanic?: EnemyDef['bossMechanic'],
): EnemyDef {
  return {
    id,
    name,
    element: '土',
    role: '统帅',
    baseStats: { atk: 1, def: 99999, hp: 9_999_999, spd: 50, crit: 0, cdmg: 0, ...over },
    skills: [dummySkill],
    bossMechanic: mechanic,
  }
}

/** 构造测试用我方单位（单体技能，便于观察打中了谁） */
function makeAlly(id: string, atk: number): BattleUnit {
  const hp = 1_000_000
  return {
    id,
    side: 'ally',
    slot: 0,
    name: id,
    element: '金',
    role: '猛将',
    stats: { atk, def: 0, hp, spd: 100, crit: 0, cdmg: 0, dodge: 0, hit: 1, res: 0 },
    skills: [dummySkill],
    skillLevels: [1],
    alive: true,
    hp,
    maxHp: hp,
    shield: 0,
    statuses: [],
    cooldowns: [0],
  }
}

// 测试用模板（注册进敌人索引，供召唤机制查找）
const TEST_MINION = makeEnemy('test_minion', '测试小怪')
const TEST_BOSS = makeEnemy(
  'test_boss_every_turn',
  '测试召唤者',
  {},
  { type: 'summon', everyTurns: 1, enemyId: 'test_minion', count: 2 },
)
const TEST_BOSS_FLOOD = makeEnemy(
  'test_boss_flood',
  '测试洪流召唤者',
  {},
  { type: 'summon', everyTurns: 1, enemyId: 'test_minion', count: 99 },
)
const TEST_BOSS_NO_SUMMON = makeEnemy(
  'test_boss_plain',
  '测试无召唤BOSS',
  {},
  { type: 'regen', ratio: 0.01 },
)
registerEnemyTemplates([TEST_MINION, TEST_BOSS, TEST_BOSS_FLOOD, TEST_BOSS_NO_SUMMON])

describe('BOSS 召唤机制（§6.5）', () => {
  it('召唤真的发生：日志出现 summon 事件，每波数量取配置 count', () => {
    const result = runBattle({
      allies: team(),
      enemies: [TEST_BOSS],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 7 },
    })

    const summons = result.log.filter((e) => e.kind === 'summon')
    expect(summons.length).toBeGreaterThan(0)
    // everyTurns: 1 → 第 1 回合末就召唤
    expect(summons[0].round).toBe(1)
    // actor 是 BOSS，target 是被召唤出来的单位（id 与名册一致）
    expect(summons[0].actorId).toBe('test_boss_every_turn#0')

    // 每波恰好 count = 2 个
    const byRound = new Map<number, string[]>()
    for (const entry of summons) {
      const list = byRound.get(entry.round) ?? []
      list.push(entry.targetId)
      byRound.set(entry.round, list)
    }
    for (const [, ids] of byRound) expect(ids.length).toBe(2)
    expect(byRound.get(1)).toEqual(['test_minion#1', 'test_minion#2'])
  })

  it('召唤物进入名册，且出场回合与召唤事件一致', () => {
    const result = runBattle({
      allies: team(),
      enemies: [TEST_BOSS],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 7 },
    })

    const summons = result.log.filter((e) => e.kind === 'summon')
    for (const entry of summons) {
      const unit = result.roster.find((u) => u.id === entry.targetId)
      expect(unit).toBeDefined()
      expect(unit!.side).toBe('enemy')
      expect(unit!.appearRound).toBe(entry.round)
    }
    // 名册里的 id 必须覆盖日志里出现的全部 actorId / targetId（铁律 #8 / #16）
    const rosterIds = new Set(result.roster.map((u) => u.id))
    for (const entry of result.log) {
      if (entry.actorId) expect(rosterIds.has(entry.actorId)).toBe(true)
      if (entry.targetId) expect(rosterIds.has(entry.targetId)).toBe(true)
    }
  })

  it('同时存活的召唤物不超过上限（不会滚雪球）', () => {
    // count 配 99、每回合都召唤：若没有上限，30 回合会叠出上百个援军
    const result = runBattle({
      allies: team(),
      enemies: [TEST_BOSS_FLOOD],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 7 },
    })

    const summons = result.log.filter((e) => e.kind === 'summon')
    expect(summons.length).toBe(BATTLE.MAX_LIVE_SUMMONS)
    // 达到上限后不再召唤（而不是每回合补满）
    const rounds = new Set(summons.map((e) => e.round))
    expect(rounds.size).toBe(1)
  })

  it('召唤物属性被削弱：血量与伤害都低于同模板的普通怪', () => {
    // 对照组：同一个小怪直接作为敌人出场
    const plain = runBattle({
      allies: team(),
      enemies: [TEST_MINION],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 9 },
    })
    const summoned = runBattle({
      allies: team(),
      enemies: [TEST_BOSS],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 9 },
    })

    const plainUnit = plain.roster.find((u) => u.id === 'test_minion#0')!
    const summonUnit = summoned.roster.find((u) => u.id === 'test_minion#1')!
    // 血量按 SUMMON_STAT_RATIO 折算
    expect(summonUnit.maxHp).toBeCloseTo(plainUnit.maxHp * BATTLE.SUMMON_STAT_RATIO, 6)

    // 伤害也一起折算（只砍血会造出「满攻玻璃炮」，直接把队伍秒了）
    const plainDmg = plain.damageById['test_minion#0'] ?? 0
    const summonDmg = summoned.damageById['test_minion#1'] ?? 0
    expect(plainDmg).toBeGreaterThan(0)
    expect(summonDmg).toBeGreaterThan(0)
    expect(summonDmg).toBeLessThan(plainDmg)
  })

  it('没有召唤机制的 BOSS 不会产生 summon 日志', () => {
    const result = runBattle({
      allies: team(),
      enemies: [TEST_BOSS_NO_SUMMON],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 3 },
    })
    expect(result.log.filter((e) => e.kind === 'summon').length).toBe(0)
  })

  it('相同种子 → 召唤事件完全一致（确定性）', () => {
    const a = runBattle({
      allies: team(),
      enemies: [TEST_BOSS],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 4242 },
    })
    const b = runBattle({
      allies: team(),
      enemies: [TEST_BOSS],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 4242 },
    })
    const pick = (r: typeof a) => r.log.filter((e) => e.kind === 'summon').map((e) => `${e.round}:${e.targetId}`)
    expect(pick(a)).toEqual(pick(b))
  })
})

describe('BOSS 锁定（召唤机制的必要配套规则）', () => {
  it('BOSS 存活时，我方单体攻击锁定 BOSS，不被低血小怪抢走', () => {
    // BOSS 血量远高于小怪：若按「集火最低血」，小怪会一直吃掉全部伤害。
    // ⚠ BOSS 的判定口径是「带 bossMechanic 的敌人」——机制 boss 必须真的带机制。
    const boss = makeEnemy(
      'test_boss_lock',
      '锁定测试BOSS',
      { hp: 1_000_000, def: 1, atk: 1 },
      { type: 'regen', ratio: 0 },
    )
    const weak = makeEnemy('test_weak', '残血小怪', { hp: 50, def: 1, atk: 1 })
    registerEnemyTemplates([boss, weak])

    const result = simulateBattle(
      [makeAlly('hero', 100)],
      [
        {
          id: 'test_boss_lock#0',
          side: 'enemy',
          slot: 0,
          name: boss.name,
          element: boss.element,
          role: boss.role,
          stats: { atk: 1, def: 1, hp: 1_000_000, spd: 50, crit: 0, cdmg: 0, dodge: 0, hit: 1, res: 0 },
          skills: [dummySkill],
          skillLevels: [1],
          alive: true,
          hp: 1_000_000,
          maxHp: 1_000_000,
          shield: 0,
          statuses: [],
          cooldowns: [0],
          bossMechanic: boss.bossMechanic,
        },
        {
          id: 'test_weak#1',
          side: 'enemy',
          slot: 1,
          name: weak.name,
          element: weak.element,
          role: weak.role,
          stats: { atk: 1, def: 1, hp: 50, spd: 50, crit: 0, cdmg: 0, dodge: 0, hit: 1, res: 0 },
          skills: [dummySkill],
          skillLevels: [1],
          alive: true,
          hp: 50,
          maxHp: 50,
          shield: 0,
          statuses: [],
          cooldowns: [0],
        },
      ],
      { mode: 'pve', seed: 11 },
      11,
      undefined,
      1,
    )

    // 全部伤害都打在 BOSS 身上，小怪毫发无伤
    const hitsOnWeak = result.log.filter((e) => e.kind === 'damage' && e.targetId === 'test_weak#1')
    expect(hitsOnWeak.length).toBe(0)
    expect(result.damageById['hero']).toBeGreaterThan(0)
  })
})

describe('真实配置的召唤 BOSS', () => {
  it('沙海之蜃（boss_mirage）真的能召唤出蜃楼幻身', () => {
    const boss = getEnemy('boss_mirage')
    expect(boss.bossMechanic).toEqual({
      type: 'summon',
      everyTurns: 3,
      enemyId: 'sand_mirage',
      count: 2,
    })

    // 用裸装英灵 + 极小缩放：BOSS 血厚、输出低，能稳稳打满 3 回合以上，
    // 保证 everyTurns: 3 的召唤窗口一定会被走到。
    const result = runBattle({
      allies: [nakedHero('xiangyu')],
      enemies: [boss],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 2024 },
    })
    // 前置条件：战斗必须活到第 3 回合末
    expect(result.rounds).toBeGreaterThanOrEqual(3)

    const summons = result.log.filter((e) => e.kind === 'summon')
    expect(summons.length).toBeGreaterThan(0)
    // 召唤出来的必须是配置里写的敌人模板
    for (const entry of summons) {
      expect(entry.targetId.startsWith('sand_mirage#')).toBe(true)
      expect(entry.actorId).toBe('boss_mirage#0')
      // everyTurns: 3 → 只在 3 的倍数回合召唤
      expect(entry.round % 3).toBe(0)
    }
    // 名册里能看到援军，且出场回合 > 1
    const minions = result.roster.filter((u) => u.id.startsWith('sand_mirage#'))
    expect(minions.length).toBeGreaterThan(0)
    for (const m of minions) expect(m.appearRound).toBeGreaterThan(1)
  })

  it('织梦者（boss_dream）召唤的是织梦丝影', () => {
    const boss = getEnemy('boss_dream')
    expect(boss.bossMechanic).toEqual({
      type: 'summon',
      everyTurns: 4,
      enemyId: 'dream_weaver',
      count: 2,
    })
  })
})
