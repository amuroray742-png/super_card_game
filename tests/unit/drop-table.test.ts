/**
 * 主线掉落表 + 遗物的独立获取入口（挂机改版 v11）。
 *
 * ## 为什么要拆成两件事
 *
 * 旧版遗物是**掉落表的一列**（`relicDrop`），挂机 / 手动挑战都会掉。
 * 挂机改版 v11 把遗物从掉落表里**摘掉**，改走独立入口 `relic.acquire`
 * （`RELIC_ACQUIRE`：花银两祈愿）。
 *
 * 这么做的原因：
 *
 * - 遗物是**实例**（实物），不该按掉落表的概率池批量产出；
 * - 遗物是**整条强化链的入口**：初阶强化副本要求"持有 Lv1 遗物"才解锁，
 *   新档仓库是空的 ⇒ 没有独立入口，整条强化链路从第一步就锁死。
 *
 * ## 守什么
 *
 * 1. `DROP_TABLES` **不含任何遗物**（连字段都没有）；
 * 2. 主线掉落表只含「银两 + 经验书」；
 * 3. 掉落概率与配置一致（概率就是概率，不是权重池）；
 * 4. `relic.acquire`：扣费前先校验余额（不足拒绝、不产生负数）、
 *    产出恰好一件遗物、重复祈愿 uid 不重复、稀有度分布与公示权重一致。
 */
import { describe, expect, it } from 'vitest'
import {
  DROP_GROWTH,
  DROP_TABLES,
  EXP_BOOK,
  RELIC_ACQUIRE,
  type DropTableDef,
} from '../../src/core/config/economy.ts'
import { STAGES } from '../../src/core/config/stages.ts'
import { rollMainDrop } from '../../src/core/systems/idle.ts'
import { applyAction } from '../../src/core/systems/actions.ts'
import { RELIC_DEFS } from '../../src/core/systems/relic.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { Rng } from '../../src/core/rng.ts'
import { ITEM_IDS, isExpBook } from '../../src/core/config/items.ts'
import type { Rarity } from '../../src/core/model/types.ts'
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

describe('主线掉落表：只剩银两 + 经验书', () => {
  it('掉落表**没有遗物字段**（遗物已移出掉落表）', () => {
    // ⚠ 挂机改版 v11：遗物改走独立入口 `relic.acquire`。
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

describe('遗物祈愿（relic.acquire）：遗物的独立获取入口', () => {
  it('扣 `RELIC_ACQUIRE.SILVER_COST` 银两，产出恰好一件遗物', () => {
    const save = createNewSave(NOW, 11)
    save.player.silver = RELIC_ACQUIRE.SILVER_COST * 3
    const ctx = actionCtx()
    const res = applyAction(save, { type: 'relic.acquire' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.silver).toBe(RELIC_ACQUIRE.SILVER_COST)
    expect(save.player.silver).toBe(RELIC_ACQUIRE.SILVER_COST * 2)
    expect(save.relics).toHaveLength(1)
    expect(save.relics[0].uid).toBe(res.result.uid)
    expect(save.relics[0].defId).toBe(res.result.relicId)
    // 遗物 id 必须是真实存在的定义
    expect(RELIC_DEFS.get(res.result.relicId)).toBeTruthy()
  })

  it('余额不足时被拒，且**不产生负数**', () => {
    // ⚠ 铁律 #10 / #22：扣费动作必须先做余额校验。
    //   历史教训：抽卡曾把圣杯结晶扣成负数（总闸门失效）。
    const save = createNewSave(NOW, 11)
    save.player.silver = RELIC_ACQUIRE.SILVER_COST - 1
    const ctx = actionCtx()
    const res = applyAction(save, { type: 'relic.acquire' }, ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('INSUFFICIENT_FUNDS')
    expect(save.player.silver).toBe(RELIC_ACQUIRE.SILVER_COST - 1)
    expect(save.player.silver).toBeGreaterThanOrEqual(0)
    expect(save.relics).toHaveLength(0)
  })

  it('重复祈愿产生**不同的 uid**（实例不能互相覆盖）', () => {
    // ⚠ 历史教训：遗物 uid 曾用"随机后缀"，量级上千后必然碰撞，
    //   碰撞会让 `save.relics.find(r => r.uid === uid)` 命中**错误**遗物
    //   （强化 / 分解错件）。现在 uid 由存档内自增序号派生。
    const save = createNewSave(NOW, 11)
    save.player.silver = RELIC_ACQUIRE.SILVER_COST * 5
    const ctx = actionCtx()
    const uids: string[] = []
    for (let i = 0; i < 3; i++) {
      const res = applyAction(save, { type: 'relic.acquire' }, ctx)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      uids.push(res.result.uid)
    }
    expect(new Set(uids).size).toBe(3)
    expect(save.relics).toHaveLength(3)
    expect(save.relics.map((r) => r.uid)).toEqual(uids)
  })

  it('祈愿的稀有度分布与公示权重一致', () => {
    // ⚠ 合规硬要求：公示的权重必须等于实际行为。
    //   遗物不走掉落表的概率列，改由 `RELIC_ACQUIRE.RARITY_WEIGHTS` 公示，
    //   这里用大样本盯住实际分布。
    const N = 4000
    const save = createNewSave(NOW, 11)
    const ctx = actionCtx(NOW, 20260920)
    const seen: Record<string, number> = {}
    for (let i = 0; i < N; i++) {
      // 每次都补足银两（库存上限会自动分解多余的遗物，不影响稀有度统计）
      save.player.silver = RELIC_ACQUIRE.SILVER_COST * 2
      const res = applyAction(save, { type: 'relic.acquire' }, ctx)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      const rarity = RELIC_DEFS.get(res.result.relicId)?.rarity
      expect(rarity).toBeTruthy()
      seen[rarity!] = (seen[rarity!] ?? 0) + 1
    }
    const total = Object.values(RELIC_ACQUIRE.RARITY_WEIGHTS).reduce((a, b) => a + b, 0)
    for (const [rarity, weight] of Object.entries(RELIC_ACQUIRE.RARITY_WEIGHTS)) {
      const p = weight / total
      const rate = (seen[rarity as Rarity] ?? 0) / N
      // 4σ 容差（N=4000 时 SSR(3%) 的标准差约 0.27%）
      const tol = 4 * Math.sqrt((p * (1 - p)) / N) + 1e-9
      expect(Math.abs(rate - p), `${rarity} 稀有度分布偏了`).toBeLessThan(tol)
    }
  })
})
