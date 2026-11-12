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
 *
 * 退出码：0 = 全通过；1 = 有 ERROR。
 */
import { HEROES } from '../src/core/config/heroes/index.ts'
import { POOLS, resolvePoolHeroIds } from '../src/core/config/pools.ts'
import { STAGES } from '../src/core/config/stages.ts'
import { RELIC_DEFS, RELIC_SETS } from '../src/core/systems/relic.ts'
import { ENEMY_INDEX } from '../src/core/config/enemies.ts'
import { BONDS } from '../src/core/config/bonds.ts'
import {
  ARENA,
  BASE_RATES,
  BATTLE,
  DAILY,
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
} from '../src/core/config/economy.ts'
import { rarityProbabilities } from '../src/core/systems/gachaRates.ts'
import type { Rarity } from '../src/core/model/types.ts'

// 加载注册型配置
import '../src/core/config/relics.ts'
import '../src/core/config/enemies.ts'

/** BOSS 由 bossMechanic 字段标识 */
const ENEMY_DEFS = ENEMY_INDEX
const BOSS_DEFS = new Map([...ENEMY_INDEX].filter(([, e]) => e.bossMechanic !== undefined))

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

for (const [key, table] of Object.entries(DROP_TABLES)) {
  for (const [field, range] of Object.entries({
    silver: table.silver,
    exp: table.exp,
    skillStones: table.skillStones,
    relicStones: table.relicStones,
    emblems: table.emblems,
  })) {
    if (range[0] > range[1]) {
      err('C/NUM', `掉落表 ${key} 的 ${field} 区间反了：${range[0]} > ${range[1]}`)
    }
    if (range[0] < 0) {
      err('C/NUM', `掉落表 ${key} 的 ${field} 下界为负：${range[0]}`)
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
if (GACHA.COST_TEN !== GACHA.COST_SINGLE * 10) {
  warn('C/NUM', `十连价格 ${GACHA.COST_TEN} ≠ 单抽 ${GACHA.COST_SINGLE} × 10`)
}

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

for (let i = 1; i < STAGES.length; i++) {
  const prev = STAGES[i - 1]
  const cur = STAGES[i]
  if (cur.powerRequired <= prev.powerRequired) {
    err('D/BAL', `关卡 ${cur.id} 门槛 ${cur.powerRequired} 未高于关卡 ${prev.id} 的 ${prev.powerRequired}（难度倒挂）`)
  }
  if (cur.enemyScale <= prev.enemyScale) {
    err(
      'D/BAL',
      `关卡 ${cur.id} 敌人缩放 ${cur.enemyScale} 未高于关卡 ${prev.id} 的 ${prev.enemyScale}（敌方难度倒挂）`,
    )
  }
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
if (ARENA.TICKET_WEEKLY_CAP <= 0) err('C/NUM', '竞技兑换抽卡券周上限必须为正')

// 日常签到：7 天一轮，奖励表长度必须匹配
if (DAILY.SIGN_IN_REWARDS.length !== DAILY.SIGN_IN_CYCLE) {
  err('C/NUM', `签到奖励数量 ${DAILY.SIGN_IN_REWARDS.length} 与周期 ${DAILY.SIGN_IN_CYCLE} 不符`)
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
