import { test, expect, type Locator, type Page } from '@playwright/test'
import type { ActionRequest, ActionResponse } from '../../src/core/systems/action-protocol.ts'
import type { FeedBooksResult } from '../../src/core/systems/growth.ts'
import type { SaveData } from '../../src/core/model/types.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { createHeroState, expToNext, realmBreakCost } from '../../src/core/systems/growth.ts'
import { EXP_BOOK, SKILL } from '../../src/core/config/economy.ts'
import { ITEM_BY_ELEMENT, ITEM_DEFS, type ItemId } from '../../src/core/config/items.ts'
import { HERO_INDEX } from '../../src/core/config/heroes/index.ts'
import {
  accessTokenOf,
  cachedSaveOf,
  loginAccount,
  postAction,
  registerAccount,
  seedSession,
  settleIdleThroughUi,
  skipGachaReveal,
  uniqueUsername,
  type CachedSave,
} from './helpers'

/**
 * 英灵养成端到端用例（属性面板 + 技能升级 + 喂经验书）。
 *
 * ## 资源/背包版本 v10 的口径变更
 *
 * | 旧 | 新 |
 * |---|---|
 * | 玩家经验池（`player.exp`） | **经验书**（`save.items.expBookSmall/Large`） |
 * | 英灵印记（`player.emblems`） | **银两**（`player.silver`） |
 * | 术式结晶（`player.skillStones`） | **五行技能材料**（`save.items.skillMat*`） |
 *
 * 守的是三条真实反馈：
 * 1. 「卡牌升级看不到属性提升」——详情页原本**压根没有属性区**；
 * 2. 「技能升级提示资源不足，但我明明有 2.1 万术式结晶」——
 *    原实现扣的是**圣杯结晶**，不是术式结晶；
 * 3. 「喂经验不扣经验池」——原实现只加不减，经验池是死资源、喂经验等于白嫖等级。
 *
 * ⚠ 用例只走**玩家能做到的操作**（抽卡 → 编队 → 推征 → 圣殿 → 详情页 → 喂书 / 提升技能），
 *   需要前置材料时用**玩家可用的 `save.import` 动作**导入（铁律 #11：
 *   改存档一律走服务端动作层），不直接改数据库。
 */

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

/**
 * 造一个前置存档（**玩家可用的 `save.import` 动作**）。
 *
 * ⚠ 为什么要用导入而不是「从头打上来」：
 *   经验书是**离散单位**（主线普通关每场只掉 10% 一本），
 *   真要刷够突破用的书要跑上百场 → CI 根本不可接受。
 *   而这条用例真正要守的是**养成链路的语义**（扣什么 / 够不够 / 门��是否生效），
 *   不是「刷一本书要多久」——那一条由 core 单测守着。
 *
 * ⚠ 编队**故意留空**：服务端在每个动作前都会结清挂机账本（`prepare()` → `settleIdleLedger`），
 *   有编队时挂机收益会混进同一次动作的银两变化里 → 扣费口径就没法精确断言了。
 *   空编队 → 无战斗 → 无掉落 → 银两变化只来自养成动作本身。
 */
async function importFixture(
  page: Page,
  prefix: string,
  mutate: (save: SaveData) => void,
): Promise<number> {
  const session = await registerAccount(uniqueUsername(prefix))
  const token = await accessTokenOf(session)
  const save = createNewSave(Date.now())
  mutate(save)
  const imported = await postAction(token, `${prefix}-fixture`, {
    type: 'save.import',
    payload: exportSave(save),
  })
  expect(imported.ok, '前置存档导入失败').toBe(true)
  await seedSession(page, await loginAccount(session.user.username))
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
 * ⚠ 必须编队才能推征——经验书来自推征掉落。
 *   队里放的是列表首位（圣殿按稀有度降序，首位就是新手保底 SSR）。
 *   ⚠ **至少 3 人**：实测 2 人队（战力 1436）在第 1 关每轮只打 3 场就卡关，
 *     3 人队（战力 2081）才能跑满 10 场。人数不够 → 书攒不够 → 喂书按钮全禁用。
 */
async function setupTeam(page: Page, count = 4): Promise<void> {
  await page.goto('/#/formation')
  await page.waitForLoadState('networkidle')
  for (let i = 0; i < count; i++) {
    await placeHero(page, SLOT_TEXTS[i], i)
  }
}

/** 读取背包里某个道具的数量 */
async function itemCountOf(page: Page, accountId: number, itemId: ItemId): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.items?.[itemId] ?? 0
}

