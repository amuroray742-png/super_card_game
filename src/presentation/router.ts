import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 路由表。
 *
 * 首发为纯前端 H5，使用 hash 模式，避免依赖服务端 rewrite。
 * 导航项（底部标签栏）共 5 个：推征 / 圣殿 / 阵位 / 铸造 / 传承。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/expedition' },
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
    { path: '/compliance', name: 'compliance', component: () => import('./views/ComplianceView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/daily', name: 'daily', component: () => import('./views/DailyView.vue') },
    { path: '/guide', name: 'guide', component: () => import('./views/GuideView.vue') },

    { path: '/:pathMatch(.*)*', redirect: '/expedition' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})
