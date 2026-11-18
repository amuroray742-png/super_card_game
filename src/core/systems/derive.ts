/**
 * 存档派生（**纯函数**，客户端与服务端共用）。
 *
 * 存档是**唯一真源**，其余一切（编队运行时对象、战力、竞技快照）都是它的**派生**。
 * 服务端权威化后，客户端不再自己维护这些派生值，而是：
 *   - 客户端：从服务端返回的 `save` 派生（用于显示）；
 *   - 服务端：从自己持有的权威 `save` 派生（用于算战斗 / 战力）。
 *
 * 同一份派生代码 → 两端算出的战力与战斗必然一致（铁律 #2 属性解析单一入口）。
 *
 * ⚠ 这里**不得**读 `Date.now()` / `Math.random()`：派生必须是存档的纯函数。
 */
import type {
  ArenaLoadout,
  HeroRuntime,
  HeroState,
  RelicInstance,
  SaveData,
} from '../model/types.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { getEquippedRelics } from './loadout.ts'
import { buildArenaLoadout } from './arena.ts'
import { getBondMods, getTeamPower } from './team.ts'
import type { BattleContext, StatMod } from '../model/types.ts'
import { RELIC_DEFS } from './relic.ts'
import '../config/relics.ts'

/** 真实挂机、预览、战力共用的PVE上下文。竞技入口不得调用。 */
export function buildPveContext(save: SaveData, seed = 1): BattleContext {
  const progress: StatMod[] = (['hp', 'atk', 'def', 'spd'] as const).map(stat => ({
    stat, value: save.player.permBoost, kind: 'pct', zone: 'progress',
  }))
  return { mode: 'pve', seed, teamMods: { bond: getBondMods(buildTeam(save)), progress } }
}

/** 存档 → 英灵状态表 */
export function buildHeroIndex(save: SaveData): Map<string, HeroState> {
  const map = new Map<string, HeroState>()
  for (const [id, state] of Object.entries(save.heroes)) map.set(id, state)
  return map
}

/** 存档 → 遗物实例表（uid → 实例） */
export function buildRelicsByUid(save: SaveData): Map<string, RelicInstance> {
  const map = new Map<string, RelicInstance>()
  for (const r of save.relics) map.set(r.uid, r)
  return map
}

/** 存档 → 每名英灵的 6 个遗物槽 */
export function buildEquippedMap(save: SaveData): Map<string, (RelicInstance | null)[]> {
  const map = new Map<string, (RelicInstance | null)[]>()
  for (const heroId of Object.keys(save.heroes)) {
    map.set(heroId, getEquippedRelics(save, heroId))
  }
  return map
}

/**
 * 存档 → 单个英灵的运行时对象。
 *
 * `slot` 是**真实编队槽位号**（0-5），不是「队伍里的第几个」——
 * 队伍会跳过空槽位，用紧凑序号会让后排的人被当成前排（铁律 #16）。
 */
export function buildHeroRuntime(save: SaveData, heroId: string): HeroRuntime | null {
  const def = HERO_INDEX.get(heroId)
  const state = save.heroes[heroId]
  if (!def || !state) return null
  return {
    def,
    state,
    relics: getEquippedRelics(save, heroId),
    slot: save.team.slots.indexOf(heroId),
  }
}

/**
 * 存档 → 当前编队的运行时对象列表。
 *
 * 槽位号沿用真实槽位（0-2 前排 / 3-5 后排），空槽位直接跳过。
 */
export function buildTeam(save: SaveData): HeroRuntime[] {
  const out: HeroRuntime[] = []
  for (let slot = 0; slot < save.team.slots.length; slot++) {
    const id = save.team.slots[slot]
    if (!id) continue
    const def = HERO_INDEX.get(id)
    const state = save.heroes[id]
    if (!def || !state) continue
    out.push({
      def,
      state,
      relics: getEquippedRelics(save, id),
      slot,
    })
  }
  return out
}

/** 存档 → 编队战力（PVE 口径，与界面显示一致） */
export function buildTeamPower(save: SaveData): number {
  return getTeamPower(buildTeam(save), buildPveContext(save))
}

/**
 * 存档 → 竞技阵容快照。
 *
 * 只读**策略性**字段（星级 / 技能等级 / 遗物所属套装 / 铭文 / 竞技等级），
 * 不含任何 PVE 数值（等级 / 遗物强化等级 / 随机词条 / 永久加成）——
 * 从类型层面阻断竞技场的数值泄漏（铁律：PvP 数值隔离）。
 */
export function buildArenaSnapshot(save: SaveData): ArenaLoadout {
  const equipped = buildEquippedMap(save)
  const relicSetsByHero = Object.fromEntries(
    save.team.slots
      .filter((id): id is string => !!id)
      .map((id) => [
        id,
        (equipped.get(id) ?? []).map((r) => r ? RELIC_DEFS.get(r.defId)?.setId ?? null : null),
      ]),
  )
  return buildArenaLoadout({
    slots: save.team.slots,
    heroes: save.heroes,
    relicSetsByHero,
    runes: save.arena.runes ?? [],
    arenaLevel: save.arena.arenaLevel ?? 1,
  })
}