/** 读取玩家银两 */
async function silverOf(page: Page, accountId: number): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.player?.silver ?? 0
}

/** 读取某个英灵在存档里的等级 */
async function heroLevelOf(page: Page, accountId: number, heroId: string): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.heroes?.[heroId]?.level ?? 0
}

/** 从详情页 URL 里取英灵 id */
function heroIdFromUrl(page: Page): string {
  return page.url().split('/hero/')[1]?.split('?')[0]?.split('#')[0] ?? ''
}

/** 进英灵详情页 */
async function openHeroDetail(page: Page, heroId: string): Promise<void> {
  await page.goto(`/#/hero/${heroId}`)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('[data-stat="atk"]')).toBeVisible()
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
 * 推征刷经验书，直到背包里的小经验书达到 target。
 *
 * ⚠ 经验书是**主线掉落**进背包的，玩家必须先打过一场才有书可喂。
 *   推征遇到战败会中断（runIdle 遇败即停），所以这里允许「这一轮没涨」再重试。
 */
async function farmBooks(
  page: Page,
  accountId: number,
  target: number,
  timeout = 420_000,
): Promise<number> {
  await page.goto('/#/expedition')
  await page.waitForLoadState('networkidle')
  let owned = await itemCountOf(page, accountId, EXP_BOOK.small.id)
  const deadline = Date.now() + timeout
  while (owned < target && Date.now() < deadline) {
    await settleIdleThroughUi(page, accountId)
    owned = await itemCountOf(page, accountId, EXP_BOOK.small.id)
  }
  expect(owned, `真实挂机经验书未达到 ${target}（实际 ${owned}）`).toBeGreaterThanOrEqual(target)
  return owned
}

/** 读取本次喂书的权威响应，核对实际扣费与变更后的存档。 */
async function feedThroughUi(
  page: Page,
  button: Locator,
): Promise<{ save: CachedSave; result: FeedBooksResult }> {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request()
    if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/action') return false
    return (request.postDataJSON() as ActionRequest).action.type === 'hero.feedBooks'
  })
  await button.click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  const body = await response.json() as ActionResponse
  expect(body.ok, body.message).toBe(true)
  expect(body.save).toBeTruthy()
  expect(body.result).toBeTruthy()
  return {
    save: JSON.parse(body.save!.payload) as CachedSave,
    result: body.result as FeedBooksResult,
  }
}

/**
 * 读取本次「境界突破」的权威响应。
 *
 * ⚠ 银两断言要拿**动作回包**里的存档做基线，不能拿操作前的本地缓存——
 *   服务端在每个动作前都会结清挂机账本，有编队时银两会漂。
 */
async function breakRealmThroughUi(page: Page): Promise<{ save: CachedSave }> {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request()
    if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/action') return false
    return (request.postDataJSON() as ActionRequest).action.type === 'hero.breakRealm'
  })
  await page.getByTestId('break-realm').click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  const body = await response.json() as ActionResponse
  expect(body.ok, body.message).toBe(true)
  expect(body.save).toBeTruthy()
  return { save: JSON.parse(body.save!.payload) as CachedSave }
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

/**
 * 读取玩家资源（银两 / 圣杯结晶）。
 *
 * ⚠ 术式结晶与遗物强化石已退役——钱包只剩**银两 + 圣杯结晶**。
 */
async function walletOf(
  page: Page,
  accountId: number,
): Promise<{ silver: number; crystals: number }> {
  const save = await cachedSaveOf(page, accountId)
  return {
    silver: save?.player?.silver ?? 0,
    crystals: save?.player?.crystals ?? 0,
  }
}

