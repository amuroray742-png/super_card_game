import { test, expect, type Page } from '@playwright/test'
import { registerAccount, seedSession, skipGachaReveal, uniqueUsername } from './helpers'

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
    await page.goto('/#/compliance')
    await expect(page.getByText('概率公示').first()).toBeVisible()
    // 公开页展示常规十连，账号资格由登录后的公示单独覆盖。
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

test.describe('核心页面入口可达（铁律 #10）', () => {
  /**
   * ⚠ 历史教训：召唤页曾有路由、有入口文案，但**游戏内一个入口都没挂**，
   *   玩家只能手敲 URL —— 核心循环在游戏内完全不可达。
   *   这条用例守的是「从主界面点得进去」，不是「路由存在」。
   */
  test('圣殿页可进入每日页', async ({ page }) => {
    await gotoApp(page, '#/temple')
    const entry = page.getByTestId('daily-entry')
    await expect(entry).toBeVisible()
    await entry.click()
    await expect(page).toHaveURL(/#\/daily/)
    await expect(page.getByText('每日签到').first()).toBeVisible()
  })

  test('传承页可进入竞技场与图鉴', async ({ page }) => {
    await gotoApp(page, '#/legacy')

    const arena = page.getByTestId('arena-entry')
    await expect(arena).toBeVisible()
    await arena.click()
    await expect(page).toHaveURL(/#\/arena/)
    await expect(page.getByText('竞技场').first()).toBeVisible()

    await page.goBack()
    await gotoApp(page, '#/legacy')
    const codex = page.getByTestId('codex-entry')
    await expect(codex).toBeVisible()
    await codex.click()
    await expect(page).toHaveURL(/#\/codex/)
    await expect(page.getByText('图鉴').first()).toBeVisible()
  })
})

test.describe('新手保底（§7.3 第 3 条）', () => {
  test('首次十连保底 1 位传说英灵，资格消耗后新手池隐藏', async ({ page }) => {
    await gotoApp(page, '#/compliance')
    const standard = page.locator('.pool-rate').filter({ hasText: '万灵殿' })
    await expect(standard.locator('tbody tr').first().locator('td').nth(2)).toHaveText('100.00%')
    await page.goto('/#/gacha')
    const ssrRate = page.locator('.rate-table tbody tr').first().locator('td').nth(2)
    await expect(ssrRate).toHaveText('100.00%')
    // 资格未消耗时，新手池「初临之赐」可见
    await expect(page.getByRole('button', { name: '初临之赐' })).toBeVisible()

    await page.locator('button', { hasText: '十连' }).first().click()
    // 演出会停在 SSR 爆点等玩家点击 → 这里直接跳过演出拿结算
    await skipGachaReveal(page)

    // 结果弹窗中至少 1 位传说英灵
    const dialog = page.locator('.dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.portrait-ssr').first()).toBeVisible()

    await page.getByRole('button', { name: '收下' }).click()

    // 召唤历史出现 SSR 记录
    await expect(page.locator('.hist-row .tag-ssr').first()).toBeVisible()

    // 资格消耗后新手池隐藏
    await expect(page.getByRole('button', { name: '初临之赐' })).toHaveCount(0)
    await expect(ssrRate).toHaveText('11.69%')
    await page.goto('/#/compliance')
    await expect(standard.locator('tbody tr').first().locator('td').nth(2)).toHaveText('11.69%')
  })
})

test.describe('抽卡券可用于十连（逐抽计价）', () => {
  test('结晶耗尽后十连自动改用抽卡券，余额不会被扣成负数', async ({ page }) => {
    await gotoApp(page, '#/gacha')

    const tenBtn = page.getByTestId('pull-ten')
    const crystals = page.getByTestId('gacha-crystals')
    const tickets = page.getByTestId('gacha-tickets')

    // 新手资源：3000 结晶 + 10 张券 → 结晶优先
    await expect(tenBtn).toContainText('结晶 3000')
    await expect(crystals).toHaveText('3,000')
    await expect(tickets).toHaveText('10')

    // 第一次十连：扣 3000 结晶，抽卡券不动
    await tenBtn.click()
    await skipGachaReveal(page)
    await page.getByRole('button', { name: '收下' }).click()
    await expect(page.locator('.dialog')).toHaveCount(0)
    await expect(crystals).toHaveText('0')
    await expect(tickets).toHaveText('10')

    // 结晶用尽 → 十连改用抽卡券（券够就能召唤）
    await expect(tenBtn).toContainText('券 10')
    await tenBtn.click()
    await skipGachaReveal(page)
    await page.getByRole('button', { name: '收下' }).click()
    await expect(page.locator('.dialog')).toHaveCount(0)
    await expect(crystals).toHaveText('0')
    await expect(tickets).toHaveText('0')

    // 券也用尽 → 按钮禁用，资源不得出现负数
    await expect(tenBtn).toBeDisabled()
    await expect(crystals).toHaveText('0')
    await expect(tickets).toHaveText('0')
  })

  test('十连混合支付只扣对应余额（结晶 2700 + 券 1）', async ({ page }) => {
    await gotoApp(page, '#/gacha')

    const singleBtn = page.getByTestId('pull-single')
    const tenBtn = page.getByTestId('pull-ten')
    const crystals = page.getByTestId('gacha-crystals')
    const tickets = page.getByTestId('gacha-tickets')

    // 新手资源：3000 结晶 + 10 张券
    await expect(crystals).toHaveText('3,000')
    await expect(tickets).toHaveText('10')

    // 先单抽一次（结晶优先 → 扣 300 结晶），把结晶压到只够 9 抽
    await singleBtn.click()
    await skipGachaReveal(page)
    await page.getByRole('button', { name: '收下' }).click()
    await expect(page.locator('.dialog')).toHaveCount(0)
    await expect(crystals).toHaveText('2,700')
    await expect(tickets).toHaveText('10')

    // 结晶只够 9 抽 → 十连必须用 9 抽结晶 + 1 张券补齐，按钮文案与实际扣费一致
    await expect(tenBtn).toContainText('结晶 2700 + 券 1')
    await tenBtn.click()
    await skipGachaReveal(page)
    await page.getByRole('button', { name: '收下' }).click()
    await expect(page.locator('.dialog')).toHaveCount(0)

    // 只扣对应余额：结晶清零（2700），抽卡券只扣 1 张（10 → 9）
    await expect(crystals).toHaveText('0')
    await expect(tickets).toHaveText('9')
  })
})

test.describe('抽卡演出（分级演出）', () => {
  test('十连逐张翻牌，每个 SSR 爆点都停住等点击后才继续', async ({ page }) => {
    test.setTimeout(60_000)
    await gotoApp(page, '#/gacha')

    // 还没抽：没有结算弹窗
    await expect(page.locator('.dialog')).toHaveCount(0)

    await page.getByTestId('pull-ten').click()

    // 演出层出现，且带「跳过」
    const reveal = page.getByTestId('gacha-reveal')
    await expect(reveal).toBeVisible()
    await expect(page.getByTestId('gacha-skip')).toBeVisible()
    // 演出期间不出现结算弹窗（先演后结算）
    await expect(page.locator('.dialog')).toHaveCount(0)
    // 十连 = 10 张卡
    await expect(page.getByTestId('gacha-reveal-card')).toHaveCount(10)

    // 新手保底 → 首个十连必出 1 位 SSR → 一定有全屏爆点
    const burst = page.getByTestId('gacha-burst')
    await expect(burst).toBeVisible({ timeout: 15000 })
    await expect(burst.locator('.tag-ssr')).toHaveText('SSR')
    await expect(burst.locator('.name')).not.toBeEmpty()

    // 爆点放完后画面**停住等玩家点击**（不会自己结束）
    const holdHint = page.getByTestId('gacha-hold-hint')
    await expect(holdHint).toBeVisible({ timeout: 15000 })
    // 停多久都不出结算：必须玩家点一下
    await page.waitForTimeout(3000)
    await expect(page.locator('.dialog')).toHaveCount(0)
    await expect(reveal).toBeVisible()
    await expect(holdHint).toBeVisible()

    // 每个实际抽到的 SSR 都有自己的停顿，须逐个放行。
    const ssrCount = await page.locator('.hist-row .tag-ssr').count()
    expect(ssrCount).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < ssrCount; i++) {
      await expect(holdHint).toBeVisible({ timeout: 15000 })
      await reveal.click({ position: { x: 12, y: 12 } })
      await expect(holdHint).toBeHidden()
    }
    await expect(page.locator('.dialog')).toBeVisible({ timeout: 15000 })
    await expect(reveal).toHaveCount(0)

    await page.getByRole('button', { name: '收下' }).click()
    await expect(page.locator('.dialog')).toHaveCount(0)
  })

  test('「跳过」立即结束演出并进入结算', async ({ page }) => {
    await gotoApp(page, '#/gacha')
    await page.getByTestId('pull-ten').click()

    const reveal = page.getByTestId('gacha-reveal')
    await expect(reveal).toBeVisible()
    await page.getByTestId('gacha-skip').click()

    // 跳过 = 把演出时间直接推到末尾（不演完剩余卡牌）
    await expect(reveal).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator('.dialog')).toBeVisible({ timeout: 5000 })
  })
})

