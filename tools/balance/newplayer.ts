/**
 * 新号数值基线（roadmap P1-2「新号数值和卡点」）。
 *
 * ⚠ 为什么要有这个脚本：
 *   `npm run balance` 比的是**战力数字**，`npm run balance:battle` 比的是
 *   **满养成**队伍——两者都跳过了「新号第一分钟到第一天」这段真实体验。
 *   玩家实际遇到的是：
 *     「新手十连抽到谁」→「第一天能养到什么程度」→「第一个 BOSS 能不能过」
 *     →「什么时候能凑出下一次十连」。
 *   这段体验此前**没有任何脚本覆盖**，于是「新手卡在第几关」「抽卡资源够不够」
 *   只能靠人肉试玩发现。
 *
 * 本脚本按**真实规则**模拟一个新号：
 *   - 存档从 `createNewSave` 起（新手资源就是 `START_RESOURCES`）；
 *   - 抽卡 / 挂机 / 养成全部走**动作层**（`applyAction`），工具不自己复算一遍
 *     规则——改数值时游戏与工具一起变（铁律 #4 单一数据源）；
 *   - 挂机是**真的跑战斗**（`idle.tick` → 逐场回放），不是按时长线性发奖；
 *   - 时间与随机源由脚本注入，core 不读真实时钟、不用 `Math.random()`（铁律 #1）。
 *
 * 逐阵容输出：战力、等级、通关进度、卡关、BOSS 通关率、材料缺口、抽卡资源来源。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { createNewSave } from '../../src/core/save/schema.ts'
import { Rng } from '../../src/core/rng.ts'
import { applyAction, syncRngState, type ActionContext, type IdleActionResult } from '../../src/core/systems/actions.ts'
import { POOL_NEWBIE } from '../../src/core/config/pools.ts'
import { buildPveContext, buildTeam } from '../../src/core/systems/derive.ts'
import { getTeamPower } from '../../src/core/systems/team.ts'
import { atRealmGate, expToNext, realmBreakCost, skillLevelCap } from '../../src/core/systems/growth.ts'
import { relicUpgradeCost } from '../../src/core/systems/relic.ts'
import { simulateWinRate } from '../../src/core/systems/battle.ts'
import { computePower, resolveStats } from '../../src/core/systems/stats.ts'
import { getStage, STAGES } from '../../src/core/config/stages.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { HERO_INDEX } from '../../src/core/config/heroes/index.ts'
import { ITEM_BY_ELEMENT, type ItemId } from '../../src/core/config/items.ts'
import { feedBooks, itemsToExp, itemName, materialTotals } from './item-flow.ts'
import {
  applyIdleTarget,
  chooseIdleTarget,
  resolveDungeonDifficulty,
} from './dungeon-loop.ts'
import {
  BATTLE,
  DAILY,
  EXP_BOOK,
  GACHA,
  IDLE,
  LEVEL,
  RELIC,
  SKILL,
  START_RESOURCES,
  type DungeonDifficultyId,
} from '../../src/core/config/economy.ts'
import type { HeroDef, Rarity, SaveData } from '../../src/core/model/types.ts'

// ─────────────────────────── 命令行 ───────────────────────────

const { values } = parseArgs({
  options: {
    /** 模拟多少个新号（每个号一个种子） */
    seeds: { type: 'string', default: '3' },
    /** 种子基数：第 i 个号用 seedBase + i */
    seed: { type: 'string', default: '20260105' },
    /** 基线 JSON 的输出路径（留空则不落盘） */
    out: { type: 'string', default: 'artifacts/baselines/newplayer.json' },
    /** 每段结算的时长（小时） */
    chunk: { type: 'string', default: '1' },
  },
})

const SEED_COUNT = Math.max(1, Number(values.seeds) || 1)
const SEED_BASE = Number(values.seed) || 20260105
/** `--out none` 表示不落盘（只看控制台） */
const OUT_PATH = values.out && values.out !== 'none' ? resolve(process.cwd(), values.out) : ''
const CHUNK_HOURS = Math.max(0.25, Number(values.chunk) || 1)

// ─────────────────────────── 常量 ───────────────────────────

const HOUR_MS = 3_600_000
/**
 * 「第一天」= **24 小时真实时长**（玩家逐段上线领奖 → 挂机 → 再上线）。
 *
 * ⚠ **实施修正（roadmap P1-2）**：原值取 `IDLE.FULL_EFFICIENCY_HOURS`（当时是 8），
 *   隐含假设「满效率时长 = 一天的挂机量」。收窄离线曲线后这个假设不成立了：
 *   真实一天的离线收益是 **f(24h)**（走 core 的离线效率曲线），
 *   而不是 f(FULL_EFFICIENCY_HOURS)——满效率时长只是曲线里的第一段。
 *
 * ⚠ **上线频率是口径的一部分，不是细节**：离线曲线按「累计时长」折算，
 *   而累计时长只在玩家**活跃**时归零，于是：
 *     · 每小时上线一次（`--chunk 1`，**默认**）→ 每段都拿到满效率 → 首日 ≈ 24h 收益；
 *     · 每天上线一次（`--chunk 24`）→ 首日只有 f(24h) ≈ 2.6h 收益。
 *   两者相差 9 倍，**必须在文档里写清楚用的是哪一个**。
 *   本基线用「每小时上线一次」（活跃首日）；「每天上线一次」的被动档见
 *   `artifacts/baselines/recalibrate.json`（`npm run balance:recalibrate`）。
 */
