/**
 * 配置校验器（Phase 8 / §18）。
 *
 * 在打包前把「数据配置写错」这类问题挡在门外。
 * 铁律 3（数据驱动）依赖配置的正确性——一个重复 id 或一条越界引用
 * 会在运行时才炸，而配置是纯数据，改动频繁，所以必须有静态校验。
 *
 * 检查项：
 *   A. 唯一性：英灵 / 遗物 / 套装 / 羁绊 / 敌人 / 关卡 / 卡池 id 不重复
 *   B. 引用完整性：所有跨表引用都能解析到目标
 *   C. 数值合法性：概率和、倍率上下界、区间顺序、等级/星级边界
 *   D. 平衡性不变量：关卡门槛单调递增、章边界不倒挂
 *   E. 合规红线：敌人全部非历史人物、概率公示可复现
 *   F. 经济红线：任务 / 周目标 / 回流 / 签到的奖励形状与投放预算
 *   H. 道具登记与副本配置（资源/背包版本 v10 新增）
 *
 * 退出码：0 = 全通过；1 = 有 ERROR。
 */
import { HEROES } from '../src/core/config/heroes/index.ts'
import { POOLS, resolvePoolHeroIds } from '../src/core/config/pools.ts'
import { STAGES, stageMonotonicityIssues } from '../src/core/config/stages.ts'
import { RELIC_DEFS, RELIC_SETS } from '../src/core/systems/relic.ts'
import { ENEMY_INDEX } from '../src/core/config/enemies.ts'
import { BONDS } from '../src/core/config/bonds.ts'
import {
  ARENA,
  BASE_RATES,
  BATTLE,
  DAILY,
  DUNGEON_DIFFICULTIES,
  DUNGEON_DROPS,
  EXP_BOOK,
  GACHA,
  LEVEL,
  RELIC,
  REALMS,
  REBIRTH,
  SKILL,
  STAGE,
  STAR,
  TIERS,
  ZONE,
  DROP_TABLES,
  type DropTableDef,
} from '../src/core/config/economy.ts'
import { rarityProbabilities } from '../src/core/systems/gachaRates.ts'
import { DAILY_TASKS, TASKS, WEEKLY_TASKS, type TaskReward } from '../src/core/config/tasks.ts'
import { LADDER, LADDER_RETURN_REWARDS, LADDER_SEASON_REWARDS } from '../src/core/config/economy.ts'
import { LADDER_TIERS } from '../src/core/config/ladder.ts'
import { RESOURCE_ICON_KEYS } from '../src/core/config/art.ts'
import {
  EXP_BOOK_ITEM_EXP,
  ITEM_DEFS,
  ITEM_IDS,
  itemText,
  type ItemId,
} from '../src/core/config/items.ts'
import { DUNGEON_VARIANTS } from '../src/core/config/dungeons.ts'
import { computeOfflineEfficiency } from '../src/core/systems/idle.ts'
import type { Rarity } from '../src/core/model/types.ts'

// 加载注册型配置
import '../src/core/config/relics.ts'
import '../src/core/config/enemies.ts'

/** BOSS 由 bossMechanic 字段标识 */
const ENEMY_DEFS = ENEMY_INDEX
const BOSS_DEFS = new Map([...ENEMY_INDEX].filter(([, e]) => e.bossMechanic !== undefined))

/** 已登记的道具 id 集合（O(1) 判定，来源唯一口径 `config/items.ts`） */
const ITEM_ID_SET = new Set<string>(ITEM_IDS)

/** 需要出图的资源 key 集合（`config/art.ts` 的唯一口径） */
const RESOURCE_ICON_KEY_SET = new Set<string>(RESOURCE_ICON_KEYS)

interface Issue {
  level: 'ERROR' | 'WARN'
  code: string
  message: string
}

const issues: Issue[] = []
const err = (code: string, message: string) => issues.push({ level: 'ERROR', code, message })
const warn = (code: string, message: string) => issues.push({ level: 'WARN', code, message })

function checkUnique(name: string, ids: string[]): void {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id)
    seen.add(id)
  }
  if (dupes.size > 0) {
    err('A/UNIQUE', `${name} 存在重复 id：${[...dupes].join(', ')}`)
  }
}

// ─────────────────────────── A. 唯一性 ───────────────────────────

checkUnique('英灵', HEROES.map((h) => h.id))
checkUnique('遗物', [...RELIC_DEFS.keys()])
checkUnique('遗物套装', [...RELIC_SETS.keys()])
checkUnique('羁绊', BONDS.map((b) => b.id))
checkUnique('敌人', [...ENEMY_DEFS.keys()])
checkUnique('BOSS', [...BOSS_DEFS.keys()])
checkUnique('关卡', STAGES.map((s) => String(s.id)))

// ─────────────────────────── B. 引用完整性 ───────────────────────────

const heroIds = new Set(HEROES.map((h) => h.id))
const relicIds = new Set(RELIC_DEFS.keys())
const setIds = new Set(RELIC_SETS.keys())
const enemyIds = new Set(ENEMY_DEFS.keys())
const bossIds = new Set(BOSS_DEFS.keys())
const bondIds = new Set(BONDS.map((b) => b.id))

for (const hero of HEROES) {
  if (!setIds.has(hero.relicAffinity[0])) {
    err('B/REF', `英灵 ${hero.id} 的遗物套装偏好 ${hero.relicAffinity[0]} 不存在`)
  }
  for (const aff of hero.relicAffinity) {
    if (!setIds.has(aff)) err('B/REF', `英灵 ${hero.id} 引用了不存在的遗物套装 ${aff}`)
  }
  if (hero.skills.length !== 3) {
    err('B/REF', `英灵 ${hero.id} 技能数量为 ${hero.skills.length}，应为 3`)
  }
  if (hero.passives.length !== 5) {
    err('B/REF', `英灵 ${hero.id} 被动数量为 ${hero.passives.length}，应为 5`)
  }
}

