/**
 * **覆盖层打开时锁住内容区滚动**。
 *
 * ## 为什么需要它
 *
 * 战斗回放改成了**全屏覆盖层**（`ChallengeReplay.vue`）：覆盖层是
 * `position: fixed`，它**盖住**了页面，但底下的 `.body` 仍然可以滚。
 * 玩家在演出途中滑动页面 → 关闭覆盖层后才发现页面已经跑位，
 * 「打完架回到原位」这个承诺就破了（AGENTS.md 铁律 #68 的 P2）。
 *
 * ## 为什么用行内样式而不是加一个 class
 *
 * `.body` 的 `overflow-y: auto` 写在 `App.vue` 的 **scoped** 样式里，
 * 全局 class 的优先级未必压得住 scoped 规则 ⇒ 直接改**行内样式**
 * （行内永远最高优先级），省掉一轮优先级纠缠。
 *
 * ⚠ 本文件在 `presentation/` 层，**允许**碰 DOM（铁律 #1 的零 DOM 约束只管
 *   `src/core/`）。
 */

/** 当前嵌套锁的层数（支持多层覆盖层叠加） */
let locks = 0

/** 加锁前 `.body` 原来的 overflow（解锁时原样还原） */
let savedOverflow: string | null = null

/** 内容区滚动容器（`.body` 是 `.shell` 里独立滚动的那一个） */
function bodyEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.body')
}

/** 锁住内容区滚动（可嵌套） */
export function lockBodyScroll(): void {
  locks += 1
  if (locks > 1) return
  const el = bodyEl()
  if (!el) return
  savedOverflow = el.style.overflow
  el.style.overflow = 'hidden'
}

/** 解锁内容区滚动（可嵌套） */
export function unlockBodyScroll(): void {
  if (locks === 0) return
  locks -= 1
  if (locks > 0) return
  const el = bodyEl()
  if (!el) return
  el.style.overflow = savedOverflow ?? ''
  savedOverflow = null
}
