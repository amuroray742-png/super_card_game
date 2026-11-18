import { test, expect, type Locator, type Page } from '@playwright/test'
import type { ActionRequest, ActionResponse } from '../../src/core/systems/action-protocol.ts'
import type { FeedExpResult } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { createHeroState, expToNext } from '../../src/core/systems/growth.ts'
import {
  accessTokenOf,
  cachedSaveOf,
  loginAccount,
  pauseFarming,
  postAction,
  registerAccount,
  seedSession,
  settleIdleThroughUi,
  skipGachaReveal,
  uniqueUsername,
  type CachedSave,
} from './helpers'

// 真实等待挂机预算；普通用例也不能再依赖连点瞬间领取十场。
test.setTimeout(180_000)

test.beforeEach(async ({ page }) => {
  // 普通动作也会结算已累积的挂机收益，继续操作前先收下弹窗里的结算。
  const offlineReport = page.locator('.dialog').filter({ hasText: '离线推征结算' })
  await page.addLocatorHandler(offlineReport, async (report) => {
    await report.getByRole('button', { name: '收下', exact: true }).click()
  })
})

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

/**
 * 注册账号并注入会话，落到抽卡页（深链不会被新手引导劫持）。
 *
 * 返回账号 id：本地缓存**按账号分槽位**（AGENTS.md 铁律 #15），
 * 读缓存必须按账号取槽位，不能取「第一个 `sgw.save.*` 键」
 * （浏览器里还可能有存量单槽位 `sgw.save.main`，键序不保证）。
 */
async function bootLoggedIn(page: Page): Promise<number> {
  const session = await registerAccount(uniqueUsername('growth'))
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
 * 编好队：默认前排 2 人、后排 2 人。
 *
 * ⚠ 必须编队才能推征——经验池的经验来自推征掉落。
 *   队里放的是列表首位（圣殿按稀有度降序，首位就是新手保底 SSR）。
 *   ⚠ **至少 3 人**：实测 2 人队（战力 1436）在第 1 关每轮只打 3 场就卡关，
 *     3 人队（战力 2081）才能跑满 10 场。人数不够 → 经验攒不够 → 喂经验按钮全禁用。
 */
async function setupTeam(page: Page, count = 4): Promise<void> {
  await page.goto('/#/formation')
  await page.waitForLoadState('networkidle')
  for (let i = 0; i < count; i++) {
    await placeHero(page, SLOT_TEXTS[i], i)
  }
}

/** 读取玩家经验池 */
async function expPoolOf(page: Page, accountId: number): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.player?.exp ?? 0
}

/** 读取玩家英灵印记 */
async function emblemsOf(page: Page, accountId: number): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.player?.emblems ?? 0
}

/** 读取某个英灵在存档里的等级 */
async function heroLevelOf(page: Page, accountId: number, heroId: string): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.heroes?.[heroId]?.level ?? 0
}

/** 从详情页 URL 里取英灵 id */
function heroIdFromUrl(page: Page): string {
  return page.url().split('/hero/')[1]?.split('?')[0]?.split('#')[0] ?? ''
}

/**
 * 推征刷经验，直到经验池达到 target。
 *
 * ⚠ 经验是**推征掉落**进池子的，玩家必须先打过一场才有经验可喂。
 *   推征遇到战败会中断（runIdle 遇败即停），所以这里允许「这一轮没涨」再重试。
 */
async function farmExp(page: Page, accountId: number, target: number, timeout = 420_000): Promise<number> {
  await page.goto('/#/expedition')
  await page.waitForLoadState('networkidle')
  let pool = await expPoolOf(page, accountId)
  const deadline = Date.now() + timeout
  while (pool < target && Date.now() < deadline) {
    await settleIdleThroughUi(page, accountId)
    pool = await expPoolOf(page, accountId)
  }
  expect(pool, `真实挂机经验池未达到 ${target}（实际 ${pool}）`).toBeGreaterThanOrEqual(target)
  return pool
}

