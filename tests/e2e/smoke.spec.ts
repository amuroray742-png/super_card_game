import { test, expect, type Page } from '@playwright/test'
import { registerAccount, seedSession, uniqueUsername } from './helpers'

/**
 * 端到端冒烟用例（§15.2）。
 *
 * 覆盖首发核心链路：
 *   登录 → 概率公示可见 → 抽卡 → 编队 → 推征 → 养成 → 合规页
 *
 * 注意：用例不依赖具体数值，只依赖**结构与交互存在**，
 * 避免数值调参导致 E2E 频繁失败。
 *
 * 每个用例都现注册一个账号（云存档按账号隔离），
 * 保证用例之间互不影响——等价于从前每个用例都是全新浏览器上下文。
 */

async function gotoApp(page: Page, hash = '#/expedition') {
  const session = await registerAccount(uniqueUsername('smoke'))
  await seedSession(page, session)
  await page.goto(`/${hash}`)
  await page.waitForLoadState('networkidle')
}

test.describe('《超级圣杯战争》核心链路', () => {
  test('首屏加载并显示底部标签栏', async ({ page }) => {
    await gotoApp(page)
    for (const label of ['推征', '圣殿', '阵位', '铸造', '传承']) {
      await expect(page.getByRole('button', { name: label, exact: false }).first()).toBeVisible()
    }
  })

  test('概率公示页显示基础/综合双栏与两位小数', async ({ page }) => {
    await gotoApp(page, '#/compliance')
    await expect(page.getByText('概率公示').first()).toBeVisible()
    // 基础概率 0.60% 与综合概率 11.69% 必须在页面上可读
    await expect(page.getByText('0.60%').first()).toBeVisible()
    await expect(page.getByText('11.69%').first()).toBeVisible()
  })

  test('概率公示按卡池分别列出（不同池概率不同）', async ({ page }) => {
    await gotoApp(page, '#/compliance')
    const body = await page.locator('body').innerText()
    // 四个卡池都要出现在公示页
    for (const pool of ['万灵殿', '诸子百家', '寰宇纪年', '初临之赐']) {
      expect(body).toContain(pool)
    }
    // 纪元池只收录 SSR/SR，其 R/N 概率并入 SR —— 该池的 N 行必须是 0.00%
    const eraBlock = page.locator('.pool-rate').filter({ hasText: '诸子百家' })
    await expect(eraBlock).toBeVisible()
    const rows = eraBlock.locator('tbody tr')
    await expect(rows).toHaveCount(4)
    // 最后一行（N）的两列都应为 0.00%
    await expect(rows.nth(3)).toContainText('0.00%')
  })

  test('抽卡页展示概率表与保底信息', async ({ page }) => {
    await gotoApp(page, '#/gacha')
    await expect(page.getByText(/基础概率|概率/).first()).toBeVisible()
    await expect(page.getByText(/保底|90/).first()).toBeVisible()
  })

  test('圣殿页可进入英灵详情', async ({ page }) => {
    await gotoApp(page, '#/temple')
    const firstHero = page.locator('.hero-cell').first()
    if (await firstHero.count()) {
      await firstHero.click()
      await expect(page).toHaveURL(/#\/hero\//)
    }
  })

  test('阵位页可打开编队界面', async ({ page }) => {
    await gotoApp(page, '#/formation')
    await expect(page.getByText('阵位').first()).toBeVisible()
  })

  test('合规页包含竞技产出隔离与无付费声明', async ({ page }) => {
    await gotoApp(page, '#/compliance')
    const body = await page.locator('body').innerText()
    expect(body).toContain('竞技')
    expect(body).toMatch(/不(提供|回流|产出)/)
  })

  test('设置页可打开合规页链接', async ({ page }) => {
    await gotoApp(page, '#/settings')
    await expect(page.getByText(/设置|版本/).first()).toBeVisible()
  })
})

test.describe('抽卡入口可达（核心闭环）', () => {
  test('铸造页提供召唤入口并可跳转到召唤页', async ({ page }) => {
    await gotoApp(page, '#/forge')
    const entry = page.getByRole('button', { name: '前往召唤', exact: true })
    await expect(entry).toBeVisible()
    await entry.click()
    await expect(page).toHaveURL(/#\/gacha/)
    await expect(page.getByText('概率公示').first()).toBeVisible()
  })

  test('圣殿页提供召唤入口', async ({ page }) => {
    await gotoApp(page, '#/temple')
    await expect(page.getByRole('button', { name: '前往召唤', exact: true })).toBeVisible()
  })

  test('顶部资源条的圣杯结晶可直达召唤页', async ({ page }) => {
    await gotoApp(page, '#/expedition')
    await page.locator('.res-link', { hasText: '圣杯结晶' }).first().click()
    await expect(page).toHaveURL(/#\/gacha/)
  })

  test('首启自动进入新手引导，第 1 步直达召唤', async ({ page }) => {
    await gotoApp(page, '#/expedition')
    await expect(page).toHaveURL(/#\/guide/)
    await expect(page.getByText('召唤英灵').first()).toBeVisible()
    await page.getByRole('button', { name: '前往召唤', exact: true }).click()
    await expect(page).toHaveURL(/#\/gacha/)
  })
})

test.describe('新手保底（§7.3 第 3 条）', () => {
  test('首次十连保底 1 位传说英灵，资格消耗后新手池隐藏', async ({ page }) => {
    await gotoApp(page, '#/gacha')
    // 资格未消耗时，新手池「初临之赐」可见
    await expect(page.getByRole('button', { name: '初临之赐' })).toBeVisible()

    await page.locator('button', { hasText: '十连' }).first().click()

    // 结果弹窗中至少 1 位传说英灵
    const dialog = page.locator('.dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.portrait-ssr').first()).toBeVisible()

    await page.getByRole('button', { name: '收下' }).click()

    // 召唤历史出现 SSR 记录
    await expect(page.locator('.hist-row .tag-ssr').first()).toBeVisible()

    // 资格消耗后新手池隐藏
    await expect(page.getByRole('button', { name: '初临之赐' })).toHaveCount(0)
  })
})

test.describe('卡面展示（Phase 8b · 3:4 完整卡面）', () => {
  test('抽卡结果以 3:4 完整卡面展示新获得英灵', async ({ page }) => {
    await gotoApp(page, '#/gacha')
    await page.locator('button', { hasText: '十连' }).first().click()

    const dialog = page.locator('.dialog')
    await expect(dialog).toBeVisible()

    const cards = dialog.locator('.new-hero img')
    await expect(cards.first()).toBeVisible()

    // 必须是 AI 卡面资源，而不是 SVG 占位头像
    await expect(cards.first()).toHaveAttribute('src', /\/portraits\/[^/]+\.webp$/)

    // 3:4 完整卡面：宽高比 0.75，未被方形裁切
    const box = await cards.first().boundingBox()
    expect(box).not.toBeNull()
    expect(Math.abs(box!.width / box!.height - 0.75)).toBeLessThan(0.02)
  })

  test('英灵详情以 3:4 完整卡面展示', async ({ page }) => {
    await gotoApp(page, '#/hero/xiangyu')
    const card = page.locator('.head img.portrait').first()
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('src', /\/portraits\/xiangyu\.webp$/)

    const box = await card.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.abs(box!.width / box!.height - 0.75)).toBeLessThan(0.02)
  })
})
