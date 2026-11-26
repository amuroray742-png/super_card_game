import { test, expect, type Page } from '@playwright/test'
import { dismissOfflineReport, giveTeam, importFixture, waitForAction } from './helpers'

/**
 * **推征页「一屏可达」**（AGENTS.md 铁律 #68）。
 *
 * ## 这条用例守什么
 *
 * 旧版推征页是 7 块纵向堆叠（主线面板 / 四张通道卡 / 副本入口 / 31 格关卡网格 /
 * 编队概览），实测约 1490px —— 而 360×640 机型的可视内容区只有 534px，
 * 于是「全部领取」这个每日高频按钮落在**第 2 屏中部**。
 *
 * 现在 L1 是**一屏**：当前关卡主卡 + 挂机四行摘要 + 副本入口行；
 * 低频信息下沉到带返回按钮的二级页（页面深度 ≤ 3 级）。
 *
 * ## 为什么用 360×640 这个最窄最矮的视口
 *
 * 「能不能一屏放下」只在**最不利机型**上验得出来：
 * 360×800 比 360×640 多 160px，430×932 又多 226px ——
 * 在宽机型上通过，在窄机型上照样滚。
 *
 * ⚠ 断言一律用 locator 的自动等待（`expect(...).toBeVisible()`）：
 *   SPA 走 hash 路由，同文档导航时 `networkidle` 立刻满足但组件还没挂载
 *   （AGENTS.md 铁律 #13）。
 */
test.use({ viewport: { width: 360, height: 640 } })

test.setTimeout(120_000)

/** 一支能打的队伍（等级只影响能否打赢，不影响布局） */
const TEAM = ['hanxin', 'luban', 'zhugeliang', 'libai', 'xiangyu', 'chengjisihan'] as const

/** 内容区滚动容器的溢出量（0 = 没有纵向滚动） */
async function bodyOverflow(page: Page): Promise<number> {
  return page
    .locator('.body')
    .evaluate((el) => (el as HTMLElement).scrollHeight - (el as HTMLElement).clientHeight)
}

/** 元素底边是否落在首屏内 */
async function bottomInFirstScreen(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) return false
  return box.y + box.height <= 640
}