/** 读取本次喂经验的权威响应，核对实际扣费与变更后的存档。 */
async function feedThroughUi(page: Page, button: Locator): Promise<{ save: CachedSave; applied: number }> {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request()
    if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/action') return false
    return (request.postDataJSON() as ActionRequest).action.type === 'hero.feedExp'
  })
  await button.click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  const body = await response.json() as ActionResponse
  expect(body.ok, body.message).toBe(true)
  expect(body.save).toBeTruthy()
  expect(body.result).toBeTruthy()
  const result = body.result as FeedExpResult
  return { save: JSON.parse(body.save!.payload) as CachedSave, applied: result.applied }
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
async function resourcesOf(
  page: Page,
  accountId: number,
): Promise<{ skillStones: number; crystals: number }> {
  const save = await cachedSaveOf(page, accountId)
  return {
    skillStones: save?.player?.skillStones ?? 0,
    crystals: save?.player?.crystals ?? 0,
  }
}

test.describe('英灵养成（属性面板 + 技能升级）', () => {
  test('详情页展示攻击/防御/生命/速度与战力', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
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
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)
    await farmExp(page, accountId, 1_200)
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
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await openFirstHeroDetail(page)

    const before = await skillLevelOf(page)
    const resBefore = await resourcesOf(page, accountId)

    const btn = page.locator('button', { hasText: '提升等级' }).first()
    await expect(btn).toBeEnabled()
    await btn.click()

    // 技能等级 +1
    await expect.poll(() => skillLevelOf(page), { timeout: 8_000 }).toBe(before + 1)

    const resAfter = await resourcesOf(page, accountId)
    // 术式结晶被扣
    expect(resAfter.skillStones).toBeLessThan(resBefore.skillStones)
    // 圣杯结晶**一分没动**（原实现扣的是它）
    expect(resAfter.crystals).toBe(resBefore.crystals)
  })

  test('术式结晶不足时按钮禁用并给出差额提示', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await openFirstHeroDetail(page)

    const btn = page.locator('button', { hasText: '提升等级' }).first()
    const before = await skillLevelOf(page)
    // 初始术式结晶有限（每次 12），连续提升到不够为止
    for (let i = 0; i < 5; i++) {
      if (await btn.isDisabled()) break
      await btn.click()
      await expect.poll(() => skillLevelOf(page), { timeout: 8_000 }).toBe(before + i + 1)
    }

    await expect(btn).toBeDisabled()
    await expect(page.getByText(/术式结晶不足/).first()).toBeVisible()
  })
})

test.describe('喂经验扣玩家经验池', () => {
  // ⚠ 这三条用例的**准备阶段**要真实挂机刷经验（每场 6 秒，攒到 1.2 千要十几轮），
  //   文件级的 180 秒预算在机器有负载时会被准备阶段吃光，
  //   失败点落在「点进英灵详情」而不是被测的「喂经验扣池子」断言上。
  //   与下方「境界突破链路」同口径：慢用例单独放宽预算，**断言一条不改**。
  test.setTimeout(600_000)

  test('喂经验会从经验池扣款，经验池是唯一来源', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    const pool = await farmExp(page, accountId, 1_200)
    expect(pool).toBeGreaterThan(0)

    await pauseFarming(page)
    await openFirstHeroDetail(page)
    // 详情页要能看到经验池
    await expect(page.locator('[data-testid="exp-pool"]')).toBeVisible()

    const levelBefore = await levelOf(page)
    const poolBefore = await expPoolOf(page, accountId)

    // 喂 1000 经验这一档
    const fed = await feedThroughUi(page, page.locator('[data-feed="1000"]'))

    // 精确守住扣费：本次权威响应必须扣1000，不被后续在线入账污染。
    expect(fed.applied).toBe(1000)
    expect(fed.save.player?.exp).toBe(poolBefore - 1000)
    await expect.poll(() => levelOf(page), { timeout: 8_000 }).toBeGreaterThan(levelBefore)
  })

  test('经验池不足时喂经验按钮禁用并给出差额提示', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    const pool = await farmExp(page, accountId, 1_200)
    // 1.2 千的经验喂不起「1.0 万」那一档
    expect(pool).toBeLessThan(10_000)

    await pauseFarming(page)
    await openFirstHeroDetail(page)
    const btn = page.locator('[data-feed="10000"]')
    await expect(btn).toBeDisabled()
    await expect(page.getByText(/经验不足/).first()).toBeVisible()
  })

  test('喂完经验池后「全部喂入」不可用', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)
    await farmExp(page, accountId, 1_200)
    await pauseFarming(page)
    await openFirstHeroDetail(page)

    const poolBefore = await expPoolOf(page, accountId)
    const fed = await feedThroughUi(page, page.locator('[data-testid="feed-all"]'))
    expect(fed.applied).toBe(poolBefore)
    expect(fed.save.player?.exp).toBe(0)
    await expect(page.locator('[data-testid="feed-all"]')).toBeDisabled()
  })
})