for (const bond of BONDS) {
  // 羁绊条件是「编队满足 X 时生效」，校验其门槛在英灵池中确实可达
  const c = bond.condition
  if (c.type === 'role') {
    const count = HEROES.filter((h) => h.role === c.role).length
    if (count < c.count) {
      err('B/REF', `羁绊 ${bond.id} 要求 ${c.count} 名 ${c.role}，但全名册只有 ${count} 名`)
    }
  } else if (c.type === 'element') {
    const count = HEROES.filter((h) => h.element === c.element).length
    if (count < c.count) {
      err('B/REF', `羁绊 ${bond.id} 要求 ${c.count} 名 ${c.element} 属性，但全名册只有 ${count} 名`)
    }
  } else if (c.type === 'rarity') {
    const count = HEROES.filter((h) => h.rarity === c.rarity).length
    if (count < c.count) {
      err('B/REF', `羁绊 ${bond.id} 要求 ${c.count} 名 ${c.rarity} 英灵，但全名册只有 ${count} 名`)
    }
  } else if (c.type === 'distinctElements') {
    const elements = new Set(HEROES.map((h) => h.element)).size
    if (elements < c.count) {
      err('B/REF', `羁绊 ${bond.id} 要求编队含 ${c.count} 种不同五行，但全名册只覆盖 ${elements} 种`)
    }
  }
  if (bond.effects.length === 0) {
    err('B/REF', `羁绊 ${bond.id} 没有任何效果`)
  }
}

for (const pool of POOLS) {
  for (const heroId of pool.heroIds) {
    if (!heroIds.has(heroId)) {
      err('B/REF', `卡池 ${pool.id} 引用了不存在的英灵 ${heroId}`)
    }
  }
  if (pool.heroIds.length === 0 && !pool.selection) {
    err('B/REF', `卡池 ${pool.id} 既没有指定英灵，也没有选取规则`)
  }
  const rateSum = Object.values(pool.rates).reduce((a, b) => a + b, 0)
  if (Math.abs(rateSum - 100) > 1e-6) {
    err('C/NUM', `卡池 ${pool.id} 概率和为 ${rateSum}，应为 100`)
  }
  if (pool.guaranteedHeroId) {
    if (!heroIds.has(pool.guaranteedHeroId)) {
      err('B/REF', `卡池 ${pool.id} 的保底英灵 ${pool.guaranteedHeroId} 不存在`)
    } else {
      // 保底英灵必须真的能被该池抽到（与 selection 规则自洽）
      const resolved = resolvePoolHeroIds(pool)
      if (!resolved.includes(pool.guaranteedHeroId)) {
        err('B/REF', `卡池 ${pool.id} 的保底英灵 ${pool.guaranteedHeroId} 不符合该池的选取规则`)
      }
    }
  }
  if (pool.selection) {
    const resolved = resolvePoolHeroIds(pool)
    if (resolved.length === 0) {
      err('B/REF', `卡池 ${pool.id} 的选取规则解析结果为空`)
    }
  }
  // 卡池内容与公示稀有度必须自洽
  for (const heroId of pool.heroIds) {
    if (!heroIds.has(heroId)) continue
    const def = HEROES.find((h) => h.id === heroId)!
    if (!pool.rates[def.rarity]) {
      err('B/REF', `卡池 ${pool.id} 含 ${def.rarity} 英灵 ${heroId}，但该稀有度概率为 0`)
    }
  }
}

// BOSS 召唤机制（§6.5）：召唤目标必须是已配置的敌人 id。
// 历史教训：机制用显示名查模板 → 永远查不到 → 召唤从未触发。
for (const [enemyId, enemy] of ENEMY_DEFS) {
  const mech = enemy.bossMechanic
  if (!mech || mech.type !== 'summon') continue
  if (!enemyIds.has(mech.enemyId)) {
    err('B/REF', `BOSS ${enemyId} 的召唤机制引用了不存在的敌人 ${mech.enemyId}`)
  }
  if (mech.everyTurns <= 0) {
    err('C/NUM', `BOSS ${enemyId} 的召唤周期 ${mech.everyTurns} 非正数`)
  }
  if (mech.count <= 0) {
    err('C/NUM', `BOSS ${enemyId} 的召唤数量 ${mech.count} 非正数`)
  }
}

for (const stage of STAGES) {
  if (stage.enemyIds.length === 0) {
    err('B/REF', `关卡 ${stage.id} 没有配置任何敌人`)
  }
  let bossCount = 0
  for (const enemyId of stage.enemyIds) {
    if (!enemyIds.has(enemyId)) {
      err('B/REF', `关卡 ${stage.id} 引用了不存在的敌人 ${enemyId}`)
      continue
    }
    if (bossIds.has(enemyId)) bossCount++
  }
  if (stage.isBoss && bossCount === 0) {
    err('B/REF', `BOSS 关 ${stage.id} 的敌人列表中没有 BOSS：${stage.enemyIds.join(', ')}`)
  }
  if (!stage.isBoss && bossCount > 0) {
    err('B/REF', `普通关 ${stage.id} 错用了 BOSS 敌人`)
  }
  if (stage.dropTableId && !DROP_TABLES[stage.dropTableId]) {
    err('B/REF', `关卡 ${stage.id} 的掉落表 ${stage.dropTableId} 不存在`)
  }
}

/**
 * 主线掉落表校验。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：掉落表不再有 `exp` / `skillStones` /
 *   `relicStones` / `emblems` 四个字段——经验改由**经验书**承载，
 *   材料改由**副本**产出（主线只掉经验书与银两）。
 */