const DAY_HOURS = 24
/** BOSS 通关率的试验场数 */
const BOSS_TRIALS = 120
/** 逐关扫描的试验场数 */
const STAGE_TRIALS = 20
/** 基线用固定「现在」：结果必须可复现，不依赖真实时钟。 */
const BASE_NOW = Date.UTC(2026, 0, 5, 4, 0, 0)

const RARITY_ORDER: Rarity[] = ['SSR', 'SR', 'R', 'N']
const FIRST_CHAPTER_STAGES = STAGES.filter((s) => s.chapter === 1)

// ─────────────────────────── 阵容档位 ───────────────────────────

interface TeamProfile {
  label: string
  /** 期望的稀有度配比；某档不够时自动用下一档补齐 */
  quota: Rarity[]
}

/**
 * 阵容档位。
 *
 * 首抽保底 1 个 SSR，其余按公示概率出（N 70% / R 24.3% / SR 5.1%），
 * 所以「1 SSR + 5 N」是完全可能的最差阵容，「全 SSR」是理论上限。
 * 真实玩家的编队落在两者之间，这里把两端与中间都各测一遍。
 */
const PROFILES: TeamProfile[] = [
  { label: 'P1 全 SSR（上限）', quota: ['SSR', 'SSR', 'SSR', 'SSR', 'SSR', 'SSR'] },
  { label: 'P2 SSR+SR 混编', quota: ['SSR', 'SSR', 'SR', 'SR', 'R', 'R'] },
  { label: 'P3 SSR 主导', quota: ['SSR', 'SSR', 'SR', 'R', 'R', 'N'] },
  { label: 'P4 1SSR+N（下限）', quota: ['SSR', 'R', 'R', 'N', 'N', 'N'] },
]

// ─────────────────────────── 工具 ───────────────────────────

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

function num(v: number): string {
  return v.toLocaleString('zh-CN')
}

/** 英灵在 1 级、无遗物时的基础战力（用于阵容内排序） */
function basePower(def: HeroDef): number {
  const runtime = {
    def,
    state: {
      id: def.id,
      level: LEVEL.MIN,
      exp: 0,
      star: 1,
      skillLevels: [1, 1, 1],
      shards: 0,
      coreAwakened: false,
      obtainedAt: 0,
    },
    relics: [],
    slot: 0,
  }
  return computePower(resolveStats(runtime, { mode: 'pve', seed: 1 }))
}

/** 按稀有度配额挑人；某档不够时用下一档补齐 */
function pickTeam(pool: HeroDef[], quota: Rarity[]): HeroDef[] {
  const byRarity = new Map<Rarity, HeroDef[]>(RARITY_ORDER.map((r) => [r, []]))
  for (const def of pool) byRarity.get(def.rarity)?.push(def)
  for (const list of byRarity.values()) list.sort((a, b) => basePower(b) - basePower(a))

  const picked: HeroDef[] = []
  const used = new Set<string>()
  for (const want of quota) {
    let taken = false
    for (let i = RARITY_ORDER.indexOf(want); i < RARITY_ORDER.length; i++) {
      const next = byRarity.get(RARITY_ORDER[i])?.find((h) => !used.has(h.id))
      if (!next) continue
      picked.push(next)
      used.add(next.id)
      taken = true
      break
    }
    if (!taken) break
  }
  return picked
}

/** 编队（按真实槽位：前 3 前排 / 后 3 后排） */
function setTeam(save: SaveData, ctx: ActionContext, heroes: HeroDef[]): void {
  for (let slot = 0; slot < 6; slot++) {
    const hero = heroes[slot] ?? null
    applyAction(save, { type: 'team.setSlot', index: slot, heroId: hero?.id ?? null }, ctx)
  }
}

// ─────────────────────────── 成长策略 ───────────────────────────

interface SpendReport {
  /** 投入的经验（经验书折算） */
  expFed: number
  realmBreaks: number
  skillUps: number
  relicUps: number
}

/**
 * 把资源按**固定优先级**花掉（这条优先级就是本脚本对「理性玩家」的建模）。
 *
 * ① 等级：经验只喂「等级最低」的上阵英灵（均衡成长）；
 * ② 境界：卡在境界门槛且银两够 → 立刻突破（经验卡在门槛上是纯浪费）；
 * ③ 遗物强化：已装备遗物**轮转**升级（每件都升几级，而不是把强化石全砸一件）；
 * ④ 技能升级：剩下的五行技能材料用于技能。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：
 *   - 经验来源从「玩家经验池」变成「背包里的经验书」（主线掉落 + 任务产出），
 *     喂书走 `feedBooks`（与 `recalibrate.ts` 同一份）；
 *   - 术式结晶 → **五行技能材料**（按英灵五行取道具 id）；
 *   - 遗物强化石 → **三档强化石**（按目标等级的档位逐档比对）；
 *   - 境界突破的印记 → **银两**。
 *
 * ⚠ 银两同时被 ③ 和 ④ 消耗，所以顺序会左右结果——这里固定成「遗物先、技能后」，
 *   因为遗物强化是**立刻可见的乘区**，而技能等级上限受境界压制（新号前期本就升不高）。
 */
