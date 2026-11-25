/**
 * 主线掉落表 + **遗物副本掉落**（遗物副本 v12）。
 *
 * ## 遗物的来源：只有「遗物副本」
 *
 * 旧版遗物是**掉落表的一列**（`relicDrop`），挂机 / 手动挑战都会掉。
 * 挂机改版 v11 把遗物从掉落表里**摘掉**，改走独立入口 `relic.acquire`
 * （花银两祈愿）；**遗物副本 v12 把祈愿也彻底下线了** ——
 * 遗物现在**只**从遗物副本（6 个副本 × 3 难度）产出。
 *
 * 这么做的原因：
 *
 * - 遗物是**实例**（实物），不该按掉落表的概率池批量产出；
 * - 祈愿是**零成本**产出，而仓库溢出时会被自动分解折算成银两
 *   ⇒ 无限印钞；
 * - 遗物是**整条强化链的入口**：初阶强化副本要求「持有 Lv1 遗物」才解锁，
 *   所以「首件遗物」的可达性由**遗物副本的解锁线**保证
 *   （`RELIC_DROP.UNLOCK_STAGE`：第一个副本在主线第 1 关即可进入）。
 *
 * ## 守什么
 *
 * 1. `DROP_TABLES` **不含任何遗物**（连字段都没有）；
 * 2. 主线掉落表只含「银两 + 经验书」；
 * 3. 掉落概率与配置一致（概率就是概率，不是权重池）；
 * 4. **遗物副本**：手动挑战胜利 ⇒ 发出 `rewards.relics` 且实例真的入库；
 *    稀有度分布与**公示口径** `relicDropRates()` 一致；
 *    保底按「件」计（连续 10 件未出 SSR ⇒ 第 11 件必出 SSR）；
 *    池内等概率；手动挑战**不受每日额度**限制（额度只管挂机）；
 * 5. **材料副本仍然只发材料**（`rewards.relics` 为 `undefined`）。
 *
 * ⚠ 铁律 #4：概率期望**一律读 core 的 `relicDropRates()`**，
 *   测试里禁止另写一份期望常量表（两处各写一套 ⇒ 改权重就有一处对不上）。
 */
import { describe, expect, it } from 'vitest'
import {
  DROP_GROWTH,
  DROP_TABLES,
  EXP_BOOK,
  RELIC,
  RELIC_DROP,
  type DropTableDef,
} from '../../src/core/config/economy.ts'
import { STAGES } from '../../src/core/config/stages.ts'
import { rollMainDrop } from '../../src/core/systems/idle.ts'
import { applyAction } from '../../src/core/systems/actions.ts'
import { RELIC_DEFS, relicDropRates, rollRelicDrop } from '../../src/core/systems/relic.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { Rng } from '../../src/core/rng.ts'
import { ITEM_IDS, isExpBook } from '../../src/core/config/items.ts'
import {
  DUNGEON_INDEX,
  dungeonStageById,
  dungeonStageId,
  relicPoolOf,
} from '../../src/core/config/dungeons.ts'
import { parseGameAction } from '../../src/core/systems/action-protocol.ts'
import type { SaveData } from '../../src/core/model/types.ts'
import type { ActionContext } from '../../src/core/systems/actions.ts'

const NOW = 1_700_000_000_000

/** 掉落表里期望产出的经验（概率 × 数量 × 面额） */
function expectedExp(table: DropTableDef): number {
  return table.items.reduce((sum, d) => {
    if (!isExpBook(d.id)) return sum
    const face = d.id === EXP_BOOK.small.id ? EXP_BOOK.small.exp : EXP_BOOK.large.exp
    return sum + (d.chance / 100) * ((d.min + d.max) / 2) * face
  }, 0)
}

/** 某一章的普通关 / BOSS 掉落表 */
function tableOf(chapter: number, boss: boolean): DropTableDef {
  const stage = STAGES.find((s) => s.chapter === chapter && s.isBoss === boss)
  if (!stage) throw new Error(`找不到第 ${chapter} 章的${boss ? 'BOSS' : '普通关'}`)
  const table = DROP_TABLES[stage.dropTableId]
  if (!table) throw new Error(`找不到掉落表：${stage.dropTableId}`)
  return table
}

