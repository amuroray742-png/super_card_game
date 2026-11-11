/**
 * 战斗结算 —— 纯函数：输入双方快照 + BattleContext，输出战报。
 *
 * 铁律：
 * - 属性一律经 resolveStats() 取，禁止直接读 hero.level / relic.level / permBoost
 * - 竞技模式下技能强度受 arenaProfile.skillScale 封顶（§6.8）
 * - 固定种子 → 完全相同的战报（测试依赖此性质）
 */
import type {
  BattleContext,
  BattleLogEntry,
  BattleResult,
  BattleUnit,
  Element,
  EnemyDef,
  FinalStats,
  HeroRuntime,
  SkillDef,
  SkillEffect,
  StatusEffect,
  StatKey,
} from '../model/types.ts'
import { BATTLE, ELEMENT_BEATS, SKILL } from '../config/economy.ts'
import { Rng } from '../rng.ts'
import { clamp, deriveStats, elementFactor, resolveStats } from './stats.ts'
import { getHeroPassiveMods } from './growth.ts'
import { getHeroSetMods } from './relic.ts'

/** 战报最大条数，防止长战斗内存膨胀 */
const MAX_LOG = 400

export interface BattleSetup {
  allies: HeroRuntime[]
  enemies: EnemyDef[]
  /** 敌人属性缩放倍率（与关卡难度同曲线，见 config/stages.ts） */
  enemyScale: number
  ctx: BattleContext
  /** 竞技铭文 id（仅 arena 模式生效） */
  runes?: string[]
}

// ─────────────────────────── 单位构建 ───────────────────────────

function scaleEnemyStats(def: EnemyDef, scale: number): FinalStats {
  const mult = Math.max(0.1, scale)
  const stats = {
    atk: def.baseStats.atk * mult,
    def: def.baseStats.def * mult,
    hp: def.baseStats.hp * mult,
    spd: def.baseStats.spd,
    crit: def.baseStats.crit,
    cdmg: def.baseStats.cdmg,
  }
  return { ...stats, ...deriveStats(stats) }
}

function buildAllyUnits(heroes: HeroRuntime[], ctx: BattleContext): BattleUnit[] {
  return heroes.map((hero, i) => {
    const stats = resolveStats(hero, ctx, {
      passives: getHeroPassiveMods(hero),
      setMods: getHeroSetMods(hero),
    })
    return {
      id: hero.def.id,
      side: 'ally' as const,
      slot: i,
      name: hero.def.name,
      element: hero.def.element,
      role: hero.def.role,
      stats,
      skills: hero.def.skills,
      skillLevels: hero.state.skillLevels,
      alive: true,
      hp: stats.hp,
      maxHp: stats.hp,
      shield: 0,
      statuses: [],
      cooldowns: hero.def.skills.map(() => 0),
    }
  })
}

function buildEnemyUnits(
  enemies: EnemyDef[],
  scale: number,
  offset: number,
): BattleUnit[] {
  return enemies.map((def, i) => {
    const stats = scaleEnemyStats(def, scale)
    return {
      id: `${def.id}#${offset + i}`,
      side: 'enemy' as const,
      slot: offset + i,
      name: def.name,
      element: def.element,
      role: def.role,
      stats,
      skills: def.skills,
      skillLevels: def.skills.map((s) => s.unlockLevel),
      alive: true,
      hp: stats.hp,
      maxHp: stats.hp,
      shield: 0,
      statuses: [],
      cooldowns: def.skills.map(() => 0),
      bossMechanic: def.bossMechanic,
    }
  })
}

// ─────────────────────────── 战斗主循环 ───────────────────────────

export function runBattle(setup: BattleSetup): BattleResult {
  const allies = buildAllyUnits(setup.allies, setup.ctx)
  const enemies = buildEnemyUnits(setup.enemies, setup.enemyScale, 0)
  return simulateBattle(allies, enemies, setup.ctx, setup.ctx.seed, setup.runes, setup.enemyScale)
}

/**
 * 单元级战斗入口 —— 竞技场复用此函数（双方均为英灵单位）。
 * 固定种子 → 完全相同的战报。
 */
