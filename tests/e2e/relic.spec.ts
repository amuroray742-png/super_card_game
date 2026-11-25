import { test, expect, type Page } from '@playwright/test'
import type { SaveData } from '../../src/core/model/types.ts'
import { relicUpgradeCost, relicDropRates } from '../../src/core/systems/relic.ts'
import { RELIC_DROP } from '../../src/core/config/economy.ts'
import { dungeonStageId, findRelicDungeonVariant, relicPoolOf } from '../../src/core/config/dungeons.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import {
  cachedSaveOf,
  claimIdleThroughUi,
  giveTeam,
  importFixture,
  postAction,
  postActionStatus,
  relicTotal,
  serverRelics,
  waitForAction,
} from './helpers'

/**
 * 遗物端到端用例（**遗物副本 · 存档 v12**）。
 *
 * ## 遗物只从遗物副本来
 *
 * 旧版遗物来自「花 5000 银两祈愿」（`relic.acquire` 动作）。
 * 现在**彻底下线**：遗物唯一来源是 **6 个遗物副本 × 3 难度 = 18 关**。
 *
 * ⚠ 这条链路曾经整条断裂过（2026-11-24）：core 的掉落结算只把遗物放进
 *   **独立数组**，`rewards.relics` 从未被赋值；而 store 的入库分支**只读 rewards**
 *   → 挂机 / 挑战产出的遗物 100% 被丢弃。
 *   掉落表明明写着「每场必掉 1 件遗物」，仓库却永远是空的。
 *   ⇒ 现在必须守住：
 *   ① **遗物真的进得来**（副本挑战 → `rewards.relics` → 入库）；
 *   ② **入口真的在玩家眼前**（副本页有遗物 tab、有挑战按钮）。
 *
 * ⚠ **祈愿已下线**：`relic.acquire` 在协议里被显式拒绝。
 *   留一条负向用例，防止有人把它「顺手加回来」。
 *
 * ⚠ **新号可达性是硬卡**：第 1 个遗物副本在主线第 1 关解锁，
 *   而强化副本要求「持有 Lv1 遗物」⇒ 首件遗物拿不到 ⇒ 整条强化链锁死。
 *   历史上正是这个坑让玩家一件遗物都拿不到，所以必须有「Lv1 队伍能打赢」的用例。
 */

/** 一支能打赢副本的队伍（Lv60） */
const STRONG_TEAM = ['hanxin', 'luban', 'zhugeliang', 'libai', 'xiangyu', 'chengjisihan'] as const
/** 强化副本 · 初阶 · 简易（强化石的来源） */
const TIER1_EASY = dungeonStageId('enhanceTier1', 'easy')
/** 遗物副本 · 第 1 号（锋锐遗窟）· 简易 —— **首件遗物的来源** */
const RELIC_EASY = dungeonStageId('relicZhanTan', 'easy')
/**
 * 遗物副本 · 第 2 号（疾影遗窟）· 简易 —— **换副本取样用**。
 *
 * ⚠ 为什么要第二个副本：掉落是**随机**的，单个副本的候选池只有 2 个套装，
 *   连打 6 次完全可能**全落在同一个套装**上（概率约 1.6% × 2 ≈ 3%），
 *   而套装一旦凑满 6 件，它的 2/4/6 三档就全部「已生效」
 *   ⇒ 页面上**再也不会出现「还差 N 件」** ⇒ 依赖该文案的断言会偶发红。
 *   改成「两个副本各打 3 次」⇒ 每个套装最多 3 件 ⇒ 必然有「还差 N 件」。
 */
const RELIC_SECOND_EASY = dungeonStageId('relicJiYing', 'easy')

/**
 * 新号的队伍：**6 名 SSR，Lv1，一件遗物都没有**。
 *
 * ⚠ 难度标定用的是 `referenceTeam(level)`，那支队伍**带 6 件 Lv1 遗物**；
 *   而真实新号**一件遗物都没有**（首件遗物正是从这个副本出的）
 *   ⇒ 拿标定队伍去论证「新号可达」是**偏乐观**的。
 *   这里用**同样 6 名 SSR、但零遗物**的队伍来测。
 */
