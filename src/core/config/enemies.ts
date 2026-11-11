/**
 * 敌人与 BOSS（§6.4 / §6.5）。
 *
 * 合规红线：敌人**全部为非历史人物**——灵体、妖异、幻想体、器械造物。
 * 命名不得指向任何真实历史人物、族群或军队。BOSS 为原创幻象名。
 */
import type { Element, EnemyDef, Role, SkillDef } from '../model/types.ts'
import { registerEnemyTemplates } from '../systems/battle.ts'

function attackSkill(name: string, ratio: number, cooldown = 0, unlockLevel = 1): SkillDef {
  return {
    id: `atk_${name}`,
    name,
    kind: cooldown > 0 ? 'battle' : 'normal',
    desc: `造成约 ${Math.round(ratio * 100)}% 攻击力的伤害。`,
    ratio,
    target: 'enemy',
    effects: [{ type: 'damage', ratio }],
    cooldown,
    unlockStar: 1,
    unlockLevel,
  }
}

function aoeSkill(name: string, ratio: number, cooldown = 3): SkillDef {
  return {
    id: `aoe_${name}`,
    name,
    kind: 'battle',
    desc: `横扫全体敌人，造成约 ${Math.round(ratio * 100)}% 攻击力的伤害。`,
    ratio,
    target: 'allEnemies',
    effects: [{ type: 'damage', ratio }],
    cooldown,
    unlockStar: 1,
    unlockLevel: 1,
  }
}

interface EnemySpec {
  id: string
  name: string
  element: Element
  role: Role
  atk: number
  def: number
  hp: number
  spd: number
  aoe?: boolean
  mechanic?: EnemyDef['bossMechanic']
}