function actionCtx(now = NOW, seed = 42): ActionContext {
  return { now, rng: new Rng(seed), randomSeed: () => seed }
}

/**
 * 造一份**打得赢副本**的存档（遗物副本的产出链必须真能跑通）。
 *
 * ⚠ 遗物副本的解锁线是**主线进度**（不是战力），所以这里把 `clearedStage`
 *   顶到 1，让第一个遗物副本（`relicZhanTan`）可进。
 *
 * ⚠ `skillLevels` 默认满级（战力最高）；**技能副本**的解锁判定读的是
 *   「还有没有技能能升」，满级 ⇒ 技能副本是锁着的 ⇒ 测材料副本时要传低等级。
 */
function strongSave(skillLevels: [number, number, number] = [20, 20, 20]): SaveData {
  const save = createNewSave(NOW, 7)
  save.heroes.xiangyu = { ...createHeroState('xiangyu', NOW), level: 240, star: 6, skillLevels }
  save.team.slots[0] = 'xiangyu'
  save.campaign.clearedStage = 1
  return save
}

/** 遗物副本「锋锐 · 简易」关卡 id（关卡 id 的唯一出处是 `dungeonStageId`） */
const RELIC_EASY = dungeonStageId('relicZhanTan', 'easy')
/** 材料副本「土 · 简易」关卡 id（对照组：材料副本**只**发材料） */
const SKILL_EARTH_EASY = dungeonStageId('skillEarth', 'easy')

describe('主线掉落表：只剩银两 + 经验书', () => {
  it('掉落表**没有遗物字段**（遗物已移出掉落表）', () => {
    // ⚠ 挂机改版 v11 + 遗物副本 v12：遗物**只**从遗物副本产出。
    //   如果 `relicDrop` 这类字段被加回来，遗物就会又变成"概率池里的一档"，
    //   而遗物是**实例**（实物），不该按概率批量产出。
    for (const [id, table] of Object.entries(DROP_TABLES)) {
      expect(Object.keys(table).sort(), `${id} 的掉落表字段不对`).toEqual(['items', 'silver'])
      expect('relicDrop' in table, `${id} 又有遗物掉落了`).toBe(false)
    }
  })

  it('每张掉落表都投经验书，且只投已登记的道具', () => {
    for (const [id, table] of Object.entries(DROP_TABLES)) {
      const ids = table.items.map((d) => d.id)
      expect(ids.length, `${id} 应当有经验书投放`).toBeGreaterThan(0)
      for (const itemId of ids) {
        expect(isExpBook(itemId), `${id} 应当只投经验书（实际投了 ${itemId}）`).toBe(true)
        expect(ITEM_IDS, `${id} 的道具 id 必须已登记`).toContain(itemId)
      }
      // 概率与数量都合法
      for (const d of table.items) {
        expect(d.chance).toBeGreaterThan(0)
        expect(d.chance).toBeLessThanOrEqual(100)
        expect(d.min).toBeGreaterThanOrEqual(1)
        expect(d.max).toBeGreaterThanOrEqual(d.min)
      }
    }
  })

  it('掉落表里没有任何遗物 id（遗物不是道具，不进背包）', () => {
    // ⚠ 遗物 id 与道具 id 是两套命名空间；一旦有人把遗物 id 塞进掉落表，
    //   表现层会当成"未知道具"渲染（背包里出现没有名字的条目，铁律 #22）。
    const relicIds = new Set(RELIC_DEFS.keys())
    for (const [id, table] of Object.entries(DROP_TABLES)) {
      for (const d of table.items) {
        expect(relicIds.has(d.id), `${id} 混进了遗物 ${d.id}`).toBe(false)
      }
    }
  })

  it('银两照旧发放（经验书不是唯一的掉落）', () => {
    const stage = STAGES.find((s) => s.chapter === 1 && !s.isBoss)!
    const table = DROP_TABLES[stage.dropTableId]
    const rng = new Rng(7)
    const rolled = rollMainDrop(stage, rng)
    expect(rolled.silver).toBeGreaterThanOrEqual(table.silver[0])
    // ⚠ 遗物不再由掉落表产出（这条锁死挂机改版 v11 的新口径）
    expect(rolled.relics ?? []).toEqual([])
  })
})

