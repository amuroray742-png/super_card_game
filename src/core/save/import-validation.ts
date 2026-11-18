import type { SaveData } from '../model/types.ts'
import { normalizeSave, SAVE_VERSION } from './schema.ts'
import { SAVE_IMPORT } from '../config/save-import.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { RELIC_INDEX } from '../config/relics.ts'
import { POOLS } from '../config/pools.ts'
import { STAGES } from '../config/stages.ts'
import { BATTLE, LEVEL, STAR, SKILL, RELIC, REBIRTH, GACHA } from '../config/economy.ts'
import { parseEquipKey } from '../systems/loadout.ts'
import { dayIndex, arenaWeekIndex } from '../time.ts'

function requireValid(ok: unknown): asserts ok {
  if (!ok) throw new Error('Invalid legacy save')
}
function record(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
}
/** 检查解码前后大小，不能用宽松 normalizeSave 把恶意集合修成正常集合。 */
export function validateImportedSave(text: string, now: number, seed: () => number): SaveData {
  requireValid(typeof text === 'string' && text.length <= SAVE_IMPORT.MAX_ENCODED_CHARS)
  const binary = atob(text)
  requireValid(binary.length <= SAVE_IMPORT.MAX_DECODED_BYTES)
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  function walk(v: unknown, depth = 0): void {
    requireValid(depth < 20)
    if (typeof v === 'number') requireValid(Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER)
    if (typeof v === 'string') requireValid(v.length <= SAVE_IMPORT.MAX_TEXT)
    if (v && typeof v === 'object') {
      requireValid(Object.keys(v).length <= SAVE_IMPORT.MAX_COLLECTION)
      for (const [k, child] of Object.entries(v)) {
        requireValid(!['__proto__', 'constructor', 'prototype'].includes(k))
        walk(child, depth + 1)
      }
    }
  }
  walk(raw)
  requireValid(record(raw) && integer(raw.version, 1, SAVE_VERSION) && record(raw.player))
  for (const k of ['heroes', 'equipped', 'team', 'gacha', 'campaign', 'idle', 'settings', 'stats']) requireValid(record(raw[k]))
  for (const k of ['relics', 'codes']) requireValid(Array.isArray(raw[k]))
  requireValid(Array.isArray(raw.team.slots) && raw.team.slots.length === 6 && Array.isArray(raw.team.presets))
  const save = normalizeSave(raw)
  for (const [k, v] of Object.entries(save.player)) {
    if (k === 'shards') {
      requireValid(record(v))
      for (const [id, n] of Object.entries(v)) requireValid(HERO_INDEX.has(id) && integer(n))
    } else requireValid(typeof v === 'number' && (k === 'permBoost' ? v <= REBIRTH.PERM_BOOST_CAP : integer(v)))
  }
  for (const [id, hero] of Object.entries(save.heroes)) {
    requireValid(HERO_INDEX.has(id) && record(hero) && hero.id === id)
    requireValid(integer(hero.level, LEVEL.MIN, LEVEL.MAX) && integer(hero.star, STAR.MIN, STAR.MAX))
    requireValid(integer(hero.exp) && integer(hero.shards) && typeof hero.coreAwakened === 'boolean')
    requireValid(Array.isArray(hero.skillLevels) && hero.skillLevels.length === 3 && hero.skillLevels.every(n => integer(n, SKILL.MIN_LEVEL, SKILL.MAX_LEVEL)))
    hero.obtainedAt = now
  }
  const slots = (values: unknown) => {
    requireValid(Array.isArray(values) && values.length === 6)
    const seen = new Set<string>()
    for (const id of values) {
      requireValid(id === null || (typeof id === 'string' && Object.hasOwn(save.heroes, id) && !seen.has(id)))
      if (typeof id === 'string') seen.add(id)
    }
  }
  slots(save.team.slots)
  for (const preset of save.team.presets) { requireValid(record(preset) && typeof preset.id === 'string' && typeof preset.name === 'string'); slots(preset.slots) }
  const relicIds = new Set<string>()
  for (const relic of save.relics) {
    requireValid(record(relic) && typeof relic.uid === 'string' && !relicIds.has(relic.uid) && RELIC_INDEX.has(relic.defId))
    requireValid(integer(relic.level, 0, RELIC.MAX_LEVEL) && typeof relic.locked === 'boolean' && Array.isArray(relic.subStats))
    const definition = RELIC_INDEX.get(relic.defId)!
    for (const mod of relic.subStats) requireValid(definition.subStatPool.some(m => m.stat === mod.stat && m.kind === mod.kind && m.zone === mod.zone && m.value === mod.value))
    relicIds.add(relic.uid)
  }
  const equipped = new Set<string>()
  for (const [key, entry] of Object.entries(save.equipped)) {
    const parsed = parseEquipKey(key)
    requireValid(parsed && record(entry) && parsed.heroId === entry.heroId && Object.hasOwn(save.heroes, entry.heroId) && relicIds.has(entry.relicId) && !equipped.has(entry.relicId))
    equipped.add(entry.relicId)
  }
  requireValid(integer(save.campaign.clearedStage, 0, STAGES.length) && STAGES.some(s => s.id === save.idle.currentStage))
  requireValid(integer(save.gacha.pitySSR, 0, GACHA.PITY_SSR_MAX) && integer(save.gacha.pity10, 0, 10))
  requireValid(record(save.gacha.pools) && Array.isArray(save.gacha.history) && typeof save.gacha.newbieUsed === 'boolean')
  requireValid(record(save.arena) && Array.isArray(save.arena.runes))
  for (const k of ['tierPoints', 'pvpPoints', 'medals', 'arenaLevel'] as const) requireValid(integer(save.arena[k]))
  requireValid(typeof save.idle.autoAdvance === 'boolean' && integer(save.idle.totalIdleSeconds))
  requireValid(record(save.campaign.stageStars) && integer(save.campaign.chapterProgress, 1))
  for (const [id, stars] of Object.entries(save.campaign.stageStars)) requireValid(STAGES.some(s => String(s.id) === id) && integer(stars, 0, 3))
  requireValid(save.codes.every(code => typeof code === 'string'))
  for (const id of Object.keys(save.gacha.pools)) requireValid(POOLS.some(p => p.id === id) && integer(save.gacha.pools[id]?.totalPulls))
  for (const draw of save.gacha.history) requireValid(record(draw) && HERO_INDEX.has(draw.heroId))
  requireValid((BATTLE.SPEED_OPTIONS as readonly number[]).includes(save.settings.speed) && typeof save.settings.sfx === 'boolean' && typeof save.settings.skipAnim === 'boolean')
  // 控制字段不信任导入值：不补历史离线收益、不继承可预测序列或周期领取资格。
  save.rng = { seed: seed(), counter: 0 }
  delete save.idle.farm
  save.createdAt = save.savedAt = save.lastTickAt = save.stats.firstStartAt = now
  save.daily = {
    signInStreak: 0,
    lastSignInDay: dayIndex(now),
    taskProgress: {},
    taskClaimed: [],
    taskDay: dayIndex(now),
    taskWeek: arenaWeekIndex(now),
  }
  save.arena.rewardWeek = arenaWeekIndex(now)
  // 「本周已获得」必须从 0 起算：置成周上限值等于宣告本周已满，
  // 导入后整周拿不到竞技勋章与竞技抽卡券（公式见 arena.ts 的 min(base, CAP - weekly)）。
  save.arena.weeklyMedals = 0
  save.arena.weeklyTickets = 0
  save.arena.defenseLoadout = null
  save.arena.snapshotHash = null
  return save
}