export function simulateBattle(
  allies: BattleUnit[],
  enemies: BattleUnit[],
  ctx: BattleContext,
  seed: number,
  runes?: string[],
  enemyScale = 1,
): BattleResult {
  const rng = new Rng(seed)
  const log: BattleLogEntry[] = []

  if (runes && runes.length > 0) {
    for (const unit of allies) unit.runes = runes
  }

  const damageById: Record<string, number> = {}
  const healById: Record<string, number> = {}
  const all = [...allies, ...enemies]

  const push = (entry: BattleLogEntry) => {
    if (log.length < MAX_LOG) log.push(entry)
  }

  let round = 0
  let win = false

  while (round < BATTLE.MAX_ROUNDS) {
    round++
    push({
      round,
      kind: 'round',
      actorId: '',
      targetId: '',
      amount: 0,
      text: `第 ${round} 回合`,
    })

    // 行动顺序：按速度降序（同速按 id 稳定排序，保证可复现）
    const order = all
      .filter((u) => u.alive)
      .sort((a, b) => effectiveStats(b).spd - effectiveStats(a).spd || a.id.localeCompare(b.id))

    for (const unit of order) {
      if (!unit.alive) continue
      if (all.every((u) => u.side !== unit.side || !u.alive)) break

      // 控制状态：眩晕无法行动
      const stun = unit.statuses.find((s) => s.kind === 'control' && s.controlKind === 'stun')
      if (stun) {
        push({
          round,
          kind: 'control',
          actorId: unit.id,
          targetId: unit.id,
          amount: 0,
          text: `${unit.name} 被震慑，无法行动`,
        })
        continue
      }

      const silence = unit.statuses.some((s) => s.kind === 'control' && s.controlKind === 'silence')
      const skill = chooseSkill(unit, silence)
      if (!skill) continue

      const skillIndex = unit.skills.indexOf(skill)
      const ratio = effectiveRatio(skill, unit.skillLevels[skillIndex] ?? 1, ctx)

      push({
        round,
        kind: 'skill',
        actorId: unit.id,
        targetId: '',
        amount: 0,
        text: `${unit.name} 施展「${skill.name}」`,
      })

      for (const effect of skill.effects) {
        applyEffect(effect, unit, all, ratio, ctx, rng, {
          round,
          push,
          damageById,
          healById,
        })
      }

      // 冷却
      if (skillIndex >= 0 && unit.cooldowns[skillIndex] !== undefined) {
        unit.cooldowns[skillIndex] = skill.cooldown
      }
    }

    // 回合末：持续伤害、状态结算、冷却递减
    for (const unit of all) {
      if (!unit.alive) continue
      applyDot(unit, all, ctx, { round, push, damageById, healById })
      decrementCooldowns(unit)
      expireStatuses(unit)
      applyRegen(unit, ctx, { round, push, damageById, healById })
    }

    // 召唤机制
    const summons = all.filter((u) => u.alive && u.bossMechanic?.type === 'summon')
    for (const boss of summons) {
      const mech = boss.bossMechanic!
      if (mech.type !== 'summon') continue
      if (round % mech.everyTurns !== 0) continue
      const pool = all.filter((u) => u.side === 'enemy' && !u.alive)
      if (pool.length === 0) continue
      const template = pool[0]
      const base = template.name.split('#')[0]
      const def = ENEMY_TEMPLATES.get(base)
      if (!def) continue
      const spawned = buildEnemyUnits([def], enemyScale, all.length)
      for (const s of spawned) {
        s.hp = s.maxHp * 0.4
        all.push(s)
      }
      push({
        round,
        kind: 'skill',
        actorId: boss.id,
        targetId: '',
        amount: 0,
        text: `${boss.name} 召唤了援军`,
      })
    }

    if (!all.some((u) => u.side === 'enemy' && u.alive)) {
      win = true
      break
    }
    if (!all.some((u) => u.side === 'ally' && u.alive)) {
      win = false
      break
    }
  }

  const damageEntries = Object.entries(damageById).sort((a, b) => b[1] - a[1])
  const mvpId = damageEntries.length > 0 ? damageEntries[0][0] : null

  return {
    win,
    rounds: round,
    log,
    damageById,
    healById,
    mvpId,
    survivors: all.filter((u) => u.side === 'ally' && u.alive).map((u) => u.id),
  }
}

// ─────────────────────────── 技能选择与强度 ───────────────────────────

/**
 * 技能优先级：宝具 > 战技 > 普通技。
 * 未解锁的技能不可用；沉默时不可用战技与宝具。
 */
