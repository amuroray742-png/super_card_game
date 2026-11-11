import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

// 等待初始路由解析完成后再挂载：否则 App 的 onMounted 里读到的 route 仍是
// START_LOCATION（path = '/'），会把深链（例如 /settings、/gacha）误判成主入口。
router.isReady().then(() => {
  app.mount('#app')
})
