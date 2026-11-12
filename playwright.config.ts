import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * E2E 配置（§15.2）。
 *
 * 移动端竖屏优先：默认用 Pixel 5 视口跑全部用例。
 * 本地起静态服务跑构建产物，避免 dev server 的热更新影响稳定性。
 *
 * 两个 webServer：
 * 1. **真实后端**（server/ 的 Fastify 代码 + 临时 SQLite 库）
 *    —— 端到端用例要走完整的注册 → 登录 → 云存档链路，用的是生产代码路径，
 *    不是另写一套 mock。
 * 2. **静态预览**（构建产物 + vite preview）
 *
 * DB 放在系统临时目录（ASCII 路径），避免中文路径下 rmSync 静默失效的问题。
 */
const E2E_PORT = 8790
const PREVIEW_PORT = 4173
const E2E_DB = join(tmpdir(), 'sgw-e2e.db')
const E2E_API_BASE = `http://127.0.0.1:${E2E_PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: [
    {
      command: `node --no-warnings server/src/index.ts --port ${E2E_PORT} --db "${E2E_DB}"`,
      url: `${E2E_API_BASE}/api/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: `npm run build && npm run preview -- --port ${PREVIEW_PORT} --host 127.0.0.1`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
})
