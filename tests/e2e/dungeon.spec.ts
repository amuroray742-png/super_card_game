import { test, expect, type Page } from '@playwright/test'
import type { SaveData } from '../../src/core/model/types.ts'
import { DUNGEON_STAGES, dungeonStageId, dungeonStagesOf } from '../../src/core/config/dungeons.ts'
import { ITEM_BY_ELEMENT } from '../../src/core/config/items.ts'
import { DUNGEON_DIFFICULTY_ORDER } from '../../src/core/config/economy.ts'
import { getStage } from '../../src/core/config/stages.ts'
import { GAME_ERROR_CODES } from '../../src/core/config/game-errors.ts'
import {
  cachedSaveOf,
  giveTeam,
  importFixture,
  postAction,
  waitForAction,
} from './helpers'

/**
 * 材料副本端到端用例（**挂机改版 v11**）。
 *
 * 副本现在是 **42 个独立关卡**（`(变体 × 难度) = 1 关`）：
 * 材料副本 14 变体 × 3 难度 = 24 关（技能 15 + 强化 9），
 * 遗物副本 6 变体 × 3 难度 = 18 关。
 * 打通一次即通关，通关记录写 `save.dungeons.cleared`（与主线**分开记账**）。
 *
 * ## 守的语义
 *
 * 1. **42 关都在页面上**，按难度段分组（简易 / 普通 / 困难），
 *    且遗物副本 18 关独立成组（`dungeon-kind-relic` tab）；
 * 2. **通关记录**：`dungeon.challenge` 胜利 → `dungeons.cleared[id] === true`，
 *    回包 `firstClear === true`，**奖励只有材料**（不发银两 / 经验书 / 遗物）；
 * 3. **战败不发奖**：不写通关记录、不发任何东西；
 * 4. **未通关的关卡不能设为挂机通道**（界面禁用 + 服务端拒绝）；
 * 5. **已通关的关卡可以设为对应通道**（技能 / 强化），通道目标写对；
 * 6. **主线通道跟随最新通关关卡**（`stageId = null`）。
 *
 * ⚠ 前置用**玩家可用的 `save.import` 动作**导入（铁律 #11）。
 *   ⚠ 但导入**不能**用来伪造副本通关：服务端在导入后会**清空** `dungeons.cleared`
 *   （导入的进度不是可信的通关凭证）⇒ 「已通关才能挂机」这条**必须真的打赢一次**。
 */

test.setTimeout(240_000)

/** 一支能打赢简易副本的队伍（Lv60 → 战力远高于简易档门槛） */
const STRONG_TEAM = ['hanxin', 'luban', 'zhugeliang', 'libai', 'xiangyu', 'chengjisihan'] as const
/** 火系英灵（技能副本用） */
const FIRE_HERO = 'libai'
/** 技能副本 · 火 · 简易（副本关卡 id 的唯一出处是 core 的 `dungeonStageId`） */
const FIRE_EASY = dungeonStageId('skillFire', 'easy')
/** 强化副本 · 初阶 · 简易 */
const TIER1_EASY = dungeonStageId('enhanceTier1', 'easy')

/** 读背包里某个道具的数量 */
async function itemCountOf(page: Page, accountId: number, itemId: string): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.items?.[itemId] ?? 0
}

/** 读主线进度 */
async function clearedStageOf(page: Page, accountId: number): Promise<number> {
  return (await cachedSaveOf(page, accountId))?.campaign?.clearedStage ?? 0
}

/** 读副本通关记录 */
async function dungeonClearedOf(
  page: Page,
  accountId: number,
  stageId: string,
): Promise<boolean> {
  return (await cachedSaveOf(page, accountId))?.dungeons?.cleared?.[stageId] === true
}

/** 打开副本页（hash 路由深链，`kind` 是唯一的 tab 参数） */
async function openDungeon(page: Page, kind: 'skill' | 'enhance'): Promise<void> {
  await page.goto(`/#/dungeon?kind=${kind}`)
  await page.waitForLoadState('networkidle')
  // ⚠ 同文档导航不会重载：必须等页面**渲染出来**再断言
  await expect(page.getByTestId(`dungeon-kind-${kind}`)).toBeVisible()
}

