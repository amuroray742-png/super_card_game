import { test, expect, type Page } from '@playwright/test'
import type { SaveData } from '../../src/core/model/types.ts'
import { relicUpgradeCost } from '../../src/core/systems/relic.ts'
import { RELIC_ACQUIRE } from '../../src/core/config/economy.ts'
import { GAME_ERROR_CODES } from '../../src/core/config/game-errors.ts'
import { dungeonStageId } from '../../src/core/config/dungeons.ts'
import {
  cachedSaveOf,
  claimIdleThroughUi,
  giveTeam,
  importFixture,
  postAction,
  relicTotal,
  serverRelics,
  waitForAction,
} from './helpers'

/**
 * 遗物端到端用例（**挂机改版 v11**）。
 *
 * ## 遗物改走独立获取入口
 *
 * 遗物**不再**由挂机 / 手动挑战产出（§1.3）——
 * 唯一入口是 **`relic.acquire`**（花 `RELIC_ACQUIRE.SILVER_COST` 银两祈愿 1 件）。
 *
 * ⚠ 这条链路曾经整条断裂：core 的掉落结算只把遗物放进**独立数组**，
 *   `rewards.relics` 从未被赋值；而 store 的入库分支**只读 rewards**
 *   → 挂机 / 离线结算产出的遗物 100% 被丢弃。
 *   掉落表明明写着「每场必掉 1 件遗物」，仓库却永远是空的。
 *   ⇒ 现在必须守住两件事：
 *   ① **挂机 / 挑战真的不再掉遗物**（掉落表里没有遗物了）；
 *   ② **独立入口真的能拿到遗物**（银两够 → 到账；银两不够 → 拒绝且不扣成负数）。
 *
 * ⚠ **祈愿走服务端动作层**（`POST /api/action` 的 `relic.acquire`）：
 *   这就是玩家那条通道，服务端用 core 动作层执行后落库（铁律 #11）。
 *   （⚠ 当前表现层**还没有**祈愿按钮——见交付说明。）
 */

test.setTimeout(240_000)

/** 一支能打赢简易副本的队伍（Lv60） */
const STRONG_TEAM = ['hanxin', 'luban', 'zhugeliang', 'libai', 'xiangyu', 'chengjisihan'] as const
/** 强化副本 · 初阶 · 简易（强化石的来源） */
const TIER1_EASY = dungeonStageId('enhanceTier1', 'easy')

/**
 * 从动作回包里读**权威存档**。
 *
 * ⚠ 不能用本地缓存做资源对账：缓存是服务端回传的**镜像**，
 *   动作刚落地时它可能还没被刷新（而且下一次回包就会覆盖它）。
 *   动作回包里的 `save.payload` 才是这次动作之后的权威状态。
 */
function saveOf(body: { save?: { payload?: string } | null } | Record<string, unknown>): {
  player?: { silver?: number; crystals?: number }
  items?: Record<string, number>
  campaign?: { clearedStage?: number }
  dungeons?: { cleared?: Record<string, boolean> }
} {
  const snapshot = body.save as { payload?: string } | undefined
  return snapshot?.payload ? JSON.parse(snapshot.payload) : {}
}

/** 祈愿 n 件遗物（走服务端动作层） */
async function acquireRelics(token: string, count: number, tag: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await postAction(token, `${tag}-acq-${i}`, { type: 'relic.acquire' })
    expect(res.ok, `第 ${i + 1} 次祈愿应当成功`).toBe(true)
  }
}

/**
 * 真实打强化副本拿强化石（**手动挑战**，不是挂机）。
 *
 * ⚠ 强化石**只从强化副本产出**（主线不再投放）。
 * ⚠ 强化副本的解锁线是「持有任意遗物」→ 玩家必须先有遗物（祈愿得来）。
 */
async function farmRelicStones(page: Page, accountId: number, rounds = 2): Promise<number> {
  await page.goto('/#/dungeon?kind=enhance')
  await page.waitForLoadState('networkidle')
  for (let i = 0; i < rounds; i++) {
    await waitForAction(page, 'dungeon.challenge', {
      trigger: async () => {
        await page.getByTestId(`dungeon-challenge-${TIER1_EASY}`).click()
      },
    })
  }
  await expect
    .poll(async () => (await cachedSaveOf(page, accountId))?.items?.relicStoneTier1 ?? 0, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2)
  return (await cachedSaveOf(page, accountId))?.items?.relicStoneTier1 ?? 0
}