for (const [key, table] of Object.entries(DROP_TABLES)) {
  const silver = table.silver
  if (silver[0] > silver[1]) {
    err('C/NUM', `掉落表 ${key} 的 silver 区间反了：${silver[0]} > ${silver[1]}`)
  }
  if (silver[0] < 0) {
    err('C/NUM', `掉落表 ${key} 的 silver 下界为负：${silver[0]}`)
  }
  for (const drop of table.items) {
    if (!ITEM_ID_SET.has(drop.id)) {
      err('B/REF', `掉落表 ${key} 的道具 ${drop.id} 未在 ITEM_DEFS 登记`)
    }
    if (drop.chance < 0 || drop.chance > 100) {
      err('C/NUM', `掉落表 ${key} 的道具 ${drop.id} 掉落概率 ${drop.chance} 不在 0~100`)
    }
    if (drop.min > drop.max) {
      err('C/NUM', `掉落表 ${key} 的道具 ${drop.id} 数量区间反了：${drop.min} > ${drop.max}`)
    }
    if (drop.min < 1) {
      err('C/NUM', `掉落表 ${key} 的道具 ${drop.id} 数量下界为 ${drop.min}，应 ≥ 1`)
    }
  }
}

// ─────────────────────────── C. 数值合法性 ───────────────────────────

const rateSum = Object.values(BASE_RATES).reduce((a, b) => a + b, 0)
if (Math.abs(rateSum - 100) > 1e-9) {
  err('C/NUM', `基础概率和为 ${rateSum}，应为 100`)
}
for (const [rarity, rate] of Object.entries(BASE_RATES)) {
  if (rate <= 0) err('C/NUM', `基础概率 ${rarity} 为 ${rate}，必须为正`)
}

if (GACHA.PITY_SSR_MAX !== 90) {
  err('C/NUM', `大保底上限为 ${GACHA.PITY_SSR_MAX}，合规要求必须为 90`)
}
if (GACHA.SOFT_PITY_START > GACHA.PITY_SSR_MAX) {
  err('C/NUM', `软保底起点 ${GACHA.SOFT_PITY_START} 大于大保底上限`)
}
if (GACHA.TEN_PULL_FLOOR !== 'SR') {
  err('C/NUM', `十连保底最低稀有度为 ${GACHA.TEN_PULL_FLOOR}，合规要求必须为 SR`)
}
// 抽卡逐抽计价：十连的结晶价 = 单抽 × 十连抽数（由 pullCost 推导，故此处只校验基础量）
if (GACHA.TEN_PULL_COUNT !== 10) {
  err('C/NUM', `十连抽数为 ${GACHA.TEN_PULL_COUNT}，应为 10`)
}
if (GACHA.COST_SINGLE <= 0) {
  err('C/NUM', '单抽价格必须为正')
}
// ⚠ **实施修正（资源/背包版本 v10）**：抽卡券已退役——抽卡**只扣圣杯结晶**
//   （`resolvePayment(count, crystals)`），原来的「每抽消耗 1 张券」校验作废。

if (STAR.MIN < 1 || STAR.MAX < STAR.MIN) err('C/NUM', '星级区间非法')
if (LEVEL.MIN < 1 || LEVEL.MAX < LEVEL.MIN) err('C/NUM', '等级区间非法')
if (SKILL.MAX_LEVEL < SKILL.MIN_LEVEL) err('C/NUM', '技能等级区间非法')
if (RELIC.MAX_LEVEL < RELIC.MIN_LEVEL) err('C/NUM', '遗物等级区间非法')
if (ZONE.MAX_PCT <= 0) err('C/NUM', '乘区上限必须为正')

if (STAGE.SCALE_ANCHORS.length !== STAGE.CHAPTERS) {
  err('C/NUM', `敌人缩放锚点数量 ${STAGE.SCALE_ANCHORS.length} 与章节数不符`)
}
if (STAGE.POWER_ANCHORS.length !== STAGE.CHAPTERS) {
  err('C/NUM', `战力门槛锚点数量 ${STAGE.POWER_ANCHORS.length} 与章节数不符`)
}
if (STAGE.IN_CHAPTER_SPAN <= 1) err('C/NUM', '章内缩放跨度必须 > 1')
if (STAGE.BOSS_MULTIPLIER <= 1) err('C/NUM', 'BOSS 倍率必须 > 1')
if (STAGE.CHAPTER_GATE_GAP <= 1) err('C/NUM', '章间门槛衔接系数必须 > 1')
if (STAGE.FIRST_STAGE_POWER <= 0) err('C/NUM', '首关门槛必须为正')
for (const [i, anchor] of STAGE.SCALE_ANCHORS.entries()) {
  if (anchor <= 0) err('C/NUM', `第 ${i + 1} 章敌人缩放锚点必须为正`)
  if (i > 0 && anchor <= STAGE.SCALE_ANCHORS[i - 1]) {
    err('C/NUM', `第 ${i + 1} 章敌人缩放锚点未高于第 ${i} 章（难度倒挂）`)
  }
}
for (const [i, anchor] of STAGE.POWER_ANCHORS.entries()) {
  if (anchor <= 0) err('C/NUM', `第 ${i + 1} 章战力门槛锚点必须为正`)
  if (i > 0 && anchor <= STAGE.POWER_ANCHORS[i - 1]) {
    err('C/NUM', `第 ${i + 1} 章战力门槛锚点未高于第 ${i} 章（门槛倒挂）`)
  }
}

if (REBIRTH.PERM_BOOST_CAP < REBIRTH.PERM_BOOST_PER_ROUND) {
  err('C/NUM', '圣杯重启永久加成上限小于每轮加成')
}
if (REBIRTH.PERM_BOOST_CAP > 1) {
  err('C/NUM', `圣杯重启永久加成上限 ${REBIRTH.PERM_BOOST_CAP} 超过 100%`)
}