function chooseSkill(unit: BattleUnit, silenced: boolean): SkillDef | null {
  const candidates: SkillDef[] = []
  for (let i = 0; i < unit.skills.length; i++) {
    const skill = unit.skills[i]
    const level = unit.skillLevels[i] ?? 1
    if (level < skill.unlockLevel) continue
    if (unit.cooldowns[i] > 0) continue
    candidates.push(skill)
  }
  if (candidates.length === 0) return null
  if (silenced) {
    const normal = candidates.find((s) => s.kind === 'normal')
    return normal ?? null
  }
  const ultimate = candidates.find((s) => s.kind === 'ultimate')
  if (ultimate) return ultimate
  const battle = candidates.find((s) => s.kind === 'battle')
  if (battle) return battle
  return candidates[0]
}

/**
 * 技能效果强度。
 * PVE：每级 +2%。
 * 竞技：每级 +2% × skillScale（0.3），且总加成不超过 skillScale 上限（+30%）。
 */
export function effectiveRatio(
  skill: SkillDef,
  skillLevel: number,
  ctx: BattleContext,
): number {
  const lv = clamp(skillLevel, SKILL.MIN_LEVEL, SKILL.MAX_LEVEL) - 1
  let pct = lv * SKILL.PCT_PER_LEVEL
  if (ctx.mode === 'arena') {
    const cap = ctx.arenaProfile?.skillScale ?? 0.3
    pct = Math.min(pct * cap, cap)
  }
  return skill.ratio * (1 + pct)
}

// ─────────────────────────── 状态与属性 ───────────────────────────

/** 计算含 buff / debuff 的有效属性 */
export function effectiveStats(unit: BattleUnit): FinalStats {
  const base = unit.stats
  const out: FinalStats = { ...base }
  const keys: StatKey[] = ['atk', 'def', 'hp', 'spd', 'crit', 'cdmg']
  for (const key of keys) {
    let pct = 0
    for (const s of unit.statuses) {
      if (s.stat !== key) continue
      if (s.kind === 'buff') pct += s.value
      else if (s.kind === 'debuff') pct -= s.value
    }
    out[key] = base[key] * (1 + pct)
  }
  out.dodge = base.dodge
  out.hit = base.hit
  out.res = base.res
  return out
}

function hasStatus(unit: BattleUnit, kind: StatusEffect['kind'], controlKind?: string): boolean {
  return unit.statuses.some(
    (s) => s.kind === kind && (controlKind === undefined || s.controlKind === controlKind),
  )
}

function addStatus(unit: BattleUnit, status: StatusEffect) {
  // 同来源同类刷新回合数
  const existing = unit.statuses.find(
    (s) => s.kind === status.kind && s.sourceId === status.sourceId && s.stat === status.stat,
  )
  if (existing) {
    existing.turns = Math.max(existing.turns, status.turns)
    existing.value = Math.max(existing.value, status.value)
  } else {
    unit.statuses.push(status)
  }
}

function decrementCooldowns(unit: BattleUnit) {
  for (let i = 0; i < unit.cooldowns.length; i++) {
    if (unit.cooldowns[i] > 0) unit.cooldowns[i]--
  }
}

function expireStatuses(unit: BattleUnit) {
  for (const s of unit.statuses) s.turns--
  unit.statuses = unit.statuses.filter((s) => s.turns > 0)
}

// ─────────────────────────── 效果结算 ───────────────────────────

interface EffectHooks {
  round: number
  push: (e: BattleLogEntry) => void
  damageById: Record<string, number>
  healById: Record<string, number>
}

function applyEffect(
  effect: SkillEffect,
  source: BattleUnit,
  all: BattleUnit[],
  ratio: number,
  ctx: BattleContext,
  rng: Rng,
  hooks: EffectHooks,
) {
  const targets = selectTargets(effect, source, all)
  for (const target of targets) {
    switch (effect.type) {
      case 'damage':
        dealDamage(source, target, ratio, ctx, rng, hooks)
        break
      case 'heal':
        healUnit(source, target, ratio, hooks)
        break
      case 'shield':
        grantShield(source, target, ratio, hooks)
        break
      case 'buff':
        addStatus(target, {
          kind: 'buff',
          stat: effect.stat,
          value: effect.value,
          turns: effect.turns,
          sourceId: source.id,
        })
        hooks.push({
          round: hooks.round,
          kind: 'buff',
          actorId: source.id,
          targetId: target.id,
          amount: effect.value,
          text: `${target.name} 获得增益`,
        })
        break
      case 'debuff':
        addStatus(target, {
          kind: 'debuff',
          stat: effect.stat,
          value: effect.value,
          turns: effect.turns,
          sourceId: source.id,
        })
        hooks.push({
          round: hooks.round,
          kind: 'debuff',
          actorId: source.id,
          targetId: target.id,
          amount: effect.value,
          text: `${target.name} 受到削弱`,
        })
        break
      case 'control':
        if (target.alive) {
          addStatus(target, {
            kind: 'control',
            value: 0,
            turns: effect.turns,
            controlKind: effect.kind,
            sourceId: source.id,
          })
          hooks.push({
            round: hooks.round,
            kind: 'control',
            actorId: source.id,
            targetId: target.id,
            amount: 0,
            text: `${target.name} 被${effect.kind === 'stun' ? '震慑' : '沉默'}`,
          })
        }
        break
      case 'dot':
        if (target.alive) {
          const srcStats = effectiveStats(source)
          addStatus(target, {
            kind: 'dot',
            value: srcStats.atk * effect.ratio,
            turns: effect.turns,
            dotKind: effect.kind,
            sourceId: source.id,
          })
          hooks.push({
            round: hooks.round,
            kind: 'dot',
            actorId: source.id,
            targetId: target.id,
            amount: 0,
            text: `${target.name} 陷入${effect.kind === 'poison' ? '中毒' : '灼烧'}`,
          })
        }
        break
    }
  }
}