function spendGrowth(save: SaveData, ctx: ActionContext, teamIds: string[]): SpendReport {
  const report: SpendReport = { expFed: 0, realmBreaks: 0, skillUps: 0, relicUps: 0 }

  // ① + ②：喂经验书 / 突破境界
  let guard = 0
  while (guard++ < 5000) {
    const states = teamIds.map((id) => save.heroes[id]).filter((s): s is NonNullable<typeof s> => !!s)
    if (states.length === 0) break
    // 选等级最低的上阵英灵（同级取存经验多的）
    const target = states.sort((a, b) => a.level - b.level || b.exp - a.exp)[0]

    if (atRealmGate(target.level)) {
      // 卡门槛：银两够就突破，不够就别喂（经验卡在门槛上是纯浪费）
      const broke = applyAction(save, { type: 'hero.breakRealm', heroId: target.id }, ctx)
      if (broke.ok) {
        report.realmBreaks += 1
        continue
      }
      const alt = states
        .filter((s) => !atRealmGate(s.level))
        .sort((a, b) => a.level - b.level)[0]
      if (!alt) break
      const fed = feedBooks(save, ctx, alt.id)
      if (!fed.fed) break
      report.expFed += fed.exp
      continue
    }

    const fed = feedBooks(save, ctx, target.id)
    if (!fed.fed) break
    report.expFed += fed.exp
  }

  // ③ 遗物强化（轮转：每次给「等级最低」的那件升一级）
  const equipped = Object.values(save.equipped)
    .map((e) => save.relics.find((r) => r.uid === e.relicId))
    .filter((r): r is NonNullable<typeof r> => !!r)
  let relicGuard = 0
  // ⚠ 护栏按「满编 × 上限」给足：强化上限提到 200 之后，
  //   36 件遗物各推到上限需要 7000+ 次升级，原来的 2000 会**中途截断**
  //   （截断 = 模拟出来的养成进度偏小，结论直接失真）。
  while (relicGuard++ < equipped.length * RELIC.MAX_LEVEL) {
    const candidates = equipped
      .filter((r) => r.level < RELIC.MAX_LEVEL)
      .sort((a, b) => a.level - b.level)
    if (candidates.length === 0) break
    const relic = candidates[0]
    const cost = relicUpgradeCost(relic.level)
    if (!cost) break
    if (save.player.silver < cost.silver) break
    // ⚠ 强化石**按档位拆分**（`cost.stones` 是 map）：逐档比对背包里的持有量
    let stoneShort = false
    for (const [id, n] of Object.entries(cost.stones)) {
      if ((save.items[id as ItemId] ?? 0) < (n ?? 0)) {
        stoneShort = true
        break
      }
    }
    if (stoneShort) break
    const up = applyAction(save, { type: 'relic.upgrade', uid: relic.uid }, ctx)
    if (!up.ok) break
    report.relicUps += 1
  }

  // ④ 技能升级
  let skillGuard = 0
  while (skillGuard++ < 200) {
    let upgraded = false
    for (const heroId of teamIds) {
      const state = save.heroes[heroId]
      if (!state) continue
      const element = HERO_INDEX.get(heroId)?.element
      if (!element) continue
      // ⚠ 技能材料按**英灵五行**取（唯一口径 `ITEM_BY_ELEMENT`）
      const materialId = ITEM_BY_ELEMENT[element]
      for (let index = 0; index < state.skillLevels.length; index++) {
        if ((state.skillLevels[index] ?? 0) >= skillLevelCap(state.level)) continue
        if ((save.items[materialId] ?? 0) < SKILL.MATERIAL_PER_LEVEL) continue
        if (save.player.silver < SKILL.SILVER_PER_LEVEL) continue
        const up = applyAction(save, { type: 'hero.upgradeSkill', heroId, index }, ctx)
        if (up.ok) {
          report.skillUps += 1
          upgraded = true
        }
      }
    }
    if (!upgraded) break
  }

  return report
}

// ─────────────────────────── 模拟 ───────────────────────────