const SPECS: EnemySpec[] = [
  // 第 1 章 荒原之息
  { id: 'wanderer', name: '游荡残魂', element: '水', role: '猛将', atk: 30, def: 12, hp: 520, spd: 92 },
  { id: 'dust_shade', name: '黄沙之影', element: '土', role: '谋士', atk: 26, def: 10, hp: 480, spd: 98 },
  { id: 'boss_wasteland', name: '荒原巨影', element: '土', role: '统帅', atk: 38, def: 18, hp: 2400, spd: 96, aoe: true, mechanic: { type: 'shieldPhase', threshold: 0.3 } },

  // 第 2 章 沙海回响
  { id: 'sand_mirage', name: '蜃楼幻身', element: '水', role: '谋士', atk: 38, def: 14, hp: 640, spd: 100, aoe: true },
  { id: 'burrower', name: '掘沙兽', element: '土', role: '猛将', atk: 44, def: 18, hp: 720, spd: 88 },
  { id: 'boss_mirage', name: '沙海之蜃', element: '水', role: '谋士', atk: 46, def: 22, hp: 3400, spd: 104, aoe: true, mechanic: { type: 'summon', everyTurns: 3, enemyId: 'sand_mirage', count: 2 } },

  // 第 3 章 潮汐遗构
  { id: 'tide_construct', name: '潮汐遗构', element: '水', role: '器者', atk: 42, def: 22, hp: 780, spd: 95 },
  { id: 'brine_wisp', name: '盐雾之灵', element: '水', role: '谋士', atk: 40, def: 16, hp: 700, spd: 104, aoe: true },
  { id: 'boss_tide', name: '潮汐主宰', element: '水', role: '统帅', atk: 52, def: 28, hp: 4600, spd: 100, aoe: true, mechanic: { type: 'regen', ratio: 0.04 } },

  // 第 4 章 雷壑
  { id: 'spark_wisp', name: '电芒游丝', element: '火', role: '谋士', atk: 52, def: 18, hp: 720, spd: 112 },
  { id: 'storm_golem', name: '雷髓巨灵', element: '火', role: '猛将', atk: 60, def: 30, hp: 960, spd: 86 },
  { id: 'boss_storm', name: '雷髓之主', element: '火', role: '猛将', atk: 64, def: 32, hp: 5800, spd: 104, aoe: true, mechanic: { type: 'enrage', threshold: 0.6, atkBonus: 0.4 } },

  // 第 5 章 幽林
  { id: 'thorn_beast', name: '荆棘兽灵', element: '木', role: '猛将', atk: 62, def: 34, hp: 1080, spd: 92 },
  { id: 'spore_drake', name: '孢雾翼', element: '木', role: '谋士', atk: 56, def: 24, hp: 940, spd: 106, aoe: true },
  { id: 'boss_grove', name: '万木之影', element: '木', role: '统帅', atk: 68, def: 38, hp: 7000, spd: 98, aoe: true, mechanic: { type: 'thorns', ratio: 0.1 } },

  // 第 6 章 熔火地脉
  { id: 'magma_hound', name: '熔岩猎犬', element: '火', role: '猛将', atk: 76, def: 32, hp: 1180, spd: 106 },
  { id: 'forge_sprite', name: '炉心精灵', element: '火', role: '器者', atk: 70, def: 28, hp: 1020, spd: 110, aoe: true },
  { id: 'boss_magma', name: '熔心巨像', element: '火', role: '统帅', atk: 82, def: 44, hp: 8400, spd: 100, aoe: true, mechanic: { type: 'elementImmunity', element: '火' } },

  // 第 7 章 霜寂山原
  { id: 'frost_wraith', name: '霜寂幽影', element: '水', role: '谋士', atk: 78, def: 36, hp: 1220, spd: 116 },
  { id: 'ice_guard', name: '冻岩守卫', element: '水', role: '猛将', atk: 84, def: 48, hp: 1440, spd: 88 },
  { id: 'boss_frost', name: '霜寂之主', element: '水', role: '统帅', atk: 92, def: 52, hp: 10200, spd: 104, aoe: true, mechanic: { type: 'elementImmunity', element: '水' } },

  // 第 8 章 织梦之境
  { id: 'dream_weaver', name: '织梦丝影', element: '木', role: '谋士', atk: 88, def: 38, hp: 1300, spd: 120, aoe: true },
  { id: 'illusion', name: '镜中幻象', element: '金', role: '猛将', atk: 96, def: 42, hp: 1400, spd: 112 },
  { id: 'boss_dream', name: '织梦者', element: '木', role: '谋士', atk: 104, def: 54, hp: 12400, spd: 118, aoe: true, mechanic: { type: 'summon', everyTurns: 4, enemyId: 'dream_weaver', count: 2 } },

  // 第 9 章 沉渊
  { id: 'abyss_lurker', name: '深渊潜伏者', element: '水', role: '猛将', atk: 110, def: 50, hp: 1560, spd: 104 },
  { id: 'void_echo', name: '虚空回响', element: '金', role: '谋士', atk: 102, def: 44, hp: 1440, spd: 124, aoe: true },
  { id: 'boss_abyss', name: '沉渊之瞳', element: '水', role: '统帅', atk: 118, def: 62, hp: 14800, spd: 112, aoe: true, mechanic: { type: 'enrage', threshold: 0.5, atkBonus: 0.5 } },

  // 第 10 章 星陨
  { id: 'star_shard', name: '星屑残片', element: '金', role: '器者', atk: 116, def: 54, hp: 1680, spd: 118 },
  { id: 'void_mirror', name: '虚像之镜', element: '金', role: '谋士', atk: 112, def: 50, hp: 1600, spd: 126, aoe: true },
  { id: 'boss_star', name: '星陨幻象', element: '金', role: '统帅', atk: 132, def: 70, hp: 18000, spd: 120, aoe: true, mechanic: { type: 'shieldPhase', threshold: 0.25 } },
]

function buildEnemy(spec: EnemySpec): EnemyDef {
  const skills: SkillDef[] = [attackSkill('撕咬', 1.0)]
  if (spec.aoe) skills.push(aoeSkill('横扫', 1.35, 3))
  return {
    id: spec.id,
    name: spec.name,
    element: spec.element,
    role: spec.role,
    baseStats: { atk: spec.atk, def: spec.def, hp: spec.hp, spd: spec.spd, crit: 0.05, cdmg: 0.5 },
    skills,
    bossMechanic: spec.mechanic,
  }
}

export const ENEMIES: readonly EnemyDef[] = SPECS.map(buildEnemy)

export const ENEMY_INDEX = new Map(ENEMIES.map((e) => [e.id, e]))

// 加载即注册，供召唤机制查找模板
registerEnemyTemplates(ENEMIES)

export function getEnemy(id: string): EnemyDef {
  const enemy = ENEMY_INDEX.get(id)
  if (!enemy) throw new Error(`未知敌人：${id}`)
  return enemy
}