describe('主线掉落表：经验投放的期望与概率', () => {
  it('期望经验随章节按 DROP_GROWTH 增长（普通关 / BOSS 各一条曲线）', () => {
    const chapters = [...new Set(STAGES.map((s) => s.chapter))].sort((a, b) => a - b)
    for (const boss of [false, true]) {
      const base = expectedExp(tableOf(chapters[0], boss))
      expect(base).toBeGreaterThan(0)
      for (const chapter of chapters) {
        const got = expectedExp(tableOf(chapter, boss))
        const want = base * Math.pow(DROP_GROWTH, chapter - chapters[0])
        // 容差 1%：数量向上取整会让期望值有小幅偏差
        expect(Math.abs(got - want) / want, `第 ${chapter} 章期望经验偏了`).toBeLessThan(0.01)
      }
    }
  })

  it('实际掷骰的出书率 ≈ 配置概率（概率就是概率，不是权重池）', () => {
    // ⚠ 概率公示与实际执行必须同一份（铁律 #4）。
    //   这条用大样本蒙特卡洛盯住"公示 10% 就是 10%"。
    const N = 20_000
    for (const chapter of [1, 3, 5, 8]) {
      for (const boss of [false, true]) {
        const stage = STAGES.find((s) => s.chapter === chapter && s.isBoss === boss)!
        const table = DROP_TABLES[stage.dropTableId]
        const rng = new Rng(20260919 + chapter * 10 + (boss ? 1 : 0))
        const hits: Record<string, number> = {}
        const counts: Record<string, number> = {}
        for (let i = 0; i < N; i++) {
          const rolled = rollMainDrop(stage, rng)
          for (const d of table.items) {
            const n = rolled.items?.[d.id] ?? 0
            if (n <= 0) continue
            hits[d.id] = (hits[d.id] ?? 0) + 1
            counts[d.id] = (counts[d.id] ?? 0) + n
          }
        }
        for (const d of table.items) {
          const p = d.chance / 100
          const rate = (hits[d.id] ?? 0) / N
          // 伯努利抽样：3σ 容差（早期章节出书率只有 10%，相对误差天然大）
          const tol = 3 * Math.sqrt((p * (1 - p)) / N) + 1e-9
          expect(Math.abs(rate - p), `第 ${chapter} 章 ${d.id} 出书率偏了`).toBeLessThan(tol)
          // 出的时候数量就是配置的数量（经验书是固定本数）
          if (hits[d.id]) {
            const avgCount = counts[d.id] / hits[d.id]
            expect(avgCount).toBeGreaterThanOrEqual(d.min)
            expect(avgCount).toBeLessThanOrEqual(d.max)
          }
        }
      }
    }
  })
})