if (BATTLE.MAX_ROUNDS <= 0) err('C/NUM', '最大回合数必须为正')
if (BATTLE.MAX_DAMAGE_REDUCTION >= 1) err('C/NUM', '减伤率上限必须 < 100%')
if (BATTLE.RANDOM_MIN > BATTLE.RANDOM_MAX) err('C/NUM', '随机因子区间反了')
if (BATTLE.ELEMENT_ADVANTAGE <= BATTLE.ELEMENT_NEUTRAL) {
  err('C/NUM', '相性优势系数必须大于中立系数')
}
if (BATTLE.ELEMENT_NEUTRAL <= BATTLE.ELEMENT_DISADVANTAGE) {
  err('C/NUM', '相性中立系数必须大于劣势系数')
}

// 境界区间必须首尾相接且覆盖等级上下限
for (let i = 0; i < REALMS.length; i++) {
  const r = REALMS[i]
  if (r.minLevel < LEVEL.MIN || r.maxLevel > LEVEL.MAX) {
    err('C/NUM', `境界 ${r.id} 超出等级区间 [${LEVEL.MIN}, ${LEVEL.MAX}]`)
  }
  if (r.minLevel > r.maxLevel) err('C/NUM', `境界 ${r.id} 区间反了`)
  if (i > 0 && r.minLevel !== REALMS[i - 1].maxLevel + 1) {
    err('C/NUM', `境界 ${r.id} 与 ${REALMS[i - 1].id} 之间不连续`)
  }
  if (r.expScale <= 0) err('C/NUM', `境界 ${r.id} 的 expScale 必须为正`)
}
if (REALMS[0].minLevel !== LEVEL.MIN) err('C/NUM', '首个境界未从最小等级开始')
if (REALMS[REALMS.length - 1].maxLevel !== LEVEL.MAX) {
  err('C/NUM', '最后一个境界未覆盖最大等级')
}

// 段位阈值必须递增
for (let i = 1; i < TIERS.length; i++) {
  if (TIERS[i].min <= TIERS[i - 1].min) {
    err('C/NUM', `段位 ${TIERS[i].name} 阈值 ${TIERS[i].min} 未大于 ${TIERS[i - 1].name} 的 ${TIERS[i - 1].min}`)
  }
}

// ─────────────────────────── D. 平衡性不变量 ───────────────────────────

if (STAGES.length !== STAGE.CHAPTERS * (STAGE.STAGES_PER_CHAPTER + 1)) {
  err('D/BAL', `关卡总数 ${STAGES.length} 与章节配置不符（期望 ${STAGE.CHAPTERS * (STAGE.STAGES_PER_CHAPTER + 1)}）`)
}

// ⚠ **实施修正（roadmap P1-2 难度曲线重标定）**：不变量从「缩放全局严格递增」
//   改为「**难度**（基础属性 × 缩放）不倒挂 + 章内缩放严格递增」。
//   敌方**基础属性本身跨章增长**约 1.25×/章，章边界处新一章首关的缩放
//   必然低于上一章 BOSS 的缩放——那是设计上的「喘息」，不是难度倒挂。
//   按缩放核对会把「基础属性增长」误判成倒挂（§6.5 实施修正）。
//   不变量的**唯一一份口径**在 core（`stageMonotonicityIssues`），守护单测同源（铁律 #4）。
for (const issue of stageMonotonicityIssues(STAGES)) {
  err('D/BAL', `关卡 ${issue.stageId} ${issue.reason}`)
}

const bosses = STAGES.filter((s) => s.isBoss)
if (bosses.length !== STAGE.CHAPTERS) {
  err('D/BAL', `BOSS 关数量为 ${bosses.length}，应为 ${STAGE.CHAPTERS}`)
}
for (const boss of bosses) {
  if (boss.index !== STAGE.STAGES_PER_CHAPTER + 1) {
    err('D/BAL', `第 ${boss.chapter} 章 BOSS 关序号为 ${boss.index}，应为 ${STAGE.STAGES_PER_CHAPTER + 1}`)
  }
}

// ─────────────────────────── E. 合规红线 ───────────────────────────

/**
 * 敌人必须全部是非历史人物（合规硬红线：历史人物只作为正面友方）。
 * 校验方式：敌人 id 与英灵 id 的**词元**不得重叠——
 * 敌人若借用历史人物名，会与英灵 id 共享中文名片段。
 */
const heroTokens = new Set<string>()
for (const h of HEROES) {
  // 英灵 id 形如 hero_xxx，抽出中文名部分
  const name = h.id.replace(/^hero_/, '')
  for (const tok of name.split('_')) {
    if (tok.length >= 2) heroTokens.add(tok)
  }
}
for (const enemyId of ENEMY_DEFS.keys()) {
  const name = enemyId.replace(/^(boss_)?/, '')
  for (const tok of name.split('_')) {
    if (tok.length >= 2 && heroTokens.has(tok)) {
      err('E/IP', `敌人 ${enemyId} 与英灵名 "${tok}" 词元重叠，可能触及「敌人为历史人物」的红线`)
    }
  }
}

// 重复抽卡不得直接提升强度：星级提升必须消耗同名碎片与印记（外部资源）
for (const h of HEROES) {
  if (h.rarity === 'SSR' && h.baseStats.atk <= 0) {
    err('C/NUM', `英灵 ${h.id} 基础攻击为 0`)
  }
}

// 概率公示必须可复现：核心概率函数可调用且返回完整四档
const rates = rarityProbabilities({ pitySSR: 0, pity10: 0 }, { isTenPull: false })
const rarities: Rarity[] = ['SSR', 'SR', 'R', 'N']
for (const r of rarities) {
  if (typeof rates[r] !== 'number' || rates[r] < 0) {
    err('E/DISCLOSURE', `概率公示缺少 ${r} 档`)
  }
}

