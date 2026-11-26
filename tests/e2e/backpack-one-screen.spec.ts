import { test, expect, type Page } from '@playwright/test'
import {
  accessTokenOf,
  dismissOfflineReport,
  loginAccount,
  postAction,
  registerAccount,
  seedSession,
  uniqueUsername,
} from './helpers'
import { buildBackpackFixture } from '../../tools/capture/relic-fixture.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { ITEM_BY_ELEMENT } from '../../src/core/config/items.ts'

/**
 * **背包页「首屏可达」**（AGENTS.md 铁律 #69）。
 *
 * ## 这条用例守什么
 *
 * 背包页是**列表型**页面（仓库 60 件 / 碎片按英灵分堆），
 * 所以口径不是推征页那种「整页零滚动」，而是：
 *
 * > **每个分类的主操作按钮，在 360×640 的首屏内就能点到。**
 *
 * 旧版的问题（实测）：
 * - 遗物分类把套装进度（12 行）、保底进度（18 行）、套装效果（12 组）堆在仓库上方，
 *   真正的网格被挤到第三屏，**「强化 +1」按钮排在 1760px 的网格下面**；
 * - 技能材料把**全部**已拥有英灵平铺成列表（随拥有量线性变长）；
 * - 经验书把**全部**英灵铺成 chip（无上限，wrap 成好几行）。
 *
 * ## 首屏判定口径
 *
 * 视口 360×640 − 顶栏 48 − 底栏 58 = **内容区 534px**；
 * 底栏是 `.body` 的 flex 兄弟节点（**不叠内容**）⇒ 首屏底边 = **582px**。
 * 断言「按钮在首屏内」= `boundingBox().y + height ≤ 582`。
 */
test.use({ viewport: { width: 360, height: 640 } })

test.setTimeout(120_000)

/** 首屏内容区的底边（视口高 − 底栏高） */
const FIRST_SCREEN_BOTTOM = 640 - 58

/**
 * 导入前置存档（走**玩家可用的 `save.import` 动作**，不碰数据库）。
 *
 * ⚠ 用 `buildBackpackFixture`：遗物 60 件、五行材料、三档强化石、两种经验书、
 *   同名碎片一次到位 —— 不依赖真实时间与随机掉落。
 */
async function importBackpackFixture(page: Page, prefix: string): Promise<void> {
  const session = await registerAccount(uniqueUsername(prefix))
  const token = await accessTokenOf(session)
  const imported = await postAction(token, `${prefix}-fixture`, {
    type: 'save.import',
    payload: exportSave(buildBackpackFixture()),
  })
  expect(imported.ok, '前置存档导入失败').toBe(true)
  await seedSession(page, await loginAccount(session.user.username))
}

/** 元素底边是否落在首屏内 */
async function inFirstScreen(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) return false
  return box.y + box.height <= FIRST_SCREEN_BOTTOM
}

/** 有多少个匹配的元素落在首屏内 */
async function countInFirstScreen(page: Page, selector: string): Promise<number> {
  const locators = await page.locator(selector).all()
  let n = 0
  for (const locator of locators) {
    const box = await locator.boundingBox()
    if (box && box.y + box.height <= FIRST_SCREEN_BOTTOM) n += 1
  }
  return n
}