function selectTargets(
  effect: SkillEffect,
  source: BattleUnit,
  all: BattleUnit[],
): BattleUnit[] {
  const enemies = all.filter((u) => u.side !== source.side && u.alive)
  const allies = all.filter((u) => u.side === source.side && u.alive)
  switch (effect.type) {
    case 'damage':
    case 'dot':
    case 'control':
    case 'debuff':
      if (effect.type === 'damage' && source.skills.length > 0) {
        // 单体伤害：优先低血目标（聚焦集火）
        const sorted = [...enemies].sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))
        return sorted.slice(0, 1)
      }
      return enemies
    case 'heal':
    case 'shield': {
      const sorted = [...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id.localeCompare(b.id))
      return sorted.slice(0, 1)
    }
    case 'buff':
      return allies
  }
}

// ─────────────────────────── 伤害 / 治疗 ───────────────────────────

export function dealDamage(
  source: BattleUnit,
  target: BattleUnit,
  ratio: number,
  ctx: BattleContext,
  rng: Rng,
  hooks: EffectHooks,
) {
  if (!target.alive) return

  const src = effectiveStats(source)
  const tgt = effectiveStats(target)

  // 属性免疫
  if (target.bossMechanic?.type === 'elementImmunity' && target.bossMechanic.element === source.element) {
    hooks.push({
      round: hooks.round,
      kind: 'damage',
      actorId: source.id,
      targetId: target.id,
      amount: 0,
      text: `${target.name} 免疫该属性攻击`,
    })
    return
  }

  // 护盾阶段：伤害先扣护盾
  let shieldRemaining = target.shield
  const baseShield = target.bossMechanic?.type === 'shieldPhase' ? target.maxHp * 0.3 : 0
  if (target.bossMechanic?.type === 'shieldPhase' && target.shield <= 0 && target.hp > target.maxHp * 0.7) {
    target.shield = baseShield
    shieldRemaining = target.shield
  }

  const defEff = Math.max(1, tgt.def)
  let dmg = src.atk * (src.atk / (src.atk + defEff)) * ratio

  // 暴击
  const crit = rng.next() < src.crit
  if (crit) dmg *= 1 + src.cdmg

  // 减伤率（上限 75%）
  const reduction = Math.min(BATTLE.MAX_DAMAGE_REDUCTION, tgt.def / (tgt.def + 1200))
  dmg *= 1 - reduction

  // 相性
  dmg *= elementFactor(source.element, target.element, ELEMENT_BEATS)

  // 随机因子
  dmg *= rng.float(BATTLE.RANDOM_MIN, BATTLE.RANDOM_MAX)

  let amount = Math.max(1, Math.round(dmg))

  // 护盾吸收
  if (shieldRemaining > 0) {
    const absorbed = Math.min(shieldRemaining, amount)
    target.shield -= absorbed
    amount -= absorbed
    if (amount <= 0) {
      hooks.push({
        round: hooks.round,
        kind: 'damage',
        actorId: source.id,
        targetId: target.id,
        amount: absorbed,
        text: `${target.name} 的护盾吸收了 ${absorbed} 点伤害`,
      })
      return
    }
  }

  target.hp -= amount
  hooks.damageById[source.id] = (hooks.damageById[source.id] ?? 0) + amount
  hooks.push({
    round: hooks.round,
    kind: 'damage',
    actorId: source.id,
    targetId: target.id,
    amount,
    crit,
    text: `${target.name} 受到 ${amount} 点伤害${crit ? '（暴击）' : ''}`,
  })

  // 反伤
  if (target.bossMechanic?.type === 'thorns') {
    const reflect = Math.max(1, Math.round(amount * target.bossMechanic.ratio))
    source.hp -= reflect
    hooks.push({
      round: hooks.round,
      kind: 'damage',
      actorId: target.id,
      targetId: source.id,
      amount: reflect,
      text: `${target.name} 反伤 ${reflect} 点`,
    })
  }

  if (target.hp <= 0) {
    target.hp = 0
    target.alive = false
    hooks.push({
      round: hooks.round,
      kind: 'damage',
      actorId: source.id,
      targetId: target.id,
      amount: 0,
      text: `${target.name} 被击败`,
    })
  }
}

