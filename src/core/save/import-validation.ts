import type { SaveData } from '../model/types.ts'
import { migrate, normalizeSave, SAVE_VERSION, createChannelRng } from './schema.ts'
import { SAVE_IMPORT } from '../config/save-import.ts'
import { HERO_INDEX } from '../config/heroes/index.ts'
import { RELIC_INDEX } from '../config/relics.ts'
import { POOLS } from '../config/pools.ts'
import { STAGES } from '../config/stages.ts'
import { BATTLE, LEVEL, STAR, SKILL, RELIC, REBIRTH, GACHA } from '../config/economy.ts'
import { ITEM_IDS } from '../config/items.ts'
import { DUNGEON_INDEX, DUNGEON_STAGE_INDEX } from '../config/dungeons.ts'
import { IDLE_CHANNEL_KINDS } from '../systems/idle.ts'
import { parseEquipKey } from '../systems/loadout.ts'
import { emptyLadderSquads } from '../config/ladder.ts'
import { dayIndex, arenaWeekIndex } from '../time.ts'

const ITEM_ID_SET = new Set<string>(ITEM_IDS)

/**
 * 导入路径的**原始**通道目标校验（必须在 `normalizeSave` **之前**调用）。
 *
 * ⚠ **为什么不能只靠归一化之后的校验**（挂机改版 v11 修正）：
 *   `normalizeSave` 对非法通道目标一律置 `null`（逐通道兜底：一条通道目标坏了
 *   只关掉那一条，不连累另外两条）。于是非法 id 在归一化后**已经不存在**，
 *   归一化之后再校验就是**死代码**——校验永远通过，坏数据照样被放进来。
 *
 *   导入是「客户端上传的数据」，语义上要**严格**：宁可整份拒绝，
 *   也不能让一份引用了不存在关卡的档进入服务端（铁律 #4 单一数据源：
 *   关卡 id 的唯一出处是配置表，非法 id 属于「凭空捏造」）。
 */
function validateRawChannelTargets(raw: Record<string, any>): void {
  const channels = raw.idle?.channels
  if (!record(channels)) return
  for (const kind of IDLE_CHANNEL_KINDS) {
    const ch = channels[kind]
    if (!record(ch)) continue
    const target = ch.target
    if (target === null || target === undefined) continue
    requireValid(record(target))
    // 目标种类必须与所在通道一致（`normalizeIdleChannel` 也是这么判的）
    requireValid(target.kind === kind)
    if (kind === 'main') {
      requireValid(
        target.stageId === null ||
          (integer(target.stageId, 1, STAGES.length) && STAGES.some((s) => s.id === target.stageId)),
      )
    } else {
      requireValid(typeof target.dungeonStageId === 'string')
      requireValid(DUNGEON_STAGE_INDEX.has(target.dungeonStageId))
      // ⚠ 副本关卡的**种类**必须与通道种类一致
      //   （`{kind:'relic', dungeonStageId:'dgn_skillGold_easy'}` 是「凭空捏造」）。
      //   `normalizeIdleChannel` 会把它洗成 `null`，但归一化前必须先拦住。
      const stage = DUNGEON_STAGE_INDEX.get(target.dungeonStageId)
      requireValid(stage !== undefined && DUNGEON_INDEX.get(stage.variantId)?.kind === kind)
    }
  }
}

/**
 * 导入路径的**原始**遗物保底计数校验（同样必须在 `normalizeSave` 之前调用）。
 *
 * ⚠ 保底计数**不能由客户端决定**：一份 `pity: 999` 的导入档会让保底机制形同虚设。
 *   非法 key / 非法数值一律整份拒绝。
 */
function validateRawRelicPity(raw: Record<string, any>): void {
  const pity = raw.relicPity
  if (pity === null || pity === undefined) return
  requireValid(record(pity))
  for (const [id, value] of Object.entries(pity)) {
    requireValid(DUNGEON_STAGE_INDEX.has(id) && integer(value))
  }
}

/**
 * 导入路径的**原始**副本通关记录校验（同样必须在 `normalizeSave` 之前调用）。
 *
 * ⚠ `normalizeDungeonCleared` 会把非法 id **过滤掉** → 归一化之后同样校验不到。
 *   导入档的副本通关记录**本来就会被清空**（不可信的通关凭证），
 *   但引用不存在的副本 id 属于「凭空捏造」，直接整份拒绝。
 */