const NEW_PLAYER_TEAM = HEROES.filter((h) => h.rarity === 'SSR')
  .slice(0, 6)
  .map((h) => h.id)

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
  relicPity?: Record<string, number>
  relicDaily?: { date?: string; count?: number }
} {
  const snapshot = body.save as { payload?: string } | undefined
  return snapshot?.payload ? JSON.parse(snapshot.payload) : {}
}

/**
 * 打遗物副本拿遗物（**手动挑战**，走服务端动作层）。
 *
 * ⚠ 遗物副本的解锁线是「主线通关第 N 关」⇒ 前置存档必须已通关主线。
 * ⚠ 走的是**玩家那条通道**（`POST /api/action` 的 `dungeon.challenge`），
 *   服务端用 core 动作层执行后落库（铁律 #11）。
 *
 * @param stageId 要打的遗物副本关卡（默认第 1 号副本的简易档）。
 *   ⚠ **掉落是随机的** ⇒ 单个副本连打 N 次可能全落在同一个套装上，
 *     用例断言若依赖「套装分布」，就必须**换副本**取样（见「套装效果区」那条）。
 */
async function farmRelicsByDungeon(
  token: string,
  count: number,
  tag: string,
  stageId: string = RELIC_EASY,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await postAction(token, `${tag}-dgn-${i}`, {
      type: 'dungeon.challenge',
      stageId,
    })
    expect(res.ok, `第 ${i + 1} 次遗物副本挑战应当成功：${String(res.message ?? '')}`).toBe(true)
    const result = res.result as { win: boolean; rewards: { relics?: string[] } }
    expect(result.win, '遗物副本挑战应当获胜').toBe(true)
    expect(result.rewards.relics ?? []).not.toHaveLength(0)
  }
}

/**
 * 真实打强化副本拿强化石（**手动挑战**，不是挂机）。
 *
 * ⚠ 强化石**只从强化副本产出**（主线不再投放）。
 * ⚠ 强化副本的解锁线是「持有任意遗物」→ 玩家必须先有遗物（打遗物副本得来）。
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

/**
 * 取一次**服务端权威**的资源基准（银两 / 初阶强化石）。
 *
 * ⚠ 为什么**不能**直接读本地缓存（`cachedSaveOf`）：
 *   1. **服务端每个动作入口都会先结算挂机**（`server/src/game/service.ts` 的 `prepare`
 *      → `settleIdleAndApply`）⇒ 快照与下一个动作之间只要跨过
 *      `IDLE.SECONDS_PER_ROLL`（6 秒）就会**多出一笔挂机收益**。
 *      本地缓存快照与「点强化」之间隔着导航、点开详情、多条断言，实测**正好会踩中**
 *      那个 6 秒窗口 ⇒ 「净减少恰好是强化花费」被凭空多出的 29 银两打偏（偶发红）。
 *   2. 本文件里 `farmRelicsByDungeon` 是**直接打 API** 的（不走页面），
 *      页面的本地缓存根本没被刷新 ⇒ 缓存与服务端真值可能对不上。
 *
 * ⇒ 做法：先发一次 `idle.tick`——它会**结算挂机并回传权威存档**，
 *   同时把**待结算次数归零** ⇒ 紧接着的下一个动作不会再多结算出银两，
 *   两者的差额就是这次动作**净**造成的增减（确定性断言）。
 */
async function authoritativeBefore(
  token: string,
  actionId: string,
): Promise<{ silver: number; stones: number }> {
  const res = await postAction(token, actionId, { type: 'idle.tick' })
  expect(res.ok, '取资源基准的 idle.tick 应当成功').toBe(true)
  const save = saveOf(res)
  return { silver: save.player?.silver ?? 0, stones: save.items?.relicStoneTier1 ?? 0 }
}