/**
 * 境界突破的**完整链路**（§5.4）。
 *
 * 覆盖：喂经验 → 撞到境界门槛（Lv60）→ 消耗英灵印记 → 跨入新境界（Lv61）
 * → 门槛上存着的经验立即兑现成等级。
 *
 * ⚠ 这条链路曾经整条断裂：`REALMS[].breakMaterial` 指向的道具 id 全项目无定义、
 *   无掉落、无 UI，于是 `applyExp` 的硬上限把英灵卡死在 Lv60——
 *   实测喂多少经验都不再升级（`blockedByRealm` 恒为 true）。
 *   只测「喂经验会扣池子」守不住这个坑：卡在门槛上的英灵照样能扣池子，
 *   但永远升不了级。必须有一条**真的走到 Lv60 并突破**的用例。
 */

/**
 * 前置存档的固定口径。
 *
 * ⚠ 主角是**唯一 SSR**：圣殿按稀有度降序排（`stores/game.ts` 的 `ownedHeroes`），
 *   所以「圣殿第一个英灵」必定是主角——定位不依赖排序细则。
 */
const REALM_PROTAGONIST = 'xiangyu'
const REALM_TEAM = [
  REALM_PROTAGONIST,
  'nangdengel',
  'tesla',
  'turing',
  'luban',
  'chengjisihan',
]
/** 凡阶门槛是 Lv60 → 主角停在门槛下一级 */
const REALM_GATE_LEVEL = 59
/** Lv59 这支队能稳定打赢的关卡（战力余量 ~123%），掉落表是第 3 章 */
const REALM_FARM_STAGE = 66
/** 名阶突破要 10 枚印记（读 core 配置，见下方断言） */
const REALM_EMBLEMS = 20

/**
 * 喂到门槛 + 突破后兑现所需的经验池下限。
 *
 * 口径全部取 core（铁律 #4 单一数据源），不写死数字：
 * - `expToNext(59)`：从 Lv59 跨到门槛 Lv60 需要的经验；
 * - `expToNext(61)`：突破到 Lv61 后，门槛上存下的经验要**再兑现一级**才够。
 * 末尾 +1000 是余量，保证「兑现成等级」而不是刚好卡在边界上。
 */
const REALM_TARGET_POOL = expToNext(REALM_GATE_LEVEL) + expToNext(REALM_GATE_LEVEL + 2) + 1_000

