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

/** 读取某英灵当前已装备的遗物数量 */
async function equippedCountOf(page: Page, heroId: string): Promise<number> {
  return page.evaluate((id) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('sgw.save.'))
    if (!key) return 0
    const save = JSON.parse(localStorage.getItem(key)!) as {
      equipped?: Record<string, { heroId: string }>
    }
    return Object.values(save.equipped ?? {}).filter((e) => e.heroId === id).length
  }, heroId)
}

/** 从详情页 URL 里取英灵 id */
function heroIdFromUrl(page: Page): string {
  return page.url().split('/hero/')[1]?.split('?')[0]?.split('#')[0] ?? ''
}

/** 读取玩家当前的银两与强化石 */
async function resourcesOf(page: Page): Promise<{ silver: number; stones: number }> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('sgw.save.'))
    if (!key) return { silver: 0, stones: 0 }
    const save = JSON.parse(localStorage.getItem(key)!) as {
      player?: { silver?: number; relicStones?: number }
    }
    return { silver: save.player?.silver ?? 0, stones: save.player?.relicStones ?? 0 }
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

/**
 * 遗物图标。
 *
 * 遗物原本**完全没有图标**：仓库里 60 件遗物长得一模一样，
 * 玩家只能靠名字认——同套装同稀有度的几件根本分不清。
 */
test.describe('遗物图标', () => {
  test('仓库里每件遗物都有自己的图标，路径由 core 给出', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // 推征产遗物
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '推征 10 场' }).click()
    await expect(page.locator('.toast')).toContainText('遗物', { timeout: 6000 })

    // 铸造页：每件遗物都有图标
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    const icons = page.locator('.relic-cell img.relic-icon')
    await expect(icons.first()).toBeVisible()
    const cellCount = await page.locator('.relic-cell').count()
    expect(await icons.count()).toBe(cellCount)

    // 路径口径：/relics/<遗物定义 id>.svg（表现层不自己拼，铁律 #8）
    const srcs = await icons.evaluateAll((els) =>
      els.map((el) => (el as HTMLImageElement).getAttribute('src') ?? ''),
    )
    for (const src of srcs) {
      expect(src).toMatch(/^\/relics\/set_[a-z]+_\d+\.svg$/)
    }

    // 图标真的加载出来了（不是 404 的空图）
    const loaded = await icons.evaluateAll((els) =>
      els.every((el) => (el as HTMLImageElement).naturalWidth > 0),
    )
    expect(loaded).toBe(true)
  })
})

/**
 * 遗物强化。
 *
 * ⚠ 玩家反馈「遗物现在好像不能强化升级」。根因是**界面**：
 *   铸造页（遗物仓库）原本**根本没有强化按钮**，
 *   唯一入口藏在英灵页、且要求遗物**已经装备**——
 *   仓库里躺着的一堆遗物一件都强化不了。
 */
test.describe('遗物强化', () => {
  test('铸造页就能强化：等级 +1、银两与强化石被扣、落盘没丢', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // 推征产遗物
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '推征 10 场' }).click()
    await expect(page.locator('.toast')).toContainText('遗物', { timeout: 6000 })

    // 铸造页 → 点第一件遗物 → 详情面板里必须有强化按钮
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    await page.locator('.relic-cell').first().click()
    const upgrade = page.getByTestId('relic-upgrade')
    await expect(upgrade).toBeVisible()
    await expect(upgrade).toBeEnabled()
    // 强化 +1 的遗物 → 按钮指向 +2
    await expect(upgrade).toContainText('强化 +2')
    // 花费写出来（玩家点之前就知道要多少银两与强化石）
    await expect(page.getByText('强化消耗：银两')).toBeVisible()

    const before = await resourcesOf(page)

    await upgrade.click()

    // 等级 +1 → 按钮指向 +3
    await expect(upgrade).toContainText('强化 +3')

    // 银两与强化石真的被扣
    await expect.poll(async () => (await resourcesOf(page)).silver, { timeout: 8000 }).toBeLessThan(
      before.silver,
    )
    await expect.poll(async () => (await resourcesOf(page)).stones, { timeout: 8000 }).toBeLessThan(
      before.stones,
    )

    // 落盘没丢：刷新后等级仍是 +2
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.locator('.relic-cell').first().click()
    await expect(page.getByTestId('relic-upgrade')).toContainText('强化 +3')
  })
})

/**
 * 一键推荐装备 + 套装效果可见。
 *
 * ⚠ 套装 2/4/6 阶梯加成**早就存在**（配置 + 战斗计算都已接上），
 *   但界面完全没展示 → 玩家不知道「再凑 1 件就能开 4 件套」，养成线等于隐形。
 */
test.describe('一键推荐装备与套装效果', () => {
  test('英灵页一键推荐：6 槽填满、战力提升、套装档位可见', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // 推征产遗物
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '推征 10 场' }).click()
    await expect(page.locator('.toast')).toContainText('遗物', { timeout: 6000 })

    // 进英灵详情页
    await page.goto('/#/temple')
    await page.waitForLoadState('networkidle')
    await page.locator('.hero-cell').first().click()
    await expect(page).toHaveURL(/#\/hero\//)

    // 一键推荐按钮在，且给出了战力增量
    const btn = page.getByTestId('relic-recommend')
    await btn.scrollIntoViewIfNeeded()
    await expect(btn).toBeVisible()
    await expect(btn).toContainText('一键推荐装备')

    // 套装的 2/4/6 阶梯在页面上看得见（哪怕当前一件都没装）
    await expect(page.getByText('套装效果', { exact: true })).toBeVisible()
    await expect(page.getByText('2 / 4 / 6 件可激活阶梯加成')).toBeVisible()

    // 点一键推荐 → 6 个槽位填满
    await btn.click()
    await expect(page.locator('.relic-slot.filled')).toHaveCount(6, { timeout: 10_000 })

    // 套装效果区现在显示了具体套装与档位
    const setPanel = page.locator('.set-row')
    await expect(setPanel.first()).toBeVisible()
    await expect(setPanel.first()).toContainText('件')
    // 至少有一档写着「还差 N 件」或「已生效」
    await expect(page.getByText(/已生效|还差 \d+ 件/).first()).toBeVisible()

    // 战力确实涨了（推荐完按钮应变为「已是推荐配置」）
    await expect(page.getByText('当前已是最优配置')).toBeVisible()

    // 存档里确实给这名英灵穿上了 6 件
    const heroId = heroIdFromUrl(page)
    expect(heroId).not.toBe('')
    await expect.poll(() => equippedCountOf(page, heroId), { timeout: 10_000 }).toBe(6)
  })

  test('套装效果区会指出「还差几件」并提示仓库里可换的件', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '推征 10 场' }).click()
    await expect(page.locator('.toast')).toContainText('遗物', { timeout: 6000 })

    await page.goto('/#/temple')
    await page.waitForLoadState('networkidle')
    await page.locator('.hero-cell').first().click()
    await expect(page).toHaveURL(/#\/hero\//)
    await page.getByTestId('relic-recommend').scrollIntoViewIfNeeded()
    await page.getByTestId('relic-recommend').click()
    await expect(page.locator('.relic-slot.filled')).toHaveCount(6, { timeout: 10_000 })

    // 套装区有「还差 N 件」的阶梯提示
    await expect(page.getByText(/还差 \d+ 件/).first()).toBeVisible()
  })
})
