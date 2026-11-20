import { test, expect, type Page } from '@playwright/test'
import {
  E2E_API_BASE,
  E2E_PASSWORD,
  accessTokenOf,
  cachedSaveOf,
  expOfRewards,
  loginAccount,
  postAction,
  registerAccount,
  seedSession,
  settleIdleThroughUi,
  skipGachaReveal,
  uniqueUsername,
} from './helpers'
import { ACCOUNT_STORAGE_KEYS } from '../../src/core/config/account.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { getStage } from '../../src/core/config/stages.ts'
import { GACHA, START_RESOURCES } from '../../src/core/config/economy.ts'

/**
 * 新号起始结晶（口径取 core，**不写死数字**——铁律 #4）。
 */
const START_CRYSTALS = START_RESOURCES.crystals
/** 十连的结晶消耗（= 10 抽 × 单抽价） */
const TEN_PULL_CRYSTALS = GACHA.COST_SINGLE * GACHA.TEN_PULL_COUNT

/**
 * 服务端权威端到端用例（AGENTS.md 铁律 #28 / #29）。
 *
 * 守的是四条新语义：
 *   1. **服务端权威**：本地缓存改了也不算数，进度以服务端为准；
 *   2. **幂等**：同一个 actionId 重放只扣一次费（断网重试的安全网）；
 *   3. **多设备一致**：两台设备看到同一份进度；
 *   4. **离线只读**：服务端不可达时只能看，不能改。
 */

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

test('挑战 BOSS 战败后页面显示刷取关卡，后续推征继续发放战利品', async ({ page }) => {
  // ⚠ 本用例要**真实等挂机时间**（每场 6 秒）才能多刷几场把经验书刷出来
  //   （经验书是概率掉落，见下面注释）→ 默认 30 秒超时不够，放宽到 90 秒。
  test.slow()
  const account = await registerAccount(uniqueUsername('farm'))
  const token = await accessTokenOf(account)
  const now = Date.now()
  const save = createNewSave(now)
  const ids = ['jeannedarc', 'nangdengel', 'huatuo', 'bianque']
  for (const [slot, id] of ids.entries()) {
    save.heroes[id] = { ...createHeroState(id, now), level: 44 }
    save.team.slots[slot] = id
  }
  save.campaign.clearedStage = 61
  save.idle.currentStage = 62
  const imported = await postAction(token, 'farm-fixture', { type: 'save.import', payload: exportSave(save) })
  expect(imported.ok).toBe(true)
  await seedSession(page, await loginAccount(account.user.username))
  await page.goto('/#/expedition')
  await expect(page.getByText(getStage(62).name, { exact: true })).toBeVisible()
  const offline = page.locator('.dialog').filter({ hasText: '离线推征结算' })
  if (await offline.isVisible()) await offline.getByRole('button', { name: '收下' }).click()

  await settleIdleThroughUi(page, account.user.id, 1)
  await expect(page.getByText('当前挑战受阻')).toBeVisible()
  await expect(page.getByText(`正在刷取「${getStage(61).name}」`, { exact: false })).toBeVisible()

  // ⚠ 资源/背包版本 v10：经验改由**经验书**产出（奖励包里没有 exp 字段），
  //   而经验书是**概率掉落**（每类道具各自独立掷一次骰子，见 `economy.ts` 的 `expBookDrop`）
  //   → 「一场一定有书」是错的假设（早期章节只有 ~73% 出书率）。
  //   这里有界重试：累计拿到书为止，而不是断言单场。
  //   ⚠ 每轮都要**真实等 6 秒**（挂机不创造时间）→ 上限 6 轮 ≈ 36 秒，
  //   所以本用例用 `test.slow()` 把超时放宽到 90 秒。
  let farmed = await settleIdleThroughUi(page, account.user.id, 1)
  let exp = expOfRewards(farmed.rewards)
  for (let i = 0; i < 5 && exp <= 0; i++) {
    farmed = await settleIdleThroughUi(page, account.user.id, 1)
    exp += expOfRewards(farmed.rewards)
  }
  expect(exp, '挂机应当产出经验书').toBeGreaterThan(0)
  expect(farmed.rewards.relics?.length ?? 0).toBeGreaterThanOrEqual(1)
  expect(farmed.reachedStage).toBe(61)
  await expect(page.getByText(getStage(62).name, { exact: true })).toBeVisible()
})
