import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteLocationNormalized } from 'vue-router'
import { pinia } from './pinia'
import { useAccountStore } from './stores/account'
import { useGameStore } from './stores/game'
import { ACCOUNT_STORAGE_KEYS } from '../core/config/account.ts'
import { sessionFlags } from '../platform/storage.ts'
import { planRouteRecovery, ROUTE_FALLBACK } from './utils/route-recovery.ts'

/**
 * 路由表 + 登录守卫。
 *
 * 首发为纯前端 H5，使用 hash 模式，避免依赖服务端 rewrite。
 * 导航项（底部标签栏）共 5 个：推征 / 圣殿 / 阵位 / 铸造 / 传承。
 *
 * 守卫职责（顺序固定）：
 *   1. 恢复会话（未登录则拦到 /login）
 *   2. 已登录则载入该账号的存档（只载一次）
 *   3. 首启引导：从主入口落地且没有英灵时进引导页
 */
declare module 'vue-router' {
  interface RouteMeta {
    /** 无需登录即可访问（登录页、公开合规页） */
    public?: boolean
    /** 底部标签栏标识 */
    tab?: string
  }
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/expedition' },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
    { path: '/expedition', name: 'expedition', component: () => import('./views/ExpeditionView.vue'), meta: { tab: 'expedition' } },
    { path: '/temple', name: 'temple', component: () => import('./views/TempleView.vue'), meta: { tab: 'temple' } },
    { path: '/formation', name: 'formation', component: () => import('./views/FormationView.vue'), meta: { tab: 'formation' } },
    // ⚠ **实施修正（资源/背包版本 v10）**：「铸造」页升级为「背包」。
    //   路径 `/forge` 与路由名 `forge` **全部保留**（E2E / 截图工具 / 任务跳转都不用改），
    //   `/backpack` 只是别名，两者 `meta.tab` 都是 `forge` → 底部标签栏高亮一致。
    { path: '/forge', name: 'forge', component: () => import('./views/BackpackView.vue'), meta: { tab: 'forge' } },
    { path: '/backpack', name: 'backpack', component: () => import('./views/BackpackView.vue'), meta: { tab: 'forge' } },
    { path: '/legacy', name: 'legacy', component: () => import('./views/LegacyView.vue'), meta: { tab: 'legacy' } },
    { path: '/dungeon', name: 'dungeon', component: () => import('./views/DungeonView.vue') },

    { path: '/hero/:id', name: 'hero', component: () => import('./views/HeroDetailView.vue') },
    { path: '/stage/:id', name: 'stage', component: () => import('./views/StageDetailView.vue') },
    { path: '/relic/:uid', name: 'relic', component: () => import('./views/RelicDetailView.vue') },
    { path: '/gacha', name: 'gacha', component: () => import('./views/GachaView.vue') },
    { path: '/gacha/:poolId', name: 'gacha-pool', component: () => import('./views/GachaView.vue') },
    { path: '/arena', name: 'arena', component: () => import('./views/ArenaView.vue') },
    { path: '/arena/rank', name: 'arena-rank', component: () => import('./views/ArenaRankView.vue') },
    { path: '/ladder', name: 'ladder', component: () => import('./views/LadderView.vue') },
    { path: '/codex', name: 'codex', component: () => import('./views/CodexView.vue') },
    { path: '/compliance', name: 'compliance', component: () => import('./views/ComplianceView.vue'), meta: { public: true } },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/daily', name: 'daily', component: () => import('./views/DailyView.vue') },
    { path: '/guide', name: 'guide', component: () => import('./views/GuideView.vue') },

    { path: '/:pathMatch(.*)*', redirect: '/expedition' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  const account = useAccountStore(pinia)
  // 会话恢复是幂等的：多处触发只会真正恢复一次
  await account.ensureRestored()

  // ── 未登录 ──────────────────────────────────────────
  if (!account.isAuthenticated) {
    // 登出后清掉「已载入」标记，换账号时重新载入存档
    useGameStore(pinia).invalidate()
    if (to.meta.public) return true
    const redirect = to.fullPath && to.fullPath !== '/' ? to.fullPath : undefined
    return { path: '/login', query: redirect ? { redirect } : {} }
  }

  // ── 已登录 ──────────────────────────────────────────
  if (to.path === '/login') return { path: '/' }

  const game = useGameStore(pinia)
  if (game.loaded && (game.offline || account.offline)) await game.reconnect()
  if (!game.loaded) {
    await game.load()
  }

  // 首启引导：没有英灵且从主入口落地 → 直接进引导页。
  // 引导是「怎么抽卡」的第一次教学，必须自动出现，不能只置一个无人读取的标记；
  // 深链（/gacha、/compliance 等）不劫持，避免玩家被弹离想去的地方。
  const isRootEntry = to.path === '/' || to.path === '/expedition'
  if (isRootEntry && !game.guideSeen && Object.keys(game.save.heroes).length === 0) {
    game.guideSeen = true
    game.guideStep = 0
    return { path: '/guide' }
  }

  return true
})

