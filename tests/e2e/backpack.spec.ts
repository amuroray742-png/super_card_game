import { test, expect, type Page } from '@playwright/test'
import type { SaveData } from '../../src/core/model/types.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { EXP_BOOK } from '../../src/core/config/economy.ts'
import { ITEM_BY_ELEMENT, ITEM_DEFS, type ItemId } from '../../src/core/config/items.ts'
import { dungeonStageId } from '../../src/core/config/dungeons.ts'
import { formatNumber } from '../../src/presentation/utils/format'
import {
  accessTokenOf,
  cachedSaveOf,
  loginAccount,
  postAction,
  registerAccount,
  seedSession,
  uniqueUsername,
} from './helpers'

/**
 * 背包页端到端用例（**资源/背包版本 v10**）。
 *
 * 「铸造」页升级为「背包」后，这里守的是 5 个分类各自**看得见、用得上**：
 *
 * 1. 5 个分类能切换（且分类写在 URL 上，刷新 / 返回都保持得住）；
 * 2. 技能材料能按五行筛选；
 * 3. 材料 → 副本**直达**（材料不足时不必自己找入口，铁律 #27）；
 * 4. 碎片 → 升星入口（碎片页点一下就到英灵页）；
 * 5. 经验书能在背包里直接投喂（扣书、升等级）。
 *
 * ⚠ 前置用**玩家可用的 `save.import` 动作**导入（铁律 #11：改存档一律走服务端动作层），
 *   不直接改数据库；导入后所有养成动作仍由服务端权威执行。
 */

test.setTimeout(180_000)

/** 火系英灵（技能材料筛选用） */
const FIRE_HERO = 'tesla'
/** 土系英灵（碎片页用） */
const EARTH_HERO = 'xiangyu'

/**
 * 造一个前置存档。
 *
 * ⚠ 编队**故意留空**：服务端在每个动作前都会结清挂机账本，
 *   有编队时挂机收益会混进同一次动作的资源变化里 → 扣费口径没法精确断言。
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

/** 读背包里某个道具的数量 */
async function itemCountOf(page: Page, accountId: number, itemId: ItemId): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.items?.[itemId] ?? 0
}

/** 读某个英灵在存档里的等级 */
async function heroLevelOf(page: Page, accountId: number, heroId: string): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.heroes?.[heroId]?.level ?? 0
}

/**
 * 断言当前地址包含某段内容（**先解码**）。
 *
 * ⚠ hash 路由的 query 里可能有中文（「?element=火」），
 *   浏览器把 `page.url()` 里的非 ASCII 字符**百分号编码**与否不统一 →
 *   直接匹配字符串会时对时错。先 `decodeURIComponent` 再比对就稳定了。
 */
function urlText(page: Page): string {
  return decodeURIComponent(page.url())
}

test.describe('背包 · 5 分类', () => {
  test('5 个分类都能切换，分类写在 URL 上', async ({ page }) => {
    await importFixture(page, 'bp', (save) => {
      save.heroes[FIRE_HERO] = createHeroState(FIRE_HERO, Date.now())
    })

    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('backpack-tab-relics')).toBeVisible()

    // 遗物 → 技能材料
    await page.getByTestId('backpack-tab-skillMat').click()
    await expect.poll(() => urlText(page)).toContain('tab=skillMat')
    await expect(page.getByTestId(`backpack-item-${ITEM_BY_ELEMENT.金}`)).toBeVisible()

    // 技能材料 → 强化材料
    await page.getByTestId('backpack-tab-relicStone').click()
    await expect.poll(() => urlText(page)).toContain('tab=relicStone')
    await expect(page.getByTestId('backpack-item-relicStoneTier1')).toBeVisible()

    // 强化材料 → 经验书
    await page.getByTestId('backpack-tab-expBook').click()
    await expect.poll(() => urlText(page)).toContain('tab=expBook')
    await expect(page.getByTestId(`backpack-item-${EXP_BOOK.small.id}`)).toBeVisible()

    // 经验书 → 卡碎片
    await page.getByTestId('backpack-tab-shards').click()
    await expect.poll(() => urlText(page)).toContain('tab=shards')
    await expect(page.getByText('同名碎片', { exact: true })).toBeVisible()

    // 卡碎片 → 遗物（回到仓库组件）
    await page.getByTestId('backpack-tab-relics').click()
    await expect.poll(() => urlText(page)).toContain('tab=relics')
    await expect(page.getByTestId('relic-total')).toBeVisible()
  })

  test('技能材料能按五行筛选，筛选写在 URL 上', async ({ page }) => {
    await importFixture(page, 'bpfilter', (save) => {
      save.heroes[FIRE_HERO] = createHeroState(FIRE_HERO, Date.now())
    })

    await page.goto('/#/forge?tab=skillMat')
    await page.waitForLoadState('networkidle')

    const fire = page.getByTestId('backpack-element-火')
    await expect(fire).toBeVisible()
    await fire.click()

    await expect.poll(() => urlText(page)).toContain('element=火')
    // 选中的五行不再被置灰（置灰表示「不是当前筛选的行」）
    await expect(page.getByTestId(`backpack-item-${ITEM_BY_ELEMENT.火}`)).not.toHaveClass(/dim/)
    await expect(page.getByTestId(`backpack-item-${ITEM_BY_ELEMENT.金}`)).toHaveClass(/dim/)
  })

  test('材料能直达对应副本（材料不足也能找到入口）', async ({ page }) => {
    await importFixture(page, 'bpdun', (save) => {
      save.heroes[FIRE_HERO] = createHeroState(FIRE_HERO, Date.now())
    })

    await page.goto('/#/forge?tab=skillMat')
    await page.waitForLoadState('networkidle')

    const fireItem = ITEM_BY_ELEMENT.火
    await page.getByTestId(`backpack-go-dungeon-${fireItem}`).click()
    await expect.poll(() => urlText(page)).toContain('/#/dungeon?kind=skill&element=火')
    // ⚠ **挂机改版 v11**：副本页改成「独立关卡」（存档 v12 共 42 关），
    //   按难度段 × 变体平铺，
    //   变体不再是一个独立分组 ⇒ 断言落在**关卡行**上（关卡 id 唯一出处是 core）。
    await expect(page.getByTestId(`dungeon-stage-${dungeonStageId('skillFire', 'easy')}`)).toBeVisible()
    // 深链命中的变体要高亮出来（点「去副本」要真的看到对应关卡）
    await expect(page.locator('[data-variant="skillFire"].hl')).toHaveCount(3)
  })

  test('强化材料能直达强化副本', async ({ page }) => {
    await importFixture(page, 'bpdun2', (save) => {
      save.heroes[EARTH_HERO] = createHeroState(EARTH_HERO, Date.now())
    })

    await page.goto('/#/forge?tab=relicStone')
    await page.waitForLoadState('networkidle')

    await page.getByTestId('backpack-go-dungeon-relicStoneTier1').click()
    await expect.poll(() => urlText(page)).toContain('/#/dungeon?kind=enhance&tier=relicStoneTier1')
    await expect(page.getByTestId(`dungeon-stage-${dungeonStageId('enhanceTier1', 'easy')}`)).toBeVisible()
    await expect(page.locator('[data-variant="enhanceTier1"].hl')).toHaveCount(3)
  })

  test('碎片页点一下就到英灵页（升星入口）', async ({ page }) => {
    await importFixture(page, 'bpshard', (save) => {
      save.heroes[EARTH_HERO] = createHeroState(EARTH_HERO, Date.now())
      save.player.shards[EARTH_HERO] = 10
    })

    await page.goto('/#/forge?tab=shards')
    await page.waitForLoadState('networkidle')

    const row = page.getByTestId(`backpack-shard-${EARTH_HERO}`)
    await expect(row).toBeVisible()
    await row.click()
    await expect.poll(() => urlText(page)).toContain(`/#/hero/${EARTH_HERO}`)
  })
})

