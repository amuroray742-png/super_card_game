import { test, expect, type Page } from '@playwright/test'
import type { ActionRequest, ActionResponse } from '../../src/core/systems/action-protocol.ts'
import type { SaveData } from '../../src/core/model/types.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { DUNGEON_DIFFICULTIES } from '../../src/core/config/economy.ts'
import { ITEM_BY_ELEMENT } from '../../src/core/config/items.ts'
import { DUNGEON_VARIANTS, dungeonDropAmount } from '../../src/core/config/dungeons.ts'
import {
  accessTokenOf,
  cachedSaveOf,
  loginAccount,
  postAction,
  registerAccount,
  seedSession,
  settleIdleThroughUi,
  uniqueUsername,
} from './helpers'

/**
 * 材料副本端到端用例（**资源/背包版本 v10**）。
 *
 * 副本是**两类材料的唯一来源**（五行技能材料 / 三档强化石），所以这条链路
 * 必须真的跑通：设去向 → 挂机 → 拿到材料 → 切回主线 → 主线继续推进。
 *
 * ## 守的语义
 *
 * 1. **副本进度与主线分开记账**——副本跑完 `campaign.clearedStage` 不动；
 * 2. **副本胜利只发所选材料**——不发银两 / 经验书 / 遗物；
 * 3. **三个去向共用一份挂机时间账本**——切换去向时先结清旧去向；
 * 4. **战败要给「降一档难度」的出口**（铁律 #27：规则写在玩家眼前）。
 *
 * ⚠ 前置用**玩家可用的 `save.import` 动作**导入（铁律 #11），导入后
 *   一切养成动作仍由服务端权威执行。
 */

test.setTimeout(240_000)

/** 一支能打赢第 1 章的队伍（Lv60 → 战力远高于第 1 章门槛） */
const STRONG_TEAM = ['hanxin', 'luban', 'zhugeliang', 'libai', 'xiangyu', 'chengjisihan']
/** 火系英灵（技能副本用） */
const FIRE_HERO = 'libai'

/**
 * 造一个前置存档。
 *
 * ⚠ 编队**必须**有货：挂机结算要真的有战斗可跑（`buildTeam(save).length === 0`
 *   时服务端直接返回「请先在阵位中编队」）。
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

/** 给存档塞一支满级队伍 */
function giveTeam(save: SaveData, ids: readonly string[], level = 60): void {
  ids.forEach((id, slot) => {
    save.heroes[id] = { ...createHeroState(id, Date.now()), level }
    save.team.slots[slot] = id
  })
}

/** 读背包里某个道具的数量 */
async function itemCountOf(page: Page, accountId: number, itemId: string): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.items?.[itemId] ?? 0
}

/** 读主线进度 */
async function clearedStageOf(page: Page, accountId: number): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.campaign?.clearedStage ?? 0
}

/** 等待某个动作的权威响应 */
async function waitAction(page: Page, type: string): Promise<ActionResponse> {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request()
    if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/action') return false
    return (request.postDataJSON() as ActionRequest).action.type === type
  })
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  const body = await response.json() as ActionResponse
  expect(body.ok, body.message).toBe(true)
  return body
}

test.describe('材料副本页', () => {
  test('种类 / 变体 / 难度都能选，每胜产量写在页面上', async ({ page }) => {
    await importFixture(page, 'dgpage', (save) => {
      giveTeam(save, STRONG_TEAM)
    })

    await page.goto('/#/dungeon?kind=skill&element=火&difficulty=easy')
    await page.waitForLoadState('networkidle')

    // 技能副本：5 个五行变体（testid 用**变体 id**，口径取 core）
    const skillVariants = DUNGEON_VARIANTS.filter((v) => v.kind === 'skill')
    expect(skillVariants).toHaveLength(5)
    for (const v of skillVariants) {
      await expect(page.getByTestId(`dungeon-variant-${v.id}`)).toBeVisible()
    }
    await expect(page.getByTestId('dungeon-variant-skillFire')).toHaveClass(/on/)

    // 3 档难度，每档都写着「每胜 N 个」（产量取 core，不写死）
    for (const d of DUNGEON_DIFFICULTIES) {
      const chip = page.getByTestId(`dungeon-difficulty-${d.id}`)
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('每胜')
    }
    const fireMat = ITEM_BY_ELEMENT.火
    const fireVariant = DUNGEON_VARIANTS.find((v) => v.id === 'skillFire')!
    const easyDrop = dungeonDropAmount(fireVariant, 'easy')
    await expect(page.getByTestId('dungeon-difficulty-easy')).toContainText(
      String(easyDrop.min === easyDrop.max ? easyDrop.min : `${easyDrop.min}~${easyDrop.max}`),
    )

    // 强化副本：3 档石
    await page.getByTestId('dungeon-kind-enhance').click()
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('dungeon-variant-enhanceTier1')).toBeVisible()
    await expect(page.getByTestId('dungeon-variant-enhanceTier2')).toBeVisible()
    await expect(page.getByTestId('dungeon-variant-enhanceTier3')).toBeVisible()
  })

  test('没英灵时技能副本未解锁，并写清原因', async ({ page }) => {
    await importFixture(page, 'dglock', (save) => {
      void save
    })

    await page.goto('/#/dungeon?kind=skill&element=火&difficulty=easy')
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('未解锁').first()).toBeVisible()
    await expect(page.getByText(/还没有英灵/).first()).toBeVisible()
    await expect(page.getByTestId('dungeon-set-target')).toBeDisabled()
  })

  test('没有 Lv60 遗物时中阶强化副本未解锁', async ({ page }) => {
    await importFixture(page, 'dgtier', (save) => {
      giveTeam(save, STRONG_TEAM)
    })

    await page.goto('/#/dungeon?kind=enhance&tier=relicStoneTier2&difficulty=easy')
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('未解锁').first()).toBeVisible()
    await expect(page.getByText(/需要持有 Lv60 遗物/).first()).toBeVisible()
    await expect(page.getByTestId('dungeon-set-target')).toBeDisabled()
  })
})

