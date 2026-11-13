import { test, expect, type Page } from '@playwright/test'
import { registerAccount, seedSession, uniqueUsername } from './helpers'

/**
 * 英灵养成端到端用例（属性面板 + 技能升级 + 喂经验扣经验池）。
 *
 * 守的是三条真实反馈：
 * 1. 「卡牌升级看不到属性提升」——详情页原本**压根没有属性区**；
 * 2. 「技能升级提示资源不足，但我明明有 2.1 万术式结晶」——
 *    原实现扣的是**圣杯结晶**，不是术式结晶；
 * 3. 「喂经验不扣经验池」——原实现只加不减，经验池是死资源、喂经验等于白嫖等级。
 *
 * ⚠ 用例只走**玩家能做到的操作**（抽卡 → 编队 → 推征 → 圣殿 → 详情页 → 喂经验 / 提升技能），
 *   不直接改存档——那既不真实，也会绕过 refresh token 轮换。
 */

/** 注册账号并注入会话，落到抽卡页（深链不会被新手引导劫持） */
async function bootLoggedIn(page: Page): Promise<void> {
  const session = await registerAccount(uniqueUsername('growth'))
  await seedSession(page, session)
  await page.goto('/#/gacha')
  await page.waitForLoadState('networkidle')
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

/**
 * 编好队：前排 2 人、后排 2 人。
 *
 * ⚠ 必须编队才能推征——经验池的经验来自推征掉落。
 *   队里放的是列表首位（圣殿按稀有度降序，首位就是新手保底 SSR）。
 *   ⚠ **至少 3 人**：实测 2 人队（战力 1436）在第 1 关每轮只打 3 场就卡关，
 *     3 人队（战力 2081）才能跑满 10 场。人数不够 → 经验攒不够 → 喂经验按钮全禁用。
 */
async function setupTeam(page: Page): Promise<void> {
  await page.goto('/#/formation')
  await page.waitForLoadState('networkidle')
  await placeHero(page, '空位 1', 0)
  await placeHero(page, '空位 2', 1)
  await placeHero(page, '空位 4', 2)
  await placeHero(page, '空位 5', 3)
}

/** 读取玩家经验池 */
async function expPoolOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('sgw.save.'))!
    const save = JSON.parse(localStorage.getItem(key)!)
    return save.player.exp ?? 0
  })
}

/**
 * 推征刷经验，直到经验池达到 target。
 *
 * ⚠ 经验是**推征掉落**进池子的，玩家必须先打过一场才有经验可喂。
 *   推征遇到战败会中断（runIdle 遇败即停），所以这里允许「这一轮没涨」再重试。
 */
async function farmExp(page: Page, target: number): Promise<number> {
  await page.goto('/#/expedition')
  await page.waitForLoadState('networkidle')
  const btn = page.locator('button', { hasText: '推征 10 场' })
  let pool = await expPoolOf(page)
  for (let i = 0; i < 8 && pool < target; i++) {
    await btn.click()
    // 推征结算落盘后经验池才会涨
    await page.waitForTimeout(800)
    pool = await expPoolOf(page)
  }
  return pool
}

/** 进圣殿点开第一个英灵的详情页 */
async function openFirstHeroDetail(page: Page): Promise<void> {
  await page.goto('/#/temple')
  await page.waitForLoadState('networkidle')
  await page.locator('.hero-cell').first().click()
  await expect(page).toHaveURL(/#\/hero\//)
  await expect(page.locator('[data-stat="atk"]')).toBeVisible()
}

/**
 * 解析展示层的数字。
 *
 * ⚠ `formatNumber` 会输出「1.3万」「2.4亿」，直接去非数字字符会把
 *   1.3万 读成 1.3（而且跨过 1e4 时数值不连续，比较必然出错）。
 */
function parseStat(text: string): number {
  const t = text.trim()
  if (t.includes('亿')) return parseFloat(t) * 1e8
  if (t.includes('万')) return parseFloat(t) * 1e4
  return Number(t.replace(/,/g, ''))
}

/** 读取属性数值 */
async function statOf(page: Page, key: string): Promise<number> {
  const text = await page.locator(`[data-stat="${key}"] b`).innerText()
  const n = parseStat(text)
  return Number.isFinite(n) ? n : 0
}

/**
 * 读取英灵当前等级。
 *
 * ⚠ 必须定位到「等级」那一行——详情页还有「境界（Lv1-60）」，
 *   直接对整块取首个 Lv 会读到境界区间。
 */
async function levelOf(page: Page): Promise<number> {
  const text = await page
    .locator('.stat-row .row-between')
    .filter({ hasText: '等级' })
    .first()
    .innerText()
  const m = text.match(/Lv(\d+)/)
  return m ? Number(m[1]) : 0
}

/** 读取技能等级（技能区第一个技能） */
async function skillLevelOf(page: Page): Promise<number> {
  const text = await page.locator('.skill .tag-sr').first().innerText()
  const m = text.match(/Lv(\d+)/)
  return m ? Number(m[1]) : 0
}

/** 读取玩家资源 */
async function resourcesOf(page: Page): Promise<{ skillStones: number; crystals: number }> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('sgw.save.'))!
    const save = JSON.parse(localStorage.getItem(key)!)
    return { skillStones: save.player.skillStones, crystals: save.player.crystals }
  })
}

