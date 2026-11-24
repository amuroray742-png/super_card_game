import { test, expect, type Page } from '@playwright/test'
import { dismissOfflineReport, giveTeam, importFixture, uniqueUsername } from './helpers'

/**
 * **挂机通道的「全部领取（N 次）」**（回归用例）。
 *
 * ## 这次修的是什么
 *
 * 推征页的「全部领取（N 次）」原来读的是**客户端镜像**里的
 * `save.idle.channels[kind].effectiveMs`。但客户端镜像只在服务端**回包**时刷新，
 * 而服务端**回包前必先结算** ⇒ 镜像里的余额恒是「不足一次」的余数
 * ⇒ **按钮永远显示「0 次」**，而点下去服务端照发（数字自相矛盾）。
 *
 * 现在待结算次数由**心跳回执**带回（服务端账本的真相）。
 *
 * ## 守的语义
 *
 * 1. 挂机一段时间后，按钮上的次数**必须大于 0**（老 bug：恒为 0）。
 * 2. 按钮上的次数**必须等于**通道卡里「可结算 N 次」——同一份数，两处一致。
 * 3. 点「全部领取」后，服务端真的发放了对应次数（不是只有界面在动）。
 * 4. 领完之后按钮归零（不多发、也不挂账）。
 *
 * ⚠ 前置用**玩家可用的 `save.import` 动作**导入（铁律 #11）：
 *   已通关到第 5 关 ⇒ 主线通道有目标（跟随模式）⇒ 才有挂机产出。
 *   ⚠ 导入**不能**伪造副本通关（服务端会清空 `dungeons.cleared`），
 *     所以这里只测**主线**通道。
 */
test.setTimeout(180_000)

/** 一支能打的队伍（等级只影响能否打赢，挂机产出不依赖战斗） */
const TEAM = ['hanxin', 'luban', 'zhugeliang', 'libai', 'xiangyu', 'chengjisihan'] as const

/** 从按钮文案里解析出次数：「全部领取（12 次）」→ 12 */
async function claimCountOf(page: Page): Promise<number> {
  const text = (await page.getByTestId('idle-claim-all').innerText()).trim()
  const matched = /(\d+)\s*次/.exec(text)
  return matched ? Number(matched[1]) : -1
}

/** 通道卡里「可结算 N 次」里的 N */
async function channelCountOf(page: Page, kind: 'main' | 'skill' | 'enhance'): Promise<number> {
  const text = await page.getByTestId(`idle-channel-${kind}`).innerText()
  const matched = /可结算\s*(\d+)\s*次/.exec(text)
  return matched ? Number(matched[1]) : -1
}

test.describe('挂机通道：全部领取的次数显示', () => {
  test('按钮显示的次数与通道卡一致，且点击后服务端真的发放', async ({ page }) => {
    // 前置：已通关第 5 关 ⇒ 主线通道跟随模式有目标
    await importFixture(page, 'idlepend', (save) => {
      giveTeam(save, TEAM, 60)
      save.campaign.clearedStage = 5
    })

    await page.goto('/#/expedition')
    await expect(page.getByTestId('idle-claim-all')).toBeVisible()
    await dismissOfflineReport(page)

    // ① 挂一会儿（心跳每 5 秒一次，在线时长按 3 倍倍率计量），
    //    按钮上的次数**必须变成非 0** —— 老 bug 是恒为 0。
    await expect
      .poll(() => claimCountOf(page), { timeout: 60_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(0)

    // ② 按钮上的次数与通道卡「可结算 N 次」是**同一份数**
    const shown = await claimCountOf(page)
    expect(await channelCountOf(page, 'main')).toBe(shown)

    // ③ 点「全部领取」→ 服务端真的发放了对应次数（回包为准，不看界面自说自话）
    const [response] = await Promise.all([
      page.waitForResponse((r) => {
        if (r.request().method() !== 'POST') return false
        if (new URL(r.url()).pathname !== '/api/action') return false
        const body = r.request().postDataJSON() as { action?: { type?: string } } | null
        return body?.action?.type === 'idle.tick'
      }),
      page.getByTestId('idle-claim-all').click(),
    ])
    expect(response.ok()).toBe(true)
    const result = (await response.json()) as {
      result?: { rolls?: number; channels?: { channel: string; rolls: number }[] }
    }
    expect(result.result?.rolls ?? 0).toBeGreaterThan(0)
    // 领取的确实是主线通道的产出
    expect(result.result?.channels?.find((c) => c.channel === 'main')?.rolls ?? 0).toBeGreaterThan(0)

    // ④ 领完之后按钮归零（不多发、也不挂账）
    await expect
      .poll(() => claimCountOf(page), { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBe(0)
  })

  test('未通关时主线通道没有目标，按钮显示 0 次', async ({ page }) => {
    // 新号：主线通道跟随模式，但 `clearedStage = 0` ⇒ 没有可挂的关卡
    await importFixture(page, 'idlepend0', (save) => {
      giveTeam(save, TEAM, 60)
      save.campaign.clearedStage = 0
    })
    await page.goto('/#/expedition')
    await expect(page.getByTestId('idle-claim-all')).toBeVisible()
    await dismissOfflineReport(page)
    // 没有目标 ⇒ 永远攒不出次数
    await page.waitForTimeout(12_000)
    expect(await claimCountOf(page)).toBe(0)
  })
})