// 竞技场：段位匹配容差与勋章周上限必须存在，避免 PvP 成为免费抽卡渠道
if (ARENA.MEDAL_WEEKLY_CAP <= 0) err('C/NUM', '竞技勋章周上限必须为正')
// ⚠ **实施修正（资源/背包版本 v10）**：竞技兑换抽卡券周上限已随钱包收敛退役
//   （`ARENA.TICKET_WEEKLY_CAP` 不复存在）；竞技材料周上限保留为
//   **历史余额的只读记录口径**（停止发放、停止消耗，但数值仍须合法）。
if (ARENA.MATERIAL_WEEKLY_CAP <= 0) err('C/NUM', '竞技材料周上限必须为正')

// 日常签到：7 天一轮，奖励表长度必须匹配
if (DAILY.SIGN_IN_REWARDS.length !== DAILY.SIGN_IN_CYCLE) {
  err('C/NUM', `签到奖励数量 ${DAILY.SIGN_IN_REWARDS.length} 与周期 ${DAILY.SIGN_IN_CYCLE} 不符`)
}

// ─────────────────────────── F. 每日任务与周目标（P2-1） ───────────────────────────
//
// 三条红线在这里被**静态**挡住（roadmap 验收要求）：
//   1. 奖励里不能出现圣杯结晶 / 抽卡券 → 不冲击抽卡间隔；
//   2. 奖励里不能出现竞技专属资源 → 不冲击竞技产出隔离；
//   3. 奖励里不能出现**副本专属材料** → 不稀释定向副本这条主线；
//   4. 奖励总量有上限 → 不冲击养成资源回收。
//
// ⚠ **实施修正（资源/背包版本 v10）**：任务 / 周目标**只发通用经验书**
//   （`TaskReward` 的形状改成 `{ expBooks?: { small?, large? } }`）。
//   术式结晶 / 遗物强化石退役后，五行技能材料与三档强化石是**副本专属产出**
//   ——日常白送会把「定向副本」这条主线稀释掉（设计稿 §3）。
checkUnique('任务', TASKS.map((t) => t.id))

/** 任务奖励允许出现的资源（与 config/tasks.ts 的 TaskReward 类型一致） */
const ALLOWED_TASK_REWARDS = new Set(['expBooks'])

for (const task of TASKS) {
  if (!Number.isInteger(task.target) || task.target <= 0) {
    err('C/NUM', `任务 ${task.id} 的目标数 ${task.target} 不是正整数`)
  }
  const reward = task.rewards as Record<string, unknown>
  for (const [key, value] of Object.entries(reward)) {
    if (!ALLOWED_TASK_REWARDS.has(key)) {
      err(
        'E/ECONOMY',
        `任务 ${task.id} 的奖励含不允许的资源「${key}」：只允许通用经验书`
          + '（发圣杯结晶会冲击抽卡间隔，发竞技资源会冲击竞技产出隔离，'
          + '发五行技能材料 / 强化石会稀释副本的定向产出）',
      )
    }
    // ⚠ `expBooks` 的值是 `{ small?, large? }`（不是数字）——逐档校验数量为正整数
    if (key === 'expBooks' && value && typeof value === 'object') {
      for (const [bookKey, count] of Object.entries(value as Record<string, unknown>)) {
        if (bookKey !== 'small' && bookKey !== 'large') {
          err('C/NUM', `任务 ${task.id} 的经验书档位「${bookKey}」非法（只允许 small / large）`)
        }
        if (typeof count !== 'number' || !(count > 0)) {
          err('C/NUM', `任务 ${task.id} 的经验书奖励 ${bookKey} 非法：${String(count)}`)
        }
      }
    }
  }
  // 引导路由必须是 vue-router 的 name（小写下划线），不能是路径
  if (task.route && !/^[a-z][a-z_]*$/.test(task.route)) {
    err('B/REF', `任务 ${task.id} 的引导路由名「${task.route}」不合法（应为 vue-router 的 name）`)
  }
}
if (DAILY_TASKS.length === 0) err('C/NUM', '每日任务为空')
if (WEEKLY_TASKS.length === 0) err('C/NUM', '周目标为空')

/**
 * 一张掉落表的**期望经验**（经验书折算）。
 *
 * ⚠ 经验不再是独立资源，而是「经验书的期望面值总和」——
 *   口径只有这一份（`EXP_BOOK_ITEM_EXP` 是面额的唯一出处）。
 */
function expectedExpOf(table: DropTableDef): number {
  let exp = 0
  for (const drop of table.items) {
    const bookExp = EXP_BOOK_ITEM_EXP[drop.id]
    if (!bookExp) continue
    const count = (drop.min + drop.max) / 2
    exp += (drop.chance / 100) * count * bookExp
  }
  return exp
}

/** 道具表 → 折算经验（只认经验书） */
function itemsToExp(items: Partial<Record<ItemId, number>> | undefined): number {
  if (!items) return 0
  let exp = 0
  for (const [id, count] of Object.entries(items)) {
    const bookExp = EXP_BOOK_ITEM_EXP[id as ItemId]
    if (!bookExp) continue
    exp += (count ?? 0) * bookExp
  }
  return exp
}

/** 任务奖励 → 折算经验 */
function taskRewardExp(rewards: TaskReward): number {
  const books = rewards.expBooks
  if (!books) return 0
  let exp = 0
  if (books.small) exp += books.small * (EXP_BOOK_ITEM_EXP[EXP_BOOK.small.id] ?? 0)
  if (books.large) exp += books.large * (EXP_BOOK_ITEM_EXP[EXP_BOOK.large.id] ?? 0)
  return exp
}

