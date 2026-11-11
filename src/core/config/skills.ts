/**
 * 技能与被动模板（§5.4 / §5.5）。
 *
 * 数据驱动的关键：英灵不逐个手写技能，而是由「定位 + 宝具效果类型」组合生成，
 * 宝具（固有技能）名称与描述来自名册，保证每个角色的标志性能力可辨识。
 */
import type { PassiveDef, Role, SkillDef, SkillEffect, StatMod } from '../model/types.ts'
import type { UltimateEffect, Tier } from './heroes/roster.ts'

/** 稀有度档位对应的技能强度系数 */
const TIER_POWER: Record<Tier, number> = { 1: 0.9, 2: 1.0, 3: 1.08, 4: 1.16 }

function damage(ratio: number): SkillEffect {
  return { type: 'damage', ratio }
}

function heal(ratio: number): SkillEffect {
  return { type: 'heal', ratio }
}

function shield(ratio: number): SkillEffect {
  return { type: 'shield', ratio }
}

function buff(stat: StatMod['stat'], value: number, turns = 2): SkillEffect {
  return { type: 'buff', stat, value, turns }
}

function debuff(stat: StatMod['stat'], value: number, turns = 2): SkillEffect {
  return { type: 'debuff', stat, value, turns }
}

function control(kind: 'stun' | 'silence', turns = 1): SkillEffect {
  return { type: 'control', kind, turns }
}

function dot(kind: 'poison' | 'burn', ratio: number, turns = 3): SkillEffect {
  return { type: 'dot', kind, ratio, turns }
}

/**
 * 生成英灵的 3 个技能：普通技 / 战技 / 宝具。
 */
export function buildSkills(role: Role, effect: UltimateEffect, tier: Tier, ultimateName: string, ultimateDesc: string): SkillDef[] {
  const p = TIER_POWER[tier]

  const normal = buildNormal(role, p)
  const battle = buildBattle(role, p)
  const ultimate = buildUltimate(role, effect, p, ultimateName, ultimateDesc)

  return [normal, battle, ultimate]
}

function buildNormal(role: Role, p: number): SkillDef {
  const config: Record<Role, { name: string; ratio: number }> = {
    猛将: { name: '挥击', ratio: 1.0 },
    统帅: { name: '督阵', ratio: 0.9 },
    谋士: { name: '试探', ratio: 0.85 },
    医者: { name: '援护', ratio: 0.7 },
    器者: { name: '机括', ratio: 0.95 },
  }
  const c = config[role]
  return {
    id: 'normal',
    name: c.name,
    kind: 'normal',
    desc: `普通攻击，造成约 ${Math.round(c.ratio * 100 * p)}% 攻击力的伤害。`,
    ratio: c.ratio * p,
    target: 'enemy',
    effects: [damage(c.ratio)],
    cooldown: 0,
    unlockStar: 1,
    unlockLevel: 1,
  }
}

function buildBattle(role: Role, p: number): SkillDef {
  switch (role) {
    case '猛将':
      return {
        id: 'battle',
        name: '横扫',
        kind: 'battle',
        desc: `横扫全体敌人，造成约 ${Math.round(150 * p)}% 攻击力的伤害。`,
        ratio: 1.5 * p,
        target: 'allEnemies',
        effects: [damage(1.5)],
        cooldown: 3,
        unlockStar: 2,
        unlockLevel: 10,
      }
    case '统帅':
      return {
        id: 'battle',
        name: '整军',
        kind: 'battle',
        desc: '提升全队 15% 攻击，持续 2 回合。',
        ratio: 0,
        target: 'allAllies',
        effects: [buff('atk', 0.15)],
        cooldown: 3,
        unlockStar: 2,
        unlockLevel: 10,
      }
    case '谋士':
      return {
        id: 'battle',
        name: '扰敌',
        kind: 'battle',
        desc: '削弱全体敌人 20% 防御，持续 2 回合。',
        ratio: 0,
        target: 'allEnemies',
        effects: [debuff('def', 0.2)],
        cooldown: 3,
        unlockStar: 2,
        unlockLevel: 10,
      }
    case '医者':
      return {
        id: 'battle',
        name: '施治',
        kind: 'battle',
        desc: '为生命最薄弱的同伴回复 15% 最大生命。',
        ratio: 0.15,
        target: 'ally',
        effects: [heal(0.15)],
        cooldown: 3,
        unlockStar: 2,
        unlockLevel: 10,
      }
    case '器者':
      return {
        id: 'battle',
        name: '投毒',
        kind: 'battle',
        desc: '使目标中毒，每回合造成 8% 攻击力的伤害，持续 3 回合。',
        ratio: 0,
        target: 'allEnemies',
        effects: [dot('poison', 0.08, 3)],
        cooldown: 3,
        unlockStar: 2,
        unlockLevel: 10,
      }
  }
}

