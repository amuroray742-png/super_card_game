import { test, expect, type Page } from '@playwright/test'
import {
  E2E_API_BASE,
  E2E_PASSWORD,
  accessTokenOf,
  cachedSaveOf,
  loginAccount,
  postAction,
  registerAccount,
  seedSession,
  skipGachaReveal,
  uniqueUsername,
} from './helpers'
import { ACCOUNT_STORAGE_KEYS } from '../../src/core/config/account.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import type { SaveData } from '../../src/core/model/types.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { getStage } from '../../src/core/config/stages.ts'
import { GACHA, IDLE, START_RESOURCES } from '../../src/core/config/economy.ts'

/**
 * 服务端权威端到端用例（AGENTS.md 铁律 #28 / #29 + 挂机改版 v11）。
 *
 * 守的是四条新语义：
 *   1. **服务端权威**：本地缓存改了也不算数，进度以服务端为准；
 *   2. **幂等**：同一个 actionId 重放只扣一次费（断网重试的安全网）；
 *   3. **多设备一致**：两台设备看到同一份进度；
 *   4. **离线只读**：服务端不可达时只能看，不能改。
 *
 * ⚠ **挂机改版 v11** 的口径：挂机是**四条独立通道**（主线 / 技能副本 / 强化副本 / 遗物副本），
 *   结算结果是**按通道分段**的 `channels[]`（不再是单个 `rewards`），
 *   离线结算回执同样按通道分段。
 */

/**
 * 新号起始结晶（口径取 core，**不写死数字**——铁律 #4）。
 */
const START_CRYSTALS = START_RESOURCES.crystals
/** 十连的结晶消耗（= 10 抽 × 单抽价） */
const TEN_PULL_CRYSTALS = GACHA.COST_SINGLE * GACHA.TEN_PULL_COUNT
/** 一支能打赢第 1 章的队伍（Lv60） */
const STRONG_TEAM = ['hanxin', 'luban', 'zhugeliang', 'libai', 'xiangyu', 'chengjisihan'] as const

