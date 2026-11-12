import { test, expect } from '@playwright/test'
import {
  E2E_API_BASE,
  E2E_PASSWORD,
  loginViaUi,
  registerAccount,
  registerViaUi,
  seedApiBase,
  seedSession,
  uniqueUsername,
} from './helpers'

/**
 * 登录系统端到端用例。
 *
 * 走**真实后端**（server/ 的 Fastify 代码 + 临时 SQLite 库），
 * 覆盖：强制登录、会话恢复、错误提示、跨设备云存档同步。
 */
test.describe('登录系统', () => {
  test('未登录访问游戏会被拦到登录页', async ({ page }) => {
    await seedApiBase(page)
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/#\/login/)
    await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible()
    // 未登录时不该出现游戏内的资源条与标签栏
    await expect(page.locator('.res-bar')).toHaveCount(0)
    await expect(page.locator('.tabs')).toHaveCount(0)
  })

  test('注册后自动进入游戏并出现首启引导', async ({ page }) => {
    await seedApiBase(page)
    await registerViaUi(page, uniqueUsername('reg'))
    await page.waitForURL(/#\/guide/)
    await expect(page.getByText('召唤英灵').first()).toBeVisible()
    // 进入游戏后才有资源条与标签栏
    await expect(page.locator('.res-bar')).toBeVisible()
  })

  test('刷新页面保持登录（会话恢复）', async ({ page }) => {
    await seedApiBase(page)
    await registerViaUi(page, uniqueUsername('keep'))
    await page.waitForURL(/#\/guide/)

    await page.reload()
    await page.waitForLoadState('networkidle')
    // 刷新后仍在游戏内，不被弹回登录页
    await expect(page).not.toHaveURL(/#\/login/)
    await expect(page.locator('.res-bar')).toBeVisible()
  })

  test('口令错误时给出正确提示', async ({ page }) => {
    const username = uniqueUsername('wrongpw')
    await registerAccount(username, E2E_PASSWORD)
    await seedApiBase(page)
    await loginViaUi(page, username, 'definitely-wrong-password')
    await expect(page.getByText('用户名或口令不正确')).toBeVisible()
    // 停在登录页
    await expect(page).toHaveURL(/#\/login/)
  })

  test('用户名已被占用时给出正确提示', async ({ page }) => {
    const username = uniqueUsername('taken')
    await registerAccount(username, E2E_PASSWORD)
    await seedApiBase(page)
    await registerViaUi(page, username)
    await expect(page.getByText('该用户名已被占用')).toBeVisible()
    await expect(page).toHaveURL(/#\/login/)
  })

  test('另一台设备用同一账号登录能看到同样的云端进度', async ({ browser }) => {
    const username = uniqueUsername('sync')
    const session = await registerAccount(username, E2E_PASSWORD)

    // 设备 A：抽卡（扣费动作会立即推上云端）
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    await seedSession(pageA, session)
    await pageA.goto('/#/gacha')
    await pageA.waitForLoadState('networkidle')
    await pageA.locator('button', { hasText: '十连' }).first().click()
    await pageA.getByRole('button', { name: '收下' }).click()

    // 设备 B：全新浏览器上下文（没有任何本地存档），用同一账号登录
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    await seedApiBase(pageB)
    await loginViaUi(pageB, username, E2E_PASSWORD)
    await pageB.waitForURL(/#\/(expedition|guide)/)

    await pageB.goto('/#/settings')
    await pageB.waitForLoadState('networkidle')
    await expect(pageB.locator('body')).toContainText(/已召唤\s*10\s*次/)

    await contextA.close()
    await contextB.close()
  })

  test('后端地址覆盖生效（登录页展示当前后端地址）', async ({ page }) => {
    await seedApiBase(page)
    await page.goto('/#/login')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.addr')).toContainText(E2E_API_BASE)
  })

  test('设置页可以退出登录，之后能用同一账号重新登录', async ({ page }) => {
    const username = uniqueUsername('logout')
    await seedApiBase(page)
    await registerViaUi(page, username)
    await page.waitForURL(/#\/guide/)

    await page.goto('/#/settings')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(username)).toBeVisible()

    await page.getByRole('button', { name: '退出登录' }).click()
    await page.waitForURL(/#\/login/)

    await loginViaUi(page, username, E2E_PASSWORD)
    await page.waitForURL(/#\/(expedition|guide)/)
  })

  test('设置页可以注销账号，注销后回到登录页', async ({ page }) => {
    const username = uniqueUsername('del')
    const session = await registerAccount(username)
    await seedSession(page, session)
    await page.goto('/#/settings')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: '注销账号' }).click()
    await page.getByRole('button', { name: '确认注销' }).click()
    await page.waitForURL(/#\/login/)
    await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible()
  })
})
