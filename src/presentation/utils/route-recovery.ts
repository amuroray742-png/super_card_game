/**
 * 路由「懒加载组件拉取失败」的兜底策略。
 *
 * ⚠ **为什么需要它**：Vue Router 的路由组件全是 `() => import(...)` 懒加载。
 * 拉取失败时（dev server 重启、发版后 chunk 失效、网络抖动）有两种表现，
 * 而玩家看到的都是同一句「页面打不开」：
 *   - **初始导航失败** → `router.isReady()` reject → `main.ts` 的 `.then(mount)`
 *     不执行 → 应用**根本没挂载** → 整页白屏；
 *   - **后续导航失败** → 导航被中止（hash 模式连 URL 都不会改）
 *     → 玩家点了「背包」，**什么都没发生**，也不会有任何提示。
 * 原因只是一次请求失败，却没有任何一句提示 —— 这就是「页面打不开」的全部真相。
 *
 * ⚠ **恢复要「送到目的地」，不是「回到原地」**：只重载的话，页面会回到失败前那页，
 *   玩家点的目标依然没打开（等于白重载一次）。
 *   所以要把**失败时想去的目标路由**记下来，重载后再自动重试一次。
 *
 * ⚠ **本模块只做判定与决策，零 DOM 依赖** → 可在 Node 下单测；
 * 真正的「重载 / 重试 / 回退」动作由 `router.ts` 执行（那是唯一碰 DOM 的地方）。
 */

/** 兜底回退路由：任何页面打不开时都有地方可去（首页是首屏，最不容易加载失败） */
export const ROUTE_FALLBACK = '/expedition'

/**
 * 动态导入失败的报错特征。
 *
 * ⚠ 各浏览器 / 各打包器的措辞不一样（Chrome / Firefox / Safari / Rollup 各一套），
 * 这里全收 —— 漏一个就等于「在某些浏览器上照样白屏」。
 */
const CHUNK_ERROR_PATTERNS = [
  'dynamically imported module',
  'importing a module script failed',
  'loading module script failed',
  'failed to load module script',
  'failed to fetch module script',
] as const

/**
 * 兜底动作。
 *
 * - `reload`：整页重载一次（换一份新的模块图 / 新的 chunk 清单），**并记住要去哪**
 * - `redirect`：回退到兜底路由，并给玩家一句人话
 * - `notify`：只提示，不再动路由（避免「重载 → 还是失败 → 再重载」成死循环）
 * - `ignore`：与动态导入无关（业务错误等），不插手
 */
export type RouteRecoveryAction =
  | { kind: 'reload'; target: string }
  | { kind: 'redirect'; to: string; message: string }
  | { kind: 'notify'; message: string }
  | { kind: 'ignore' }

/** 把错误摊平成一段小写文本（error / cause / 字符串都吃） */
function errorText(error: unknown): string {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error.toLowerCase()
  if (typeof error === 'object') {
    const e = error as { name?: unknown; message?: unknown; cause?: unknown }
    const parts = [e.name, e.message].map((v) => (typeof v === 'string' ? v : ''))
    // cause 可能又是一层 Error（包装过的动态导入报错），要**递归**摊平，
    // 否则外层只看到「wrapped」这种无信息文案 → 判不出是动态导入失败。
    // `cause !== error` 防自引用导致的死循环。
    const cause = e.cause
    const causeText = cause && cause !== error ? errorText(cause) : ''
    return [...parts, causeText].join(' ').toLowerCase()
  }
  return String(error).toLowerCase()
}

/** 这是一次「动态导入（chunk）拉取失败」吗？ */
export function isChunkLoadError(error: unknown): boolean {
  const text = errorText(error)
  if (!text) return false
  return CHUNK_ERROR_PATTERNS.some((pattern) => text.includes(pattern))
}

/**
 * 给出兜底动作。
 *
 * @param error 导航抛出的错误
 * @param recoveryCount 本会话已经用过几次兜底（0 = 还没用过）
 * @param target 失败时**想去**的路由（重载后要送去这里，不能只回原地）
 */
export function planRouteRecovery(
  error: unknown,
  recoveryCount: number,
  target: string = ROUTE_FALLBACK,
): RouteRecoveryAction {
  if (!isChunkLoadError(error)) return { kind: 'ignore' }
  if (recoveryCount <= 0) return { kind: 'reload', target }
  if (recoveryCount === 1) {
    return {
      kind: 'redirect',
      to: ROUTE_FALLBACK,
      message: '页面加载失败，已返回首页，请刷新后重试',
    }
  }
  return { kind: 'notify', message: '页面加载失败，请检查网络后刷新页面重试' }
}
