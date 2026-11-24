import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 开发期后端地址（Vite dev server 代理目标）。
 *
 * ⚠ **只在这里写一处**：Vite 配置不是 core，且这个值不进任何运行时口径。
 */
const DEV_API_TARGET = 'http://127.0.0.1:8787'

/**
 * preview（构建产物本地验收）的代理目标。
 *
 * 默认同上；E2E 用 `SGW_PREVIEW_API_TARGET` 指到**它自己的**后端实例，
 * 免得「忘了注入后端地址」的用例悄悄打到开发后端上（串台 + 用例假绿）。
 */
const PREVIEW_API_TARGET = process.env.SGW_PREVIEW_API_TARGET || DEV_API_TARGET

/**
 * **同源代理**：把前端的 `/api` 请求转发到后端。
 *
 * ⚠ 为什么必须有它（否则「手机打开就能注册」根本做不到）：
 *   - 前端默认后端地址是**同源**（core 默认值 `''`），
 *     而后端默认只绑 `127.0.0.1`，手机上并没有「本机的 8787」；
 *   - 就算把 base 改成 LAN 地址，浏览器的 **CORS 预检**也会被白名单拦掉
 *     （白名单里只有 localhost / 127.0.0.1）；
 *   - 走同源代理后，手机只跟 5173 说话，由 dev server 代为转发 ⇒
 *     **不碰 CORS、不用知道 LAN IP、换网络也不失效**——
 *     与生产（前端 `/api` → nginx → 后端）同一套形态。
 */
function apiProxy(target: string) {
  return {
    '/api': { target, changeOrigin: true },
  }
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2020',
    // H5 首发首包目标 < 1.5MB（占位图阶段）
    chunkSizeWarningLimit: 1200,
  },
  server: {
    // ⚠ `host: true` = 监听所有网卡 ⇒ 手机 / 局域网设备能打开页面。
    host: true,
    port: 5173,
    proxy: apiProxy(DEV_API_TARGET),
  },
  preview: {
    // 构建产物的本地验收同样走同源代理（对齐生产的 nginx 反代）。
    // ⚠ E2E / 截图工具会往 `localStorage['sgw.apiBase']` 写**绝对地址**，
    //   覆盖值优先 ⇒ 这里的代理只在「没有覆盖」时兜底，不会串到别的后端。
    host: true,
    proxy: apiProxy(PREVIEW_API_TARGET),
  },
})