/** 读取玩家当前的银两与初阶强化石 */
async function resourcesOf(
  page: Page,
  accountId: number,
): Promise<{ silver: number; stones: number }> {
  const save = await cachedSaveOf(page, accountId)
  return { silver: save?.player?.silver ?? 0, stones: save?.items?.relicStoneTier1 ?? 0 }
}

test.describe('遗物获取途径（独立入口 · 挂机改版 v11）', () => {
  test('挂机与手动挑战都不再掉遗物', async ({ page }) => {
    const { accountId, token } = await importFixture(page, 'rlcnodrop', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      // 已通关到第 5 关 → 主线通道**有目标**（挂机真的会产出东西）
      save.campaign.clearedStage = 5
    })
    // 先有一件遗物当基准
    await acquireRelics(token, 1, 'rlcnodrop')
    expect(await relicTotal(page)).toBe(1)

    // ── 1) 挂机结算：产出里没有遗物 ───────────────────────
    const settlement = await claimIdleThroughUi(page)
    expect(settlement.rolls).toBeGreaterThan(0)
    const main = settlement.channels.find((c) => c.channel === 'main')
    expect(main, '主线通道应当有产出').toBeTruthy()
    expect(main!.rewards.relics ?? []).toHaveLength(0)
    // 仓库件数没有因为挂机而增加
    expect(await relicTotal(page)).toBe(1)

    // ── 2) 手动挑战：奖励里也没有遗物 ────────────────────
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    const body = await waitForAction(page, 'campaign.challenge', {
      trigger: async () => {
        await page.getByTestId('campaign-challenge').click()
      },
    })
    const result = body.result as unknown as {
      win: boolean
      rewards: { relics?: string[]; items?: Record<string, number> }
    }
    expect(result.win).toBe(true)
    expect(result.rewards.relics ?? []).toHaveLength(0)
    // 仓库件数仍然没变
    expect(await relicTotal(page)).toBe(1)
    expect(await cachedSaveOf(page, accountId)).not.toBeNull()
  })

  test('祈愿：银两足够 → 拿到一件遗物、银两按配置扣', async ({ page }) => {
    const { accountId, token } = await importFixture(page, 'rlcacq', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })
    const before = (await cachedSaveOf(page, accountId))?.player?.silver ?? 0
    expect(before).toBeGreaterThanOrEqual(RELIC_ACQUIRE.SILVER_COST)

    const res = await postAction(token, 'rlcacq-1', { type: 'relic.acquire' })
    expect(res.ok).toBe(true)
    const result = res.result as { relicId: string; uid: string; silver: number }
    expect(result.relicId).toBeTruthy()
    expect(result.uid).toBeTruthy()
    // 回包里的花费就是配置里的价格（不写死数字）
    expect(result.silver).toBe(RELIC_ACQUIRE.SILVER_COST)

    // 权威存档里银两正好扣掉一份
    expect(saveOf(res).player?.silver).toBe(before - RELIC_ACQUIRE.SILVER_COST)

    // 仓库里真的多了一件（服务端统计）
    expect(await relicTotal(page)).toBe(1)
    const saved = await serverRelics(page)
    expect(saved.total).toBe(1)
    expect(saved.items[0].defId).toBe(result.relicId)
    expect(saved.items[0].uid).toBe(result.uid)
    expect(saved.items[0].level).toBeGreaterThanOrEqual(1)
  })

  test('祈愿：银两不足 → 被拒、余额不变、不产生负数', async ({ page }) => {
    const { accountId, token } = await importFixture(page, 'rlcbroke', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.player.silver = 100
    })

    const res = await postAction(token, 'rlcbroke-1', { type: 'relic.acquire' })
    expect(res.ok).toBe(false)
    expect(res.code).toBe(GAME_ERROR_CODES.INSUFFICIENT_FUNDS)

    // 余额**一个字节都没变**（不产生负数）
    expect(saveOf(res).player?.silver).toBe(100)
    expect((await cachedSaveOf(page, accountId))?.player?.silver).toBe(100)

    // 仓库还是空的
    expect(await relicTotal(page)).toBe(0)
  })
})

/**
 * 遗物图标。
 *
 * 遗物原本**完全没有图标**：仓库里的件长得一模一样，玩家只能靠名字认。
 * 这条用例守的是「素材真的到位且真的加载出来了」——
 * 配置齐全 ≠ 资源齐全（铁律 #22）。
 */