test.describe('推征页：一屏可达', () => {
  test('360×640 下 L1 没有纵向滚动，三个关键 CTA 都在首屏内', async ({ page }) => {
    await importFixture(page, 'onescreen', (save) => {
      giveTeam(save, TEAM, 60)
      save.campaign.clearedStage = 5
    })

    await page.goto('/#/expedition')
    await expect(page.getByTestId('campaign-challenge')).toBeVisible()
    await dismissOfflineReport(page)

    // ① L1 不许有纵向滚动
    const overflow = await bodyOverflow(page)
    expect(overflow, `推征页在 360×640 下出现了 ${overflow}px 的纵向滚动`).toBeLessThanOrEqual(4)

    // ② 三个关键 CTA 必须都在首屏内
    for (const id of ['campaign-challenge', 'idle-claim-all', 'stage-stage-list']) {
      await expect(page.getByTestId(id), `${id} 不可见`).toBeVisible()
      expect(await bottomInFirstScreen(page, id), `${id} 落在首屏之外`).toBe(true)
    }
  })

  test('通道行点得动：主线 → 选关模式，三个副本 → 副本页', async ({ page }) => {
    await importFixture(page, 'onechan', (save) => {
      giveTeam(save, TEAM, 60)
      save.campaign.clearedStage = 5
    })
    await page.goto('/#/expedition')
    await expect(page.getByTestId('idle-channel-main')).toBeVisible()

    // ① 主线通道 → 关卡一览的「选关模式」
    await page.getByTestId('idle-channel-main').click()
    // ⚠ **必须等路由真的切过去**：不能用 `toBeVisible()` 等「关卡 ›」按钮——
    //   推征页上也有一个同 testid 的按钮，等它等于什么都没等（导航还没发生）。
    await expect(page).toHaveURL(/#\/stages/)
    await expect(page).toHaveURL(/pick=main/)
    await expect(page.locator('.stage-grid')).toBeVisible()

    // ② 技能副本通道 → 副本页对应 tab
    await page.goto('/#/expedition')
    await expect(page.getByTestId('idle-channel-skill')).toBeVisible()
    await page.getByTestId('idle-channel-skill').click()
    await expect(page).toHaveURL(/kind=skill/)
    await expect(page.getByTestId('dungeon-kind-skill')).toBeVisible()
  })

  test('二级页有返回按钮，返回后回到推征页', async ({ page }) => {
    await importFixture(page, 'oneback', (save) => {
      giveTeam(save, TEAM, 60)
      save.campaign.clearedStage = 5
    })
    await page.goto('/#/expedition')
    await expect(page.getByTestId('stage-stage-list')).toBeVisible()

    await page.getByTestId('stage-stage-list').click()
    await expect(page.locator('.stage-grid')).toBeVisible()

    // ⚠ 二级页**同样一屏**：31 格网格塞进去后不能把页面撑出第二屏
    const overflow = await bodyOverflow(page)
    expect(overflow, `关卡一览页出现了 ${overflow}px 的纵向滚动`).toBeLessThanOrEqual(4)

    // 返回按钮来自 App.vue 的 `.top-back`（非标签页路由自动带）
    const back = page.locator('.top-back')
    await expect(back).toBeVisible()
    await back.click()
    await expect(page.getByTestId('campaign-challenge')).toBeVisible()
  })

  test('挂机「详情 ›」开抽屉：四条通道的明细与规则都在里面', async ({ page }) => {
    await importFixture(page, 'onesheet', (save) => {
      giveTeam(save, TEAM, 60)
      save.campaign.clearedStage = 5
    })
    await page.goto('/#/expedition')
    await expect(page.getByTestId('idle-detail-open')).toBeVisible()

    await page.getByTestId('idle-detail-open').click()
    const sheet = page.getByTestId('idle-detail')
    await expect(sheet).toBeVisible()

    // 四条通道的明细都在抽屉里（「每次产出」是一屏化时被挤掉的那部分信息）
    for (const kind of ['main', 'skill', 'enhance', 'relic']) {
      await expect(page.getByTestId(`idle-detail-${kind}`)).toContainText('每次产出')
    }
    // 挂机规则也在
    await expect(sheet).toContainText('不跑战斗')

    await page.getByTestId('idle-detail-close').click()
    await expect(sheet).toHaveCount(0)
  })

  test('战斗回放是覆盖层：关掉后主卡位置一个字都不动', async ({ page }) => {
    await importFixture(page, 'oneoverlay', (save) => {
      giveTeam(save, TEAM, 60)
      save.campaign.clearedStage = 5
    })
    await page.goto('/#/expedition')
    await expect(page.getByTestId('campaign-challenge')).toBeVisible()
    await dismissOfflineReport(page)

    const before = await page.getByTestId('campaign-challenge').boundingBox()
    expect(before).toBeTruthy()

    // 挑战 → 覆盖层升起
    await waitForAction(page, 'campaign.challenge', {
      trigger: async () => {
        await page.getByTestId('campaign-challenge').click()
      },
    })
    const overlay = page.getByTestId('challenge-replay')
    await expect(overlay).toBeVisible({ timeout: 10_000 })

    // 覆盖层期间底下的页面**不能滚**（锁住了）
    expect(await bodyOverflow(page), '覆盖层打开时底下页面还能滚').toBeLessThanOrEqual(4)

    // 关掉覆盖层 → 底下页面的位置必须原样
    await page.getByTestId('challenge-replay-close').click()
    await expect(overlay).toHaveCount(0)

    const after = await page.getByTestId('campaign-challenge').boundingBox()
    expect(after).toBeTruthy()
    expect(
      Math.abs((after?.y ?? 0) - (before?.y ?? 0)),
      '关掉覆盖层后主卡位置变了 ⇒ 覆盖层没有真正做到「关掉后回到原位」',
    ).toBeLessThanOrEqual(1)
  })
})
