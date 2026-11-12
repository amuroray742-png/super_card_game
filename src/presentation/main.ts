import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { pinia } from './pinia'
import './styles/global.css'

const app = createApp(App)
app.use(pinia)
app.use(router)

// 等待初始路由解析完成后再挂载：否则 App 的 onMounted 里读到的 route 仍是
// START_LOCATION（path = '/'），会把深链（例如 /settings、/gacha）误判成主入口。
// 路由守卫里的「恢复会话 + 载入存档」也会在这之前完成，界面不会闪出空壳。
router.isReady().then(() => {
  app.mount('#app')
})