test.describe('遗物获取途径（遗物副本 · 存档 v12）', () => {
  test('「遗物祈愿」已下线：动作被拒、银两不变、界面不再有祈愿按钮', async ({ page }) => {
    const { accountId, token } = await importFixture(page, 'rlcdown', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.campaign.clearedStage = 5
    })
    const before = (await cachedSaveOf(page, accountId))?.player?.silver ?? 0

    // ⚠ 协议层**不认识**这个动作了 ⇒ `parseGameAction` 返回 null ⇒ 服务端回 **400**
    //   （协议级失败，不是「静默成功但什么都不给」）。
    const { status, body } = await postActionStatus(token, 'rlcdown-1', { type: 'relic.acquire' })
    expect(status, '遗物祈愿动作应当被拒绝').toBe(400)
    expect(body.ok, '协议级失败的回包里没有 ok 字段').toBeUndefined()

    // 银两一个字节都没变
    expect((await cachedSaveOf(page, accountId))?.player?.silver).toBe(before)

    // 界面上也不能再有祈愿入口（否则玩家点了只会报错）
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('relic-acquire')).toHaveCount(0)
  })

  test('手动挑战遗物副本 → 真的拿到遗物、真的入库', async ({ page }) => {
    const { accountId, token } = await importFixture(page, 'rlcdgn', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      // 遗物副本的解锁线 = 主线通关关卡（`RELIC_DROP.UNLOCK_STAGE`）
      save.campaign.clearedStage = 5
    })

    const res = await postAction(token, 'rlcdgn-1', {
      type: 'dungeon.challenge',
      stageId: RELIC_EASY,
    })
    expect(res.ok, `遗物副本挑战应当成功：${String(res.message ?? '')}`).toBe(true)
    const result = res.result as {
      win: boolean
      firstClear: boolean
      rewards: { relics?: string[]; items?: Record<string, number> }
    }
    expect(result.win).toBe(true)
    expect(result.firstClear).toBe(true)

    // ⚠ 遗物副本**只发遗物**，不发堆叠材料（铁律 #22：一关只产一种）
    expect(result.rewards.items ?? {}).toEqual({})
    const relics = result.rewards.relics ?? []
    expect(relics).not.toHaveLength(0)

    // 掉落的遗物必须来自**该副本的候选池**（表现层/服务端都不许凭空捏造）
    const variant = findRelicDungeonVariant('set_zhanshen')!
    const pool = relicPoolOf(variant) ?? []
    for (const defId of relics) {
      expect(pool).toContain(defId)
    }

    // 仓库真的多了一件（服务端分页统计）
    expect(await relicTotal(page)).toBe(relics.length)
    const saved = await serverRelics(page)
    expect(saved.total).toBe(relics.length)
    expect(saved.items[0].level).toBeGreaterThanOrEqual(1)
  })

  /**
   * ⚠ **新号可达性（硬卡）**。
   *
   * 第 1 个遗物副本在主线第 1 关解锁，而强化副本要求「持有 Lv1 遗物」
   * ⇒ 首件遗物拿不到 ⇒ 整条强化链锁死（2026-11-24 的真实故障）。
   *
   * 这条用例守的就是：**Lv1、零遗物**的队伍也能打赢第一个遗物副本 easy 档。
   */
  test('新号可达性：Lv1、零遗物的队伍能打赢第一个遗物副本', async ({ page }) => {
    const { token } = await importFixture(page, 'rlcnew', (save: SaveData) => {
      giveTeam(save, NEW_PLAYER_TEAM, 1)
      // 只通关了主线第 1 关 —— 这就是新号第一次能进遗物副本的时刻
      save.campaign.clearedStage = 1
    })

    const res = await postAction(token, 'rlcnew-1', {
      type: 'dungeon.challenge',
      stageId: RELIC_EASY,
    })
    expect(res.ok, `新号应当能进第一个遗物副本：${String(res.message ?? '')}`).toBe(true)
    const result = res.result as { win: boolean; rewards: { relics?: string[] } }
    expect(result.win, '新号必须打得赢第一个遗物副本').toBe(true)
    expect(result.rewards.relics ?? []).not.toHaveLength(0)
  })

  test('挂机与主线手动挑战都不掉遗物（遗物只从遗物副本来）', async ({ page }) => {
    const { accountId, token } = await importFixture(page, 'rlcnodrop', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      // 已通关到第 5 关 → 主线通道**有目标**（挂机真的会产出东西）
      save.campaign.clearedStage = 5
    })
    // 先从遗物副本拿一件当基准
    await farmRelicsByDungeon(token, 1, 'rlcnodrop')
    const baseline = await relicTotal(page)
    expect(baseline).toBe(1)

    // ── 1) 挂机结算：产出里没有遗物 ───────────────────────
    const settlement = await claimIdleThroughUi(page)
    expect(settlement.rolls).toBeGreaterThan(0)
    const main = settlement.channels.find((c) => c.channel === 'main')
    expect(main, '主线通道应当有产出').toBeTruthy()
    expect(main!.rewards.relics ?? []).toHaveLength(0)
    // 仓库件数没有因为挂机而增加
    expect(await relicTotal(page)).toBe(baseline)

    // ── 2) 主线手动挑战：奖励里也没有遗物 ────────────────────
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
    expect(await relicTotal(page)).toBe(baseline)
    expect(await cachedSaveOf(page, accountId)).not.toBeNull()
  })

  test('材料副本仍然只发材料（遗物副本与材料副本的产出形状不同）', async ({ page }) => {
    const { token } = await importFixture(page, 'rlcmat', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.campaign.clearedStage = 5
    })
    // ⚠ 初阶强化副本的解锁线是「持有任意遗物」⇒ 先从遗物副本拿一件
    await farmRelicsByDungeon(token, 1, 'rlcmat')

    const res = await postAction(token, 'rlcmat-1', {
      type: 'dungeon.challenge',
      stageId: TIER1_EASY,
    })
    expect(res.ok).toBe(true)
    const result = res.result as { win: boolean; rewards: { relics?: string[]; items?: Record<string, number> } }
    expect(result.win).toBe(true)
    expect(result.rewards.relics ?? []).toHaveLength(0)
    expect(Object.keys(result.rewards.items ?? {})).toEqual(['relicStoneTier1'])
  })
})