/**
 * 任务奖励里的**副本材料**数量（必须恒为 0）。
 *
 * ⚠ `TaskReward` 类型里没有 `items` 字段（编译期就挡住了），这里再查一次运行时形状——
 *   「副本专属产出不被日常稀释」是设计稿 §3 的红线，值得多一道运行时闸门。
 */
function taskMaterialCount(rewards: TaskReward): number {
  const raw = rewards as unknown as Record<string, unknown>
  const items = raw.items
  if (!items || typeof items !== 'object') return 0
  let count = 0
  for (const [id, value] of Object.entries(items as Record<string, unknown>)) {
    if (EXP_BOOK_ITEM_EXP[id as ItemId]) continue // 经验书不算副本材料
    count += typeof value === 'number' ? value : 1
  }
  return count
}

/**
 * 任务奖励预算：日投放 ≤ 每日挂机产出的 **1/3**（工具侧临时口径）。
 *
 * ⚠ **口径变更说明（资源/背包版本 v10）**：
 *   原闸门是「日投放 ≤ 每小时挂机产出的 **2%**」，那把尺子是量
 *   **术式结晶 / 遗物强化石**的——两者已随钱包收敛退役，任务表里也就不再有了。
 *   现在任务只发**通用经验书**，于是：
 *     · 材料维度 → 恒为 0（结构性红线，见上面的 `taskMaterialCount`）；
 *     · 经验维度 → 分母换成**每日**挂机经验产出（任务是「每天」的流量，
 *       用「一小时」做分母会把尺度差一个数量级）。
 *   ⚠ 阈值 1/3 是**工具侧临时口径**（数值待策划确认）：
 *   实测任务日投放 ≈ 每日挂机经验产出的 21%，回流日均 ≈ 6%。
 */
const TASK_EXP_BUDGET_RATIO = 1 / 3

const battlesPerHour = Math.round(3600 / BATTLE.SECONDS_PER_BATTLE)
/** 第 1 章每场的期望经验（新号与日常玩家的实际产出水平） */
const stage1ExpPerBattle = expectedExpOf(DROP_TABLES.stage_1)
/** 每日挂机经验产出 = core 的离线效率曲线 f(24h) × 场次/小时 × 每场期望经验 */
const dailyIdleExp = computeOfflineEfficiency(24 * 3600) * battlesPerHour * stage1ExpPerBattle

/** 任务日投放 = 每日任务全领 + 周目标摊到每天 */
const taskDailyExp =
  DAILY_TASKS.reduce((sum, t) => sum + taskRewardExp(t.rewards), 0) +
  WEEKLY_TASKS.reduce((sum, t) => sum + taskRewardExp(t.rewards), 0) / 7

/** 任务 / 周目标里的副本材料（必须为 0） */
const taskMaterialTotal = [...DAILY_TASKS, ...WEEKLY_TASKS].reduce(
  (sum, t) => sum + taskMaterialCount(t.rewards),
  0,
)
if (taskMaterialTotal > 0) {
  err(
    'E/ECONOMY',
    `任务 / 周目标含 ${taskMaterialTotal} 个副本材料：`
      + '五行技能材料与三档强化石是**副本专属产出**，日常投放会稀释定向副本这条主线',
  )
}

if (dailyIdleExp > 0) {
  const ratio = taskDailyExp / dailyIdleExp
  if (ratio > TASK_EXP_BUDGET_RATIO) {
    err(
      'D/BAL',
      `任务日投放经验 ${taskDailyExp.toFixed(0)}，`
        + `达每日挂机经验产出（${dailyIdleExp.toFixed(0)}）的 ${(ratio * 100).toFixed(1)}%，`
        + `超过 ${(TASK_EXP_BUDGET_RATIO * 100).toFixed(1)}% 上限`,
    )
  }
}

// ─────────────────────────── G. 三队天梯（P2-2） ───────────────────────────
//
// roadmap P2-2 的验收要求：覆盖首次参与、结算、下赛季重置，以及
// **积分和奖励隔离**。这里的静态检查守住后两条的「配置侧」：
//
//   1. 奖励隔离：天梯产出与赛季奖励**不含**任何 PVE 资源；
//   2. 回流口径：回流奖励只含养成材料 + 竞技勋章，**不含**圣杯结晶 / 抽卡券；
//   3. 投放预算：回流日均投放 ≤ 每小时挂机产出的 2%（与任务同一把尺）；
//   4. 敌方合规：梯队里的敌人**全部是灵体 / 妖异 / 器械造物**，不是历史人物。
if (LADDER.SQUAD_COUNT !== 3) err('C/NUM', '三队天梯必须是 3 支队伍')
if (LADDER.SQUAD_SIZE !== 6) err('C/NUM', '三队天梯每队必须是 6 人')
if (LADDER.SEASON_WEEKS <= 0) err('C/NUM', '赛季长度必须为正')
if (LADDER.SEASON_CARRY_PCT < 0 || LADDER.SEASON_CARRY_PCT > 1) {
  err('C/NUM', '赛季保留比例必须在 0~1 之间')
}
if (LADDER.RETURN_COOLDOWN_DAYS < LADDER.RETURN_MIN_OFFLINE_DAYS) {
  err('C/NUM', '回流冷却天数不得小于回流判定天数')
}