function healUnit(source: BattleUnit, target: BattleUnit, ratio: number, hooks: EffectHooks) {
  if (!target.alive) return
  const amount = Math.max(1, Math.round(source.maxHp * ratio))
  const before = target.hp
  target.hp = Math.min(target.maxHp, target.hp + amount)
  const healed = target.hp - before
  hooks.healById[source.id] = (hooks.healById[source.id] ?? 0) + healed
  hooks.push({
    round: hooks.round,
    kind: 'heal',
    actorId: source.id,
    targetId: target.id,
    amount: healed,
    text: `${target.name} 恢复 ${healed} 点生命`,
  })
}

function grantShield(source: BattleUnit, target: BattleUnit, ratio: number, hooks: EffectHooks) {
  const amount = Math.max(1, Math.round(source.maxHp * ratio))
  target.shield += amount
  hooks.push({
    round: hooks.round,
    kind: 'shield',
    actorId: source.id,
    targetId: target.id,
    amount,
    text: `${target.name} 获得 ${amount} 点护盾`,
  })
}

function applyDot(unit: BattleUnit, all: BattleUnit[], ctx: BattleContext, hooks: EffectHooks) {
  const dots = unit.statuses.filter((s) => s.kind === 'dot')
  for (const dot of dots) {
    if (!unit.alive) return
    const amount = Math.max(1, Math.round(dot.value))
    unit.hp -= amount
    hooks.damageById[dot.sourceId] = (hooks.damageById[dot.sourceId] ?? 0) + amount
    hooks.push({
      round: hooks.round,
      kind: 'dot',
      actorId: dot.sourceId,
      targetId: unit.id,
      amount,
      text: `${unit.name} 因${dot.dotKind === 'poison' ? '中毒' : '灼烧'}损失 ${amount} 点生命`,
    })
    if (unit.hp <= 0) {
      unit.hp = 0
      unit.alive = false
    }
  }
}

function applyRegen(unit: BattleUnit, ctx: BattleContext, hooks: EffectHooks) {
  const mech = unit.bossMechanic
  if (!mech || mech.type !== 'regen' || !unit.alive) return
  const amount = Math.max(1, Math.round(unit.maxHp * mech.ratio))
  const before = unit.hp
  unit.hp = Math.min(unit.maxHp, unit.hp + amount)
  hooks.healById[unit.id] = (hooks.healById[unit.id] ?? 0) + (unit.hp - before)
}

// ─────────────────────────── 敌人模板索引 ───────────────────────────

/** 供召唤机制查找敌人模板。由 config/enemies.ts 在加载时注册。 */
export const ENEMY_TEMPLATES = new Map<string, EnemyDef>()

export function registerEnemyTemplates(defs: readonly EnemyDef[]) {
  for (const def of defs) ENEMY_TEMPLATES.set(def.id, def)
}

// ─────────────────────────── 批量模拟 ───────────────────────────

export interface SimulationSummary {
  trials: number
  winRate: number
  avgRounds: number
}

/** 批量模拟通关率（用于数值调参，§5.8） */
export function simulateWinRate(
  setup: Omit<BattleSetup, 'ctx'> & { ctx: Omit<BattleContext, 'seed'> },
  trials = 200,
  seedBase = 12345,
): SimulationSummary {
  let wins = 0
  let totalRounds = 0
  for (let i = 0; i < trials; i++) {
    const result = runBattle({ ...setup, ctx: { ...setup.ctx, seed: seedBase + i } })
    if (result.win) wins++
    totalRounds += result.rounds
  }
  return {
    trials,
    winRate: wins / trials,
    avgRounds: totalRounds / trials,
  }
}

export { elementFactor }
export type { Element }
