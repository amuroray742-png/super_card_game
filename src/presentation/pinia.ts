import { createPinia } from 'pinia'

/**
 * 全局 Pinia 实例。
 *
 * 单独抽出来是因为**路由守卫**里要用 store——守卫不在组件 setup 上下文中，
 * 不能依赖 `getActivePinia()` 的隐式注入，显式传实例最稳。
 */
export const pinia = createPinia()
