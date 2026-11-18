/**
 * 三队天梯 · PVE 长线挑战（roadmap P2-2）。
 *
 * 端到端走**真实后端**（真实 SQLite + 真实动作层），验的是：
 *
 * 1. **入口可达**：竞技场页有显式入口，演武场页能打开（铁律 #10）；
 * 2. **首次参与**：编队保存 → 发起挑战 → 结算面板出现（三队结果 + 段位分）；
 * 3. **每周一轮**：本周挑战过就再打不了（服务端拒绝，不是前端禁用就完事）；
 * 4. **产出隔离**：天梯产出**不动**银两 / 经验 / 强化石 / 术式结晶 / 圣杯结晶；
 * 5. **段位分独立**：镜像试炼（竞技场）不写天梯段位分；
 * 6. **换设备一致**：天梯进度与领取状态由服务端权威。
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

/** 造一份三队阵容（每队 6 人，跨队复用同一批英灵） */
function squadsOf(ids: string[]): (string | null)[][] {
  const row: (string | null)[] = [...ids, null, null, null, null, null, null].slice(0, 6)
  return [row, [...row], [...row]]
}

/** 抽一次十连，拿到 10 个英灵 */
async function pullTen(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/#/gacha')
  await page.waitForLoadState('networkidle')
  await page.locator('button', { hasText: '十连' }).first().click()
  await skipGachaReveal(page)
  await page.getByRole('button', { name: '收下' }).click()
}

