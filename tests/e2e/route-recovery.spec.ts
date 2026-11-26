import { test, expect, type Page } from '@playwright/test'
import { importFixture, giveTeam } from './helpers'

/**
 * 路由「懒加载组件拉取失败」的兜底（presentation/utils/route-recovery.ts）。
 *
 * ⚠ **为什么要有这条用例**：懒加载 chunk 拉不到时，Vue Router 会中止导航，
 *   而玩家只看到「页面打不开」：
 *   - 初始导航失败 → `router.isReady()` reject → 应用**根本没挂载** → 整页白屏；
 *   - 后续导航失败 → 导航被中止（hash 模式连 URL 都不会改）
 *     → 玩家点了「背包」，**什么都没发生**，也不会有任何提示。
 *   两种都不是「业务报错」，只是一个静默的死页面 —— 没有兜底就永远只能靠玩家手动刷新。
 *
 * ⚠ 这里的模拟方式是**真的让请求失败**（拦截构建产物并 abort），
 *   不是 mock 掉 router：只有真失败才能验出「重载 → 重试目标 → 回退首页」这条兜底链。
 */

/** 背包页的构建产物 chunk（预览服务跑的是构建产物，文件名带 hash） */
const BACKPACK_CHUNK = '**/assets/BackpackView-*.js'

/** 一支队伍：存档里有英灵 ⇒ 不会被「首启引导」劫持（否则落地页是引导页，不是推征页） */
const TEAM = ['xiangyu'] as const

/**
 * 提示条只存在 2.2 秒，直接断言会撞上「断言轮询刚好错过」的竞态。
 * 这里用 MutationObserver 把出现过的提示**记进 sessionStorage**
 * （跨重载存活），断言时读它 ⇒ 不会漏，也不会误判。
 */
const TOAST_LOG_KEY = 'sgw.e2e.toastLog'

async function captureToasts(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    // ⚠ 用**定时采样**而不是 MutationObserver：init 脚本执行时
    //   `document.documentElement` 还是 null（文档还没解析），observe 会直接抛。
    const timer = setInterval(() => {
      const text = (document.querySelector('.toast')?.textContent ?? '').trim()
      if (!text) return
      const log = sessionStorage.getItem(key) ?? ''
      if (!log.includes(text)) sessionStorage.setItem(key, `${log}${text}\n`)
    }, 50)
    window.addEventListener('pagehide', () => clearInterval(timer))
  }, TOAST_LOG_KEY)
}

/** 模拟「背包页的 chunk 拉不到」 */
async function breakBackpackChunk(page: Page): Promise<void> {
  await page.route(BACKPACK_CHUNK, (route) => route.abort())
}

/** 读出出现过的全部提示（页面正在重载时读不到，返回空串让轮询继续） */
async function toastLog(page: Page): Promise<string> {
  return page
    .evaluate((key) => sessionStorage.getItem(key) ?? '', TOAST_LOG_KEY)
    .catch(() => '')
}

/**
 * 推征页的**主 CTA**（用来判断「页面是活的」而不是停在上一页）。
 *
 * ⚠ 推征页一屏化 v13：挂机面板的标题从「挂机通道」改成了「挂机」，
 *   而「已通关 N 关」那行字随关卡网格下沉到了 `/stages`
 *   ⇒ 这里改用**必定存在且唯一**的主按钮「挑战此关」作为探针。
 */
const EXPEDITION_HEADING = '挑战此关'

test.describe('路由 chunk 拉取失败的兜底', () => {
  test('点背包时 chunk 拉不到 → 兜底生效，不会停在死页面', async ({ page }) => {
    await importFixture(page, 'route', (save) => {
      giveTeam(save, TEAM, 60)
    })
    await captureToasts(page)
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(EXPEDITION_HEADING).first()).toBeVisible()

    await breakBackpackChunk(page)
    await page.getByRole('button', { name: '背包' }).first().click()

    // 兜底链：重载一次（并记住要去背包）→ 还是失败 → 回退首页 + 给一句提示
    await expect.poll(() => toastLog(page), { timeout: 20_000 }).toContain('页面加载失败')
    await expect(page).toHaveURL(/#\/expedition/, { timeout: 20_000 })
    // 关键：**页面是活的**（内容真的渲染出来了），不是「点了没反应」
    await expect(page.getByText(EXPEDITION_HEADING).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '背包' }).first()).toBeVisible()
  })

  test('页面一打开就拉不到 chunk → 不能白屏，要落到可用页面', async ({ page }) => {
    // ⚠ 这里**不**先导存档：要让「打开页面」这一步本身是首次加载，
    //   才能验出「初始导航失败 ⇒ 整页白屏」这条老路被堵住了。
    await importFixture(page, 'routeinit', (save) => {
      giveTeam(save, TEAM, 60)
    })
    await captureToasts(page)
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    await breakBackpackChunk(page)
    // ⚠ 页面会**自己重载**（兜底第一步），这会打断本次导航 → 导航异常属预期，吞掉。
    //   超时也一并兜住：真正的断言在下面（重载后仍会失败 → 回退首页）。
    await page.goto('/#/forge', { timeout: 8000 }).catch(() => undefined)

    // 关键：应用**挂上了**（底部标签栏可见），而不是一片空白
    await expect(page.getByRole('button', { name: '背包' }).first()).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => toastLog(page), { timeout: 20_000 }).toContain('页面加载失败')
    // 没被留在拉不到的页面上
    await expect(page).not.toHaveURL(/#\/forge/, { timeout: 20_000 })
    await expect(page.getByText(EXPEDITION_HEADING).first()).toBeVisible()
  })
})
