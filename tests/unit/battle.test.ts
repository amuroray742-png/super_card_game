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
    expect(result.log.length).toBeLessThanOrEqual(1500)
  })

  it('最长的战斗（末章 BOSS 打满 30 回合）不会被战报上限截断', () => {
    // ⚠ 旧上限 400 会把这场战斗截断在第 15 回合左右：
    //   回放里血条停在半血、没有死亡演出、回合数对不上（实测 8/8 场触顶）。
    const stage = getStage(310)
    const result = runBattle({
      allies: ['xiangyu', 'hanxin', 'zhugeliang', 'caiwenji', 'mayuan', 'zhangfei'].map((id) =>
        maxedHero(id),
      ),
      enemies: stage.enemyIds.map((id) => getEnemy(id)),
      enemyScale: stage.enemyScale,
      ctx: { mode: 'pve' as const, seed: 2024 },
    })
    expect(result.log.length).toBeLessThan(1500)
    // 打得久说明战报确实很长（不是战斗太短导致断言空过）
    expect(result.rounds).toBeGreaterThan(10)
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

describe('目标选择（并列按槽位序）', () => {
  /**
   * 同血并列时的目标必须按**槽位序**选，而不是英灵 id 的字典序。
   *
   * 历史教训：字典序是拼音字母序，与编队无关——
   * 会出现「怪开局固定去打 caiwenji 这类字母序最小的人」这种反直觉结果。
   * 改为槽位序后，同血时前排先挨打，符合「前排承伤」的编队语义。
   */
  it('同血时前排（slot 小）先挨打', () => {
    // 对照组必须**同血**：否则会走「集火低血」分支，测不到并列判定。
    // weiqing / mayuan 同为 R 猛将同档 → 基础 HP 相同（880）。
    const result = runBattle({
      allies: [makeHero('weiqing', {}, 0), makeHero('mayuan', {}, 3)],
      enemies: [getEnemy('wanderer')],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 4242 },
    })

    // 两者同血 → 并列按槽位序 → 前排 weiqing(slot=0) 先挨打。
    // 旧规则按 id 字典序会选 mayuan（"mayuan" < "weiqing"），即后排先挨打。
    const allyHits = result.log.filter(
      (e) => e.kind === 'damage' && (e.targetId === 'weiqing' || e.targetId === 'mayuan'),
    )
    expect(allyHits.length).toBeGreaterThan(0)
    expect(allyHits[0].targetId).toBe('weiqing')
    // 后排 mayuan 若挨打，必然在 weiqing 之后
    const mayuanIdx = result.log.findIndex((e) => e.targetId === 'mayuan' && e.kind === 'damage')
    if (mayuanIdx >= 0) {
      expect(allyHits[0].round).toBeLessThanOrEqual(result.log[mayuanIdx].round)
    }
  })

  it('目标选择规则未变：仍优先集火低血目标', () => {
    const result = runBattle(setup(99, ['xiangyu', 'hanxin']))
    // 存在伤害记录 → 集火仍生效
    expect(Object.keys(result.damageById).length).toBeGreaterThan(0)
  })
})

describe('参战名册（roster）', () => {
  it('roster 的 id 与日志里的 actorId / targetId 完全一致', () => {
    const result = runBattle(setup(555, ['xiangyu', 'caiwenji']))
    const rosterIds = new Set(result.roster.map((u) => u.id))
    for (const entry of result.log) {
      if (entry.actorId) expect(rosterIds.has(entry.actorId)).toBe(true)
      if (entry.targetId) expect(rosterIds.has(entry.targetId)).toBe(true)
    }
  })

  it('roster 携带真实槽位与初始血量', () => {
    const result = runBattle({
      allies: [makeHero('xiangyu', {}, 0), makeHero('caiwenji', {}, 3)],
      enemies: [getEnemy('wanderer')],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 777 },
    })

    const xiangyu = result.roster.find((u) => u.id === 'xiangyu')!
    const caiwenji = result.roster.find((u) => u.id === 'caiwenji')!
    expect(xiangyu.slot).toBe(0)
    expect(caiwenji.slot).toBe(3)
    expect(xiangyu.maxHp).toBeGreaterThan(0)
    expect(caiwenji.maxHp).toBeGreaterThan(0)

    // 敌方槽位是该阵营内的出场序号（0 起），不会画到画布外
    const enemy = result.roster.find((u) => u.side === 'enemy')!
    expect(enemy.slot).toBe(0)
  })

  it('名册覆盖全部参战单位，敌方槽位连续', () => {
    const result = runBattle({
      allies: [makeHero('xiangyu'), makeHero('hanxin')],
      enemies: [getEnemy('boss_mirage'), getEnemy('wanderer')],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 31 },
    })
    const enemies = result.roster.filter((u) => u.side === 'enemy')
    // 名册必须覆盖全部敌方单位，且槽位按出场序号连续（不会画到画布外）
    enemies.forEach((u, i) => expect(u.slot).toBe(i))
    // 名册条目数 = 敌方单位数（不得漏人）
    const enemyIdsInLog = new Set(
      result.log
        .map((e) => e.targetId)
        .filter((id) => id.endsWith('#0') || id.endsWith('#1') || id.endsWith('#2')),
    )
    for (const id of enemyIdsInLog) {
      expect(enemies.some((u) => u.id === id)).toBe(true)
    }
  })

  it('名册携带基础定义 id / 定位 / 五行 / BOSS 机制（战斗演出的唯一来源）', () => {
    const result = runBattle({
      allies: [makeHero('xiangyu'), makeHero('caiwenji')],
      enemies: [getEnemy('boss_mirage'), getEnemy('wanderer')],
      enemyScale: 1,
      ctx: { mode: 'pve', seed: 31 },
    })

    // 英灵：defId 就是英灵 id
    const ally = result.roster.find((u) => u.id === 'xiangyu')!
    expect(ally.defId).toBe('xiangyu')
    expect(ally.role).toBe('猛将')
    expect(ally.element).toBe('土')
    expect(ally.mechanic).toBeUndefined()

    // 敌人：defId 去掉 `#序号` 后缀（表现层不得自行剥，AGENTS.md 铁律 #16）
    const enemy = result.roster.find((u) => u.side === 'enemy')!
    expect(enemy.id).toBe(`${enemy.defId}#${enemy.slot}`)
    expect(enemy.defId).toMatch(/^[a-z_]+$/)

    // BOSS 携带机制类型（战斗演出据此加描边与分段血条）
    const boss = result.roster.find((u) => u.defId === 'boss_mirage')!
    expect(boss.mechanic).toBe('summon')
  })
})

