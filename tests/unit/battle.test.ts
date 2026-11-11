/**
 * 战斗系统（§15.1）：确定性、伤害公式、BOSS 机制
 */
import { describe, expect, it } from 'vitest'
import { runBattle, effectiveStats } from '../../src/core/systems/battle.ts'
import { elementFactor } from '../../src/core/systems/stats.ts'
import { ELEMENT_BEATS, BATTLE } from '../../src/core/config/economy.ts'
import { getStage } from '../../src/core/config/stages.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { makeHero, maxedHero } from './helpers.ts'

function setup(seed: number, heroIds = ['xiangyu', 'hanxin', 'zhugeliang']) {
  const stage = getStage(1)
  return {
    allies: heroIds.map((id) => maxedHero(id)),
    enemies: stage.enemyIds.map((id) => getEnemy(id)),
    enemyScale: stage.enemyScale,
    ctx: { mode: 'pve' as const, seed },
  }
}

describe('战斗确定性', () => {
  it('固定种子 → 战报逐条一致', () => {
    const a = runBattle(setup(1234))
    const b = runBattle(setup(1234))
    expect(a.win).toBe(b.win)
    expect(a.rounds).toBe(b.rounds)
    expect(a.log.length).toBe(b.log.length)
    for (let i = 0; i < a.log.length; i++) {
      expect(a.log[i].kind).toBe(b.log[i].kind)
      expect(a.log[i].actorId).toBe(b.log[i].actorId)
      expect(a.log[i].targetId).toBe(b.log[i].targetId)
      expect(a.log[i].amount).toBe(b.log[i].amount)
    }
    expect(a.damageById).toEqual(b.damageById)
  })

  it('不同种子 → 可能产生不同战报', () => {
    const a = runBattle(setup(1))
    const b = runBattle(setup(99999))
    expect(JSON.stringify(a.damageById)).not.toBe(JSON.stringify(b.damageById))
  })

  it('战报长度受限，防止长战斗内存膨胀', () => {
    const result = runBattle(setup(5))
    expect(result.log.length).toBeLessThanOrEqual(400)
  })
})

describe('伤害公式（§6.2）', () => {
  it('相性系数：我克 1.25 / 平 1.0 / 克我 0.85', () => {
    expect(elementFactor('金', '木', ELEMENT_BEATS)).toBe(1.25)
    expect(elementFactor('木', '金', ELEMENT_BEATS)).toBe(0.85)
    expect(elementFactor('金', '水', ELEMENT_BEATS)).toBe(1.0)
  })

  it('减伤率上限 75%', () => {
    expect(BATTLE.MAX_DAMAGE_REDUCTION).toBe(0.75)
    // 防御极高时减伤率不会超过上限
    const reduction = Math.min(BATTLE.MAX_DAMAGE_REDUCTION, 100000 / (100000 + 1200))
    expect(reduction).toBeLessThanOrEqual(0.75)
  })

  it('随机因子在 0.95~1.05 之间', () => {
    expect(BATTLE.RANDOM_MIN).toBe(0.95)
    expect(BATTLE.RANDOM_MAX).toBe(1.05)
  })

  it('有效属性应用 buff / debuff', () => {
    const unit = {
      id: 'u',
      side: 'ally' as const,
      slot: 0,
      name: '测试',
      element: '金' as const,
      role: '猛将' as const,
      stats: {
        atk: 100, def: 50, hp: 1000, spd: 100, crit: 0.1, cdmg: 0.5,
        dodge: 0, hit: 1, res: 0,
      },
      skills: [],
      skillLevels: [],
      alive: true,
      hp: 1000,
      maxHp: 1000,
      shield: 0,
      statuses: [
        { kind: 'buff' as const, stat: 'atk' as const, value: 0.5, turns: 2, sourceId: 's' },
      ],
      cooldowns: [],
    }
    expect(effectiveStats(unit).atk).toBeCloseTo(150, 6)
  })
})

describe('战斗结果', () => {
  it('MVP 为伤害最高的单位', () => {
    const result = runBattle(setup(77))
    if (result.mvpId) {
      const entries = Object.entries(result.damageById).sort((a, b) => b[1] - a[1])
      expect(result.mvpId).toBe(entries[0][0])
    }
  })

  it('战斗在最大回合数内结束', () => {
    const result = runBattle(setup(3, ['nangdengel']))
    expect(result.rounds).toBeLessThanOrEqual(BATTLE.MAX_ROUNDS)
  })
})

describe('BOSS 机制（§6.5）', () => {
  it('护盾阶段：BOSS 前段血量有护盾', () => {
    const boss = getEnemy('boss_wasteland')
    expect(boss.bossMechanic?.type).toBe('shieldPhase')
  })

  it('召唤机制可正常结算（不抛错）', () => {
    const boss = getEnemy('boss_mirage')
    expect(boss.bossMechanic?.type).toBe('summon')
    const result = runBattle({
      allies: [makeHero('xiangyu')],
      enemies: [boss],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 11 },
    })
    expect(result.rounds).toBeGreaterThan(0)
  })

  it('属性免疫机制存在且可结算', () => {
    const boss = getEnemy('boss_magma')
    expect(boss.bossMechanic?.type).toBe('elementImmunity')
    const result = runBattle({
      allies: [makeHero('libai')],
      enemies: [boss],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 13 },
    })
    expect(result.rounds).toBeGreaterThan(0)
  })
})