test.describe('副本页（42 个独立关卡）', () => {
  test('技能 15 关 + 强化 9 关 + 遗物 18 关 = 42 关，按难度段分组', async ({ page }) => {
    await importFixture(page, 'dgpage', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })

    // 配置侧：42 关是**唯一出处**（core 的关卡表）
    expect(DUNGEON_STAGES).toHaveLength(42)
    expect(dungeonStagesOf('skill')).toHaveLength(15)
    expect(dungeonStagesOf('enhance')).toHaveLength(9)
    // ⚠ 遗物副本（存档 v12）：6 个副本 × 3 难度 = 18 关
    expect(dungeonStagesOf('relic')).toHaveLength(18)

    // ── 技能副本 tab：15 关，3 个难度段各 5 关 ─────────────
    await openDungeon(page, 'skill')
    await expect(page.locator('.dgn-row')).toHaveCount(15)

    const groups = page.locator('.page > .panel')
    // 3 个难度段 + 1 个「规则」面板
    await expect(groups).toHaveCount(4)
    const difficultyNames = ['简易', '普通', '困难']
    for (let i = 0; i < DUNGEON_DIFFICULTY_ORDER.length; i++) {
      const group = groups.nth(i)
      await expect(group).toContainText(difficultyNames[i])
      // 段内关卡数 = 变体数（技能副本 5 个变体）
      await expect(group.locator('.dgn-row')).toHaveCount(5)
    }

    // 关卡按难度段**逐段排列**（顺序口径取 core）
    const order = await page.locator('.dgn-row').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')),
    )
    const expected = DUNGEON_DIFFICULTY_ORDER.flatMap((difficulty) =>
      dungeonStagesOf('skill')
        .filter((s) => s.difficulty === difficulty)
        .map((s) => `dungeon-stage-${s.id}`),
    )
    expect(order).toEqual(expected)

    // ── 强化副本 tab：9 关，3 个难度段各 3 关 ───────────────
    await page.getByTestId('dungeon-kind-enhance').click()
    await expect(page.locator('.dgn-row')).toHaveCount(9)
    const enhanceGroups = page.locator('.page > .panel')
    for (let i = 0; i < 3; i++) {
      await expect(enhanceGroups.nth(i).locator('.dgn-row')).toHaveCount(3)
    }
  })

  test('每关都写着门槛、产量与通关状态', async ({ page }) => {
    await importFixture(page, 'dginfo', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })

    await openDungeon(page, 'skill')
    const row = page.getByTestId(`dungeon-stage-${FIRE_EASY}`)
    await expect(row).toBeVisible()
    await expect(row).toContainText('门槛')
    await expect(row).toContainText('每胜')
    // 产量口径取 core，不写死数字
    const stage = DUNGEON_STAGES.find((s) => s.id === FIRE_EASY)!
    // ⚠ `drop` 现在**可空**（遗物副本只产遗物实例 ⇒ 没有堆叠材料）
    expect(stage.drop, '技能副本必须有堆叠材料产出').not.toBeNull()
    const amount = stage.drop!.min === stage.drop!.max
      ? String(stage.drop!.min)
      : `${stage.drop!.min}~${stage.drop!.max}`
    await expect(row).toContainText(`每胜 ${amount}`)
    // 未通关
    await expect(row).toContainText('未通关')
  })
})