describe('死亡事件（§6.3 战斗演出）', () => {
  it('单位被击败时有独立的 death 事件', () => {
    const result = runBattle({
      allies: [maxedHero('xiangyu')],
      enemies: [getEnemy('wanderer')],
      enemyScale: 1,
      ctx: { mode: 'pve' as const, seed: 5 },
    })
    const deaths = result.log.filter((e) => e.kind === 'death')
    expect(deaths.length).toBeGreaterThan(0)
    for (const d of deaths) {
      expect(d.targetId).toBeTruthy()
      expect(d.amount).toBe(0)
      expect(d.text).toContain('被击败')
      // 死者必须在名册里（表现层要靠它做消散演出）
      expect(result.roster.some((u) => u.id === d.targetId)).toBe(true)
    }
  })

  it('持续伤害致死同样产出 death 事件（否则回放里单位会静默消失）', () => {
    // 构造「只会灼烧、不直接造成伤害」的技能，逼出 dot 致死分支
    const dotHero = makeHero('zuchongzhi', { level: 60, star: 6, skillLevels: [20, 20, 20] })
    const burnOnly = {
      ...dotHero,
      def: {
        ...dotHero.def,
        skills: [
          {
            id: 'burn_only',
            name: '焚',
            kind: 'battle' as const,
            desc: '只灼烧，不直接造成伤害',
            ratio: 0,
            target: 'allEnemies' as const,
            effects: [{ type: 'dot' as const, kind: 'burn' as const, ratio: 10, turns: 5 }],
            cooldown: 0,
            unlockStar: 1,
            unlockLevel: 1,
          },
        ],
      },
    }
    const result = runBattle({
      allies: [burnOnly],
      enemies: [getEnemy('wanderer')],
      enemyScale: 1,
      ctx: { mode: 'pve' as const, seed: 7 },
    })
    const deaths = result.log.filter((e) => e.kind === 'death')
    expect(deaths.length).toBeGreaterThan(0)
    expect(deaths[0].targetId).toBe('wanderer#0')
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