function buildUltimate(
  role: Role,
  effect: UltimateEffect,
  p: number,
  name: string,
  desc: string,
): SkillDef {
  const base = {
    id: 'ultimate',
    name,
    kind: 'ultimate' as const,
    desc,
    ratio: 0,
    target: 'enemy' as const,
    cooldown: 5,
    unlockStar: 4,
    unlockLevel: 30,
  }

  switch (effect) {
    case 'burst':
      return {
        ...base,
        desc: `${desc}。对单体造成约 ${Math.round(280 * p)}% 攻击力的伤害。`,
        ratio: 2.8 * p,
        target: 'enemy',
        effects: [damage(2.8)],
      }
    case 'aoe':
      return {
        ...base,
        desc: `${desc}。对全体敌人造成约 ${Math.round(180 * p)}% 攻击力的伤害。`,
        ratio: 1.8 * p,
        target: 'allEnemies',
        effects: [damage(1.8)],
      }
    case 'pierce':
      return {
        ...base,
        desc: `${desc}。造成约 ${Math.round(220 * p)}% 攻击力的伤害，无视部分减伤。`,
        ratio: 2.2 * p,
        target: 'enemy',
        effects: [damage(2.2), buff('crit', 0.2, 1)],
      }
    case 'buff':
      return {
        ...base,
        desc: `${desc}。全队攻击提升 25%、防御提升 15%，持续 3 回合。`,
        ratio: 0,
        target: 'allAllies',
        effects: [buff('atk', 0.25, 3), buff('def', 0.15, 3)],
      }
    case 'control':
      return {
        ...base,
        desc: `${desc}。震慑单体敌人 1 回合，并削弱其防御 20%。`,
        ratio: 0,
        target: 'enemy',
        effects: [control('stun', 1), debuff('def', 0.2, 2)],
      }
    case 'heal':
      return {
        ...base,
        desc: `${desc}。为全队回复 20% 最大生命并附加护盾。`,
        ratio: 0.2,
        target: 'allAllies',
        effects: [heal(0.2), shield(0.12)],
      }
    case 'dot':
      return {
        ...base,
        desc: `${desc}。使全体敌人灼烧，每回合造成 12% 攻击力的伤害，持续 4 回合。`,
        ratio: 0,
        target: 'allEnemies',
        effects: [dot('burn', 0.12, 4)],
      }
  }
}

/**
 * 生成星级被动（2★ 起逐条解锁，共 5 条）。
 * 全部归属 skill 乘区——竞技模式下按 passiveScale 打折。
 */
export function buildPassives(role: Role, tier: Tier): PassiveDef[] {
  const p = 1 + (tier - 1) * 0.05
  const roleBonus = ((): StatMod[] => {
    switch (role) {
      case '猛将':
        return [{ stat: 'atk', kind: 'pct', value: 0.08 * p, zone: 'skill' }]
      case '统帅':
        return [
          { stat: 'atk', kind: 'pct', value: 0.05 * p, zone: 'skill' },
          { stat: 'def', kind: 'pct', value: 0.05 * p, zone: 'skill' },
        ]
      case '谋士':
        return [
          { stat: 'crit', kind: 'pct', value: 0.05 * p, zone: 'skill' },
          { stat: 'spd', kind: 'pct', value: 0.05 * p, zone: 'skill' },
        ]
      case '医者':
        return [
          { stat: 'hp', kind: 'pct', value: 0.07 * p, zone: 'skill' },
          { stat: 'def', kind: 'pct', value: 0.05 * p, zone: 'skill' },
        ]
      case '器者':
        return [
          { stat: 'crit', kind: 'pct', value: 0.06 * p, zone: 'skill' },
          { stat: 'atk', kind: 'pct', value: 0.04 * p, zone: 'skill' },
        ]
    }
  })()

  return [
    {
      id: 'p_atk',
      name: '锋锐',
      desc: '攻击提升 5%',
      unlockStar: 2,
      mods: [{ stat: 'atk', kind: 'pct', value: 0.05, zone: 'skill' }],
    },
    {
      id: 'p_hp',
      name: '坚体',
      desc: '生命提升 6%',
      unlockStar: 3,
      mods: [{ stat: 'hp', kind: 'pct', value: 0.06, zone: 'skill' }],
    },
    {
      id: 'p_crit',
      name: '洞隙',
      desc: '暴击提升 4%',
      unlockStar: 4,
      mods: [{ stat: 'crit', kind: 'pct', value: 0.04, zone: 'skill' }],
    },
    {
      id: 'p_def',
      name: '守御',
      desc: '防御提升 7%',
      unlockStar: 5,
      mods: [{ stat: 'def', kind: 'pct', value: 0.07, zone: 'skill' }],
    },
    {
      id: 'p_role',
      name: rolePassiveName(role),
      desc: rolePassiveDesc(role),
      unlockStar: 6,
      mods: roleBonus,
    },
  ]
}

function rolePassiveName(role: Role): string {
  switch (role) {
    case '猛将':
      return '万人敌'
    case '统帅':
      return '令行禁止'
    case '谋士':
      return '算无遗策'
    case '医者':
      return '回春妙手'
    case '器者':
      return '机心巧匠'
  }
}

function rolePassiveDesc(role: Role): string {
  switch (role) {
    case '猛将':
      return '攻击大幅提升'
    case '统帅':
      return '攻防同步提升'
    case '谋士':
      return '暴击与速度提升'
    case '医者':
      return '生命与抵抗提升'
    case '器者':
      return '暴击与攻击提升'
  }
}
