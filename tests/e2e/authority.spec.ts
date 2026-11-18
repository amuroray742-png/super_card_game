import { test, expect, type Page } from '@playwright/test'
import {
  E2E_API_BASE,
  E2E_PASSWORD,
  cachedSaveOf,
  loginAccount,
  registerAccount,
  seedSession,
  skipGachaReveal,
  uniqueUsername,
} from './helpers'
import { ACCOUNT_STORAGE_KEYS } from '../../src/core/config/account.ts'

/**
 * 服务端权威端到端用例（AGENTS.md 铁律 #28 / #29）。
 *
 * 守的是四条新语义：
 *   1. **服务端权威**：本地缓存改了也不算数，进度以服务端为准；
 *   2. **幂等**：同一个 actionId 重放只扣一次费（断网重试的安全网）；
 *   3. **多设备一致**：两台设备看到同一份进度；
 *   4. **离线只读**：服务端不可达时只能看，不能改。
 */

/** 直接调后端接口发一个动作 */
async function postAction(
  accessToken: string,
  actionId: string,
  action: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${E2E_API_BASE}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ actionId, action }),
  })
  const body = (await res.json()) as Record<string, unknown>
  return body
}

/** 拉服务端存档（权威版本） */
async function pullSave(accessToken: string): Promise<Record<string, never> | null> {
  const res = await fetch(`${E2E_API_BASE}/api/save`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return null
  const body = (await res.json()) as { payload: string }
  return JSON.parse(body.payload) as Record<string, never>
}

/** 换一对新令牌（拿 access token） */
async function accessTokenOf(session: { refreshToken: string }): Promise<string> {
  const res = await fetch(`${E2E_API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
  const body = (await res.json()) as { accessToken: string }
  return body.accessToken
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
    expect(before?.player?.crystals).toBe(3000)

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
    expect(after?.player?.crystals).toBe(3000)
  })

  test('同一个 actionId 重放只扣一次费（断网重试的安全网）', async () => {
    const session = await registerAccount(uniqueUsername('idem'))
    const token = await accessTokenOf(session)
    await postAction(token, 'create-1', { type: 'save.create' })

    const before = await pullSave(token)
    expect((before as unknown as { player: { crystals: number } }).player.crystals).toBe(3000)

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
      player: { crystals: number; tickets: number }
      stats: { totalPulls: number }
    }
    expect(after.player.crystals).toBe(0)
    expect(after.player.tickets).toBe(10)
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

    // 网络恢复后无需刷新：已 loaded 的游戏镜像也必须重新拉取权威档。
    await page.evaluate((base) => localStorage.setItem('sgw.apiBase', base), E2E_API_BASE)
    await page.getByTestId('reconnect').click()
    await expect(page.locator('.offline-bar')).toHaveCount(0, { timeout: 15_000 })
    await pullTen(page)
    await expect.poll(async () => (await cachedSaveOf(page, session.user.id))?.stats?.totalPulls)
      .toBe(20)
  })
})