interface ProfileResult {
  label: string
  /** 实际编成的稀有度构成 */
  composition: string
  roster: { id: string; name: string; rarity: Rarity }[]
  power: number
  /** 上阵英灵等级 */
  levels: Record<string, number>
  /** 通关到的关卡 */
  clearedStage: number
  /** 首次失败（卡关）的关卡——玩家真实推进时撞上的那堵墙 */
  blockedAtStage: number | null
  /** 一天结束时仍然打不过的第一关（逐关扫描） */
  endOfDayFailStage: number | null
  /** 第一个 BOSS 的实战通关率 */
  bossStage: number
  bossWinRate: number
  bossAvgRounds: number
  /** 首次境界突破发生在第几小时 */
  firstRealmBreakHour: number | null
  /**
   * 每小时的成长曲线（这是基线里最有用的一张表）。
   *
   * ⚠ 没有这条曲线就看不出「节奏」：只看终局数字会以为「数值爆炸」，
   *   曲线才能指出是**哪一段**开始失控（章内难度跨度 vs 养成速度）。
   */
  curve: {
    hour: number
    clearedStage: number
    level: number
    power: number
    silver: number
    /** 经验（经验书折算） */
    exp: number
    relics: number
  }[]
  resources: {
    silver: number
    crystals: number
    /** 经验（经验书折算） */
    exp: number
    /** 经验书本数（小 + 大） */
    expBooks: number
    /** 五行技能材料合计 */
    skillMats: number
    /** 三档强化石合计 */
    relicStones: number
    /** 同名英灵碎片合计 */
    shards: number
  }
  /** 仓库里的遗物件数 */
  relics: number
  /** 全天累计投入的经验（喂书折算） */
  expFed: number
  /** 材料缺口（想继续变强还差什么） */
  gaps: {
    /** 升到下一级还差多少经验 */
    expToNextLevel: number
    /** 技能升满还差多少五行技能材料（按道具 id 分列） */
    skillMatShort: Record<string, number>
    /** 遗物再升 10 级还差多少强化石（按道具 id 分列） */
    relicStoneShort: Record<string, number>
    /** 突破境界还差多少银两 */
    silverShort: number
    powerShort: number
  }
  /** 每小时产出（回退刷取的产出速率） */
  perHour: {
    silver: number
    exp: number
    skillMats: number
    relicStones: number
    shards: number
    relics: number
  }
  /**
   * **回退刷取时间**：卡在某一关时，靠回退刷取再升一级要多久。
   *
   * ⚠ 这是 roadmap P1-2 明确要的指标（「回退刷取时间」）：
   *   玩家卡关后不是干等，而是回去刷更低的关卡攒资源。
   *   「距离下一级还差多少经验 ÷ 当前每小时经验产出」= 他要刷多久才能再推进一步。
   *   这个数一旦是「几分钟」，玩家就会觉得游戏没有过程；是「几小时」，节奏才对。
   */
  farmToNextLevelHours: number
  /** 卡住时每场战斗的经验产出（回退关卡的掉落速率） */
  expPerBattle: number
}

interface AccountResult {
  seed: number
  pull: {
    rarity: Record<Rarity, number>
    crystalsUsed: number
    guaranteed: boolean
    crystalsLeft: number
  }
  profiles: ProfileResult[]
  /** 抽卡资源来源（圣杯结晶从哪来） */
  gachaIncome: {
    fromIdle: boolean
    signInPerCycle: number
    signInPerDay: number
    daysForNextTenPull: number
  }
}

/**
 * 推进挂机账本并结算一段时长（走真实的 `idle.tick` 动作）。
 *
 * ⚠ **实施修正（roadmap P1-2）**：这里原来直接改 `save.idle.measuredAt` /
 *   `save.idle.activeUntil` 来「模拟离线」，结果**从第 4 小时起收益恒为 0**——
 *   core 的离线计量是**累计时长**口径（`settleIdleLedger`），累计的离线时长
 *   只有在玩家**活跃**（`onlineMs > 0`）时才归零；直接改字段永远走不到那条分支，
 *   累计时长一路涨到 `CAP_HOURS` 之后，后续每段的折算增量就是 0。
 *   真实玩家每天都会上线，所以模拟也必须每天上线一次——
 *   走真实的「心跳计量离线段 → 心跳让租约生效（归零）→ 领奖」序列
 *   （与 tools/balance/recalibrate.ts 同口径）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：返回本段的**产出**（真实回放奖励包）——
 *   经验改由经验书承载，而书会被喂光，所以「余额差值」测不出产出速率，
 *   「回退刷取下一级」这个指标必须用**产出**来算。
 */
function advanceIdle(
  save: SaveData,
  ctx: ActionContext,
  hours: number,
): {
  exp: number
  silver: number
  materials: { skillMats: number; relicStones: number }
  run: IdleActionResult | null
} {
  const ms = Math.round(hours * HOUR_MS)
  // ① 先把「现在」推过去，再让心跳计量这一段离线时长
  //    （租约已过期 → 走离线曲线，不吃 3 倍在线倍率）
  ctx.now += ms
  applyAction(save, { type: 'idle.heartbeat' }, ctx)
  // ② 再来一跳（一个心跳间隔后）：租约已生效 → onlineMs > 0 → 离线累计归零
  ctx.now += IDLE.HEARTBEAT_INTERVAL_MS
  applyAction(save, { type: 'idle.heartbeat' }, ctx)
  // ③ 领奖：回放服务端已累计的场次（客户端只是上限）
  const battles = Math.floor(ms / 1000 / BATTLE.SECONDS_PER_BATTLE)
  const tick = applyAction(save, { type: 'idle.tick', battles: Math.max(1, battles) }, ctx)
  const run = tick.ok ? tick.result : null
  const rewards = run?.rewards
  return {
    exp: itemsToExp(rewards?.items),
    silver: rewards?.silver ?? 0,
    /**
     * 本段的**材料产出**（五行技能材料 / 三档强化石）。
     *
     * ⚠ 必须用**产出**而不是余额差：材料到账就会被养成动作吃掉，
     *   余额差会把这部分产出抹掉（经验维度早就踩过这个坑）。
     *   材料只在**挂机去向切到副本**的那些小时里才有流入。
     */
    materials: materialTotals(rewards?.items),
    run,
  }
}