test.describe('背包 · 经验书投喂', () => {
  test('投喂扣书、升等级', async ({ page }) => {
    const accountId = await importFixture(page, 'bpfeed', (save) => {
      save.heroes[EARTH_HERO] = createHeroState(EARTH_HERO, Date.now())
      save.items[EXP_BOOK.small.id] = 5
    })

    await page.goto('/#/forge?tab=expBook')
    await page.waitForLoadState('networkidle')

    // 选书 + 选英灵
    await page.getByTestId(`backpack-pick-book-${EXP_BOOK.small.id}`).click()
    // ⚠ 背包页一屏化 v14：英灵不再平铺成 chip（旧版是**无上限**的 chip 列表，
    //   wrap 成好几行吃掉首屏）⇒ 改成「当前英灵 + 换」按钮 + 抽屉。
    await page.getByTestId('backpack-feed-pick-hero').click()
    await expect(page.getByTestId('backpack-hero-picker')).toBeVisible()
    await page.getByTestId(`backpack-pick-hero-${EARTH_HERO}`).click()

    const levelBefore = await heroLevelOf(page, accountId, EARTH_HERO)
    const booksBefore = await itemCountOf(page, accountId, EXP_BOOK.small.id)
    expect(booksBefore).toBe(5)

    // 本数填 2 → 预览必须写清楚投多少、升几级（铁律 #27：规则写在玩家眼前）
    await page.locator('input[type="number"]').fill('2')
    await expect(page.getByText(/预览：投入/).first()).toBeVisible()

    await page.getByTestId('backpack-feed').click()

    await expect.poll(() => itemCountOf(page, accountId, EXP_BOOK.small.id), { timeout: 10_000 }).toBe(3)
    await expect.poll(() => heroLevelOf(page, accountId, EARTH_HERO), { timeout: 10_000 })
      .toBeGreaterThan(levelBefore)
  })

  test('没有经验书时投喂按钮不可用', async ({ page }) => {
    await importFixture(page, 'bpnobook', (save) => {
      save.heroes[EARTH_HERO] = createHeroState(EARTH_HERO, Date.now())
      save.items[EXP_BOOK.small.id] = 0
      save.items[EXP_BOOK.large.id] = 0
    })

    await page.goto('/#/forge?tab=expBook')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('backpack-feed')).toBeDisabled()
  })
})

test.describe('背包 · 道具名称与说明来自登记表', () => {
  test('道具名称不是就地写的中文串', async ({ page }) => {
    await importFixture(page, 'bpname', (save) => {
      save.heroes[EARTH_HERO] = createHeroState(EARTH_HERO, Date.now())
      save.items[EXP_BOOK.small.id] = 3
    })

    await page.goto('/#/forge?tab=expBook')
    await page.waitForLoadState('networkidle')

    const row = page.getByTestId(`backpack-item-${EXP_BOOK.small.id}`)
    await expect(row).toContainText(ITEM_DEFS[EXP_BOOK.small.id].name)
    // 经验值取 core 配置，不写死（⚠ 展示层带千分位，断言用格式化后的值）
    await expect(row).toContainText(formatNumber(EXP_BOOK.small.exp))
  })
})