/**
 * **遗物挂机通道**（第 4 条挂机通道 · 存档 v12）。
 *
 * ⚠ 守的是「遗物也能挂机」这条链路：
 *   已通关的遗物副本 ⇒ 能设为挂机目标 ⇒ 挂机真的产出遗物。
 *
 * ⚠ 每日额度只约束**挂机**（手动挑战不受限），所以这条用例里额度是满的。
 */
test.describe('遗物挂机通道', () => {
  test('已通关的遗物副本能设为挂机通道，挂机真的产出遗物', async ({ page }) => {
    const { accountId, token } = await importFixture(page, 'rlcidle', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.campaign.clearedStage = 5
    })

    // 先**真的打赢一次**（导入不能伪造通关记录）
    await farmRelicsByDungeon(token, 1, 'rlcidle')
    const before = await relicTotal(page)

    // 副本页 → 遗物 tab → 设为挂机通道
    await page.goto('/#/dungeon?kind=relic')
    await page.waitForLoadState('networkidle')
    const setBtn = page.getByTestId(`dungeon-set-channel-${RELIC_EASY}`)
    await expect(setBtn).toBeVisible()
    await setBtn.click()

    // 通道目标写对了
    await expect
      .poll(
        async () => (await cachedSaveOf(page, accountId))?.idle?.channels?.relic?.target?.dungeonStageId,
        { timeout: 8000 },
      )
      .toBe(RELIC_EASY)

    // 推征页 → 领取 ⇒ 遗物通道真的有产出
    const settlement = await claimIdleThroughUi(page)
    const relic = settlement.channels.find((c) => c.channel === 'relic')
    expect(relic, '遗物通道应当有产出').toBeTruthy()
    expect(relic!.rewards.relics ?? []).not.toHaveLength(0)

    // 仓库真的多了（服务端分页统计）
    await expect.poll(async () => relicTotal(page), { timeout: 10_000 }).toBeGreaterThan(before)
  })

  test('遗物通道的「可领 N 次」不会超过每日额度（铁律 #62：界面只能少写）', async ({ page }) => {
    const { token } = await importFixture(page, 'rlccap', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.campaign.clearedStage = 5
    })
    await farmRelicsByDungeon(token, 1, 'rlccap')

    await page.goto('/#/dungeon?kind=relic')
    await page.waitForLoadState('networkidle')
    await page.getByTestId(`dungeon-set-channel-${RELIC_EASY}`).click()

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    const claim = page.getByTestId('idle-claim-relic')
    await expect(claim).toBeVisible()

    // 按钮上写的次数 ≤ 今日剩余额度（额度按「件」计，每次掷奖至少出 1 件）
    const label = (await claim.textContent()) ?? ''
    const shown = Number(label.match(/(\d+)/)?.[1] ?? '0')
    expect(shown).toBeLessThanOrEqual(RELIC_DROP.DAILY_CAP)

    // 实际领取到的件数也不会超过额度
    const settlement = await claimIdleThroughUi(page)
    const relic = settlement.channels.find((c) => c.channel === 'relic')
    const got = relic?.rewards.relics?.length ?? 0
    expect(got).toBeLessThanOrEqual(RELIC_DROP.DAILY_CAP)
  })
})