/**
 * 资源快照。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：钱包只剩银两与圣杯结晶；
 *   经验 / 术式结晶 / 遗物强化石 / 印记 / 抽卡券全部退役，
 *   前三者改由**背包堆叠物**（`save.items`）承载，经验按**经验书折算**。
 */
function snapshotResources(save: SaveData) {
  const materials = materialTotals(save.items)
  return {
    silver: save.player.silver,
    crystals: save.player.crystals,
    /** 经验（经验书折算） */
    exp: itemsToExp(save.items),
    /** 经验书本数 */
    expBooks: (save.items[EXP_BOOK.small.id] ?? 0) + (save.items[EXP_BOOK.large.id] ?? 0),
    /** 五行技能材料合计 */
    skillMats: materials.skillMats,
    /** 三档强化石合计 */
    relicStones: materials.relicStones,
    /** 同名英灵碎片合计 */
    shards: Object.values(save.player.shards).reduce((a, b) => a + b, 0),
    relics: save.relics.length,
  }
}

/** 材料缺口：想继续变强还差什么 */
function computeGaps(
  save: SaveData,
  teamIds: string[],
  power: number,
  bossPowerRequired: number,
) {
  const states = teamIds.map((id) => save.heroes[id]).filter((s): s is NonNullable<typeof s> => !!s)
  const lowest = [...states].sort((a, b) => a.level - b.level)[0]
  const expToNextLevel = lowest ? Math.max(0, expToNext(lowest.level) - lowest.exp) : 0

  // 技能升满（受境界上限约束）还差多少**五行技能材料**（按英灵五行分列）
  const skillShort: Record<string, number> = {}
  for (const state of states) {
    const element = HERO_INDEX.get(state.id)?.element
    if (!element) continue
    const materialId = ITEM_BY_ELEMENT[element]
    const cap = skillLevelCap(state.level)
    let need = 0
    for (let i = 0; i < state.skillLevels.length; i++) {
      need += Math.max(0, cap - (state.skillLevels[i] ?? 0)) * SKILL.MATERIAL_PER_LEVEL
    }
    skillShort[materialId] = (skillShort[materialId] ?? 0) + need
  }

  // 遗物再升 10 级还差多少**强化石**（按档位分列：逐级价格随档位变化）
  const relicShort: Record<string, number> = {}
  {
    const equipped = Object.values(save.equipped)
      .map((e) => save.relics.find((r) => r.uid === e.relicId))
      .filter((r): r is NonNullable<typeof r> => !!r)
    const cheapest = equipped.length > 0
      ? Math.min(...equipped.map((r) => r.level))
      : RELIC.MIN_LEVEL
    for (let l = cheapest; l < cheapest + 10; l++) {
      const cost = relicUpgradeCost(l)
      if (!cost) break
      for (const [id, n] of Object.entries(cost.stones)) {
        relicShort[id] = (relicShort[id] ?? 0) + (n ?? 0)
      }
    }
  }
  // 缺口 = 需要 - 持有（逐档）
  for (const [id, need] of Object.entries(relicShort)) {
    relicShort[id] = Math.max(0, need - (save.items[id as ItemId] ?? 0))
  }

  // 突破境界的**银两**缺口（印记已退役，突破改扣银两）
  const gated = states.find((s) => atRealmGate(s.level))
  const breakCost = gated ? realmBreakCost(gated.level) : null
  const silverShort = breakCost ? Math.max(0, breakCost.silver - save.player.silver) : 0

  return {
    expToNextLevel,
    skillMatShort: skillShort,
    relicStoneShort: relicShort,
    silverShort,
    powerShort: Math.max(0, bossPowerRequired - power),
  }
}