/** 拉服务端存档（权威版本） */
async function pullSave(accessToken: string): Promise<Record<string, never> | null> {
  const res = await fetch(`${E2E_API_BASE}/api/save`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return null
  const body = (await res.json()) as { payload: string }
  return JSON.parse(body.payload) as Record<string, never>
}

/** 某个账号的本地缓存槽位键（口径取 core 的唯一来源） */
function slotKey(accountId: number | string): string {
  return `${ACCOUNT_STORAGE_KEYS.SAVE_SLOT_PREFIX}${accountId}`
}

/** 存量单槽位（旧档迁移通道）的键 */
const LEGACY_SLOT_KEY = `${ACCOUNT_STORAGE_KEYS.SAVE_SLOT_PREFIX}${ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT}`

/**
 * 抽一次十连（跳过演出）。
 *
 * ⚠ 必须等**结算弹窗**真的出来才算完：十连走服务端动作，
 *   请求还没回来时本地缓存里的 `totalPulls` 还是 0——
 *   直接读缓存会读到「动作还没落地」的中间态（实测约 1/3 概率）。
 */
async function pullTen(page: Page): Promise<void> {
  await page.locator('button', { hasText: '十连' }).first().click()
  await skipGachaReveal(page)
  const collect = page.getByRole('button', { name: '收下' })
  await collect.waitFor({ state: 'visible', timeout: 15_000 })
  await collect.click()
}

/**
 * 造一个前置存档，**但不要打开页面**。
 *
 * ⚠ 离线结算用例需要「玩家离线一段时间」：
 *   页面开着 → 心跳一直续租 → 在线计量 → 永远不会有离线回执。
 *   所以这里只走服务端动作层（导入档），**不载入页面**。
 */
async function importWithoutPage(
  prefix: string,
  mutate: (save: SaveData) => void,
): Promise<{ accountId: number; token: string; username: string }> {
  const username = uniqueUsername(prefix)
  const session = await registerAccount(username)
  const token = await accessTokenOf(session)
  const save = createNewSave(Date.now())
  mutate(save)
  const imported = await postAction(token, `${prefix}-fixture`, {
    type: 'save.import',
    payload: exportSave(save),
  })
  expect(imported.ok, '前置存档导入失败').toBe(true)
  return { accountId: session.user.id, token, username }
}

test.describe('服务端权威', () => {
  test('本地缓存改了也不算数：进度以服务端为准', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('auth'))
    await seedSession(page, session)
    await page.goto('/#/gacha')
    await page.waitForLoadState('networkidle')

    const before = await cachedSaveOf(page, session.user.id)
    // ⚠ 资源/背包版本 v10：新号起始结晶 6,000（＝ 20 抽），钱包只有银两 + 圣杯结晶。
    expect(before?.player?.crystals).toBe(START_CRYSTALS)

    // 篡改本地缓存（模拟玩家手动改 / 另一个标签页写坏）
    await page.evaluate((key) => {
      const save = JSON.parse(localStorage.getItem(key)!)
      save.player.crystals = 999999
      localStorage.setItem(key, JSON.stringify(save))
    }, slotKey(session.user.id))

    // 重新载入 → 服务端版本覆盖本地缓存
    await page.reload()
    await page.waitForLoadState('networkidle')
    const after = await cachedSaveOf(page, session.user.id)
    expect(after?.player?.crystals).toBe(START_CRYSTALS)
  })

  test('客户端改本地缓存的挂机通道不生效：下一个服务端回包覆盖它', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('authidle'))
    const token = await accessTokenOf(session)
    // 前置：已通关到第 5 关 ⇒ 主线通道有目标（跟随模式）
    const save = createNewSave(Date.now())
    STRONG_TEAM.forEach((id, slot) => {
      save.heroes[id] = { ...createHeroState(id, Date.now()), level: 60 }
      save.team.slots[slot] = id
    })
    save.campaign.clearedStage = 5
    const imported = await postAction(token, 'authidle-fixture', {
      type: 'save.import',
      payload: exportSave(save),
    })
    expect(imported.ok).toBe(true)

    await seedSession(page, await loginAccount(session.user.username))
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    // 篡改本地缓存里的**挂机通道目标**
    await page.evaluate((key) => {
      const cached = JSON.parse(localStorage.getItem(key)!)
      cached.idle.channels.main.target = { kind: 'main', stageId: 3 }
      cached.idle.channels.skill.target = { kind: 'skill', dungeonStageId: 'dgn_skillFire_easy' }
      cached.idle.channels.enhance.target = { kind: 'enhance', dungeonStageId: 'dgn_enhanceTier1_easy' }
      localStorage.setItem(key, JSON.stringify(cached))
    }, slotKey(session.user.id))
    expect((await cachedSaveOf(page, session.user.id))?.idle?.channels?.main?.target)
      .toEqual({ kind: 'main', stageId: 3 })

    // 触发一次**客户端动作**（服务端回包 = 权威版本，覆盖本地镜像）
    await page.getByTestId('campaign-challenge').click()

    // 篡改值被覆盖回服务端的形状：主线仍是「跟随」，副本通道仍是关闭
    await expect
      .poll(async () => (await cachedSaveOf(page, session.user.id))?.idle?.channels?.main?.target, { timeout: 10_000 })
      .toEqual({ kind: 'main', stageId: null })
    const cached = await cachedSaveOf(page, session.user.id)
    expect(cached?.idle?.channels?.skill?.target).toBeNull()
    expect(cached?.idle?.channels?.enhance?.target).toBeNull()
  })

  test('同一个 actionId 重放只扣一次费（断网重试的安全网）', async () => {
    const session = await registerAccount(uniqueUsername('idem'))
    const token = await accessTokenOf(session)
    await postAction(token, 'create-1', { type: 'save.create' })

    const before = await pullSave(token)
    expect((before as unknown as { player: { crystals: number } }).player.crystals).toBe(START_CRYSTALS)

    const first = await postAction(token, 'pull-1', {
      type: 'gacha.pull',
      poolId: 'standard',
      count: 10,
    })
    const second = await postAction(token, 'pull-1', {
      type: 'gacha.pull',
      poolId: 'standard',
      count: 10,
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    // 第二次是重放：结果一致，且没有再扣一次
    expect(second.replayed).toBe(true)
    expect(second.result).toEqual(first.result)

    const after = await pullSave(token) as unknown as {
      player: { crystals: number }
      stats: { totalPulls: number }
      shards?: Record<string, number>
    }
    // 十连只扣一次结晶（10 抽 × 300 = 3,000）
    expect(after.player.crystals).toBe(START_CRYSTALS - TEN_PULL_CRYSTALS)
    expect(after.stats.totalPulls).toBe(10)
  })

  test('挑战类动作重放同一 actionId：只发一次奖、不重复推进', async () => {
    const { token } = await importWithoutPage('idemch', (save) => {
      STRONG_TEAM.forEach((id, slot) => {
        save.heroes[id] = { ...createHeroState(id, Date.now()), level: 60 }
        save.team.slots[slot] = id
      })
    })

    const first = await postAction(token, 'ch-idem', { type: 'campaign.challenge' })
    expect(first.ok).toBe(true)
    const firstResult = first.result as unknown as {
      win: boolean
      firstClear: boolean
      rewards: { crystals?: number }
    }
    expect(firstResult.win).toBe(true)
    expect(firstResult.firstClear).toBe(true)
    // 首通结晶发了一次
    expect(firstResult.rewards.crystals).toBeGreaterThan(0)
    // 战斗回放**只在第一次**返回（不进幂等日志）
    expect(first.replay).toBeTruthy()

    // 重放同一 actionId
    const second = await postAction(token, 'ch-idem', { type: 'campaign.challenge' })
    expect(second.ok).toBe(true)
    expect(second.replayed).toBe(true)
    expect(second.result).toEqual(first.result)
    // 幂等日志里**没有**战斗回放 ⇒ 重放拿不到演出数据（结果与奖励仍一致）
    expect(second.replay).toBeUndefined()

    // 进度只推进了一次、结晶只发了一次
    const after = await pullSave(token) as unknown as {
      player: { crystals: number }
      campaign: { clearedStage: number }
    }
    expect(after.campaign.clearedStage).toBe(1)
    expect(after.player.crystals).toBe(START_CRYSTALS + firstResult.rewards.crystals!)
  })
})