/**
 * **遗物副本页**（表现层不变量）。
 *
 * ⚠ 守的是「养成规则在玩家眼前」（铁律 #27）：
 *   稀有度概率公示、套装进度、每日额度、保底进度，
 *   玩家看不到 ⇒ 这条养成线等于隐形（历史上套装 2/4/6 加成就 invisible 过）。
 */
test.describe('遗物副本页', () => {
  test('第三个 tab 存在，概率公示 / 套装进度 / 每日额度 / 保底进度都在页面上', async ({ page }) => {
    await importFixture(page, 'rlcpage', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.campaign.clearedStage = 5
    })

    // 从副本页点第三个 tab（入口必须可达，铁律 #10）
    await page.goto('/#/dungeon')
    await page.waitForLoadState('networkidle')
    const tab = page.getByTestId('dungeon-kind-relic')
    await expect(tab).toBeVisible()
    await tab.click()
    await expect(page).toHaveURL(/kind=relic/)

    // 稀有度概率公示：四档都在，且数字与 core 的唯一口径一致
    const rates = relicDropRates('easy')
    for (const rate of rates) {
      const row = page.getByTestId(`relic-rate-easy-${rate.rarity}`)
      await expect(row).toBeVisible()
      // 百分比数字（写成 "5%" 或 "5.0%" 都认，只断言数字本身）
      await expect(row).toContainText(String(Math.round(rate.percent * 100)))
    }

    // 每日额度
    await expect(page.getByTestId('relic-daily-quota')).toBeVisible()

    // 套装进度（第 1 个副本覆盖 set_zhanshen / set_tanpo）
    const variant = findRelicDungeonVariant('set_zhanshen')!
    for (const setId of variant.relicSetIds ?? []) {
      await expect(page.getByTestId(`relic-set-progress-${setId}`)).toBeVisible()
    }

    // 保底进度（该副本的 easy 关卡）
    await expect(page.getByTestId(`relic-pity-${RELIC_EASY}`)).toBeVisible()
  })

  test('强化副本被解锁线挡住时，给的出路是「去遗物副本」而不是「去祈愿」', async ({ page }) => {
    await importFixture(page, 'rlcgate', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.campaign.clearedStage = 5
    })
    await page.goto('/#/dungeon?kind=enhance')
    await page.waitForLoadState('networkidle')

    // 玩家**一件遗物都没有** ⇒ 初阶强化副本的解锁线挡路
    const hint = page.getByTestId('dungeon-go-relic-dungeon')
    await expect(hint).toBeVisible()
    // 文案里不许再出现「祈愿」
    await expect(hint).not.toContainText('祈愿')
    await hint.click()
    await expect(page).toHaveURL(/kind=relic/)
  })
})