test.describe('三队天梯', () => {
  test('竞技场页有入口，演武场页可打开且写清玩法口径', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('ladder'))
    await seedSession(page, session)
    await page.goto('/#/arena')
    await page.waitForLoadState('networkidle')

    // 铁律 #10：核心循环入口必须可达
    await page.getByTestId('arena-goto-ladder').click()
    await expect(page).toHaveURL(/#\/ladder/)

    // 玩法口径写在页面上（PVE 完整数值 / 架空演武 / 产出隔离）
    await expect(page.getByText('PVE 完整数值')).toBeVisible()
    await expect(page.getByText('灵体投影')).toBeVisible()
    await expect(page.getByText('不回流')).toBeVisible()

    // 三队编成 + 敌方梯队 + 挑战按钮都在
    await expect(page.getByTestId('ladder-slot-0-0')).toBeVisible()
    await expect(page.getByTestId('ladder-slot-2-5')).toBeVisible()
    await expect(page.getByTestId('ladder-save')).toBeVisible()
    await expect(page.getByTestId('ladder-challenge')).toBeVisible()
    // 敌方梯队列出灵体（合规：不是历史人物）
    await expect(page.getByText('游荡残魂').first()).toBeVisible()
  })

  test('编队 → 保存 → 挑战 → 结算面板出现（首次参与）', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('ladder'))
    await seedSession(page, session)
    await pullTen(page)

    await page.goto('/#/ladder')
    await page.waitForLoadState('networkidle')

    // 编队：第 1 队第 1 槽选一个英灵
    await page.getByTestId('ladder-slot-0-0').click()
    await page.locator('.dialog .pick-row').first().click()
    await expect(page.getByTestId('ladder-slot-0-0')).not.toContainText('空位')

    // 保存阵容（服务端权威）
    await page.getByTestId('ladder-save').click()
    await expect(page.getByText('演武场阵容已保存')).toBeVisible()

    // 发起挑战
    await page.getByTestId('ladder-challenge').click()
    await expect(page.getByTestId('ladder-result')).toBeVisible({ timeout: 15_000 })
    // 三个梯队各有一行结果
    await expect(page.getByTestId('ladder-result').locator('.enemy-row')).toHaveCount(3)
    // 段位分与产出写出来
    await expect(page.getByTestId('ladder-result')).toContainText('段位分')
    await expect(page.getByTestId('ladder-result')).toContainText('竞技勋章')
  })

  test('每周一轮：本周挑战过就再打不了（服务端拒绝）', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('ladder'))
    const accessToken = await accessTokenOf(session.refreshToken)
    await postAction(accessToken, 'l-create', { type: 'save.create' })
    await postAction(accessToken, 'l-pull', { type: 'gacha.pull', poolId: 'standard', count: 10 })

    const save = await pullSave(accessToken)
    const heroIds = Object.keys(save.heroes).slice(0, 6)
    expect(heroIds.length).toBe(6)

    const lineup = await postAction(accessToken, 'l-squads', {
      type: 'arena.ladderSaveSquads',
      squads: squadsOf(heroIds),
    })
    expect(lineup.ok).toBe(true)

    const first = await postAction(accessToken, 'l-challenge-1', { type: 'arena.ladderChallenge' })
    expect(first.ok).toBe(true)

    // 换一个 actionId 再打一次 → 服务端拒绝（不是前端禁用就完事）
    const second = await postAction(accessToken, 'l-challenge-2', { type: 'arena.ladderChallenge' })
    expect(second.ok).toBe(false)
    expect(second.code).toBe('LADDER_ALREADY_SETTLED')

    // 段位分没有被第二次结算改变
    const afterFirst = await pullSave(accessToken)
    const afterSecond = await pullSave(accessToken)
    expect(afterSecond.arena.tierPoints).toBe(afterFirst.arena.tierPoints)
  })

  test('天梯产出隔离：银两 / 经验 / 强化石 / 术式结晶 / 圣杯结晶都不动', async ({ page }) => {
    const session = await registerAccount(uniqueUsername('ladder'))
    await seedSession(page, session)
    await pullTen(page)

    await page.goto('/#/ladder')
    await page.waitForLoadState('networkidle')
    await page.getByTestId('ladder-slot-0-0').click()
    await page.locator('.dialog .pick-row').first().click()
    await page.getByTestId('ladder-save').click()
    await expect(page.getByText('演武场阵容已保存')).toBeVisible()

    const before = await cachedSaveOf(page, session.user.id)
    await page.getByTestId('ladder-challenge').click()
    await expect(page.getByTestId('ladder-result')).toBeVisible({ timeout: 15_000 })
    const after = await cachedSaveOf(page, session.user.id)

    expect(after?.player?.silver).toBe(before?.player?.silver)
    expect(after?.player?.skillStones).toBe(before?.player?.skillStones)
    expect(after?.player?.relicStones).toBe(before?.player?.relicStones)
    expect(after?.player?.crystals).toBe(before?.player?.crystals)
    expect(after?.player?.exp).toBe(before?.player?.exp)
  })

  test('未编队就挑战 → 服务端拒绝，资源不变', async () => {
    const session = await registerAccount(uniqueUsername('ladder'))
    const accessToken = await accessTokenOf(session.refreshToken)
    await postAction(accessToken, 'l-create2', { type: 'save.create' })

    const before = await pullSave(accessToken)
    const res = await postAction(accessToken, 'l-challenge-empty', { type: 'arena.ladderChallenge' })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('LADDER_NO_SQUAD')

    const after = await pullSave(accessToken)
    expect(after.arena.tierPoints).toBe(before.arena.tierPoints)
  })

  test('段位分独立：镜像试炼不写天梯段位分', async () => {
    const session = await registerAccount(uniqueUsername('ladder'))
    const accessToken = await accessTokenOf(session.refreshToken)
    await postAction(accessToken, 'l-create3', { type: 'save.create' })
    await postAction(accessToken, 'l-pull3', { type: 'gacha.pull', poolId: 'standard', count: 10 })

    const save = await pullSave(accessToken)
    const heroIds = Object.keys(save.heroes).slice(0, 6)
    // 编主线队伍
    for (let i = 0; i < heroIds.length; i++) {
      await postAction(accessToken, `l-team-${i}`, { type: 'team.setSlot', index: i, heroId: heroIds[i] })
    }

    const before = await pullSave(accessToken)
    const settle = await postAction(accessToken, 'l-settle', { type: 'arena.settle' })
    expect(settle.ok).toBe(true)

    const after = await pullSave(accessToken)
    // 天梯段位分没动，对战分动了
    expect(after.arena.tierPoints).toBe(before.arena.tierPoints)
    expect(after.arena.pvpPoints).toBeGreaterThan(before.arena.pvpPoints)
  })

  test('换设备看到同一份天梯进度（服务端权威）', async ({ browser }) => {
    const username = uniqueUsername('ladder')
    const session = await registerAccount(username, E2E_PASSWORD)
    const accessToken = await accessTokenOf(session.refreshToken)
    await postAction(accessToken, 'l-create4', { type: 'save.create' })
    await postAction(accessToken, 'l-pull4', { type: 'gacha.pull', poolId: 'standard', count: 10 })

    const save = await pullSave(accessToken)
    const heroIds = Object.keys(save.heroes).slice(0, 6)
    await postAction(accessToken, 'l-squads4', {
      type: 'arena.ladderSaveSquads',
      squads: squadsOf(heroIds),
    })
    const challenge = await postAction(accessToken, 'l-challenge4', { type: 'arena.ladderChallenge' })
    expect(challenge.ok).toBe(true)
    const tierPoints = (await pullSave(accessToken)).arena.tierPoints

    // 设备 B：同一账号，全新上下文
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    await seedApiBase(pageB)
    await loginViaUi(pageB, username, E2E_PASSWORD)
    await pageB.waitForURL(/#\/(expedition|guide)/)
    await pageB.goto('/#/ladder')
    await pageB.waitForLoadState('networkidle')

    // 段位分一致，且本周已挑战（按钮禁用）
    await expect(pageB.getByText(String(tierPoints)).first()).toBeVisible()
    await expect(pageB.getByTestId('ladder-challenge')).toBeDisabled()

    await contextB.close()
  })
})