function validateRawDungeonCleared(raw: Record<string, any>): void {
  const cleared = raw.dungeons?.cleared
  if (cleared === null || cleared === undefined) return
  requireValid(record(cleared))
  for (const [id, value] of Object.entries(cleared)) {
    requireValid(DUNGEON_STAGE_INDEX.has(id) && value === true)
  }
}

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
  // ⚠ **挂机改版 v11 / 遗物副本 v12**：导入**只接受当前版本**（v12）。
  //   旧版本走服务端存档的迁移链，不走导入路径——导入是「客户端上传的数据」，
  //   版本不一致时宁可拒绝，也不要把半迁移的档放进来。
  requireValid(record(raw) && raw.version === SAVE_VERSION && record(raw.player))
  for (const k of ['heroes', 'equipped', 'team', 'gacha', 'campaign', 'idle', 'settings', 'stats']) requireValid(record(raw[k]))
  for (const k of ['relics', 'codes']) requireValid(Array.isArray(raw[k]))
  requireValid(Array.isArray(raw.team.slots) && raw.team.slots.length === 6 && Array.isArray(raw.team.presets))
  // ⚠ **必须在归一化之前**查原始值：归一化会把非法目标 / 非法副本 id 洗成合法形状，
  //   之后再校验就是死代码（详见 `validateRawChannelTargets` 的注释）。
  validateRawChannelTargets(raw)
  validateRawDungeonCleared(raw)
  validateRawRelicPity(raw)
  const save = normalizeSave(raw)
  // ⚠ **实施修正（资源/背包版本 v10）**：导入路径**必须**走迁移。
  //   `normalizeSave` 保留原始版本号（它曾把版本改写成当前版本 →
  //   迁移对导入档完全不跑 → 导入的 v9 旧档会保留 `player.tickets` 等退役字段）。
  //   迁移后退役字段被折算（券 → 结晶、印记 → 银两、经验池 → 经验书）。
  migrate(save)
  for (const [k, v] of Object.entries(save.player)) {
    if (k === 'shards') {
      requireValid(record(v))
      for (const [id, n] of Object.entries(v)) requireValid(HERO_INDEX.has(id) && integer(n))
    } else requireValid(typeof v === 'number' && (k === 'permBoost' ? v <= REBIRTH.PERM_BOOST_CAP : integer(v)))
  }
  // 背包堆叠物：只认已登记的道具 id，数量取非负整数
  requireValid(record(save.items))
  for (const [id, n] of Object.entries(save.items)) {
    requireValid(ITEM_ID_SET.has(id) && integer(n))
  }
  // 旧档一次性分配权益
  requireValid(record(save.legacy))
  requireValid(integer(save.legacy.skillStones) && integer(save.legacy.relicStones))
  requireValid(typeof save.legacy.allocated === 'boolean')
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
  requireValid(integer(save.campaign.clearedStage, 0, STAGES.length))
  requireValid(integer(save.campaign.creditedStages, 0, STAGES.length))
  requireValid(integer(save.gacha.pitySSR, 0, GACHA.PITY_SSR_MAX) && integer(save.gacha.pity10, 0, 10))
  requireValid(record(save.gacha.pools) && Array.isArray(save.gacha.history) && typeof save.gacha.newbieUsed === 'boolean')
  requireValid(record(save.arena) && Array.isArray(save.arena.runes))
  for (const k of ['tierPoints', 'pvpPoints', 'medals', 'arenaLevel'] as const) requireValid(integer(save.arena[k]))
  // ⚠ **挂机改版 v11 / 遗物副本 v12**：四条通道的账本结构逐项校验
  //   （这层是**纵深防御**：真正的闸门在上面的原始值校验——归一化后的目标
  //   必然合法，这里再查一遍是为了防 `normalizeSave` 语义变化时静默失守）
  requireValid(integer(save.idle.totalIdleSeconds) && Number.isFinite(save.idle.activeUntil))
  for (const kind of IDLE_CHANNEL_KINDS) {
    const ch = save.idle.channels[kind]
    requireValid(record(ch))
    requireValid(Number.isFinite(ch.measuredAt) && integer(ch.effectiveMs) && integer(ch.offlineElapsedMs) && integer(ch.pendingOfflineMs))
    requireValid(ch.target === null || record(ch.target))
    if (ch.target === null) continue
    const target = ch.target
    if (target.kind === 'main') {
      requireValid(
        target.stageId === null ||
          (integer(target.stageId, 1, STAGES.length) && STAGES.some((s) => s.id === target.stageId)),
      )
    } else {
      requireValid(typeof target.dungeonStageId === 'string')
      requireValid(DUNGEON_STAGE_INDEX.has(target.dungeonStageId))
    }
  }
  // 副本通关记录：只保留合法关卡 id
  requireValid(record(save.dungeons?.cleared))
  for (const [id, value] of Object.entries(save.dungeons.cleared)) {
    requireValid(DUNGEON_STAGE_INDEX.has(id) && value === true)
  }
  // ⚠ **遗物副本 v12**：保底计数与每日额度计数逐项校验
  //   （保底是「防重复抽」机制，额度是「防通胀闸门」，两者都只能由服务端推进）。
  requireValid(record(save.relicPity))
  for (const [id, value] of Object.entries(save.relicPity)) {
    requireValid(DUNGEON_STAGE_INDEX.has(id) && integer(value))
  }
  requireValid(record(save.relicDaily) && typeof save.relicDaily.date === 'string' && integer(save.relicDaily.count))
  requireValid(record(save.campaign.stageStars) && integer(save.campaign.chapterProgress, 1))
  for (const [id, stars] of Object.entries(save.campaign.stageStars)) requireValid(STAGES.some(s => String(s.id) === id) && integer(stars, 0, 3))
  requireValid(save.codes.every(code => typeof code === 'string'))
  for (const id of Object.keys(save.gacha.pools)) requireValid(POOLS.some(p => p.id === id) && integer(save.gacha.pools[id]?.totalPulls))
  for (const draw of save.gacha.history) requireValid(record(draw) && HERO_INDEX.has(draw.heroId))
  requireValid((BATTLE.SPEED_OPTIONS as readonly number[]).includes(save.settings.speed) && typeof save.settings.sfx === 'boolean' && typeof save.settings.skipAnim === 'boolean')
  // 控制字段不信任导入值：不补历史离线收益、不继承可预测序列或周期领取资格。
  // ⚠ 挂机改版 v11：四条通道的随机序列也**重新派生**（导入的档不能决定随机序列）。
  const importedSeed = seed()
  save.rng = { seed: importedSeed, counter: 0, channels: createChannelRng(importedSeed) }
  // ⚠ **挂机改版 v11 / 遗物副本 v12**：导入只接受当前版本，且导入后的挂机账本**按新建的方式重置**——
  //   四条通道的计量水位 = 导入时刻，有效预算 / 离线累计 / 待报告时长全部清零。
  //   副本通关记录与副本挂机目标一并清空（导入进度不是可信的通关凭证）。
  for (const kind of IDLE_CHANNEL_KINDS) {
    const ch = save.idle.channels[kind]
    ch.measuredAt = now
    ch.effectiveMs = 0
    ch.offlineElapsedMs = 0
    ch.pendingOfflineMs = 0
    if (kind === 'main') ch.target = { kind: 'main', stageId: null }
    else ch.target = null
  }
  save.idle.activeUntil = now
  save.dungeons.cleared = {}
  // ⚠ **遗物副本 v12**：保底计数与每日额度**不继承**导入值
  //   （与副本通关记录同理：导入的进度不是可信的凭证）。
  //   继承 `pity: 999` 会让保底形同虚设；继承 `daily.count` 会白扣玩家额度。
  save.relicPity = {}
  save.relicDaily = { date: '', count: 0 }
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
  save.arena.weeklyMaterials = 0
  save.arena.defenseLoadout = null
  save.arena.snapshotHash = null
  // 天梯：周结算标记与编队**不继承**导入值。
  //
  // ⚠ 继承了「本周已结算」的话，导入后一整周都打不了天梯（每周只有一轮）；
  //   编队里也可能有玩家已经不再拥有的英灵 → 一挑战就报错。
  //   段位分与赛季称号保留（那是玩家真打出来的进度）。
  save.arena.ladder.lastSettledWeek = null
  save.arena.ladder.seasonPoints = 0
  save.arena.ladder.season = 1
  save.arena.ladder.seasonStartWeek = arenaWeekIndex(now)
  save.arena.ladder.squads = emptyLadderSquads()
  save.arena.ladder.lastActiveAt = now
  save.arena.ladder.lastReturnAt = 0
  save.arena.ladder.returnPending = false
  save.arena.ladder.returnDays = 0
  // ⚠ **实施修正（资源/背包版本 v10）**：导入档**不拿**首通结晶的一次性补发
  //   （实现文档 §2「客户端导入数据不能作为历史补偿凭证」），
  //   所以把「已发放首通结晶的关卡数」直接对齐到导入的高水位——
  //   否则下一次结算会把导入进度当成「本次首通」再发一遍（凭空几千万结晶）。
  save.campaign.creditedStages = save.campaign.clearedStage
  return save
}