test.describe('英灵养成（属性面板 + 技能升级）', () => {
  test('详情页展示攻击/防御/生命/速度与战力', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await openFirstHeroDetail(page)

    for (const key of ['atk', 'def', 'hp', 'spd']) {
      const cell = page.locator(`[data-stat="${key}"]`)
      await expect(cell).toBeVisible()
      await expect(cell.locator('b')).not.toHaveText('')
    }
    await expect(page.getByText('战力').first()).toBeVisible()
  })

  test('喂经验后等级与属性都提升（并能看到提升预览）', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)
    await farmExp(page, 1_200)
    await openFirstHeroDetail(page)

    const levelBefore = await levelOf(page)
    const atkBefore = await statOf(page, 'atk')
    const hpBefore = await statOf(page, 'hp')

    // 提升预览：喂经验 / 升星各一行，带绿色的 +N
    await expect(page.locator('.preview-box')).toBeVisible()
    await expect(page.locator('.preview-box .ok-text').first()).toContainText('攻 +')

    // 全部喂入（经验池有多少喂多少）
    await page.locator('[data-testid="feed-all"]').click()

    await expect.poll(() => levelOf(page), { timeout: 8_000 }).toBeGreaterThan(levelBefore)
    await expect.poll(() => statOf(page, 'atk'), { timeout: 8_000 }).toBeGreaterThan(atkBefore)
    await expect.poll(() => statOf(page, 'hp'), { timeout: 8_000 }).toBeGreaterThan(hpBefore)
  })

  test('技能升级消耗术式结晶，圣杯结晶不动', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await openFirstHeroDetail(page)

    const before = await skillLevelOf(page)
    const resBefore = await resourcesOf(page)

    const btn = page.locator('button', { hasText: '提升等级' }).first()
    await expect(btn).toBeEnabled()
    await btn.click()

    // 技能等级 +1
    await expect.poll(() => skillLevelOf(page), { timeout: 8_000 }).toBe(before + 1)

    const resAfter = await resourcesOf(page)
    // 术式结晶被扣
    expect(resAfter.skillStones).toBeLessThan(resBefore.skillStones)
    // 圣杯结晶**一分没动**（原实现扣的是它）
    expect(resAfter.crystals).toBe(resBefore.crystals)
  })

  test('术式结晶不足时按钮禁用并给出差额提示', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await openFirstHeroDetail(page)

    const btn = page.locator('button', { hasText: '提升等级' }).first()
    const before = await skillLevelOf(page)
    // 初始术式结晶有限（每次 12），连续提升到不够为止
    for (let i = 0; i < 5; i++) {
      if (await btn.isDisabled()) break
      await btn.click()
      await expect.poll(() => skillLevelOf(page), { timeout: 8_000 }).toBe(before + i + 1)
      await page.waitForTimeout(250)
    }

    await expect(btn).toBeDisabled()
    await expect(page.getByText(/术式结晶不足/).first()).toBeVisible()
  })
})

test.describe('喂经验扣玩家经验池', () => {
  test('喂经验会从经验池扣款，经验池是唯一来源', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    const pool = await farmExp(page, 1_200)
    expect(pool).toBeGreaterThan(0)

    await openFirstHeroDetail(page)
    // 详情页要能看到经验池
    await expect(page.locator('[data-testid="exp-pool"]')).toBeVisible()

    const levelBefore = await levelOf(page)
    const poolBefore = await expPoolOf(page)

    // 喂 1000 经验这一档
    await page.locator('[data-feed="1000"]').click()

    // ⚠ 原实现只加不减：经验池纹丝不动，等于白嫖等级
    await expect.poll(() => expPoolOf(page), { timeout: 8_000 }).toBe(poolBefore - 1000)
    await expect.poll(() => levelOf(page), { timeout: 8_000 }).toBeGreaterThan(levelBefore)
  })

  test('经验池不足时喂经验按钮禁用并给出差额提示', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    const pool = await farmExp(page, 1_200)
    // 1.2 千的经验喂不起「1.0 万」那一档
    expect(pool).toBeLessThan(10_000)

    await openFirstHeroDetail(page)
    const btn = page.locator('[data-feed="10000"]')
    await expect(btn).toBeDisabled()
    await expect(page.getByText(/经验不足/).first()).toBeVisible()
  })

  test('喂完经验池后「全部喂入」不可用', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)
    await farmExp(page, 1_200)
    await openFirstHeroDetail(page)

    await page.locator('[data-testid="feed-all"]').click()
    await expect.poll(() => expPoolOf(page), { timeout: 8_000 }).toBe(0)
    await expect(page.locator('[data-testid="feed-all"]')).toBeDisabled()
  })
})