/**
 * 已经兜底过的错误（同一个错误对象只处理一次）。
 *
 * ⚠ 同一次失败会被送两遍：`router.onError` 与 `router.isReady()` 的 reject
 *   拿到的是**同一个 error 对象**。不 dedupe 就会出现「先重载、又立刻回退」连着触发。
 */
const handledRouteErrors = new WeakSet<object>()

/**
 * 动态导入（chunk）拉取失败时的兜底（策略见 `utils/route-recovery.ts`）。
 *
 * ⚠ 触发场景：
 *   - dev：Vite 重启 / HMR 后模块图与已加载的页面不一致；
 *   - prod：发版后旧 chunk 失效（文件名 hash 变了）、网络抖动。
 *
 * ⚠ 恢复顺序是「重载一次（并记住要去哪）→ 回退首页 + 提示 → 只提示」，
 *   次数由**会话级计数**控制（`ACCOUNT_STORAGE_KEYS.ROUTE_CHUNK_RETRY`）——
 *   有上限，才不会「重载 → 还是失败 → 再重载」成死循环。
 *
 * @param to 失败时**想去**的路由（重载后要送去这里，不能只回原地）
 * @returns 是否由本次兜底处理（false = 与动态导入无关，原样抛给调用方）
 */
export function handleRouteError(error: unknown, to?: RouteLocationNormalized | null): boolean {
  if (error && typeof error === 'object') {
    if (handledRouteErrors.has(error)) return false
    handledRouteErrors.add(error)
  }
  const key = ACCOUNT_STORAGE_KEYS.ROUTE_CHUNK_RETRY
  const targetKey = ACCOUNT_STORAGE_KEYS.ROUTE_CHUNK_TARGET
  const target = to?.fullPath || ROUTE_FALLBACK
  const action = planRouteRecovery(error, sessionFlags.count(key), target)
  if (action.kind === 'ignore') return false
  sessionFlags.bump(key)
  if (action.kind === 'reload') {
    // ⚠ **必须先记住要去哪**：hash 模式下失败的导航连 URL 都不会改，
    //   不记下来，重载后只会回到失败前那一页 —— 玩家点的目标依然没打开。
    sessionFlags.set(targetKey, action.target)
    location.reload()
    return true
  }
  if (action.kind === 'redirect') {
    sessionFlags.clear(targetKey)
    useGameStore(pinia).notify(action.message, 'warn')
    void router
      .replace(action.to)
      .catch(() => undefined)
      .finally(() => sessionFlags.clear(key))
    return true
  }
  useGameStore(pinia).notify(action.message, 'warn')
  return true
}

router.onError((error, to) => {
  handleRouteError(error, to)
})

/**
 * 重载之后**把玩家要去的那一页补上**。
 *
 * ⚠ 失败的导航被中止时，hash 模式的 URL 不会变 ⇒ 重载后停在原地。
 *   这里把之前记下的目标路由再导航一次：
 *   - 这次能拉下来（多半是瞬时故障）→ 玩家要的页面**真的打开了**；
 *   - 还是拉不下来 → 由 `handleRouteError` 接手（回退首页 + 提示），不会成死循环。
 *
 * @returns 是否发起了重试导航
 */
export async function retryPendingRoute(): Promise<boolean> {
  const key = ACCOUNT_STORAGE_KEYS.ROUTE_CHUNK_RETRY
  const targetKey = ACCOUNT_STORAGE_KEYS.ROUTE_CHUNK_TARGET
  const target = sessionFlags.get(targetKey)
  if (!target) {
    // 没有待重试的目标 ⇒ 本次会话的兜底预算重置（下次故障仍能完整重来一遍）
    sessionFlags.clear(key)
    return false
  }
  sessionFlags.clear(targetKey)
  try {
    await router.replace(target)
  } catch {
    // 失败已由 handleRouteError 接手（回退首页 + 提示），这里不再重复处理
    return false
  }
  sessionFlags.clear(key)
  return true
}