test.describe('境界突破链路（喂经验至 Lv60 → 消耗印记突破到 Lv61）', () => {
  // ⚠ 前置是导入的，但「攒经验 → 喂 → 突破」全程真实：约 30 场挂机 + 几次动作
  test.setTimeout(900_000)

  test('喂到境界门槛后，消耗英灵印记突破到新境界，存量经验立即兑现', async ({ page }) => {
    // ── 0) 造前置存档 ────────────────────────────────
    //
    // ⚠ 为什么用 `save.import` 造前置，而不是让英灵从 Lv1 一路打到 Lv60：
    //   EXP_BASE 重标定后（60 → 900），单人 Lv1→Lv60 需要 118,500 经验，
    //   真实挂机产出速率约 50 exp/s → 一条用例要跑 ~40 分钟，CI 根本不可接受。
    //   而这条用例真正要守的是**境界门槛的语义**（卡门槛 → 突破 → 存量经验兑现），
    //   不是「Lv1→Lv60 要爬多久」——那一条由 core 单测
    //   （tests/unit/growth.test.ts 的「喂经验 + 突破可以一路到 Lv240」）守着。
    //
    //   `save.import` 是**玩家可用的动作**（铁律 #11：改存档一律走服务端动作层），
    //   与 authority.spec.ts 的刷取用例同一模式；导入后一切动作仍由服务端权威执行。
    const session = await registerAccount(uniqueUsername('realm'))
    const token = await accessTokenOf(session)
    const now = Date.now()
    const save = createNewSave(now)
    for (const [slot, id] of REALM_TEAM.entries()) {
      save.heroes[id] = { ...createHeroState(id, now), level: REALM_GATE_LEVEL }
      save.team.slots[slot] = id
    }
    save.campaign.clearedStage = REALM_FARM_STAGE - 1
    save.campaign.chapterProgress = 3
    save.idle.currentStage = REALM_FARM_STAGE
    // 不自动推进：钉在余量足够的关卡上，产出稳定（推进到战力临界点会随机卡关）
    save.idle.autoAdvance = false
    save.player.emblems = REALM_EMBLEMS

    const imported = await postAction(token, 'realm-fixture', {
      type: 'save.import',
      payload: exportSave(save),
    })
    expect(imported.ok, '前置存档导入失败').toBe(true)

    await seedSession(page, await loginAccount(session.user.username))
    const accountId = session.user.id

    // ── 1) 定位主角（唯一 SSR → 圣殿第一位）──────────
    await page.goto('/#/temple')
    await page.waitForLoadState('networkidle')
    await page.locator('.hero-cell').first().click()
    await expect(page).toHaveURL(/#\/hero\//)
    const heroId = heroIdFromUrl(page)
    expect(heroId).toBe(REALM_PROTAGONIST)

    // ── 2) 挂机攒经验池 ──────────────────────────────
    const pool = await farmExp(page, accountId, REALM_TARGET_POOL, 600_000)
    expect(pool, `真实挂机经验池未达到 ${REALM_TARGET_POOL}（实际 ${pool}）`)
      .toBeGreaterThanOrEqual(REALM_TARGET_POOL)

    // ── 3) 全部喂给主角 → 撞到境界门槛 Lv60 ─────────
    // 收集过程全是真实挂机；收够后通过玩家编队操作暂停，隔离扣款/突破断言。
    await pauseFarming(page)
    await page.goto(`/#/hero/${heroId}`)
    await page.waitForLoadState('networkidle')
    const poolBeforeFeed = await expPoolOf(page, accountId)
    const fed = await feedThroughUi(page, page.locator('[data-testid="feed-all"]'))

    expect(fed.applied).toBe(poolBeforeFeed)
    expect(fed.save.heroes?.[heroId]?.level).toBe(60)
    expect(fed.save.player?.exp).toBe(0)
    await expect.poll(() => heroLevelOf(page, accountId, heroId), { timeout: 15_000 }).toBe(60)
    // 没升掉的经验存在英灵身上（卡在门槛上也不丢）
    const banked = fed.save.heroes?.[heroId]?.exp ?? 0
    expect(banked).toBeGreaterThan(0)

    // ── 4) 境界门槛出现突破入口 ─────────────────────
    await expect(page.getByText(/已达名阶门槛/).first()).toBeVisible()
    const breakBtn = page.locator('[data-testid="break-realm"]')
    await expect(breakBtn).toBeVisible()
    await expect(breakBtn).toBeEnabled()

    const emblemsBefore = await emblemsOf(page, accountId)
    expect(emblemsBefore).toBeGreaterThanOrEqual(10)

    // ── 5) 突破：扣印记 + 跨入 Lv61 + 存量经验兑现 ────
    await breakBtn.click()

    await expect.poll(() => heroLevelOf(page, accountId, heroId), { timeout: 15_000 }).toBeGreaterThan(60)
    // 印记按配置扣（名阶 10 枚）
    await expect.poll(() => emblemsOf(page, accountId), { timeout: 8_000 }).toBe(emblemsBefore - 10)
    // 存量经验被兑现 → 等级不止 61
    expect(await heroLevelOf(page, accountId, heroId)).toBeGreaterThan(61)
    // 境界显示切到名阶
    await expect(page.locator('.stat-row').filter({ hasText: '境界' }).first()).toContainText('名阶')
  })
})
