/**
 * 战斗画面布局（纯计算，**零 DOM 依赖**）。
 *
 * ## 为什么单独抽一个模块
 *
 * 「三排单位同屏时不重叠」是一条**可计算的不变量**：
 * 绘制顺序是前排先画、后排后画，后排一旦压到前排的血条或名牌上，
 * 玩家就看不到自己人的血量（历史教训：行距只按头像直径估算，
 * 结果上排血条被下排头像整个盖住）。
 *
 * 若这条约束只存在于「看截图时注意」，改一次行距就会静默回归。
 * 所以把几何算成纯函数，由 `tests/unit/battle-layout.test.ts` 直接断言：
 * **下一排的最上缘 ≥ 上一排的最下沿**。
 *
 * ⚠ 遮挡边界**不是头像边缘**，而是「定位色环（r+2）/ BOSS 双环（r+6）」
 *   画出的更高外缘——只按头像直径留距会被这两个外圈吃掉。
 */
import type { BattleUnitRosterEntry } from '../../core/model/types.ts'

/** 战斗画面布局常量（唯一口径，表现层与单测共用） */
export const BATTLE_LAYOUT = {
  /** 头像半径 */
  unitRadius: 21,
  /** 定位色环比头像外伸多少 */
  ringOut: 2,
  /** BOSS 双环比头像外伸多少 */
  bossOut: 6,
  /** 血条相对头像中心的纵向偏移 */
  barDy: 24,
  /** 血条高度 */
  barHeight: 5,
  /** 名牌基线相对头像中心的纵向偏移 */
  nameDy: 40,
  /** 名牌下沿相对头像中心的偏移（基线 + descender） */
  nameBottom: 42,
  /** 行距（相邻两排头像中心的纵向距离） */
  rowGap: 72,
  /** 第一排头像中心的纵坐标 */
  rowTop: 78,
  /** 底部事件条高度 */
  eventBarHeight: 28,
  /** 飘字基线相对头像中心的纵向偏移（负 = 在头顶） */
  floatDy: -46,
  /** 飘字上浮距离 */
  floatRise: 16,
  /** 飘字基线的最低位置（不出画布顶） */
  floatMinY: 20,
  /** 飘字最大字号（决定「字顶不得为负」） */
  floatMaxFont: 19,
  /** 名牌字号 */
  nameFont: 11,
  /**
   * 画布高度（CSS 像素）。
   *
   * ⚠ 不是随手定的：三排 + 顶部飘字空间 + 底部事件条必须完整放得下，
   *   画矮了就装不下第三排。渲染层用 CSS `v-bind` 绑定这个值，
   *   避免「常量改了但 CSS 没改」的两套口径。
   */
  canvasHeight: 300,
} as const

/**
 * 三排完整排布所需的**最小画布高度**。
 *
 * = 第一排中心 + 2 个行距 + 名牌下沿 + 底部事件条。
 */
export function minRequiredHeight(): number {
  return (
    BATTLE_LAYOUT.rowTop +
    2 * BATTLE_LAYOUT.rowGap +
    BATTLE_LAYOUT.nameBottom +
    BATTLE_LAYOUT.eventBarHeight
  )
}

/**
 * 某排头像中心的纵坐标。
 *
 * 画布高度变化时按比例兜底，但**下限取常量**——
 * 画布被压扁时宁可留白，也不能让三排糊在一起。
 */
export function rowCenterY(row: number, canvasHeight: number): number {
  const gap = Math.max(BATTLE_LAYOUT.rowGap, canvasHeight * 0.24)
  const top = Math.max(BATTLE_LAYOUT.rowTop - 14, canvasHeight * 0.26)
  return top + row * gap
}

/**
 * 某排画出的所有元素里，**最低的下沿**（目前是名牌下沿）。
 *
 * 血条在头像下方、名牌在血条下方，所以下沿由名牌决定。
 */
export function rowBottomY(row: number, canvasHeight: number): number {
  return rowCenterY(row, canvasHeight) + BATTLE_LAYOUT.nameBottom
}

/**
 * 某排**最上缘**的遮挡源（BOSS 双环外缘；普通单位是定位色环）。
 *
 * 这一圈是后画的，会压住上一排的元素——行距必须按它算。
 */
export function rowTopEdgeY(row: number, canvasHeight: number): number {
  return rowCenterY(row, canvasHeight) - (BATTLE_LAYOUT.unitRadius + BATTLE_LAYOUT.bossOut)
}

/**
 * 飘字基线的纵坐标。
 *
 * 上浮但**不出画布顶**；下界钳制保证字顶（基线 - 字号）不为负。
 */
export function floatBaseY(unitY: number, progress: number): number {
  const raw = unitY + BATTLE_LAYOUT.floatDy - progress * BATTLE_LAYOUT.floatRise
  return Math.max(BATTLE_LAYOUT.floatMinY, raw)
}

/**
 * 单位在画布上的位置（纯计算，便于单测与渲染共用同一口径）。
 *
 * ⚠ `slot` 是**真实编队槽位号**（0-2 前排 / 3-5 后排），
 *   队伍会跳过空槽位，用紧凑序号会把后排的人画到前排去（AGENTS.md 铁律 #16）。
 */
export function unitPosition(
  unit: Pick<BattleUnitRosterEntry, 'side' | 'slot'>,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  const row = unit.slot % 3
  const col = Math.floor(unit.slot / 3) // 0=前排 1=后排
  const x =
    unit.side === 'ally'
      ? canvasWidth * 0.3 - col * canvasWidth * 0.17
      : canvasWidth * 0.7 + col * canvasWidth * 0.17
  return { x, y: rowCenterY(row, canvasHeight) }
}