test.describe('副本挑战与通关记录', () => {
  test('挑战胜利：写入 dungeons.cleared，回包 firstClear，奖励只有材料', async ({ page }) => {
    const { accountId } = await importFixture(page, 'dgwin', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })

    await openDungeon(page, 'skill')
    const body = await waitForAction(page, 'dungeon.challenge', {
      trigger: async () => {
        await page.getByTestId(`dungeon-challenge-${FIRE_EASY}`).click()
      },
    })
    const result = body.result as unknown as {
      stageId: string
      win: boolean
      firstClear: boolean
      rewards: {
        silver?: number
        crystals?: number
        items?: Record<string, number>
        relics?: string[]
        shards?: Record<string, number>
      }
    }

    expect(result.stageId).toBe(FIRE_EASY)
    expect(result.win).toBe(true)
    expect(result.firstClear).toBe(true)
    // 奖励**只有材料**：不发银两 / 经验书 / 遗物 / 碎片 / 结晶
    expect(result.rewards.items?.[ITEM_BY_ELEMENT.火] ?? 0).toBeGreaterThan(0)
    expect(result.rewards.silver).toBeUndefined()
    expect(result.rewards.crystals).toBeUndefined()
    expect(result.rewards.relics).toBeUndefined()
    expect(result.rewards.shards).toBeUndefined()
    expect(Object.keys(result.rewards.items ?? {})).toEqual([ITEM_BY_ELEMENT.火])

    // 材料真的入库
    await expect.poll(() => itemCountOf(page, accountId, ITEM_BY_ELEMENT.火), { timeout: 10_000 })
      .toBeGreaterThan(0)

    // 通关记录写进 `dungeons.cleared`（**副本不写主线进度**）
    await expect.poll(() => dungeonClearedOf(page, accountId, FIRE_EASY), { timeout: 10_000 }).toBe(true)
    expect(await clearedStageOf(page, accountId)).toBe(0)

    // 页面上标成「已通关」
    await expect(page.getByTestId(`dungeon-stage-${FIRE_EASY}`)).toContainText('已通关')

    // ⚠ **副本挑战也要演出来**：服务端执行 → 响应的一次性 `replay` → 页面级回放面板。
    //   （曾经的缺口：客户端只取 `result`，`battle` 恒为 undefined ⇒ 副本页挑战后毫无反馈。）
    const panel = page.getByTestId('challenge-replay')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(panel.locator('canvas.battle-canvas')).toHaveAttribute('data-visible-units', /[1-9]/)
  })

  test('挑战失败：win=false、不发奖、不写通关记录', async ({ page }) => {
    const { accountId } = await importFixture(page, 'dglose', (save: SaveData) => {
      // 一级小队打简易档技能副本 → 必败
      giveTeam(save, [FIRE_HERO], 1)
    })

    await openDungeon(page, 'skill')
    const body = await waitForAction(page, 'dungeon.challenge', {
      trigger: async () => {
        await page.getByTestId(`dungeon-challenge-${FIRE_EASY}`).click()
      },
    })
    const result = body.result as unknown as {
      win: boolean
      firstClear: boolean
      rewards: Record<string, unknown>
    }

    expect(result.win).toBe(false)
    expect(result.firstClear).toBe(false)
    // 战败不发任何奖励
    expect(Object.keys(result.rewards)).toHaveLength(0)

    // 不写通关记录
    expect(await dungeonClearedOf(page, accountId, FIRE_EASY)).toBe(false)
    // 材料也没发
    expect(await itemCountOf(page, accountId, ITEM_BY_ELEMENT.火)).toBe(0)
    // 界面仍然标成「未通关」
    await expect(page.getByTestId(`dungeon-stage-${FIRE_EASY}`)).toContainText('未通关')
  })

  test('未通关的副本关卡不能设为挂机通道（界面禁用 + 服务端拒绝）', async ({ page }) => {
    const { token } = await importFixture(page, 'dglock', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })

    await openDungeon(page, 'skill')
    // 界面：未通关 → 按钮禁用
    await expect(page.getByTestId(`dungeon-set-channel-${FIRE_EASY}`)).toBeDisabled()

    // 服务端：同样拒绝（**存档一个字节都没变**）
    const rejected = await postAction(token, 'dg-lock-1', {
      type: 'idle.setChannel',
      channel: 'skill',
      dungeonStageId: FIRE_EASY,
    })
    expect(rejected.ok).toBe(false)
    expect(rejected.code).toBe(GAME_ERROR_CODES.NOT_FOUND)
    expect(String(rejected.message ?? '')).toContain('尚未通关')
  })
})