test.describe('背包页：首屏可达', () => {
  test('5 个分类在 360px 下**一行排完**（第 5 个不再被切在屏幕外）', async ({ page }) => {
    await importBackpackFixture(page, 'bagpill')
    await page.goto('/#/forge')
    await expect(page.getByTestId('backpack-tab-relics')).toBeVisible()
    await dismissOfflineReport(page)

    for (const key of ['relics', 'skillMat', 'relicStone', 'expBook', 'shards']) {
      const box = await page.getByTestId(`backpack-tab-${key}`).boundingBox()
      expect(box, `${key} 分类按钮没有布局`).toBeTruthy()
      expect(
        box!.x + box!.width,
        `「${key}」分类按钮被切在 360px 之外 ⇒ 玩家不知道还有这一类`,
      ).toBeLessThanOrEqual(360)
    }
  })

  test('遗物分类：容量条 + 网格 + 「去遗物副本」都在首屏内', async ({ page }) => {
    await importBackpackFixture(page, 'bagrelic')
    await page.goto('/#/forge?tab=relics')
    await expect(page.getByTestId('relic-total')).toBeVisible()
    await dismissOfflineReport(page)

    // 网格至少 6 件落在首屏内（列表可滚，但**首屏必须能看到东西**）
    expect(await countInFirstScreen(page, '.relic-cell')).toBeGreaterThanOrEqual(6)

    // 主操作：去遗物副本（遗物的唯一来源，铁律 #59）
    await expect(page.getByTestId('relic-go-dungeon')).toBeVisible()
    expect(await inFirstScreen(page, 'relic-go-dungeon')).toBe(true)

    // 图鉴摘要行（套装进度 + 保底 → L2）
    await expect(page.getByTestId('relic-atlas-open')).toBeVisible()
    expect(await inFirstScreen(page, 'relic-atlas-open')).toBe(true)
  })

  test('点遗物 → 详情抽屉升起来，「强化 +N」就在抽屉里', async ({ page }) => {
    await importBackpackFixture(page, 'bagdrawer')
    await page.goto('/#/forge?tab=relics')
    await expect(page.getByTestId('relic-total')).toBeVisible()
    await dismissOfflineReport(page)

    const firstCell = page.locator('.relic-cell').first()
    const before = await firstCell.boundingBox()

    await page.getByTestId('relic-open').first().click()
    const sheet = page.getByTestId('relic-detail-sheet')
    await expect(sheet).toBeVisible()

    // 强化按钮必须在**抽屉的可见范围内**（不是抽屉里要往下滚才看得到）
    const sheetBox = await sheet.boundingBox()
    const upgradeBox = await page.getByTestId('relic-upgrade').boundingBox()
    expect(sheetBox).toBeTruthy()
    expect(upgradeBox).toBeTruthy()
    expect(
      upgradeBox!.y + upgradeBox!.height,
      '「强化 +N」按钮落在抽屉可视区之外 ⇒ 还是要滚才摸得到操作键',
    ).toBeLessThanOrEqual(sheetBox!.y + sheetBox!.height)
    await expect(page.getByTestId('relic-upgrade')).toBeEnabled()

    // 关掉抽屉 ⇒ 底下网格的位置一个字都不动
    await page.getByTestId('relic-detail-close').click()
    await expect(sheet).toHaveCount(0)
    const after = await firstCell.boundingBox()
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1)
  })

  test('图鉴摘要行 → L2「套装与保底」，带返回按钮，套装与保底都写清楚', async ({ page }) => {
    await importBackpackFixture(page, 'bagatlas')
    await page.goto('/#/forge?tab=relics')
    await expect(page.getByTestId('relic-atlas-open')).toBeVisible()
    await dismissOfflineReport(page)

    await page.getByTestId('relic-atlas-open').click()
    await expect(page).toHaveURL(/\/forge\/sets/)
    await expect(page.getByText('套装与保底')).toBeVisible()

    // 返回按钮来自 App.vue 的 `.top-back`（非标签页路由自动带）
    const back = page.locator('.top-back')
    await expect(back).toBeVisible()

    // 12 个套装的进度行都在（件数口径来自**服务端统计**）
    await expect(page.getByTestId('relic-set-row-set_zhanshen')).toBeVisible()
    await expect(page.getByTestId('relic-set-row-set_zhanshen')).toContainText('/ 5')

    // 保底进度行也在（按遗物副本关卡列）
    await expect(page.locator('[data-testid^="relic-pity-row-"]').first()).toBeVisible()

    await back.click()
    await expect(page.getByTestId('relic-atlas-open')).toBeVisible()
  })

  test('技能材料：5 个「去副本」都在首屏内，英灵列表收进抽屉', async ({ page }) => {
    await importBackpackFixture(page, 'bagskill')
    await page.goto('/#/forge?tab=skillMat')
    await expect(page.getByTestId('backpack-element-金')).toBeVisible()
    await dismissOfflineReport(page)

    for (const el of ['金', '木', '水', '火', '土']) {
      // ⚠ 道具 id 走 core 的唯一口径 `ITEM_BY_ELEMENT`（禁止就地写字符串 id）
      const itemId = ITEM_BY_ELEMENT[el as keyof typeof ITEM_BY_ELEMENT]
      const goButton = page.getByTestId(`backpack-go-dungeon-${itemId}`)
      await expect(goButton).toBeVisible()
      expect(
        await inFirstScreen(page, `backpack-go-dungeon-${itemId}`),
        `「${el}」系材料的「去副本」按钮落在首屏之外`,
      ).toBe(true)
    }

    // 「可使用的英灵」是**一行摘要**，明细在抽屉里
    await expect(page.getByTestId('backpack-usable-heroes-open')).toBeVisible()
    await page.getByTestId('backpack-usable-heroes-open').click()
    await expect(page.getByTestId('backpack-usable-heroes')).toBeVisible()
    await expect(page.locator('[data-testid^="backpack-usable-hero-"]').first()).toBeVisible()
  })

  test('强化材料 / 经验书 / 卡碎片：主操作都在首屏内', async ({ page }) => {
    await importBackpackFixture(page, 'bagother')

    // 强化材料：三档强化石的「去副本」
    await page.goto('/#/forge?tab=relicStone')
    await expect(page.getByTestId('backpack-item-relicStoneTier1')).toBeVisible()
    await dismissOfflineReport(page)
    for (const tier of ['relicStoneTier1', 'relicStoneTier2', 'relicStoneTier3']) {
      expect(
        await inFirstScreen(page, `backpack-go-dungeon-${tier}`),
        `「${tier}」的「去副本」按钮落在首屏之外`,
      ).toBe(true)
    }

    // 经验书：「投喂」按钮在首屏内，且换人走抽屉
    await page.goto('/#/forge?tab=expBook')
    await expect(page.getByTestId('backpack-feed')).toBeVisible()
    await dismissOfflineReport(page)
    expect(await inFirstScreen(page, 'backpack-feed'), '「投喂」按钮落在首屏之外').toBe(true)
    await page.getByTestId('backpack-feed-pick-hero').click()
    await expect(page.getByTestId('backpack-hero-picker')).toBeVisible()
    await expect(page.locator('[data-testid^="backpack-pick-hero-"]').first()).toBeVisible()

    // 卡碎片：筛选行 + 前几行在首屏内，「共 N 位英灵」写清楚
    await page.goto('/#/forge?tab=shards')
    await expect(page.getByTestId('backpack-only-starable')).toBeVisible()
    await dismissOfflineReport(page)
    expect(await countInFirstScreen(page, '[data-testid^="backpack-shard-"]')).toBeGreaterThanOrEqual(3)
    await expect(page.getByText(/共 \d+ 位英灵有碎片/)).toBeVisible()
  })
})
