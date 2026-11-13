import { describe, it, expect } from 'vitest'
import {
  BATTLE_LAYOUT,
  floatBaseY,
  minRequiredHeight,
  rowBottomY,
  rowCenterY,
  rowTopEdgeY,
  unitPosition,
} from '../../src/presentation/utils/battle-layout.ts'

/**
 * 战斗画面布局的不变量（AGENTS.md 铁律 #21）。
 *
 * 这组断言守的是「上排单位的血条不会被下排单位盖住」——
 * 它曾真实发生过：行距只按头像直径估算（45.6px），
 * 而遮挡边界其实是**定位色环（r+2）/ BOSS 双环（r+6）**画出的更高外缘。
 */

/** 画布高度的候选值：实际用的那个，以及更高的情况 */
const HEIGHTS = [BATTLE_LAYOUT.canvasHeight, 320, 360]

describe('战斗画面布局 · 纵向不重叠', () => {
  it('相邻两排不得重叠：下一排的最上缘 ≥ 上一排的最下沿', () => {
    for (const h of HEIGHTS) {
      for (let row = 0; row < 2; row++) {
        expect(rowTopEdgeY(row + 1, h)).toBeGreaterThanOrEqual(rowBottomY(row, h))
      }
    }
  })

  it('最坏情况（BOSS 双环）也不重叠', () => {
    // 双环外缘 = 头像半径 + bossOut，是所有元素里最高的一圈
    const worst = BATTLE_LAYOUT.unitRadius + BATTLE_LAYOUT.bossOut
    for (const h of HEIGHTS) {
      for (let row = 0; row < 2; row++) {
        const nextTop = rowCenterY(row + 1, h) - worst
        expect(nextTop).toBeGreaterThanOrEqual(rowBottomY(row, h))
      }
    }
  })

  it('第三排的下沿不得压到底部事件条', () => {
    for (const h of HEIGHTS) {
      expect(rowBottomY(2, h)).toBeLessThanOrEqual(h - BATTLE_LAYOUT.eventBarHeight)
    }
  })

  it('画布高度不得低于三排所需的下限（否则第三排被裁掉）', () => {
    expect(BATTLE_LAYOUT.canvasHeight).toBeGreaterThanOrEqual(minRequiredHeight())
    // 顶部还要留出飘字空间
    expect(BATTLE_LAYOUT.rowTop - BATTLE_LAYOUT.floatRise).toBeGreaterThanOrEqual(
      BATTLE_LAYOUT.floatMinY,
    )
  })

  it('名牌与血条都在头像下方（头顶只留给飘字）', () => {
    expect(BATTLE_LAYOUT.barDy).toBeGreaterThan(BATTLE_LAYOUT.unitRadius)
    expect(BATTLE_LAYOUT.nameDy).toBeGreaterThan(BATTLE_LAYOUT.barDy)
    expect(BATTLE_LAYOUT.nameBottom).toBeGreaterThan(BATTLE_LAYOUT.barDy)
  })

  it('行距不得小于「双环外缘 + 名牌下沿」', () => {
    const need = BATTLE_LAYOUT.unitRadius + BATTLE_LAYOUT.bossOut + BATTLE_LAYOUT.nameBottom
    expect(BATTLE_LAYOUT.rowGap).toBeGreaterThanOrEqual(need)
  })
})

describe('战斗画面布局 · 飘字不出画布', () => {
  it('任意进度下飘字基线都不低于下限', () => {
    const y0 = rowCenterY(0, 300)
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(floatBaseY(y0, p)).toBeGreaterThanOrEqual(BATTLE_LAYOUT.floatMinY)
    }
  })

  it('字顶不得为负（基线 ≥ 最大字号）', () => {
    expect(BATTLE_LAYOUT.floatMinY).toBeGreaterThanOrEqual(BATTLE_LAYOUT.floatMaxFont)
    const y0 = rowCenterY(0, 300)
    for (const p of [0, 0.5, 1]) {
      expect(floatBaseY(y0, p) - BATTLE_LAYOUT.floatMaxFont).toBeGreaterThanOrEqual(0)
    }
  })

  it('飘字确实在向上飘（进度越大基线越靠上）', () => {
    const y0 = rowCenterY(0, 300)
    expect(floatBaseY(y0, 0)).toBeGreaterThan(floatBaseY(y0, 1))
  })
})

describe('战斗画面布局 · 站位', () => {
  it('前排朝敌：我方在左、敌方在右', () => {
    const ally = unitPosition({ side: 'ally', slot: 0 }, 400, 300)
    const enemy = unitPosition({ side: 'enemy', slot: 0 }, 400, 300)
    expect(ally.x).toBeLessThan(enemy.x)
  })

  it('后排（slot 3-5）在前排之后，且更靠后', () => {
    const front = unitPosition({ side: 'ally', slot: 0 }, 400, 300)
    const back = unitPosition({ side: 'ally', slot: 3 }, 400, 300)
    // slot 3 = row 0 / col 1（纵深在后），slot 4 = row 1（纵向更后）
    expect(back.x).toBeLessThan(front.x)
    expect(rowCenterY(1, 300)).toBeGreaterThan(rowCenterY(0, 300))
  })

  it('用真实槽位号：slot 4/5 落在第二、三排', () => {
    expect(rowCenterY(4 % 3, 300)).toBe(rowCenterY(1, 300))
    expect(rowCenterY(5 % 3, 300)).toBe(rowCenterY(2, 300))
  })
})