test.describe('多设备一致', () => {
  test('两台设备看到同一份进度', async ({ browser }) => {
    const username = uniqueUsername('multi')
    await registerAccount(username)
    // 两个独立会话（refresh token 是一次性轮换的，不能共用）
    const sessionA = await loginAccount(username)
    const sessionB = await loginAccount(username)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    try {
      await seedSession(pageA, sessionA)
      await seedSession(pageB, sessionB)
      await pageA.goto('/#/gacha')
      await pageA.waitForLoadState('networkidle')

      // A 抽一次十连
      await pullTen(pageA)
      const pullsA = (await cachedSaveOf(pageA, sessionA.user.id))?.stats?.totalPulls
      expect(pullsA).toBe(10)

      // B 重新载入 → 看到 A 的进度
      await pageB.goto('/#/gacha')
      await pageB.waitForLoadState('networkidle')
      await pageB.reload()
      await pageB.waitForLoadState('networkidle')
      const pullsB = (await cachedSaveOf(pageB, sessionA.user.id))?.stats?.totalPulls
      expect(pullsB).toBe(10)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

test.describe('离线只读', () => {
  test('服务端不可达 → 能看进度，不能操作', async ({ page }) => {
    // ⚠ 不用 seedSession：它的 init script 每次导航都会把后端地址改回去，
    //   离线用例需要自己控制后端地址。
    const username = uniqueUsername('offline')
    const session = await registerAccount(username)

    await page.goto('/#/login')
    await page.evaluate((base) => localStorage.setItem('sgw.apiBase', base), E2E_API_BASE)
    await page.reload()
    await page.waitForLoadState('networkidle')

    await page.getByPlaceholder('3-16 位字母、数字或下划线').fill(username)
    await page.getByPlaceholder('至少 8 位').fill(E2E_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).last().click()
    // 新号没有英灵 → 会被引导页劫持（这是预期行为），等落地即可
    await page.waitForURL(/\/#\/(guide|expedition)/, { timeout: 15_000 })

    // 存量旧档槽位（迁移通道）不该被新版客户端写入新档：
    // 一旦写进去，第一个账号登录时会把这份新档当成「旧档」导入服务端，
    // 还顺手占掉一次性迁移标记 → 玩家真正的旧档再也迁不过来。
    const legacyBefore = await page.evaluate((key) => localStorage.getItem(key), LEGACY_SLOT_KEY)
    expect(legacyBefore).toBeNull()

    // 玩一下：抽一次十连（让本地缓存里有进度）
    await page.goto('/#/gacha')
    await page.waitForLoadState('networkidle')
    await pullTen(page)
    expect((await cachedSaveOf(page, session.user.id))?.stats?.totalPulls).toBe(10)
    expect(await cachedSaveOf(page, session.user.id)).not.toHaveProperty('rng')

    // 抽完之后迁移通道仍然干净
    const legacyAfter = await page.evaluate((key) => localStorage.getItem(key), LEGACY_SLOT_KEY)
    expect(legacyAfter).toBeNull()

    // 后端「挂掉」：指向一个没人监听的端口
    await page.evaluate(() => localStorage.setItem('sgw.apiBase', 'http://127.0.0.1:9'))
    await page.reload()
    await page.waitForLoadState('networkidle')

    // 离线提示出现，且没被踢回登录页
    await expect(page.locator('.offline-bar')).toBeVisible({ timeout: 10_000 })
    await expect(page).not.toHaveURL(/\/#\/login/)

    // 进度还在（来自本地缓存）
    expect((await cachedSaveOf(page, session.user.id))?.stats?.totalPulls).toBe(10)

    // 操作被拒绝：不能改存档
    await page.goto('/#/gacha')
    await page.waitForLoadState('networkidle')
    await page.locator('button', { hasText: '十连' }).first().click()
    await expect(page.getByText('离线模式，只能查看进度')).toBeVisible({ timeout: 10_000 })
    expect((await cachedSaveOf(page, session.user.id))?.stats?.totalPulls).toBe(10)

    await page.goto('/#/settings')
    await page.getByRole('button', { name: '注销账号', exact: true }).click()
    await page.getByRole('button', { name: '确认注销', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('无法连接服务器')
    expect(await cachedSaveOf(page, session.user.id)).not.toBeNull()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.goto('/#/gacha')

    // 网络恢复后无需刷新：已 loaded 的游戏镜像也必须重新拉取权威档。
    await page.evaluate((base) => localStorage.setItem('sgw.apiBase', base), E2E_API_BASE)
    await page.getByTestId('reconnect').click()
    await expect(page.locator('.offline-bar')).toHaveCount(0, { timeout: 15_000 })
    await pullTen(page)
    await expect.poll(async () => (await cachedSaveOf(page, session.user.id))?.stats?.totalPulls)
      .toBe(20)
  })
})

test.describe('离线结算回执（服务端出具 · 分通道分段）', () => {
  // ⚠ 这条用例要**真实离线一段时间**（阈值 `IDLE.OFFLINE_SETTLE_THRESHOLD_SEC` = 60 秒）
  //   → 预算必须放宽到 3 分钟。
  test.setTimeout(240_000)

  test('离线期间不打开页面，回来后按通道分段弹出结算回执', async ({ page }) => {
    // ⚠ **不要打开页面**：页面开着 → 心跳一直续租 → 全算在线 → 永远没有离线回执
    const { username } = await importWithoutPage('offsettle', (save) => {
      STRONG_TEAM.forEach((id, slot) => {
        save.heroes[id] = { ...createHeroState(id, Date.now()), level: 60 }
        save.team.slots[slot] = id
      })
      // 已通关到第 5 关 ⇒ 主线通道有目标（跟随最新通关关卡）
      save.campaign.clearedStage = 5
    })

    // 真实等待超过离线阈值
    await page.waitForTimeout(IDLE.OFFLINE_SETTLE_THRESHOLD_SEC * 1000 + 15_000)

    // 回来上线 → 服务端补算离线收益并回传回执
    await seedSession(page, await loginAccount(username))
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    const dialog = page.getByTestId('offline-settlement')
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    // 标题与总次数都来自**服务端回执**
    await expect(dialog).toContainText('离线挂机结算')
    // ⚠ 通道数**按实际结算段数推导**（界面不写死「三条 / 四条」）：
    //   这里断言「文案里的条数 = 弹窗里实际渲染的通道段数」，
    //   少写或多数都会被拦下（写死一个数 ⇒ 挂机通道增减后立刻说谎）。
    const settledChannels = await dialog.locator('.offline-chan').count()
    await expect(dialog).toContainText(`${settledChannels} 条通道各自结算`)
    // 分通道分段：主线这一段带着**目标名**与次数
    const main = dialog.locator('.offline-chan').filter({ hasText: '主线' })
    await expect(main).toBeVisible()
    await expect(main).toContainText(getStage(5).name)
    await expect(main).toContainText('次')

    // 收下后弹窗消失
    await dialog.getByRole('button', { name: '收下', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })
})