describe('遗物副本掉落（遗物的唯一来源）', () => {
  /**
   * 遗物副本「锋锐 · 简易」的候选池（**唯一出处**：`relicPoolOf`）。
   *
   * ⚠ 测试里**禁止**自己拼遗物 id 列表：候选池是「套装 → 遗物 id」的映射
   *   （`config/relics.ts`），手写一份必然与配置漂移（铁律 #8）。
   */
  function relicPool(): readonly string[] {
    const variant = DUNGEON_INDEX.get('relicZhanTan')
    if (!variant) throw new Error('缺少遗物副本变体 relicZhanTan')
    return relicPoolOf(variant)!
  }

  it('手动挑战遗物副本胜利 ⇒ 发出 `rewards.relics`，实例真的入库', () => {
    // ⚠ 铁律 #22：「配置齐全」≠「功能可用」。
    //   遗物是**整条强化链的入口**（初阶强化副本要求「持有 Lv1 遗物」才解锁），
    //   所以「打一把遗物副本 → 仓库里真的多了一件」必须被守住。
    const save = strongSave()
    const before = save.relics.length
    const res = applyAction(save, { type: 'dungeon.challenge', stageId: RELIC_EASY }, actionCtx(NOW, 20260925))

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.win).toBe(true)

    // ① 奖励包里真的有遗物（走 `rewards` 这一份口径，铁律 #26）
    const defIds = res.result.rewards.relics
    expect(defIds, '遗物副本胜利没有发出 rewards.relics').toBeTruthy()
    expect(defIds!.length).toBeGreaterThan(0)

    // ② 实例**真的入库**了（不是只挂在旁路数组上 —— 那条老 bug 让 100% 产出被丢弃）
    expect(save.relics).toHaveLength(before + defIds!.length)
    const inst = save.relics[save.relics.length - 1]
    expect(defIds).toContain(inst.defId)
    expect(RELIC_DEFS.get(inst.defId)).toBeTruthy()
    // 等级 = 最低强化等级（口径取 core 常量，不在测试里写死数字）
    expect(inst.level).toBe(RELIC.MIN_LEVEL)

    // ③ uid 唯一（存档内自增序号派生 ⇒ 天然不碰撞）
    expect(new Set(save.relics.map((r) => r.uid)).size).toBe(save.relics.length)
  })

  it('稀有度分布与公示口径 `relicDropRates()` 一致（公示 = 实际，铁律 #4）', () => {
    // ⚠ **期望值一律读 core 的 `relicDropRates(difficulty)`**——
    //   测试里绝不能另写一份 `{N:45,R:35,SR:15,SSR:5}`（铁律 #4）：
    //   两处各写一套，改了权重就有一处对不上，公示与实际脱节（合规硬伤）。
    //
    // ⚠ **为什么放宽到 ±3 个百分点**：
    //   ① 蒙特卡洛抽样本身有统计误差（3σ 下 SSR 的标准差约 0.3%，本来够用）；
    //   ② `rollRelicDrop` 一次可能出 1~3 件，「件」与「次」不是同一个分母，
    //      换算时多了一层取整误差；
    //   ③ 本条**刻意隔离了保底**（每次调用都从 pity = 0 起算），
    //      测的就是「公示的基础权重表」本身；
    //      保底带来的加成由下面那条单独盯住（不是混进来稀释断言）。
    const pool = relicPool()
    const N = 5000
    const difficulties = ['easy', 'normal', 'hard'] as const
    for (let d = 0; d < difficulties.length; d++) {
      const difficulty = difficulties[d]
      const rng = new Rng(20260925 + d)
      const seen: Record<string, number> = {}
      let items = 0
      for (let i = 0; i < N; i++) {
        const rolled = rollRelicDrop(pool, difficulty, rng, 0)
        for (const defId of rolled.defIds) {
          const rarity = RELIC_DEFS.get(defId)!.rarity
          seen[rarity] = (seen[rarity] ?? 0) + 1
          items++
        }
      }
      expect(items, `${difficulty} 一次都没出件`).toBeGreaterThan(0)
      for (const rate of relicDropRates(difficulty)) {
        const actual = (seen[rate.rarity] ?? 0) / items
        expect(
          Math.abs(actual - rate.percent),
          `${difficulty} 的 ${rate.rarity} 实际占比 ${actual} 偏离公示 ${rate.percent}`,
        ).toBeLessThan(0.03)
      }
    }
  })

  it('保底按「件」计：连续 10 件未出 SSR ⇒ 第 11 件必出 SSR，计数归零', () => {
    const pool = relicPool()
    // ⚠ 保底计数是**入参**（随存档落盘在 `save.relicPity`）——
    //   这里直接把它顶到阈值，等价于「已经连续 10 件没出 SSR」。
    const rolled = rollRelicDrop(pool, 'easy', new Rng(11), RELIC_DROP.PITY_SSR, 1)
    expect(rolled.defIds).toHaveLength(1)
    expect(RELIC_DEFS.get(rolled.defIds[0])!.rarity).toBe('SSR')
    // 出了 SSR ⇒ 保底计数归零
    expect(rolled.pity).toBe(0)
  })

  it('保底在自然掉落中也会触发，且逐件重放与 core 返回的计数一致', () => {
    const pool = relicPool()
    const rng = new Rng(20260926)
    let pity = 0
    let sawForced = false
    // ⚠ easy 档一次**恰好一件** ⇒ 「件」与「次」同义，便于逐件核对。
    for (let i = 0; i < 200; i++) {
      const before = pity
      const rolled = rollRelicDrop(pool, 'easy', rng, pity, 1)
      const rarity = RELIC_DEFS.get(rolled.defIds[0])!.rarity
      if (before >= RELIC_DROP.PITY_SSR) {
        // 保底窗口内 ⇒ 必出 SSR，且计数归零
        expect(rarity, '保底窗口内没有出 SSR').toBe('SSR')
        expect(rolled.pity).toBe(0)
        sawForced = true
      } else {
        // 未触发 ⇒ 非 SSR 加 1、出 SSR 归零（逐件记账）
        expect(rolled.pity).toBe(rarity === 'SSR' ? 0 : before + 1)
      }
      pity = rolled.pity
    }
    // 200 件里保底**必然**触发过（否则保底就是死代码）
    expect(sawForced).toBe(true)
  })

  it('一次掉多件时保底**逐件**累加（不是按场次计）', () => {
    const pool = relicPool()
    // ⚠ hard 档一次出 2~3 件 ⇒ 保底必须**逐件**推进。
    //   起始 pity = 8：两件最多把计数推到 10，**触发不了保底**
    //   （保底要求「掷之前」计数已 ≥ 阈值）⇒ 可以干净地验证「逐件累加」。
    //   固定种子 2 ⇒ 这两件恰好都是非 SSR（N + R），断言可以写死。
    const rolled = rollRelicDrop(pool, 'hard', new Rng(2), 8, 2)
    expect(rolled.defIds).toHaveLength(2)

    const rarities = rolled.defIds.map((id) => RELIC_DEFS.get(id)!.rarity)
    expect(rarities.every((r) => r !== 'SSR'), '固定种子应当两件都不是 SSR').toBe(true)

    // 逐件重放 core 的保底规则 ⇒ 必须与 core 返回的计数逐位一致
    let expected = 8
    for (const rarity of rarities) expected = rarity === 'SSR' ? 0 : expected + 1
    expect(rolled.pity).toBe(expected)

    // ⚠ **逐件**而不是「按场」：两件都是非 SSR 时，计数必须 **+2**（8 → 10，不是 8 → 9）
    expect(rolled.pity).toBe(10)
  })

  it('多件掉落里出了 SSR ⇒ 计数归零后从 0 重新累加（逐件规则的另一半）', () => {
    const pool = relicPool()
    // ⚠ 起始 pity = 9：第一件若非 SSR，计数到 10，第二件**仍不是保底**
    //   （保底要求「掷之前」计数已达阈值）⇒ 覆盖得到
    //   「SSR 把计数打回 0、随后非 SSR 从 0 重新累加」这条路径。
    const rolled = rollRelicDrop(pool, 'hard', new Rng(2), 9, 2)
    const rarities = rolled.defIds.map((id) => RELIC_DEFS.get(id)!.rarity)

    let expected = 9
    for (const rarity of rarities) expected = rarity === 'SSR' ? 0 : expected + 1
    expect(rolled.pity).toBe(expected)
  })

  it('池内等概率：同一稀有度下的每个候选都出现过（没有偏袒某一件）', () => {
    // ⚠ 候选池里两件同稀有度的遗物，如果抽签有偏袒（比如总抽第一件），
    //   玩家集齐一套的难度就会凭空变高 —— 这条守住「池内等概率」。
    const pool = relicPool()
    const rng = new Rng(20260928)
    const seen = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      const rolled = rollRelicDrop(pool, 'easy', rng, 0)
      for (const defId of rolled.defIds) seen.add(defId)
    }
    // 池里的每一件都出现过（3000 次 × 45% 起步 ⇒ 覆盖是稳的）
    for (const defId of pool) {
      expect(seen.has(defId), `候选池里的 ${defId} 从没出现过`).toBe(true)
    }
  })

  it('⚠ 手动挑战**不受每日额度限制**（额度只管挂机）', () => {
    // ⚠ `RELIC_DROP.DAILY_CAP` 是**挂机**的防通胀闸门：
    //   遗物是零成本产出，仓库溢出会自动分解折算成银两 ⇒ 挂机不限额就是印钞机。
    //   手动挑战是**主动行为**（逐场结算、耗时换产出），不该被额度卡住。
    const save = strongSave()
    for (let i = 0; i < 30; i++) {
      const res = applyAction(save, { type: 'dungeon.challenge', stageId: RELIC_EASY }, actionCtx(NOW, 5000 + i))
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.result.win).toBe(true)
    }
    // 30 场手动挑战 ⇒ 额度计数**仍然是 0**
    expect(save.relicDaily.count).toBe(0)
    // 但遗物确实产出了（否则「不受限制」就是空话）
    expect(save.relics.length).toBeGreaterThan(0)
  })

  it('材料副本仍然只发材料：`rewards.relics` 为 undefined，items 只有该副本的材料', () => {
    // ⚠ 遗物副本与材料副本是**两种产出形状**：遗物是实例（`rewards.relics`），
    //   材料是堆叠物（`rewards.items`）。一关**只**产其中一种（铁律 #22）。
    const save = strongSave([1, 1, 1])
    const stage = dungeonStageById(SKILL_EARTH_EASY)!
    expect(stage.drop, '材料副本必须有 drop').toBeTruthy()
    const res = applyAction(save, { type: 'dungeon.challenge', stageId: SKILL_EARTH_EASY }, actionCtx(NOW, 20260929))

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.win).toBe(true)
    expect(res.result.rewards.relics).toBeUndefined()
    expect(Object.keys(res.result.rewards.items ?? {})).toEqual([stage.drop!.itemId])
    // 仓库里一件遗物都没有
    expect(save.relics).toHaveLength(0)
  })

  it('⚠ 祈愿入口已彻底下线：协议层显式拒绝 `relic.acquire`', () => {
    // ⚠ 遗物来源**只有一个**（遗物副本）。协议里若还留着祈愿分支，
    //   会让人以为「花银两买遗物」还在 ⇒ 玩家找不到入口 / 文档对不上。
    expect(parseGameAction({ type: 'relic.acquire' })).toBeNull()
  })

  it('⚠ 保底会把长期实际 SSR 产出率抬到约 12%（公示表是**基础权重**）', () => {
    // ⚠ **这是一条「如实记录现状」的测试**，不是「公示 = 实际」的证明：
    //   `relicDropRates()` 公示的是**基础权重**（SSR 5%），
    //   而 `PITY_SSR = 10` 的保底会把**长期实际**产出率抬到约 11~12%
    //   （保底窗口内必有 1 件 SSR）。
    //   ⇒ 玩家按公示理解「每 20 件出 1 件 SSR」，实际约每 8~9 件就出 1 件。
    //
    // ⚠ 之所以**放宽到 ±1.25 个百分点**：这里比较的是「保底后的长期率」
    //   与一个**理论量级**（几何分布求和 ≈ 11.6%），不是与公示表比；
    //   真正的「公示 = 实际」由上面那条（隔离保底的基础权重）守住。
    const pool = relicPool()
    const rng = new Rng(20260930)
    let pity = 0
    let items = 0
    let ssr = 0
    for (let i = 0; i < 5000; i++) {
      const rolled = rollRelicDrop(pool, 'easy', rng, pity)
      pity = rolled.pity
      for (const defId of rolled.defIds) {
        items++
        if (RELIC_DEFS.get(defId)!.rarity === 'SSR') ssr++
      }
    }
    const rate = ssr / items
    expect(rate).toBeGreaterThan(0.1)
    expect(rate).toBeLessThan(0.125)
  })
})