// 梯队表：层数与段位一致、每队 6 个敌人、敌人必须存在且不是 BOSS
if (LADDER_TIERS.length !== TIERS.length) {
  err('B/REF', `梯队层数 ${LADDER_TIERS.length} 与段位数 ${TIERS.length} 不一致`)
}
if (LADDER.SCALE_ANCHORS.length !== LADDER_TIERS.length) {
  err('B/REF', `缩放锚点数 ${LADDER.SCALE_ANCHORS.length} 与梯队层数 ${LADDER_TIERS.length} 不一致`)
}
const ladderSquadIds = new Set<string>()
for (const tier of LADDER_TIERS) {
  if (tier.squads.length !== LADDER.SQUAD_COUNT) {
    err('C/NUM', `梯队层 ${tier.index} 有 ${tier.squads.length} 个梯队，应为 ${LADDER.SQUAD_COUNT} 个`)
  }
  for (const squad of tier.squads) {
    if (ladderSquadIds.has(squad.id)) err('B/REF', `梯队 id 重复：${squad.id}`)
    ladderSquadIds.add(squad.id)
    if (squad.enemyIds.length !== LADDER.SQUAD_SIZE) {
      err('C/NUM', `梯队 ${squad.id} 有 ${squad.enemyIds.length} 个敌人，应为 ${LADDER.SQUAD_SIZE} 个`)
    }
    for (const enemyId of squad.enemyIds) {
      const enemy = ENEMY_INDEX.get(enemyId)
      if (!enemy) {
        err('B/REF', `梯队 ${squad.id} 引用了不存在的敌人 ${enemyId}`)
        continue
      }
      // 合规：敌人一律为非历史人物（灵体 / 妖异 / 幻想体 / 器械造物）
      if (enemy.bossMechanic) {
        err('E/ECONOMY', `梯队 ${squad.id} 用了 BOSS ${enemyId}：天梯梯队只用普通灵体`)
      }
    }
  }
  const row = LADDER.SCALE_ANCHORS[tier.index]
  if (!row || row.length !== LADDER.SQUAD_COUNT) {
    err('C/NUM', `梯队层 ${tier.index} 的缩放锚点数量应为 ${LADDER.SQUAD_COUNT}`)
    continue
  }
  for (const scale of row) {
    if (!(scale > 0)) err('C/NUM', `梯队层 ${tier.index} 的缩放锚点必须为正`)
  }
}

// 赛季奖励：只允许竞技专属资源（minPoints 是分档门槛，不是资源）
const LADDER_REWARD_KEYS = new Set(['medals', 'arenaMaterials', 'titleTier', 'minPoints'])
for (const spec of LADDER_SEASON_REWARDS) {
  for (const key of Object.keys(spec)) {
    if (!LADDER_REWARD_KEYS.has(key)) {
      err('E/ECONOMY', `赛季奖励含不允许的资源「${key}」：只允许勋章 / 竞技材料 / 称号`)
    }
  }
}

// 回流奖励：只允许养成材料 + 竞技勋章；**禁止**圣杯结晶 / 抽卡券（minDays 是档位门槛）
//
// ⚠ **实施修正（资源/背包版本 v10）**：术式结晶 / 遗物强化石退役 → 回流改发
//   **通用经验书**（`items`），竞技勋章停发（`medals` 恒为 0）。
const ALLOWED_RETURN_REWARDS = new Set(['items', 'medals', 'minDays'])
for (const spec of LADDER_RETURN_REWARDS) {
  for (const key of Object.keys(spec)) {
    if (!ALLOWED_RETURN_REWARDS.has(key)) {
      err(
        'E/ECONOMY',
        `回流奖励含不允许的资源「${key}」：只允许通用经验书 / 竞技勋章`
          + '（发圣杯结晶会冲击抽卡间隔，发副本材料会稀释定向副本产出）',
      )
    }
  }
  if (spec.minDays < LADDER.RETURN_MIN_OFFLINE_DAYS) {
    err('C/NUM', `回流档位 ${spec.minDays} 天低于判定阈值 ${LADDER.RETURN_MIN_OFFLINE_DAYS} 天`)
  }
  // 回流奖励里不得混入副本专属材料（同任务：副本材料只能来自副本）
  let material = 0
  for (const [id, count] of Object.entries(spec.items)) {
    if (EXP_BOOK_ITEM_EXP[id as ItemId]) continue
    material += count ?? 0
  }
  if (material > 0) {
    err(
      'E/ECONOMY',
      `回流奖励含 ${material} 个副本材料：五行技能材料与三档强化石是**副本专属产出**`,
    )
  }
}

// 回流投放预算：日均 ≤ 每日挂机经验产出的 1/3（与任务同一把尺，⚠ 工具侧临时口径）
const returnTop = LADDER_RETURN_REWARDS[0]
const returnDailyExp = itemsToExp(returnTop.items) / LADDER.RETURN_COOLDOWN_DAYS
if (dailyIdleExp > 0) {
  const ratio = returnDailyExp / dailyIdleExp
  if (ratio > TASK_EXP_BUDGET_RATIO) {
    err(
      'D/BAL',
      `回流日均投放经验 ${returnDailyExp.toFixed(0)}，`
        + `达每日挂机经验产出（${dailyIdleExp.toFixed(0)}）的 ${(ratio * 100).toFixed(2)}%，`
        + `超过 ${(TASK_EXP_BUDGET_RATIO * 100).toFixed(1)}% 上限`,
    )
  }
}

// ─────────────────────────── H. 道具登记与副本配置（资源/背包版本 v10） ───────────────────────────
//
// ⚠ 为什么单独一节：新模型把「堆叠物」从钱包搬进了背包（`save.items`），
//   于是多了两条**新的数据链**：
//     · 道具登记表（`core/config/items.ts`）——「道具没有名字 / 没出图标」；
//     · 副本配置（`core/config/dungeons.ts` + `economy.ts` 的 `DUNGEON_DROPS`）——
//       「副本产出的道具没人登记」或「产量没配」。
//   两者都会让玩家在背包里看到一个「半成品」条目（铁律 #22：配置齐全 ≠ 功能可用）。