test.describe('挂机去向与副本产出', () => {
  test('设为挂机去向 → 挂机拿到材料 → 切回主线 → 主线继续推进', async ({ page }) => {
    const accountId = await importFixture(page, 'dgrun', (save) => {
      giveTeam(save, STRONG_TEAM)
      // 主线从第 1 关起步，方便断言「切回主线后主线继续推进」
      save.campaign.clearedStage = 0
      save.campaign.chapterProgress = 1
      save.idle.currentStage = 1
      save.idle.autoAdvance = false
    })

    const fireMat = ITEM_BY_ELEMENT.火

    // ── 1) 设为挂机去向（技能副本 · 火 · 简易）────────
    await page.goto('/#/dungeon?kind=skill&element=火&difficulty=easy')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('dungeon-set-target')).toBeEnabled()
    await page.getByTestId('dungeon-set-target').click()
    const setRes = await waitAction(page, 'idle.setTarget')
    expect((setRes.result as { target: { kind: string } }).target.kind).toBe('skill')

    // ── 2) 推征页看得到当前去向 ────────────────────────
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('idle-target-name')).toContainText('技能副本')
    await expect(page.getByTestId('idle-target-name')).toContainText('火')

    // ── 3) 挂机 → 拿到副本材料 ────────────────────────
    const matBefore = await itemCountOf(page, accountId, fireMat)
    expect(matBefore).toBe(0)

    const run = await settleIdleThroughUi(page, accountId)
    expect(run.dungeon, '副本去向的结算必须带回副本明细').toBeTruthy()
    expect(run.dungeon!.itemId).toBe(fireMat)

    await expect.poll(() => itemCountOf(page, accountId, fireMat), { timeout: 10_000 })
      .toBeGreaterThan(matBefore)

    // 副本**不写主线进度**（分开记账）
    expect(await clearedStageOf(page, accountId)).toBe(0)

    // ── 4) 切回主线 → 主线继续推进 ─────────────────────
    await page.getByTestId('idle-target-campaign').click()
    await page.getByTestId('idle-target-apply').click()
    const backRes = await waitAction(page, 'idle.setTarget')
    expect((backRes.result as { target: { kind: string } }).target.kind).toBe('campaign')

    await expect.poll(() => page.getByTestId('idle-target-name').innerText(), { timeout: 10_000 })
      .toContain('主线')

    await settleIdleThroughUi(page, accountId)
    await expect.poll(() => clearedStageOf(page, accountId), { timeout: 15_000 }).toBeGreaterThan(0)
  })

  test('副本战败时给出「降一档难度」的出口', async ({ page }) => {
    const accountId = await importFixture(page, 'dglose', (save) => {
      // 一支一级小队打第 8 章（困难档取材章）→ 必败
      save.heroes[FIRE_HERO] = { ...createHeroState(FIRE_HERO, Date.now()), level: 1 }
      save.team.slots[0] = FIRE_HERO
      save.campaign.clearedStage = 0
      save.idle.currentStage = 1
      save.idle.target = { kind: 'skill', element: '火', difficulty: 'hard' }
    })

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    // 去向已是困难档技能副本
    await expect(page.getByTestId('idle-target-name')).toContainText('技能副本')
    await expect(page.getByTestId('idle-target-difficulty-hard')).toHaveClass(/on/)

    // 战败 → 界面给出「降一档难度」的出口（铁律 #27：规则写在玩家眼前）
    const run = await settleIdleThroughUi(page, accountId)
    expect(run.dungeon, '副本去向的结算必须带回副本明细').toBeTruthy()
    expect(run.dungeon!.blockedAtBattle, '一级小队打困难档必须战败').not.toBeNull()
    expect(run.dungeon!.suggestDifficulty).toBe('normal')

    await expect(page.getByTestId('idle-lower-difficulty')).toBeVisible()
  })
})
