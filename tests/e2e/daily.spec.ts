/**
 * 每日任务与周目标（roadmap P2-1）。
 *
 * 端到端走**真实后端**（真实 SQLite + 真实动作层），验的是：
 *
 * 1. 任务页列得出每日任务与周目标，且每条都能**一键到对应玩法**（铁律 #10）；
 * 2. 计数来自真实动作（召唤 / 签到），不是客户端自报；
 * 3. 领取走服务端：发奖到账、重复领取被拒（换一个 actionId 也领不到第二次）；
 * 4. 奖励**不动圣杯结晶**（不冲击抽卡间隔）；
 * 5. 换设备看到同一份任务进度（服务端权威）。
 */
import { expect, test } from '@playwright/test'
import {
  E2E_API_BASE,
  E2E_PASSWORD,
  cachedSaveOf,
  loginViaUi,
  registerAccount,
  seedApiBase,
  seedSession,
  skipGachaReveal,
  uniqueUsername,
} from './helpers.ts'

/** 直接调后端接口发一个动作（绕过界面，验服务端判定） */
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
  return (await res.json()) as Record<string, unknown>
}

/** 拉服务端存档（权威版本） */
async function pullSave(accessToken: string): Promise<any> {
  const res = await fetch(`${E2E_API_BASE}/api/save`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return null
  const body = (await res.json()) as { payload: string }
  return JSON.parse(body.payload)
}

/** 换一对新令牌（拿 access token） */
async function accessTokenOf(refreshToken: string): Promise<string> {
  const res = await fetch(`${E2E_API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  const body = (await res.json()) as { accessToken: string }
  return body.accessToken
}

test.describe('每日任务与周目标', () => {
  test('任务页列出每日任务与周目标', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('daily'))
    await seedSession(page, session)
    await page.goto('/#/daily')
    await page.waitForLoadState('networkidle')

    // 每日任务 4 条 + 周目标 3 条（条目由 core 的任务表驱动）
    await expect(page.getByTestId('task-d_battle')).toBeVisible()
    await expect(page.getByTestId('task-d_pull')).toBeVisible()
    await expect(page.getByTestId('task-d_relic')).toBeVisible()
    await expect(page.getByTestId('task-d_signin')).toBeVisible()
    await expect(page.getByTestId('task-w_battle')).toBeVisible()
    await expect(page.getByTestId('task-w_pull')).toBeVisible()
    await expect(page.getByTestId('task-w_relic')).toBeVisible()

    // 目标数与奖励写在页面上（玩家看得见「还差多少、给什么」）
    await expect(page.getByTestId('task-d_battle')).toContainText('推征 30 场')
    await expect(page.getByTestId('task-d_battle')).toContainText('0 / 30')
  })

  test('「前往」真的把玩家带到对应玩法', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('daily'))
    await seedSession(page, session)

    // ⚠ 先抽一次：新账号**没有英灵**时进 /expedition 会被首启引导接管
    //   （router 守卫：无英灵 + 从主入口落地 → 进 /guide）。
    await page.goto('/#/gacha')
    await page.waitForLoadState('networkidle')
    await page.locator('button', { hasText: '十连' }).first().click()
    await skipGachaReveal(page)
    await page.getByRole('button', { name: '收下' }).click()

    await page.goto('/#/daily')
    await page.waitForLoadState('networkidle')

    await page.getByTestId('task-go-d_battle').click()
    await expect(page).toHaveURL(/#\/expedition/)
    await page.goto('/#/daily')
    await page.getByTestId('task-go-d_pull').click()
    await expect(page).toHaveURL(/#\/gacha/)
    await page.goto('/#/daily')
    await page.getByTestId('task-go-d_relic').click()
    await expect(page).toHaveURL(/#\/forge/)
  })

  test('签到达成任务 → 领取 → 经验书到账，圣杯结晶不动', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('daily'))
    await seedSession(page, session)
    await page.goto('/#/daily')
    await page.waitForLoadState('networkidle')

    // 签到前：任务未完成
    await expect(page.getByTestId('task-d_signin')).toContainText('0 / 1')
    await expect(page.getByTestId('task-claim-d_signin')).toBeDisabled()

    await page.getByRole('button', { name: '领取今日奖励' }).click()
    await expect(page.getByTestId('task-d_signin')).toContainText('1 / 1')
    await expect(page.getByTestId('task-claim-d_signin')).toBeEnabled()

    const before = await cachedSaveOf(page, session.user.id)
    await page.getByTestId('task-claim-d_signin').click()
    await expect(page.getByTestId('task-claim-d_signin')).toHaveText('已领取')

    const after = await cachedSaveOf(page, session.user.id)
    // ⚠ 任务奖励口径（资源/背包版本 v10）：只发**通用经验书**，
    //   术式结晶 / 遗物强化石已退役，副本材料与竞技资源也不在任务奖励里。
    expect(after?.items?.expBookSmall).toBe((before?.items?.expBookSmall ?? 0) + 1)
    // 任务奖励**不含**圣杯结晶：抽卡间隔不受影响
    expect(after?.player?.crystals).toBe(before?.player?.crystals)
  })

  test('召唤推进「完成召唤」任务', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('daily'))
    await seedSession(page, session)
    await page.goto('/#/gacha')
    await page.waitForLoadState('networkidle')

    await page.locator('button', { hasText: '十连' }).first().click()
    await skipGachaReveal(page)
    await page.getByRole('button', { name: '收下' }).click()

    await page.goto('/#/daily')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('task-d_pull')).toContainText('10 / 1')
    await expect(page.getByTestId('task-claim-d_pull')).toBeEnabled()
  })

  test('同一个任务领不到第二次（换一个 actionId 也一样）', async () => {
    const session = await registerAccount(uniqueUsername('daily'))
    const accessToken = await accessTokenOf(session.refreshToken)
    await postAction(accessToken, 'e-create', { type: 'save.create' })
    const pulled = await postAction(accessToken, 'e-pull', { type: 'gacha.pull', poolId: 'standard', count: 1 })
    expect(pulled.ok).toBe(true)

    const first = await postAction(accessToken, 'e-claim-1', { type: 'daily.claimTask', taskId: 'd_pull' })
    expect(first.ok).toBe(true)

    const saveAfterFirst = await pullSave(accessToken)
    const booksAfterFirst = saveAfterFirst.items.expBookSmall

    // 新 actionId 再领一次 → 服务端拒绝（先校验后修改，资源不变）
    const second = await postAction(accessToken, 'e-claim-2', { type: 'daily.claimTask', taskId: 'd_pull' })
    expect(second.ok).toBe(false)
    expect(second.code).toBe('TASK_ALREADY_CLAIMED')

    const saveAfterSecond = await pullSave(accessToken)
    expect(saveAfterSecond.items.expBookSmall).toBe(booksAfterFirst)
  })

  test('任务没完成时领不到（服务端拒绝，资源不变）', async () => {
    const session = await registerAccount(uniqueUsername('daily'))
    const accessToken = await accessTokenOf(session.refreshToken)
    await postAction(accessToken, 'e-create', { type: 'save.create' })

    const res = await postAction(accessToken, 'e-claim', { type: 'daily.claimTask', taskId: 'd_battle' })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('TASK_NOT_COMPLETED')
  })

  test('换设备看到同一份任务进度（服务端权威）', async ({ browser }) => {
    const username = uniqueUsername('daily')
    const session = await registerAccount(username, E2E_PASSWORD)

    // 设备 A：抽一次 → 「完成召唤」进度 +1
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    await seedSession(pageA, session)
    await pageA.goto('/#/gacha')
    await pageA.waitForLoadState('networkidle')
    await pageA.locator('button', { hasText: '十连' }).first().click()
    await skipGachaReveal(pageA)
    await pageA.getByRole('button', { name: '收下' }).click()

    // 设备 B：同一账号，全新上下文（没有任何本地存档）
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    await seedApiBase(pageB)
    await loginViaUi(pageB, username, E2E_PASSWORD)
    await pageB.waitForURL(/#\/(expedition|guide)/)
    await pageB.goto('/#/daily')
    await pageB.waitForLoadState('networkidle')
    await expect(pageB.getByTestId('task-d_pull')).toContainText('10 / 1')

    await contextA.close()
    await contextB.close()
  })
})
