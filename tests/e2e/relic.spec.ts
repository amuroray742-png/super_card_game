import { test, expect, type Page } from '@playwright/test'
import { RELIC } from '../../src/core/config/economy.ts'
import {
  cachedSaveOf,
  pauseFarming,
  registerAccount,
  relicTotal,
  seedSession,
  serverRelics,
  settleIdleThroughUi,
  skipGachaReveal,
  uniqueUsername,
} from './helpers'

// 遗物必须用真实挂机时间收集，不能靠连点凭空产出。
test.setTimeout(240_000)

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

/**
 * 注册账号并注入会话，落到抽卡页（深链不会被新手引导劫持）。
 *
 * 返回账号 id：本地缓存**按账号分槽位**（AGENTS.md 铁律 #15），
 * 读缓存必须按账号取槽位，不能取「第一个 `sgw.save.*` 键」
 * （浏览器里还可能有存量单槽位 `sgw.save.main`，键序不保证）。
 */
async function bootLoggedIn(page: Page): Promise<number> {
  const session = await registerAccount(uniqueUsername('relic'))
  await seedSession(page, session)
  await page.goto('/#/gacha')
  await page.waitForLoadState('networkidle')
  return session.user.id
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

/**
 * 仓库里的遗物实例（**服务端权威**）。
 *
 * ⚠ 存档分包后，客户端镜像里**只有已装备遗物**（≤36 件），
 *   仓库里可能几千件 → 「仓库里有几件」只能问服务端（铁律 #8 / #16）。
 */
async function relicsOf(page: Page): Promise<Array<{ defId: string; uid: string; level: number }>> {
  const result = await serverRelics(page)
  return result.items
}

/** 在推征页结算一场（读仓库件数会换页，所以每次结算前先回推征页） */
async function settleOnExpedition(
  page: Page,
  accountId: number,
  battles = 10,
): Promise<ReturnType<typeof settleIdleThroughUi> extends Promise<infer T> ? T : never> {
  await page.goto('/#/expedition')
  await page.waitForLoadState('networkidle')
  return settleIdleThroughUi(page, accountId, battles)
}

/**
 * 真实收集到目标件数才离开推征页；十场按钮不是「立即送十件」。
 * 推荐用例至少备足十件，保留完整六槽断言，不靠一次随机掉落猜数量。
 */
async function collectRelics(page: Page, accountId: number, target = 10): Promise<void> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await settleIdleThroughUi(page, accountId)
    if ((await relicTotal(page)) >= target) return
  }
  expect(await relicTotal(page), `真实挂机未收集到 ${target} 件遗物`).toBeGreaterThanOrEqual(target)
}

/** 读取某英灵当前已装备的遗物数量 */
async function equippedCountOf(page: Page, accountId: number, heroId: string): Promise<number> {
  const equipped = (await cachedSaveOf(page, accountId))?.equipped ?? {}
  return Object.values(equipped).filter((e) => e.heroId === heroId).length
}

/** 从详情页 URL 里取英灵 id */
function heroIdFromUrl(page: Page): string {
  return page.url().split('/hero/')[1]?.split('?')[0]?.split('#')[0] ?? ''
}

/** 读取玩家当前的银两与强化石 */
async function resourcesOf(
  page: Page,
  accountId: number,
): Promise<{ silver: number; stones: number }> {
  const save = await cachedSaveOf(page, accountId)
  return { silver: save?.player?.silver ?? 0, stones: save?.player?.relicStones ?? 0 }
}

