import { test, expect, type Page } from '@playwright/test'
import { registerAccount, seedSession, uniqueUsername, type E2eSession } from './helpers'

/**
 * 战斗演出端到端用例（§6.3「数值型轻演出」）。
 *
 * 覆盖：观战 → 画布渲染 → 演出推进 → 跳过 → 战后结算 → 倍速写回存档。
 *
 * ⚠ 用例只断言**结构与交互存在**，不依赖具体数值：
 *   战斗胜负、伤害数字都随养成变化，断言它们会让 E2E 变成数值测试。
 *   真正要守住的是「画布真的在按时间轴演出」与「结算面板真的出得来」。
 */

interface CanvasProbe {
  /** 画布 backing store 宽度（设备像素） */
  width: number
  /** 画布 CSS 宽度 */
  clientWidth: number
  height: number
  clientHeight: number
  /** 2D 变换矩阵的缩放分量——必须是 DPR，否则高分屏整场戏挤在角落 */
  scale: number
  /** 画布里不透明像素占比（画过东西就不是空白） */
  paintedRatio: number
}

/** 注册账号并注入会话，落到抽卡页（深链不会被新手引导劫持） */
async function bootLoggedIn(page: Page): Promise<E2eSession> {
  const session = await registerAccount(uniqueUsername('battle'))
  await seedSession(page, session)
  await page.goto('/#/gacha')
  await page.waitForLoadState('networkidle')
  return session
}

/** 新手十连，拿到一批英灵 */
async function pullHeroes(page: Page): Promise<void> {
  await page.locator('button', { hasText: '十连' }).first().click()
  await page.getByRole('button', { name: '收下' }).click()
  await expect(page.locator('.dialog')).toHaveCount(0)
}

/** 把第 index 位英灵放进指定槽位（阵位页的选择器） */
async function placeHero(page: Page, slotText: string, index: number): Promise<void> {
  await page.locator('.slot', { hasText: slotText }).click()
  const dialog = page.locator('.dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('.pick-row').nth(index).click()
  await expect(dialog).toHaveCount(0)
}

/** 编好队：前排 1 人、后排 1 人 */
async function setupTeam(page: Page): Promise<void> {
  await page.goto('/#/formation')
  await page.waitForLoadState('networkidle')
  await placeHero(page, '空位 1', 0)
  await placeHero(page, '空位 4', 1)
}

/** 读取画布的渲染状态 */
async function probeCanvas(page: Page): Promise<CanvasProbe> {
  return page.evaluate(() => {
    const el = document.querySelector('canvas.battle-canvas') as HTMLCanvasElement | null
    if (!el) throw new Error('找不到战斗画布')
    const c = el.getContext('2d')
    if (!c) throw new Error('取不到 2D 上下文')
    const t = c.getTransform()
    const data = c.getImageData(0, 0, el.width, el.height).data
    let painted = 0
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) painted++
    }
    return {
      width: el.width,
      clientWidth: el.clientWidth,
      height: el.height,
      clientHeight: el.clientHeight,
      scale: t.a,
      paintedRatio: painted / (el.width * el.height),
    }
  })
}