/**
 * 遗物仓库：**套装进度可见 + 能直达遗物副本**。
 *
 * ⚠ 守的是「缺哪套 → 去哪个副本」这条路是通的（铁律 #27）。
 */
test.describe('遗物仓库', () => {
  test('仓库里能看到每个套装的进度，并能一键跳到对应遗物副本', async ({ page }) => {
    await importFixture(page, 'rlcware', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.campaign.clearedStage = 5
    })

    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')

    const row = page.getByTestId('relic-set-row-set_zhanshen')
    await expect(row).toBeVisible()
    // 「x / 5 件」——一件都没有时是 0 / 5
    await expect(row).toContainText('/ 5')

    // 点套装 → 直达对应的遗物副本
    await row.click()
    await expect(page).toHaveURL(/kind=relic/)
  })

  test('仓库空态引导指向遗物副本，不再提「祈愿」', async ({ page }) => {
    await importFixture(page, 'rlcempty', (save: SaveData) => {
      giveTeam(save, STRONG_TEAM, 60)
      save.campaign.clearedStage = 5
    })
    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('祈愿')).toHaveCount(0)
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
      save.campaign.clearedStage = 5
    })
    await farmRelicsByDungeon(token, 2, 'rlicon')

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
      save.campaign.clearedStage = 5
    })
    // 首件遗物（来自遗物副本）→ 解锁初阶强化副本 → 强化石
    await farmRelicsByDungeon(token, 1, 'rlicup')
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

    // ⚠ 资源基准取**服务端权威状态**（不取本地缓存）——原因见 `authoritativeBefore`。
    const before = await authoritativeBefore(token, 'rlicup-baseline')
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
      save.campaign.clearedStage = 5
    })
    // 6 件才填得满 6 个槽位
    await farmRelicsByDungeon(token, 6, 'rliadv')

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
      save.campaign.clearedStage = 5
    })
    // ⚠ **两个副本各打 3 次**：单副本连打 6 次可能全落在同一套装上（随机掉落），
    //   那个套装一旦凑满 6 件，三档就全「已生效」⇒ 页面不再有「还差 N 件」。
    //   两个副本 ⇒ 每个套装最多 3 件 ⇒ 「还差 N 件」必然出现。
    await farmRelicsByDungeon(token, 3, 'rliadv2a', RELIC_EASY)
    await farmRelicsByDungeon(token, 3, 'rliadv2b', RELIC_SECOND_EASY)

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
      save.campaign.clearedStage = 5
    })
    await farmRelicsByDungeon(token, 2, 'rlilock')

    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')
    expect(await relicTotal(page)).toBeGreaterThanOrEqual(2)

    // 先把第一件锁上
    await page.getByTestId('relic-open').first().click()
    await page.getByTestId('relic-lock').click()
    await expect(page.getByTestId('relic-lock')).toContainText('解除锁定')

    // 仓库件数此刻是稳定的（遗物只从副本来，挂机不产遗物，件数只会被分解动作改变）。
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
      save.campaign.clearedStage = 5
    })
    await farmRelicsByDungeon(token, 1, 'rlibatch')
    await farmRelicStones(page, accountId)

    await page.goto('/#/forge')
    await page.waitForLoadState('networkidle')

    const checks = page.getByTestId('relic-check')
    // ⚠ 必须先等**渲染出来**：SPA 走 hash 路由，`networkidle` 立刻满足，
    //   但遗物列表可能还没挂上 ⇒ `check()` 会一直等它出现，
    //   那几秒正好跨过 `IDLE.SECONDS_PER_ROLL`（6 秒）的掷奖周期
    //   ⇒ 服务端在下一次动作入口结算时会多发一笔挂机收益，把「净减少 = 花费」打偏。
    await expect(checks.first()).toBeVisible()
    await checks.nth(0).check()

    // ⚠ 资源基准取**服务端权威状态**（不取本地缓存）——原因见 `authoritativeBefore`。
    //   基准必须是**被测动作之前最后一个**服务端动作 ⇒ 两者之间只剩一次点击。
    const before = await authoritativeBefore(token, 'rlibatch-baseline')

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