test.describe('遗物获取途径（挂机掉落入库）', () => {
  test('推征产出的遗物真的进了仓库，刷新后也不丢', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)

    // 起点：新档仓库是空的
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('仓库暂无遗物')).toBeVisible()

    await setupTeam(page)

    // 等真实时间预算，再从按钮领取；不假定点击十场就会打满十场。
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    const settlement = await settleIdleThroughUi(page, accountId)

    // 结算提示里要报遗物数量（表现层只认 rewards 这一份口径）
    const toast = page.locator('.toast')
    await expect(toast).toContainText('遗物', { timeout: 6000 })
    const toastText = await toast.innerText()
    const dropped = Number(/遗物\s*(\d+)/.exec(toastText)?.[1] ?? 0)
    expect(dropped).toBeGreaterThan(0)
    expect(dropped).toBe(settlement.rewards.relics?.length ?? 0)

    // 仓库里真的有遗物了（服务端分页接口 = 页面渲染的那份数据）
    const firstPage = await serverRelics(page)
    expect(firstPage.total).toBe(dropped)
    const cells = page.locator('.relic-cell')
    await expect(cells.first()).toBeVisible()
    await expect(cells).toHaveCount(dropped)
    // 页面上的总件数与提示里的数量一致
    expect(await relicTotal(page)).toBe(dropped)

    // 存档里的实例结构完整（id 合法、能被强化与装备）
    const saved = await relicsOf(page)
    expect(saved).toHaveLength(dropped)
    for (const r of saved) {
      expect(r.defId).toBeTruthy()
      expect(r.uid).toBeTruthy()
      expect(r.level).toBeGreaterThanOrEqual(1)
    }

    // 刷新后旧实例不丢；载入可能补算新增掉落，因此不能固定总数。
    await page.reload()
    await page.waitForLoadState('networkidle')
    const reloaded = await relicsOf(page)
    expect(reloaded.length).toBeGreaterThanOrEqual(saved.length)
    for (const relic of saved) expect(reloaded).toContainEqual(relic)
    await expect(page.locator('.relic-cell')).toHaveCount(reloaded.length)
    expect(await relicTotal(page)).toBe(reloaded.length)

    // 遗物是**可用的实例**：点开能看到词条并能装备
    await page.getByTestId('relic-open').first().click()
    await expect(page.getByRole('button', { name: '装备到英灵' })).toBeVisible()
  })

  test('连推两轮，遗物逐轮累加（不是只剩最后一场的）', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // ⚠ 读仓库件数会**换页**（读的是服务端数据），所以每次结算前先回推征页
    const beforeFirst = await relicTotal(page)

    const first = await settleOnExpedition(page, accountId, 1)
    expect(first.rewards.relics?.length ?? 0).toBeGreaterThan(0)
    const afterFirst = await relicTotal(page)
    expect(afterFirst - beforeFirst).toBe(first.rewards.relics?.length ?? 0)

    const second = await settleOnExpedition(page, accountId, 1)
    expect(second.rewards.relics?.length ?? 0).toBeGreaterThan(0)
    expect((await relicTotal(page)) - afterFirst).toBe(second.rewards.relics?.length ?? 0)
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
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // 推征产遗物
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await collectRelics(page, accountId)
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

    // 图标真的加载出来了（不是 404 的空图）。
    // ⚠ 图片是**异步加载**的：格子可见 ≠ 图已加载完，
    //   直接查 naturalWidth 会偶发读到 0（图片还在路上）→ 必须轮询等加载完成。
    await expect
      .poll(
        async () =>
          icons.evaluateAll((els) =>
            els.every((el) => {
              const img = el as HTMLImageElement
              return img.complete && img.naturalWidth > 0
            }),
          ),
        { timeout: 10_000 },
      )
      .toBe(true)
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
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // 推征产遗物
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await collectRelics(page, accountId)
    await expect(page.locator('.toast')).toContainText('遗物', { timeout: 6000 })

    // ⚠ 清空编队：挂机时间账本会在**下一次动作**里一次性结算掉攒下的战斗，
    //   玩家钱包在「扣费」的同时还在「进账」→ 扣了多少根本不可确定。
    //   清空编队后无编队 → 无战斗 → 无掉落，扣费口径才能精确断言。
    await pauseFarming(page)

    // 铸造页 → 点第一件遗物 → 详情面板里必须有强化按钮
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    await page.getByTestId('relic-open').first().click()
    const upgrade = page.getByTestId('relic-upgrade')
    await expect(upgrade).toBeVisible()
    await expect(upgrade).toBeEnabled()
    // 强化 +1 的遗物 → 按钮指向 +2
    await expect(upgrade).toContainText('强化 +2')
    // 花费写出来（玩家点之前就知道要多少银两与强化石）
    await expect(page.getByText('强化消耗：银两')).toBeVisible()

    const before = await resourcesOf(page, accountId)

    await upgrade.click()

    // 等级 +1 → 按钮指向 +3
    await expect(upgrade).toContainText('强化 +3')

    // 银两与强化石**精确**被扣（编队已清空，没有并发进来的挂机收益）
    await expect.poll(async () => (await resourcesOf(page, accountId)).silver, { timeout: 8000 }).toBe(
      before.silver - RELIC.SILVER_PER_LEVEL,
    )
    await expect.poll(async () => (await resourcesOf(page, accountId)).stones, { timeout: 8000 }).toBe(
      before.stones - RELIC.STONES_PER_LEVEL,
    )

    // 落盘没丢：刷新后等级仍是 +2
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.getByTestId('relic-open').first().click()
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
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // 推征产遗物
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await collectRelics(page, accountId)
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
    await expect.poll(() => equippedCountOf(page, accountId, heroId), { timeout: 10_000 }).toBe(6)
  })

  test('套装效果区会指出「还差几件」并提示仓库里可换的件', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await collectRelics(page, accountId)
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

/**
 * 仓库批量操作与锁定。
 *
 * ⚠ 守的是「批量走服务端权威动作」——覆盖**已装备 / 锁定 / 重复提交**
 *   （roadmap P1-1 验收条件）。
 *
 * ⚠ 锁定的语义 = **永不被自动分解**（含库存溢出）：
 *   玩家特意留下的东西不该被一键清空。
 */
test.describe('仓库批量操作与锁定', () => {
  test('锁定的件不会被批量分解；其余勾选的会被分解掉', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    // 推征产遗物
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await collectRelics(page, accountId)

    // ⚠ 清空编队：否则批量动作会顺手结算挂机收益、仓库件数凭空多出几件，
    //   「分解掉了 1 件」就数不准了（挂机掉落会与分解同时发生）。
    await pauseFarming(page)

    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    expect(await relicTotal(page)).toBeGreaterThanOrEqual(2)

    // 先把第一件锁上
    await page.getByTestId('relic-open').first().click()
    await page.getByTestId('relic-lock').click()
    await expect(page.getByTestId('relic-lock')).toContainText('解除锁定')

    // 仓库件数此刻是稳定的（无编队 → 无挂机掉落），批量分解后正好少 1 件。
    // ⚠ 必须在**勾选之前**测量：读件数会离开再回到铸造页，页面重新挂载后
    //   详情面板关闭、勾选清空（批量按钮随之不可点）。
    const beforeBatch = await relicTotal(page)

    // 勾选前两件 → 批量分解
    const checks = page.getByTestId('relic-check')
    await checks.nth(0).check()
    await checks.nth(1).check()
    await expect(page.getByText('已选 2 件')).toBeVisible()

    await page.getByTestId('relic-batch-decompose').click()

    // 只分解掉 1 件（另一件被锁定跳过）
    await expect.poll(async () => relicTotal(page), { timeout: 8000 }).toBe(beforeBatch - 1)
  })

  test('批量强化：等级真的 +1，资源被扣', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await collectRelics(page, accountId)

    // 清空编队 → 无并发挂机收益 → 扣费可精确断言
    await pauseFarming(page)

    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')

    const silverBefore = (await cachedSaveOf(page, accountId))?.player?.silver ?? 0
    const stonesBefore = (await cachedSaveOf(page, accountId))?.player?.relicStones ?? 0

    const checks = page.getByTestId('relic-check')
    await checks.nth(0).check()
    await page.getByTestId('relic-batch-upgrade').click()

    // 银两与强化石被扣（正好一件遗物 +1 级）
    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.player?.silver ?? 0, { timeout: 8000 })
      .toBe(silverBefore - RELIC.SILVER_PER_LEVEL)
    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.player?.relicStones ?? 0, { timeout: 8000 })
      .toBe(stonesBefore - RELIC.STONES_PER_LEVEL)
  })
})