/** 模拟一个新号在某个阵容下的第一天 */
function simulateProfile(template: SaveData, profile: TeamProfile): ProfileResult {
  // 每个阵容从**同一份**抽卡结果出发（只改编队），保证阵容之间可比
  const save: SaveData = structuredClone(template)
  const ctx: ActionContext = {
    now: BASE_NOW,
    rng: Rng.fromSnapshot(save.rng.seed, save.rng.counter),
    randomSeed: () => save.rng.seed,
  }

  const pool = Object.keys(save.heroes)
    .map((id) => HERO_INDEX.get(id))
    .filter((d): d is HeroDef => !!d)
  const team = pickTeam(pool, profile.quota)
  if (team.length === 0) throw new Error('首抽没有产出任何英灵')
  setTeam(save, ctx, team)
  const teamIds = team.map((h) => h.id)

  // 逐段挂机 + 养成
  let firstRealmBreakHour: number | null = null
  const curve: ProfileResult['curve'] = []

  const chunks = Math.ceil(DAY_HOURS / CHUNK_HOURS)
  let chunkBefore = snapshotResources(save)
  let chunkAfter = chunkBefore
  /** 最后一段的**真实产出**（经验书 / 材料的到账速率） */
  let lastProduced = { exp: 0, silver: 0, materials: { skillMats: 0, relicStones: 0 } }
  /** 全天累计投入的经验（喂书折算） */
  let totalExpFed = 0
  /** 副本难度（自适应状态；口径与 recalibrate.ts 共用，铁律 #4） */
  let dungeonDifficulty: DungeonDifficultyId = 'easy'
  for (let c = 0; c < chunks; c++) {
    // ── 选本段（1 小时）的挂机去向 ──
    //
    // ⚠ **必须在「这段挂机时间开始之前」选**：去向是存档状态，
    //   它决定了这段离线期归谁（切换时服务端先按**旧去向**结清，设计稿 §3）。
    //
    // ⚠ 段内**不能**重复套用离线曲线：本脚本每段都走「心跳 ×2」（每小时上线一次），
    //   租约每段生效一次 → 离线累计每段归零 → 每段都拿到 f(该段时长) 的满额，
    //   这正是「每小时上线一次」的口径（与 recalibrate 的「每天一次」不同，
    //   两者相差 9 倍，见 economy.ts 的 IDLE 注释）。
    const plan = chooseIdleTarget(
      save,
      ctx,
      teamIds,
      dungeonDifficulty,
      Math.floor((CHUNK_HOURS * 3600) / BATTLE.SECONDS_PER_BATTLE),
    )
    applyIdleTarget(save, ctx, plan)
    const produced = advanceIdle(save, ctx, CHUNK_HOURS)
    lastProduced = produced
    // 副本难度自适应：战败降一档，没战败按当前战力往上走
    dungeonDifficulty = resolveDungeonDifficulty(
      save,
      ctx,
      produced.run?.dungeon?.blockedAtBattle != null && plan.kind !== 'campaign'
        ? (plan.difficulty ?? null)
        : null,
    )
    // 首轮之后先把遗物穿上（推荐装备与服务端执行同一函数 → 预览 = 执行）
    if (c === 0) {
      for (const heroId of teamIds) applyAction(save, { type: 'relic.autoEquip', heroId }, ctx)
    }
    const spend = spendGrowth(save, ctx, teamIds)
    totalExpFed += spend.expFed
    if (spend.realmBreaks > 0 && firstRealmBreakHour === null) {
      firstRealmBreakHour = (c + 1) * CHUNK_HOURS
    }
    const hour = (c + 1) * CHUNK_HOURS
    const levelNow = Math.min(...teamIds.map((id) => save.heroes[id]?.level ?? 1))
    curve.push({
      hour,
      clearedStage: save.campaign.clearedStage,
      level: levelNow,
      power: getTeamPower(buildTeam(save), buildPveContext(save)),
      silver: save.player.silver,
      /** 经验（经验书折算） */
      exp: itemsToExp(save.items),
      relics: save.relics.length,
    })
    chunkBefore = chunkAfter
    chunkAfter = snapshotResources(save)
  }

  // 每小时产出（用**最后一段**的速率，代表卡关后的实际回退刷取速度）
  //
  // ⚠ 经验用**产出**而不是余额差：经验书会被喂光，余额差恒为 0，
  //   而「回退刷取下一级」要的是**到账速率**。
  const chunkDelta = {
    silver: chunkAfter.silver - chunkBefore.silver,
    shards: chunkAfter.shards - chunkBefore.shards,
    relics: chunkAfter.relics - chunkBefore.relics,
  }
  const perHour = {
    silver: Math.round(chunkDelta.silver / CHUNK_HOURS),
    exp: Math.round(lastProduced.exp / CHUNK_HOURS),
    skillMats: Math.round(lastProduced.materials.skillMats / CHUNK_HOURS),
    relicStones: Math.round(lastProduced.materials.relicStones / CHUNK_HOURS),
    shards: Math.round(chunkDelta.shards / CHUNK_HOURS),
    relics: Math.round(chunkDelta.relics / CHUNK_HOURS),
  }

  // 第一个 BOSS 的实战通关率
  const bossStageId = FIRST_CHAPTER_STAGES.find((s) => s.isBoss)?.id ?? 0
  const bossStage = getStage(bossStageId)
  const allies = buildTeam(save)
  const ctxBattle = buildPveContext(save)
  const boss = simulateWinRate(
    {
      allies,
      enemies: bossStage.enemyIds.map((id) => getEnemy(id)),
      enemyScale: bossStage.enemyScale,
      ctx: ctxBattle,
    },
    BOSS_TRIALS,
  )

  // 逐关扫描：一天结束时仍然打不过的第一关
  let endOfDayFailStage: number | null = null
  for (const st of FIRST_CHAPTER_STAGES) {
    const r = simulateWinRate(
      {
        allies,
        enemies: st.enemyIds.map((eid) => getEnemy(eid)),
        enemyScale: st.enemyScale,
        ctx: ctxBattle,
      },
      STAGE_TRIALS,
    )
    if (r.winRate < 0.5) {
      endOfDayFailStage = st.id
      break
    }
  }

  const power = getTeamPower(allies, ctxBattle)
  const levels: Record<string, number> = {}
  for (const id of teamIds) levels[id] = save.heroes[id]?.level ?? 0

  const clearedStage = save.campaign.clearedStage
  const blockedAtStage = save.idle.currentStage > clearedStage ? save.idle.currentStage : null
  const gaps = computeGaps(save, teamIds, power, bossStage.powerRequired)

  // 回退刷取时间：经验池的每小时收入要分给 6 名英灵，
  //   「距离下一级还差的经验 ÷ 每名英灵每小时分到的经验」= 还要刷多久。
  const battlesPerHour = Math.floor(3600 / BATTLE.SECONDS_PER_BATTLE)
  const expPerBattle = Math.round(perHour.exp / battlesPerHour)
  const expPerHeroPerHour = perHour.exp / Math.max(1, teamIds.length)
  const farmToNextLevelHours =
    expPerHeroPerHour > 0 ? gaps.expToNextLevel / expPerHeroPerHour : Number.POSITIVE_INFINITY

  return {
    label: profile.label,
    composition: team.map((h) => h.rarity).join('/'),
    roster: team.map((h) => ({ id: h.id, name: h.name, rarity: h.rarity })),
    power,
    levels,
    clearedStage,
    blockedAtStage,
    endOfDayFailStage,
    bossStage: bossStageId,
    bossWinRate: boss.winRate,
    bossAvgRounds: boss.avgRounds,
    firstRealmBreakHour,
    curve,
    resources: {
      silver: save.player.silver,
      crystals: save.player.crystals,
      /** 经验（经验书折算） */
      exp: itemsToExp(save.items),
      expBooks: (save.items[EXP_BOOK.small.id] ?? 0) + (save.items[EXP_BOOK.large.id] ?? 0),
      skillMats: materialTotals(save.items).skillMats,
      relicStones: materialTotals(save.items).relicStones,
      shards: Object.values(save.player.shards).reduce((a, b) => a + b, 0),
    },
    relics: save.relics.length,
    /** 全天累计投入的经验（喂书折算） */
    expFed: totalExpFed,
    gaps: computeGaps(save, teamIds, power, bossStage.powerRequired),
    perHour,
    farmToNextLevelHours,
    expPerBattle,
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

console.log('='.repeat(78))
console.log('《超级圣杯战争》新号数值基线（roadmap P1-2）')
console.log('='.repeat(78))

const accounts: AccountResult[] = []

for (let a = 0; a < SEED_COUNT; a++) {
  const seed = SEED_BASE + a
  // 每个号都是**全新存档** + 一次新手池十连
  const template = createNewSave(BASE_NOW, seed)
  const ctx: ActionContext = { now: BASE_NOW, rng: new Rng(seed), randomSeed: () => seed }
  const pull = applyAction(template, { type: 'gacha.pull', poolId: POOL_NEWBIE.id, count: 10 }, ctx)
  if (!pull.ok) throw new Error(`首抽失败：${pull.message}`)
  syncRngState(template, ctx.rng)

  const rarity: Record<Rarity, number> = { SSR: 0, SR: 0, R: 0, N: 0 }
  for (const item of pull.result.items) rarity[item.rarity] += 1

  console.log(`\n【账号 ${a + 1}/${SEED_COUNT}】seed=${seed}`)
  console.log(
    `  首抽（新手池十连）：SSR ${rarity.SSR} / SR ${rarity.SR} / R ${rarity.R} / N ${rarity.N}` +
      `　新手保底${pull.result.guaranteedTriggered ? '**替换**了末张' : '未替换（自然已出 SSR）'}`,
  )
  console.log(
    `  扣费：圣杯结晶 ${num(pull.result.crystalsUsed)}（余 ${num(template.player.crystals)}）`,
  )

  const profiles: ProfileResult[] = []
  for (const profile of PROFILES) {
    const result = simulateProfile(template, profile)
    profiles.push(result)
    const minLevel = Math.min(...Object.values(result.levels))
    console.log(
      `  ${profile.label.padEnd(16)} 构成 ${result.composition.padEnd(24)}` +
        `战力 ${num(result.power).padStart(10)}` +
        `　Lv${minLevel}` +
        `　通关 第${result.clearedStage}关` +
        `　卡关 第${result.blockedAtStage ?? '-'}关` +
        `　BOSS ${pct(result.bossWinRate)}`,
    )
  }

  accounts.push({
    seed,
    pull: {
      rarity,
      crystalsUsed: pull.result.crystalsUsed,
      guaranteed: pull.result.guaranteedTriggered,
      crystalsLeft: template.player.crystals,
    },
    profiles,
    gachaIncome: {
      fromIdle: false,
      signInPerCycle: DAILY.SIGN_IN_REWARDS.reduce((sum, r) => sum + (r.crystals ?? 0), 0),
      signInPerDay:
        DAILY.SIGN_IN_REWARDS.reduce((sum, r) => sum + (r.crystals ?? 0), 0) / DAILY.SIGN_IN_CYCLE,
      daysForNextTenPull: daysForNextTenPull(),
    },
  })
}

// ─────────────────────────── 汇总 ───────────────────────────

console.log('\n' + '-'.repeat(78))
console.log('【逐阵容汇总】')
console.log(
  '  阵容'.padEnd(20) + 'BOSS胜率'.padEnd(10) + '卡关'.padEnd(8) +
    '破境界'.padEnd(10) + '投入经验'.padEnd(12) + '仓库'.padEnd(8) +
    '每h银两'.padEnd(12) + '每h经验'.padStart(12) + '回退刷取下一级',
)
for (const account of accounts) {
  for (const p of account.profiles) {
    console.log(
      `  ${p.label.padEnd(18)}` +
        `${pct(p.bossWinRate).padEnd(10)}` +
        `${String(p.blockedAtStage ?? '-').padEnd(8)}` +
        `${(p.firstRealmBreakHour !== null ? `${p.firstRealmBreakHour}h` : '未达成').padEnd(10)}` +
        `${num(p.expFed).padEnd(12)}` +
        `${String(p.relics).padEnd(8)}` +
        `${num(p.perHour.silver).padEnd(12)}` +
        `${num(p.perHour.exp).padStart(12)} ` +
        `${Number.isFinite(p.farmToNextLevelHours) ? `${p.farmToNextLevelHours.toFixed(1)} 小时` : '—'}`,
    )
  }
}

console.log('\n【第一天成长曲线】每小时推进到哪里（关卡 / 等级 / 战力 / 银两 / 经验书 / 仓库）')
for (const account of accounts) {
  for (const p of account.profiles) {
    console.log(`  ── ${p.label}（账号 seed=${account.seed}）`)
    console.log(
      '     小时'.padEnd(9) + '通关关卡'.padEnd(11) + '等级'.padEnd(8) +
        '战力'.padEnd(14) + '银两'.padEnd(14) + '经验'.padEnd(14) + '仓库',
    )
    for (const row of p.curve) {
      console.log(
        `     ${String(row.hour).padEnd(7)}` +
          `第${row.clearedStage}关`.padEnd(11) +
          `Lv${row.level}`.padEnd(8) +
          num(Math.round(row.power)).padEnd(14) +
          num(row.silver).padEnd(14) +
          num(row.exp).padEnd(14) +
          String(row.relics),
      )
    }
  }
}

console.log('\n【材料缺口】（想继续变强还差什么）')
for (const account of accounts) {
  for (const p of account.profiles) {
    // ⚠ 五行技能材料 / 三档强化石**按道具 id 分列**（新模型的材料是分档的）
    const skillShort = Object.entries(p.gaps.skillMatShort)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${itemName(id as ItemId)} ${num(n)}`)
      .join(' / ') || '—'
    const stoneShort = Object.entries(p.gaps.relicStoneShort)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${itemName(id as ItemId)} ${num(n)}`)
      .join(' / ') || '—'
    console.log(
      `  ${p.label.padEnd(18)}` +
        `经验 ${num(p.gaps.expToNextLevel).padEnd(12)}` +
        `技能材料 ${skillShort.padEnd(30)}` +
        `强化石 ${stoneShort.padEnd(24)}` +
        `突破银两 ${num(p.gaps.silverShort).padEnd(10)}` +
        `战力 ${num(p.gaps.powerShort)}`,
    )
  }
}

console.log('\n【抽卡资源来源】')
const sample = accounts[0]
console.log(`  首抽后余额：圣杯结晶 ${num(sample.pull.crystalsLeft)}`)
console.log('  推征掉落里**没有**圣杯结晶 → 结晶只来自签到与兑换码')
console.log(
  `  签到 ${DAILY.SIGN_IN_CYCLE} 天循环共 ${num(sample.gachaIncome.signInPerCycle)} 结晶` +
    `（日均 ${num(Math.round(sample.gachaIncome.signInPerDay))}）` +
    `　下一个十连（${num(GACHA.COST_SINGLE * GACHA.TEN_PULL_COUNT)} 结晶）需签到约 ${sample.gachaIncome.daysForNextTenPull} 天`,
)
console.log(
  `  新号自带 ${num(START_RESOURCES.crystals)} 结晶 = 恰好 ` +
    `${num(Math.floor(START_RESOURCES.crystals / GACHA.COST_SINGLE))} 抽` +
    `（每抽 ${num(GACHA.COST_SINGLE)} 结晶）`,
)

if (OUT_PATH) {
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seedBase: SEED_BASE,
        seedCount: SEED_COUNT,
        dayHours: DAY_HOURS,
        chunkHours: CHUNK_HOURS,
        accounts,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\n基线已写入：${OUT_PATH}`)
}

console.log('\n' + '='.repeat(78))

/** 集齐一个十连的结晶需要签到几天 */
function daysForNextTenPull(): number {
  const need = GACHA.COST_SINGLE * GACHA.TEN_PULL_COUNT
  const perCycle = DAILY.SIGN_IN_REWARDS.reduce((sum, r) => sum + (r.crystals ?? 0), 0)
  return Math.ceil(need / (perCycle / DAILY.SIGN_IN_CYCLE))
}