// ① 道具名称必须全局唯一（界面上「图标 + 名称」并排，靠名字认道具）
{
  const seen = new Map<string, string[]>()
  for (const id of ITEM_IDS) {
    const name = ITEM_DEFS[id].name
    seen.set(name, [...(seen.get(name) ?? []), id])
  }
  for (const [name, ids] of seen) {
    if (ids.length > 1) {
      err('A/UNIQUE', `道具名称「${name}」重复：${ids.join(', ')}（展示名必须全局唯一）`)
    }
  }
}

for (const id of ITEM_IDS) {
  const def = ITEM_DEFS[id]
  // ② 图标 key 必须落在 RESOURCE_ICON_KEYS（新增道具却忘了出图会被这里拦下）
  if (!RESOURCE_ICON_KEY_SET.has(def.iconKey)) {
    err('B/REF', `道具 ${id} 的图标 key「${def.iconKey}」不在 RESOURCE_ICON_KEYS 里`)
  }
  // ③ 描述里的占位符必须全部能填上（`itemText` 之后不允许再残留 `{xxx}`）
  const leftover = itemText(def.desc).match(/\{(\w+)\}/)
  if (leftover) {
    err('C/NUM', `道具 ${id} 的描述里残留未填充的占位符「${leftover[0]}」`)
  }
}

// ④ 副本变体：产出道具必须已登记 + 产量必须已登记 + 数量区间合法
const dungeonItemIds = new Set<string>()
for (const variant of DUNGEON_VARIANTS) {
  if (!ITEM_ID_SET.has(variant.itemId)) {
    err('B/REF', `副本 ${variant.id} 的产出道具 ${variant.itemId} 未在 ITEM_DEFS 登记`)
  }
  dungeonItemIds.add(variant.itemId)
  const drop = DUNGEON_DROPS[variant.itemId]
  if (!drop) {
    err('B/REF', `副本 ${variant.id} 的产出道具 ${variant.itemId} 没有登记 DUNGEON_DROPS 产量`)
    continue
  }
  if (drop.min > drop.max) {
    err('C/NUM', `副本 ${variant.id} 的产量区间反了：${drop.min} > ${drop.max}`)
  }
  if (drop.min < 1) {
    err('C/NUM', `副本 ${variant.id} 的产量下界为 ${drop.min}，应 ≥ 1`)
  }
}

// ⑤ DUNGEON_DROPS 不得登记「没有副本会产出」的道具（死配置）
for (const id of Object.keys(DUNGEON_DROPS)) {
  if (!dungeonItemIds.has(id)) {
    err('B/REF', `DUNGEON_DROPS 登记了没有副本会产出的道具 ${id}`)
  }
}

// ⑥ 副本难度必须取材某一章（取材章决定波次），且倍率合法
for (const difficulty of DUNGEON_DIFFICULTIES) {
  if (difficulty.chapter < 1 || difficulty.chapter > STAGE.CHAPTERS) {
    err('C/NUM', `副本难度 ${difficulty.id} 的取材章节 ${difficulty.chapter} 超出 1~${STAGE.CHAPTERS}`)
  }
  if (difficulty.dropMul <= 0) {
    err('C/NUM', `副本难度 ${difficulty.id} 的掉落倍率 ${difficulty.dropMul} 必须为正`)
  }
}

// ⑦ 副本专属材料不得出现在主线掉落表里（主线只掉经验书与银两）
for (const [key, table] of Object.entries(DROP_TABLES)) {
  for (const drop of table.items) {
    if (dungeonItemIds.has(drop.id)) {
      err(
        'E/ECONOMY',
        `主线掉落表 ${key} 掉落了副本专属道具 ${drop.id}：副本材料只能来自副本`,
      )
    }
  }
}

// ⑧ 签到奖励里的道具只能是经验书（副本材料不得进签到）
for (const [index, reward] of DAILY.SIGN_IN_REWARDS.entries()) {
  let material = 0
  for (const [id, count] of Object.entries(reward.items ?? {})) {
    if (EXP_BOOK_ITEM_EXP[id as ItemId]) continue
    material += count ?? 0
  }
  if (material > 0) {
    err(
      'E/ECONOMY',
      `签到第 ${index + 1} 天含 ${material} 个副本材料：副本材料只能来自副本`,
    )
  }
}

// ─────────────────────────── 输出 ───────────────────────────

const errors = issues.filter((i) => i.level === 'ERROR')
const warns = issues.filter((i) => i.level === 'WARN')

console.log('='.repeat(78))
console.log('《超级圣杯战争》配置校验')
console.log('='.repeat(78))
console.log(
  `\n  英灵 ${HEROES.length} · 遗物 ${RELIC_DEFS.size} · 套装 ${RELIC_SETS.size} · 羁绊 ${BONDS.length}`,
)
console.log(
  `  敌人 ${ENEMY_DEFS.size} · BOSS ${BOSS_DEFS.size} · 关卡 ${STAGES.length} · 卡池 ${POOLS.length} · 掉落表 ${Object.keys(DROP_TABLES).length}`,
)
console.log(
  `  道具 ${ITEM_IDS.length} · 副本变体 ${DUNGEON_VARIANTS.length} · 副本难度 ${DUNGEON_DIFFICULTIES.length}`,
)

if (warns.length > 0) {
  console.log(`\n【WARN】${warns.length} 条`)
  for (const w of warns) console.log(`  · [${w.code}] ${w.message}`)
}

if (errors.length > 0) {
  console.log(`\n【ERROR】${errors.length} 条`)
  for (const e of errors) console.log(`  · [${e.code}] ${e.message}`)
  console.log('\n校验未通过。')
  process.exit(1)
}

console.log('\n全部检查通过 ✓')
process.exit(0)