test.describe('战斗演出（§6.3 数值型轻演出）', () => {
  test('观战：画布按 DPR 渲染，演出推进，跳过后出战后结算', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    // 未编队时不该有回放面板；编好队后点「观战」出画布
    await page.getByRole('button', { name: '观战', exact: true }).click()

    const canvas = page.locator('canvas.battle-canvas')
    await expect(canvas).toBeVisible()
    await expect(page.getByText('战斗回放')).toBeVisible()

    // 高分屏必须按 DPR 建缓冲并设置变换矩阵（铁律 #17）
    const probe = await probeCanvas(page)
    const dpr = Math.min(2, await page.evaluate(() => window.devicePixelRatio || 1))
    expect(probe.scale).toBeGreaterThan(0)
    expect(Math.abs(probe.scale - dpr)).toBeLessThan(0.01)
    expect(probe.width).toBe(Math.floor(probe.clientWidth * dpr))
    expect(probe.height).toBe(Math.floor(probe.clientHeight * dpr))
    // 画布不能是空白
    expect(probe.paintedRatio).toBeGreaterThan(0.9)

    // 画面上确实有人（我方 2 人 + 敌方若干）
    const visible = await canvas.getAttribute('data-visible-units')
    expect(Number(visible)).toBeGreaterThanOrEqual(3)

    // 演出在推进：回合数会往前走
    await expect(canvas).toHaveAttribute('data-round', /[1-9]\d*/)
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-round')), { timeout: 15_000 })
      .toBeGreaterThan(1)

    // 控制条齐全
    await expect(page.getByRole('button', { name: '重播', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '跳过', exact: true })).toBeVisible()
    for (const s of [1, 2, 4, 8]) {
      await expect(page.getByRole('button', { name: `×${s}`, exact: true })).toBeVisible()
    }

    // 重播：时间轴回到开头（纯函数模型的直接体现）
    await page.getByRole('button', { name: '重播', exact: true }).click()
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-progress')), { timeout: 5_000 })
      .toBeLessThan(0.3)

    // 跳过 → 战后结算面板
    await page.getByRole('button', { name: '跳过', exact: true }).click()
    const panel = page.locator('.result-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('战后结算')
    await expect(panel).toContainText('回合数')
    await expect(panel).toContainText('存活')
    await expect(panel).toContainText('伤害统计')
    await expect(panel).toContainText('掉落')
    // 胜败标签二选一
    await expect(panel.locator('.tag').first()).toHaveText(/胜利|失败/)
  })

  test('设置页开启「跳过演出」后，观战直接出战后结算', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // 设置页打开「跳过演出」
    await page.goto('/#/settings')
    await page.waitForLoadState('networkidle')
    const row = page.locator('.setting-row').filter({ hasText: '跳过演出' })
    await expect(row).toBeVisible()
    await row.locator('button.switch').click()
    await expect(row.locator('button.switch')).toHaveClass(/on/)

    // 观战：不播演出，直接出结算
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '观战', exact: true }).click()

    await expect(page.locator('.result-panel')).toBeVisible()
    await expect(page.locator('.result-panel')).toContainText('战后结算')
    // 时间轴被推到末尾
    await expect(page.locator('canvas.battle-canvas')).toHaveAttribute('data-progress', '1.0000')
  })

  test('倍速切换会写回存档（跨页面保持）', async ({ page }) => {
    const session = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '观战', exact: true }).click()
    await expect(page.locator('canvas.battle-canvas')).toBeVisible()

    await page.getByRole('button', { name: '×4', exact: true }).click()
    await expect(page.locator('canvas.battle-canvas')).toHaveAttribute('data-speed', '4')

    // 写进了本地存档槽位（每账号一个槽位）
    const saved = await page.evaluate(
      (slot) => {
        const raw = localStorage.getItem(`sgw.save.${slot}`)
        return raw ? (JSON.parse(raw) as { settings?: { speed?: number } }).settings?.speed : undefined
      },
      String(session.user.id),
    )
    expect(saved).toBe(4)
  })

  test('关卡详情页的战斗预览用同一套动画回放', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    await page.goto('/#/stage/1')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '战斗预览', exact: true }).click()

    await expect(page.locator('canvas.battle-canvas')).toBeVisible()
    await expect(page.locator('.battle-ctrl')).toBeVisible()

    // 预览也要**自动开演**（曾经因为没人调 replay() 而卡在第 0 帧不动）
    const canvas = page.locator('canvas.battle-canvas')
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-round')), { timeout: 15_000 })
      .toBeGreaterThan(1)

    // 预览同样能出结算
    await page.getByRole('button', { name: '跳过', exact: true }).click()
    await expect(page.locator('.result-panel')).toBeVisible()
  })

  test('未编队时点观战会提示，不出画布', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '观战', exact: true }).click()

    await expect(page.getByText('请先在阵位中编队')).toBeVisible()
    await expect(page.locator('canvas.battle-canvas')).toHaveCount(0)
  })
})
