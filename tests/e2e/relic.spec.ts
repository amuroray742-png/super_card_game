import { test, expect, type Page } from '@playwright/test'
import { registerAccount, seedSession, skipGachaReveal, uniqueUsername } from './helpers'

/**
 * 遗物获取途径端到端用例。
 *
 * 守的是「玩家**真的**能拿到遗物」这条链路（AGENTS.md 铁律 #22 的教训：
 * 「配置齐全」≠「功能可用」）。
 *
 * ⚠ 历史 bug：core 的 `rollRewards` 只把遗物放进**独立数组**，
 *   `rewards.relics` 从未被赋值；而 store 的 `applyRewards` **只读 rewards**
 *   → 挂机 / 离线结算产出的遗物 100% 被丢弃。
 *   掉落表明明写着「每场必掉 1 件遗物」，仓库却永远是空的，
 *   强化石能掉但没东西可强化、套装效果永不触发——整条遗物养成线是死的。
 *
 * 本用例走**玩家能做到的操作**（抽卡 → 编队 → 推征 → 铸造仓库），
 * 不直接改存档（那既不真实，也会绕过 refresh token 轮换）。
 */

/** 注册账号并注入会话，落到抽卡页（深链不会被新手引导劫持） */
async function bootLoggedIn(page: Page): Promise<void> {
  const session = await registerAccount(uniqueUsername('relic'))
  await seedSession(page, session)
  await page.goto('/#/gacha')
  await page.waitForLoadState('networkidle')
}

/** 新手十连，拿到一批英灵 */
async function pullHeroes(page: Page): Promise<void> {
  await page.locator('button', { hasText: '十连' }).first().click()
  // 演出会停在 SSR 爆点等玩家点击 → 这里直接跳过演出拿结算
  await skipGachaReveal(page)
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

/** 阵位的 6 个槽位文案（前 3 前排 / 后 3 后排） */
const SLOT_TEXTS = ['空位 1', '空位 2', '空位 3', '空位 4', '空位 5', '空位 6'] as const

/**
 * 编满 6 人。
 *
 * ⚠ 人数不够会被卡在第 1 关：实测 2 人队每轮只打 3 场就卡关（战力不够），
 *   卡关后 `runIdle` 直接 break，那之后的战斗**没有掉落**。
 *   满编 6 人才能稳定跑满 10 场，遗物数量才够断言。
 */
async function setupTeam(page: Page): Promise<void> {
  await page.goto('/#/formation')
  await page.waitForLoadState('networkidle')
  for (let i = 0; i < SLOT_TEXTS.length; i++) {
    await placeHero(page, SLOT_TEXTS[i], i)
  }
}

/** 读取存档里的遗物实例列表 */
async function relicsOf(page: Page): Promise<Array<{ defId: string; uid: string; level: number }>> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('sgw.save.'))
    if (!key) return []
    const save = JSON.parse(localStorage.getItem(key)!) as { relics?: Array<{ defId: string; uid: string; level: number }> }
    return save.relics ?? []
  })
}

test.describe('遗物获取途径（挂机掉落入库）', () => {
  test('推征产出的遗物真的进了仓库，刷新后也不丢', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)

    // 起点：新档仓库是空的
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('仓库暂无遗物')).toBeVisible()

    await setupTeam(page)

    // 推征 10 场
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '推征 10 场' }).click()

    // 结算提示里要报遗物数量（表现层只认 rewards 这一份口径）
    const toast = page.locator('.toast')
    await expect(toast).toContainText('遗物', { timeout: 6000 })
    const toastText = await toast.innerText()
    const dropped = Number(/遗物\s*(\d+)/.exec(toastText)?.[1] ?? 0)
    expect(dropped).toBeGreaterThan(0)

    // 仓库里真的有遗物了
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    const cells = page.locator('.relic-cell')
    await expect(cells.first()).toBeVisible()
    await expect(cells).toHaveCount(dropped)
    // 页面上的总件数与提示里的数量一致
    await expect(page.getByText(`共 ${dropped} 件`)).toBeVisible()

    // 存档里的实例结构完整（id 合法、能被强化与装备）
    const saved = await relicsOf(page)
    expect(saved).toHaveLength(dropped)
    for (const r of saved) {
      expect(r.defId).toBeTruthy()
      expect(r.uid).toBeTruthy()
      expect(r.level).toBeGreaterThanOrEqual(1)
    }

    // 刷新后不丢（落盘没丢）
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.relic-cell')).toHaveCount(dropped)

    // 遗物是**可用的实例**：点开能看到词条并能装备
    await page.locator('.relic-cell').first().click()
    await expect(page.getByRole('button', { name: '装备到英灵' })).toBeVisible()
  })

  test('连推两轮，遗物逐轮累加（不是只剩最后一场的）', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: '推征 1 场' }).click()
    await expect(page.locator('.toast')).toBeVisible({ timeout: 6000 })
    const afterFirst = (await relicsOf(page)).length
    expect(afterFirst).toBeGreaterThan(0)

    await page.getByRole('button', { name: '推征 1 场' }).click()
    await expect(page.locator('.toast')).toBeVisible({ timeout: 6000 })
    await expect
      .poll(async () => (await relicsOf(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(afterFirst)
  })
})