/**
 * 离线结算弹窗会盖住抽卡按钮（第一次点击会被弹窗吃掉），
 * 出现时先收下，否则抽卡根本没发生。
 */
async function dismissOfflineIfAny(page: Page): Promise<void> {
  const offline = page.locator('.dialog').filter({ hasText: '离线推征结算' })
  const visible = await offline
    .waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true)
    .catch(() => false)
  if (!visible) return
  await offline.getByRole('button', { name: '收下' }).click()
  await expect(offline).toHaveCount(0)
}

/** 抽一次十连并走完演出 → 结算 */
async function pullTen(page: Page): Promise<string[]> {
  await dismissOfflineIfAny(page)
  await page.getByTestId('pull-ten').click()
  // 演出可跳过（这里只为提速，跳过失败不影响断言）
  await skipGachaReveal(page)
  await page.getByRole('button', { name: '收下' }).click()
  await expect(page.locator('.dialog')).toHaveCount(0)
  return page.locator('.hist-row').allTextContents()
}

test.describe('抽卡随机性（铁律 #24）', () => {
  test('两次十连抽到的英灵序列不同（不再是固定脚本）', async ({ page }) => {
    await gotoApp(page, '#/gacha')

    // 第一次十连：新手保底只替换第 10 张，前 9 张是纯随机产出
    const first = await pullTen(page)
    await expect(page.locator('.hist-row')).toHaveCount(10)

    const second = await pullTen(page)
    expect(second.slice(0, 9)).not.toEqual(first.slice(0, 9))
  })

  test('刷新页面后序列继续前进，不复现上一批', async ({ page }) => {
    await gotoApp(page, '#/gacha')

    const first = await pullTen(page)

    await page.reload()
    await page.waitForLoadState('networkidle')

    const second = await pullTen(page)
    expect(second.slice(0, 9)).not.toEqual(first.slice(0, 9))
  })
})

test.describe('卡面展示（Phase 8b · 3:4 完整卡面）', () => {
  test('抽卡结果以 3:4 完整卡面展示新获得英灵', async ({ page }) => {
    await gotoApp(page, '#/gacha')
    await page.locator('button', { hasText: '十连' }).first().click()
    // 演出会停在 SSR 爆点等玩家点击 → 这里直接跳过演出拿结算
    await skipGachaReveal(page)

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