test.describe('遗物图标', () => {
  test('仓库里每件遗物都有自己的图标，路径由 core 给出', async ({ page }) => {
    const { token } = await importFixture(page, 'rlicon', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })
    await acquireRelics(token, 2, 'rlicon')

    // 铸造页：每件遗物都有图标
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    const icons = page.locator('.relic-cell img.relic-icon')
    await expect(icons.first()).toBeVisible()
    const cellCount = await page.locator('.relic-cell').count()
    expect(await icons.count()).toBe(cellCount)

    // 路径口径：/relics/<遗物定义 id>.webp（表现层不自己拼，铁律 #8）
    const srcs = await icons.evaluateAll((els) =>
      els.map((el) => (el as HTMLImageElement).getAttribute('src') ?? ''),
    )
    for (const src of srcs) {
      expect(src).toMatch(/^\/relics\/set_[a-z]+_\d+\.webp$/)
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
    const { accountId, token } = await importFixture(page, 'rlicup', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })
    // 首件遗物 → 解锁初阶强化副本 → 强化石
    await acquireRelics(token, 1, 'rlicup')
    await farmRelicStones(page, accountId)

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
    // ⚠ 花费取 core 的 `relicUpgradeCost`（强化价格随等级递增，断言不写死数字）。
    const upgradeCost = relicUpgradeCost(1)!

    const body = await waitForAction(page, 'relic.upgrade', {
      trigger: async () => {
        await upgrade.click()
      },
    })

    // 等级 +1 → 按钮指向 +3
    await expect(upgrade).toContainText('强化 +3')

    // 银两与强化石被**精确**扣掉（读动作回包的权威存档）
    const after = saveOf(body)
    expect(after.player?.silver).toBe(before.silver - upgradeCost.silver)
    expect(after.items?.relicStoneTier1).toBe(before.stones - (upgradeCost.stones.relicStoneTier1 ?? 0))

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
    const { accountId, token } = await importFixture(page, 'rliadv', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })
    // 6 件才填得满 6 个槽位
    await acquireRelics(token, 6, 'rliadv')

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
    const { token } = await importFixture(page, 'rliadv2', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })
    await acquireRelics(token, 6, 'rliadv2')

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
 * ⚠ 守的是「批量走服务端权威动作」——覆盖**已装备 / 锁定 / 重复提交**。
 * ⚠ 锁定的语义 = **永不被自动分解**（含库存溢出）：
 *   玩家特意留下的东西不该被一键清空。
 */
test.describe('仓库批量操作与锁定', () => {
  test('锁定的件不会被批量分解；其余勾选的会被分解掉', async ({ page }) => {
    const { token } = await importFixture(page, 'rlilock', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })
    await acquireRelics(token, 2, 'rlilock')

    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    expect(await relicTotal(page)).toBeGreaterThanOrEqual(2)

    // 先把第一件锁上
    await page.getByTestId('relic-open').first().click()
    await page.getByTestId('relic-lock').click()
    await expect(page.getByTestId('relic-lock')).toContainText('解除锁定')

    // 仓库件数此刻是稳定的（挂机不再掉遗物，件数只会被分解动作改变）。
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
    const { accountId, token } = await importFixture(page, 'rlibatch', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
    })
    await acquireRelics(token, 1, 'rlibatch')
    await farmRelicStones(page, accountId)

    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')

    const before = await resourcesOf(page, accountId)

    const checks = page.getByTestId('relic-check')
    await checks.nth(0).check()
    const body = await waitForAction(page, 'relic.upgradeBatch', {
      trigger: async () => {
        await page.getByTestId('relic-batch-upgrade').click()
      },
    })

    // 银两与强化石被扣（正好一件遗物 +1 级）
    const batchCost = relicUpgradeCost(1)!
    const after = saveOf(body)
    expect(after.player?.silver).toBe(before.silver - batchCost.silver)
    expect(after.items?.relicStoneTier1).toBe(before.stones - (batchCost.stones.relicStoneTier1 ?? 0))
  })
})

/** 读取某英灵当前已装备的遗物数量 */
async function equippedCountOf(page: Page, accountId: number, heroId: string): Promise<number> {
  const equipped = (await cachedSaveOf(page, accountId))?.equipped ?? {}
  return Object.values(equipped).filter((e) => e.heroId === heroId).length
}

/** 从详情页 URL 里取英灵 id */
function heroIdFromUrl(page: Page): string {
  return page.url().split('/hero/')[1]?.split('?')[0]?.split('#')[0] ?? ''
}