/**
 * 前置存档的固定口径。
 *
 * ⚠ 主角是**唯一 SSR**：圣殿按稀有度降序排（`stores/game.ts` 的 `ownedHeroes`），
 *   所以「圣殿第一个英灵」必定是主角——定位不依赖排序细则。
 */
const PROTAGONIST = 'xiangyu'
/** 主角是土系 → 技能材料是「土系技能材料」（口径取 core，不就地写） */
const PROTAGONIST_MATERIAL = ITEM_BY_ELEMENT[HERO_INDEX.get(PROTAGONIST)!.element]
/** 凡阶门槛是 Lv60 → 主角停在门槛下一级 */
const REALM_GATE_LEVEL = 59

/**
 * 喂到门槛 + 突破后兑现所需的小经验书数量。
 *
 * 口径全部取 core（铁律 #4 单一数据源），不写死数字：
 * - `expToNext(59)`：从 Lv59 跨到门槛 Lv60 需要的经验；
 * - `expToNext(61)`：突破到 Lv61 后，门槛上存下的经验要**再兑现一级**才够；
 * 末尾 +2000 是余量，保证「兑现成等级」而不是刚好卡在边界上。
 */
const REALM_BOOKS = Math.ceil(
  (expToNext(REALM_GATE_LEVEL) + expToNext(REALM_GATE_LEVEL + 2) + 2_000) / EXP_BOOK.small.exp,
)

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

  test('喂经验书后等级与属性都提升（并能看到提升预览）', async ({ page }) => {
    await bootLoggedIn(page)
    await pullHeroes(page)
    await openFirstHeroDetail(page)

    const levelBefore = await levelOf(page)
    const atkBefore = await statOf(page, 'atk')
    const hpBefore = await statOf(page, 'hp')

    // 提升预览：喂书 / 升星各一行，带绿色的 +N
    // ⚠ 页面里有多个 `.preview-box`（提升预览 / 境界门槛 / 喂书面板）→ 取第一个。
    await expect(page.locator('.preview-box').first()).toBeVisible()
    await expect(page.locator('.preview-box').first().locator('.ok-text').first()).toContainText('攻 +')

    // 喂 1 本（新手自带 10 本小经验书）
    await page.locator('[data-testid="feed-count"]').fill('1')
    await page.getByTestId('feed-books').click()

    await expect.poll(() => levelOf(page), { timeout: 8_000 }).toBeGreaterThan(levelBefore)
    await expect.poll(() => statOf(page, 'atk'), { timeout: 8_000 }).toBeGreaterThan(atkBefore)
    await expect.poll(() => statOf(page, 'hp'), { timeout: 8_000 }).toBeGreaterThan(hpBefore)
  })

  test('技能升级消耗五行材料与银两，圣杯结晶不动', async ({ page }) => {
    const accountId = await importFixture(page, 'skill', (save) => {
      save.heroes[PROTAGONIST] = { ...createHeroState(PROTAGONIST, Date.now()), level: 1 }
      save.items[PROTAGONIST_MATERIAL] = SKILL.MATERIAL_PER_LEVEL * 3
    })
    await openHeroDetail(page, PROTAGONIST)

    const before = await skillLevelOf(page)
    const resBefore = await walletOf(page, accountId)
    const matBefore = await itemCountOf(page, accountId, PROTAGONIST_MATERIAL)
    expect(matBefore).toBeGreaterThanOrEqual(SKILL.MATERIAL_PER_LEVEL)

    const btn = page.locator('button', { hasText: '提升等级' }).first()
    await expect(btn).toBeEnabled()
    await btn.click()

    // 技能等级 +1
    await expect.poll(() => skillLevelOf(page), { timeout: 8_000 }).toBe(before + 1)

    const resAfter = await walletOf(page, accountId)
    const matAfter = await itemCountOf(page, accountId, PROTAGONIST_MATERIAL)
    // 五行材料按配置扣
    expect(matAfter).toBe(matBefore - SKILL.MATERIAL_PER_LEVEL)
    // 银两按配置扣
    expect(resAfter.silver).toBe(resBefore.silver - SKILL.SILVER_PER_LEVEL)
    // 圣杯结晶**一分没动**（原实现扣的是它）
    expect(resAfter.crystals).toBe(resBefore.crystals)
  })

  test('五行材料不足时按钮禁用并给出差额提示', async ({ page }) => {
    await importFixture(page, 'skill', (save) => {
      save.heroes[PROTAGONIST] = { ...createHeroState(PROTAGONIST, Date.now()), level: 1 }
      // 材料为 0 → 按钮必须禁用
      save.items[PROTAGONIST_MATERIAL] = 0
    })
    await openHeroDetail(page, PROTAGONIST)

    const btn = page.locator('button', { hasText: '提升等级' }).first()
    await expect(btn).toBeDisabled()
    await expect(page.getByText(new RegExp(`${ITEM_DEFS[PROTAGONIST_MATERIAL].name}不足`)).first()).toBeVisible()
  })
})