test.describe('挂机通道（多通道并行）', () => {
  test('已通关的副本关卡可以设为对应通道，通道目标写对', async ({ page }) => {
    const { accountId } = await importFixture(page, 'dgchan', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })

    // ── 1) 先真的打赢一次（导入给不了通关凭证）──────────────
    await openDungeon(page, 'skill')
    await waitForAction(page, 'dungeon.challenge', {
      trigger: async () => {
        await page.getByTestId(`dungeon-challenge-${FIRE_EASY}`).click()
      },
    })
    await expect.poll(() => dungeonClearedOf(page, accountId, FIRE_EASY), { timeout: 10_000 }).toBe(true)

    // ── 2) 设为技能通道 ────────────────────────────────────
    const setRes = await waitForAction(page, 'idle.setChannel', {
      trigger: async () => {
        await page.getByTestId(`dungeon-set-channel-${FIRE_EASY}`).click()
      },
    })
    const result = setRes.result as unknown as {
      channel: string
      target: { kind: string; dungeonStageId: string } | null
    }
    expect(result.channel).toBe('skill')
    expect(result.target).toEqual({ kind: 'skill', dungeonStageId: FIRE_EASY })

    // 权威存档里的通道目标写对了
    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.idle?.channels?.skill?.target, { timeout: 10_000 })
      .toEqual({ kind: 'skill', dungeonStageId: FIRE_EASY })

    // 推征页看得到这条通道的目标
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('idle-channel-skill')).toContainText('已开启')
    await expect(page.getByTestId('idle-channel-skill')).toContainText('火')
  })

  test('强化副本走自己的通道，两条通道互不干扰', async ({ page }) => {
    const { accountId, token } = await importFixture(page, 'dgenh', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      // ⚠ 遗物副本的解锁线是「主线通关关卡」⇒ 前置必须已通关主线
      save.campaign.clearedStage = 5
    })

    // 强化副本 · 初阶 · 简易：需要「持有任意遗物」才解锁
    // ⚠ 新档没有遗物 → 这里打**遗物副本**拿一件（遗物的唯一来源，存档 v12）
    const acquired = await postAction(token, 'dg-enh-acquire', {
      type: 'dungeon.challenge',
      stageId: dungeonStageId('relicZhanTan', 'easy'),
    })
    expect(acquired.ok, '遗物副本挑战应当成功').toBe(true)

    await openDungeon(page, 'enhance')
    await waitForAction(page, 'dungeon.challenge', {
      trigger: async () => {
        await page.getByTestId(`dungeon-challenge-${TIER1_EASY}`).click()
      },
    })
    await expect.poll(() => dungeonClearedOf(page, accountId, TIER1_EASY), { timeout: 10_000 }).toBe(true)

    const setRes = await waitForAction(page, 'idle.setChannel', {
      trigger: async () => {
        await page.getByTestId(`dungeon-set-channel-${TIER1_EASY}`).click()
      },
    })
    const result = setRes.result as unknown as { channel: string; target: { kind: string } | null }
    expect(result.channel).toBe('enhance')
    expect(result.target?.kind).toBe('enhance')

    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.idle?.channels?.enhance?.target, { timeout: 10_000 })
      .toEqual({ kind: 'enhance', dungeonStageId: TIER1_EASY })
  })

  test('主线通道跟随最新通关关卡（stageId = null）', async ({ page }) => {
    const { accountId } = await importFixture(page, 'dgmain', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      // 已通关到第 5 关 → 主线通道跟随它
      save.campaign.clearedStage = 5
    })

    // 导入后主线通道恢复「跟随」模式
    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.idle?.channels?.main?.target, { timeout: 10_000 })
      .toEqual({ kind: 'main', stageId: null })

    // 推征页的主线卡显示的是**最新通关关卡**的名字
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('idle-channel-main')).toContainText(getStage(5).name)

    // 手动挑战推进到第 6 关 → 跟随目标跟着走（目标本身仍是 null）
    await waitForAction(page, 'campaign.challenge', {
      trigger: async () => {
        await page.getByTestId('campaign-challenge').click()
      },
    })
    await expect.poll(() => clearedStageOf(page, accountId), { timeout: 10_000 }).toBe(6)
    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.idle?.channels?.main?.target, { timeout: 10_000 })
      .toEqual({ kind: 'main', stageId: null })
    await expect(page.getByTestId('idle-channel-main')).toContainText(getStage(6).name)
  })
})
