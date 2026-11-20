/**
 * 主线掉落表：经验 → **经验书**（资源/背包版本 v10）。
 *
 * ## 为什么要有这条单测
 *
 * 经验池退役后，主线每场产出的经验变成**一叠叠经验书**，而经验书是
 * **概率掉落**（每类道具各自独立掷一次骰子，见 `economy.ts` 的 `expBookDrop`）。
 *
 * ⚠ 这让 E2E 很难断言：单场只有 ~73% 出书率（早期章节更低），
 *   「一场一定有书」是错的假设 → E2E 只能有界重试（见 `tests/e2e/authority.spec.ts`），
 *   仍然带着残余 flake。
 *
 * 所以**规则本身**（期望经验口径、投放的道具种类、章节成长）在这里用
 * **确定性**方式钉死：固定种子 + 解析式期望值。
 */
import { describe, expect, it } from 'vitest'
import {
  DROP_GROWTH,
  DROP_TABLES,
  EXP_BOOK,
  type DropTableDef,
} from '../../src/core/config/economy.ts'
import { STAGES } from '../../src/core/config/stages.ts'
import { rollRewards } from '../../src/core/systems/idle.ts'
import { Rng } from '../../src/core/rng.ts'
import { ITEM_IDS, isExpBook } from '../../src/core/config/items.ts'

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

describe('主线掉落表（经验 → 经验书）', () => {
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
    const N = 20_000
    for (const chapter of [1, 3, 5, 8]) {
      for (const boss of [false, true]) {
        const stage = STAGES.find((s) => s.chapter === chapter && s.isBoss === boss)!
        const table = DROP_TABLES[stage.dropTableId]
        const rng = new Rng(20260919 + chapter * 10 + (boss ? 1 : 0))
        const hits: Record<string, number> = {}
        const counts: Record<string, number> = {}
        for (let i = 0; i < N; i++) {
          const rolled = rollRewards(stage, rng)
          for (const d of table.items) {
            const n = rolled.rewards.items?.[d.id] ?? 0
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

  it('银两与遗物照旧发放（经验书不是唯一的掉落）', () => {
    const stage = STAGES.find((s) => s.chapter === 1 && !s.isBoss)!
    const table = DROP_TABLES[stage.dropTableId]
    const rng = new Rng(7)
    const rolled = rollRewards(stage, rng)
    expect(rolled.rewards.silver).toBeGreaterThanOrEqual(table.silver[0])
    expect(rolled.rewards.relics?.length ?? 0).toBe(1)
  })
})