test.describe('喂经验书扣背包', () => {
  // ⚠ 这几条用例的**准备阶段**要真实挂机刷书（每场 6 秒），
  //   文件级的 180 秒预算在机器有负载时会被准备阶段吃光，
  //   失败点落在「点进英灵详情」而不是被测的「喂书扣背包」断言上。
  //   与下方「境界突破链路」同口径：慢用例单独放宽预算，**断言一条不改**。
  test.setTimeout(600_000)

  test('喂经验书会从背包扣书，等级提升，经验书是唯一来源', async ({ page }) => {
    const accountId = await bootLoggedIn(page)
    await pullHeroes(page)
    await setupTeam(page)

    const owned = await farmBooks(page, accountId, 1)
    expect(owned).toBeGreaterThan(0)

    await openFirstHeroDetail(page)
    // 详情页要能看到经验书面板
    await expect(page.locator(`[data-book="${EXP_BOOK.small.id}"]`)).toBeVisible()

    const levelBefore = await levelOf(page)
    const booksBefore = await itemCountOf(page, accountId, EXP_BOOK.small.id)

    // 喂 1 本
    const fed = await feedThroughUi(page, page.getByTestId('feed-books'))

    // 精确守住扣费：本次权威响应必须扣 1 本，不被后续在线入账污染。
    expect(fed.result.booksUsed).toBe(1)
    expect(fed.result.applied).toBe(EXP_BOOK.small.exp)
    expect(fed.save.items?.[EXP_BOOK.small.id]).toBe(booksBefore - 1)
    await expect.poll(() => levelOf(page), { timeout: 8_000 }).toBeGreaterThan(levelBefore)
  })

  test('经验书不足时喂书按钮禁用并给出差额提示', async ({ page }) => {
    await importFixture(page, 'nobook', (save) => {
      save.heroes[PROTAGONIST] = { ...createHeroState(PROTAGONIST, Date.now()), level: 1 }
      save.items[EXP_BOOK.small.id] = 0
      save.items[EXP_BOOK.large.id] = 0
    })
    await openHeroDetail(page, PROTAGONIST)

    const btn = page.getByTestId('feed-books')
    await expect(btn).toBeDisabled()
    await expect(page.getByText(/不足/).first()).toBeVisible()
  })

  test('喂完库存后「使用」按钮不可用', async ({ page }) => {
    const accountId = await importFixture(page, 'onebook', (save) => {
      save.heroes[PROTAGONIST] = { ...createHeroState(PROTAGONIST, Date.now()), level: 1 }
      save.items[EXP_BOOK.small.id] = 1
    })
    await openHeroDetail(page, PROTAGONIST)

    const booksBefore = await itemCountOf(page, accountId, EXP_BOOK.small.id)
    expect(booksBefore).toBe(1)

    const fed = await feedThroughUi(page, page.getByTestId('feed-books'))
    expect(fed.result.booksUsed).toBe(1)
    expect(fed.save.items?.[EXP_BOOK.small.id]).toBe(0)

    // 书用完了 → 按钮禁用（不能再喂）
    await expect(page.getByTestId('feed-books')).toBeDisabled()
  })
})

