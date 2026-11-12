import { createRouter, createWebHashHistory } from 'vue-router'
import { pinia } from './pinia'
import { useAccountStore } from './stores/account'
import { useGameStore } from './stores/game'

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
    { path: '/forge', name: 'forge', component: () => import('./views/ForgeView.vue'), meta: { tab: 'forge' } },
    { path: '/legacy', name: 'legacy', component: () => import('./views/LegacyView.vue'), meta: { tab: 'legacy' } },

    { path: '/hero/:id', name: 'hero', component: () => import('./views/HeroDetailView.vue') },
    { path: '/stage/:id', name: 'stage', component: () => import('./views/StageDetailView.vue') },
    { path: '/relic/:uid', name: 'relic', component: () => import('./views/RelicDetailView.vue') },
    { path: '/gacha', name: 'gacha', component: () => import('./views/GachaView.vue') },
    { path: '/gacha/:poolId', name: 'gacha-pool', component: () => import('./views/GachaView.vue') },
    { path: '/arena', name: 'arena', component: () => import('./views/ArenaView.vue') },
    { path: '/arena/rank', name: 'arena-rank', component: () => import('./views/ArenaRankView.vue') },
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
