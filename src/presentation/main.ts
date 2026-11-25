import { createApp } from 'vue'
import App from './App.vue'
import { router, retryPendingRoute } from './router'
import { pinia } from './pinia'
import { useGameStore } from './stores/game'
import { isChunkLoadError } from './utils/route-recovery.ts'
import './styles/global.css'

const app = createApp(App)
app.use(pinia)
app.use(router)

// 等待初始路由解析完成后再挂载：否则 App 的 onMounted 里读到的 route 仍是
// START_LOCATION（path = '/'），会把深链（例如 /settings、/gacha）误判成主入口。
// 路由守卫里的「恢复会话 + 载入存档」也会在这之前完成，界面不会闪出空壳。
router
  .isReady()
  .then(() => {
    app.mount('#app')
    // ⚠ 上一次是「chunk 拉不到 → 重载」的话，这里把玩家**要去的那一页**补上。
    //   不补的话，重载只会回到失败前那一页 —— 玩家点的目标依然没打开。
    void retryPendingRoute()
  })
  .catch((error) => {
    // ⚠ **初始导航失败时 `isReady()` 会 reject** —— 不接这个 catch 就是整页白屏：
    //   `app.mount` 写在 `.then` 里，永远轮不到 ⇒ 应用根本没挂载，
    //   玩家看到一片空白，console 里只剩一条动态导入报错。
    //
    //   动态导入失败（chunk 拉不到）由 `router.onError` 兜底：
    //   重载一次（并记住要去哪）→ 回退首页 → 只提示
    //   （详见 presentation/utils/route-recovery.ts）。
    //   这里负责把应用挂上，让外壳（资源条 / 标签栏）与提示可见，
    //   免得兜底信息无处可显示。
    console.error('[router] 初始导航失败', error)
    app.mount('#app')
    // 非动态导入的错误（守卫抛错等）没有路由级兜底 → 给一句人话，而不是留一片空白
    if (!isChunkLoadError(error)) {
      useGameStore(pinia).notify('页面加载失败，请刷新后重试', 'warn')
    }
  })