/**
 * 境界突破的**完整链路**（§5.4）。
 *
 * 覆盖：喂经验书 → 撞到境界门槛（Lv60）→ 消耗银两 → 跨入新境界（Lv61）
 * → 门槛上存着的经验立即兑现成等级。
 *
 * ⚠ 这条链路曾经整条断裂：`REALMS[].breakMaterial` 指向的道具 id 全项目无定义、
 *   无掉落、无 UI，于是 `applyExp` 的硬上限把英灵卡死在 Lv60——
 *   实测喂多少经验都不再升级（`blockedByRealm` 恒为 true）。
 *   只测「喂经验会扣池子」守不住这个坑：卡在门槛上的英灵照样能扣池子，
 *   但永远升不了级。必须有一条**真的走到 Lv60 并突破**的用例。
 *
 * ⚠ 突破消耗品本轮从「英灵印记」改成**银两**（印记随钱包收敛退役），
 *   所以断言必须**读配置**（`realmBreakCost`），不能写死数字。
 */
test.describe('境界突破链路（喂书至 Lv60 → 消耗银两突破到 Lv61）', () => {
  // ⚠ 前置是导入的，但「喂书 → 突破」全程真实：真实服务端动作 + 真实扣费
  test.setTimeout(600_000)

  test('喂到境界门槛后，消耗银两突破到新境界，存量经验立即兑现', async ({ page }) => {
    // ── 0) 造前置存档 ────────────────────────────────
    const accountId = await importFixture(page, 'realm', (save) => {
      // 主角停在凡阶门槛下一级
      save.heroes[PROTAGONIST] = { ...createHeroState(PROTAGONIST, Date.now()), level: REALM_GATE_LEVEL }
      // 备好喂到门槛 + 兑现一级所需的小经验书
      save.items[EXP_BOOK.small.id] = REALM_BOOKS
    })
    await openHeroDetail(page, PROTAGONIST)
    const heroId = heroIdFromUrl(page)
    expect(heroId).toBe(PROTAGONIST)

    // ── 1) 全部喂入 → 撞到境界门槛 Lv60 ──────────────
    await page.locator('[data-testid="feed-count"]').fill(String(REALM_BOOKS))
    const fed = await feedThroughUi(page, page.getByTestId('feed-books'))

    expect(fed.result.booksUsed).toBe(REALM_BOOKS)
    expect(fed.save.items?.[EXP_BOOK.small.id]).toBe(0)
    expect(fed.save.heroes?.[heroId]?.level).toBe(60)
    await expect.poll(() => heroLevelOf(page, accountId, heroId), { timeout: 15_000 }).toBe(60)
    // 没升掉的经验存在英灵身上（卡在门槛上也不丢）
    const banked = fed.save.heroes?.[heroId]?.exp ?? 0
    expect(banked).toBeGreaterThan(0)

    // ── 2) 境界门槛出现突破入口 ─────────────────────
    await expect(page.getByText(/已达名阶门槛/).first()).toBeVisible()
    const breakBtn = page.getByTestId('break-realm')
    await expect(breakBtn).toBeVisible()
    await expect(breakBtn).toBeEnabled()

    // 突破费用**读配置**（名阶 20,000 银两），不写死
    const cost = realmBreakCost(60)
    expect(cost).toBeTruthy()

    // ── 3) 突破：扣银两 + 跨入 Lv61 + 存量经验兑现 ────
    const broke = await breakRealmThroughUi(page)

    await expect.poll(() => heroLevelOf(page, accountId, heroId), { timeout: 15_000 }).toBeGreaterThan(60)
    // 银两按配置扣（用动作回包做基线，避免挂机入账污染）
    expect(broke.save.player?.silver).toBe((fed.save.player?.silver ?? 0) - cost!.silver)
    // 存量经验被兑现 → 等级不止 61
    expect(await heroLevelOf(page, accountId, heroId)).toBeGreaterThan(61)
    // 境界显示切到名阶
    await expect(page.locator('.stat-row').filter({ hasText: '境界' }).first()).toContainText('名阶')
  })
})
