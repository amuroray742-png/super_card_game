import { test, expect, type Page } from '@playwright/test'
import type { BattleResult } from '../../src/core/model/types.ts'
import { FIRST_CLEAR_CRYSTALS } from '../../src/core/config/economy.ts'
import { getStage } from '../../src/core/config/stages.ts'
import { EXP_BOOK } from '../../src/core/config/economy.ts'
import {
  cachedSaveOf,
  giveTeam,
  importFixture,
  waitForAction,
} from './helpers'

/**
 * 战斗端到端用例（§6.3「数值型轻演出」 + **挂机改版 v11 的手动挑战**）。
 *
 * ## 两条主线
 *
 * 1. **战斗演出**：关卡详情**弹窗**（深链 `/stage/:id` 保留）里的「战斗预览」
 *    走同一套 Canvas 回放——画布按 DPR 渲染、演出随时间推进、跳过出战后结算、
 *    文字战报与画面同源。
 * 2. **手动挑战**（v11 新增）：主线推进改为**纯手动挑战** `campaign.challenge`，
 *    战斗在**服务端**执行，回放由响应的 `replay` 字段一次性带回。
 *
 * ⚠ 用例只断言**结构与交互存在**，不依赖具体数值：
 *   战斗胜负、伤害数字都随养成变化，断言它们会让 E2E 变成数值测试。
 *   真正要守住的是「画布真的在按时间轴演出」「结算面板真的出得来」
 *   与「首胜的三种奖励真的到账」。
 */

/** 一支能稳赢第 1 章的队伍（Lv60 → 战力远高于第 1 关门槛） */
const STRONG_TEAM = ['hanxin', 'luban', 'zhugeliang', 'libai', 'xiangyu', 'chengjisihan'] as const

/**
 * **演出**用的队伍（Lv1）。
 *
 * ⚠ 演出用例要的是「一场打得有来有回的战斗」——Lv60 满编打第 1 关是**秒杀**
 *   （实测 1 回合结束），演出根本推进不到第 2 回合。
 *   Lv1 满编打第 1 关实测 4 回合，足够验证「演出随时间推进」。
 */
const PREVIEW_TEAM = STRONG_TEAM

interface CanvasProbe {
  /** 画布 backing store 宽度（设备像素） */
  width: number
  /** 画布 CSS 宽度 */
  clientWidth: number
  height: number
  clientHeight: number
  /** 2D 变换矩阵的缩放分量——必须是 DPR，否则高分屏整场戏挤在角落 */
  scale: number
  /** 画布里不透明像素占比（画过东西就不是空白） */
  paintedRatio: number
}

/** 读取画布的渲染状态 */
async function probeCanvas(page: Page): Promise<CanvasProbe> {
  return page.evaluate(() => {
    const el = document.querySelector('canvas.battle-canvas') as HTMLCanvasElement | null
    if (!el) throw new Error('找不到战斗画布')
    const c = el.getContext('2d')
    if (!c) throw new Error('取不到 2D 上下文')
    const t = c.getTransform()
    const data = c.getImageData(0, 0, el.width, el.height).data
    let painted = 0
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) painted++
    }
    return {
      width: el.width,
      clientWidth: el.clientWidth,
      height: el.height,
      clientHeight: el.clientHeight,
      scale: t.a,
      paintedRatio: painted / (el.width * el.height),
    }
  })
}

/** 打开关卡详情弹窗（深链 `/stage/:id`，v11 保留的外部依赖） */
async function openStageDetail(page: Page, stageId: number): Promise<void> {
  await page.goto(`/#/stage/${stageId}`)
  await page.waitForLoadState('networkidle')
  // ⚠ SPA 走 hash 路由：同文档导航不会重载，必须等组件**渲染出来**再断言
  await expect(page.getByTestId('stage-detail-modal')).toBeVisible()
}

test.describe('战斗演出（关卡详情弹窗 · §6.3 数值型轻演出）', () => {
  test('关卡详情深链可用：画布按 DPR 渲染，演出推进，跳过后出战后结算', async ({ page }) => {
    await importFixture(page, 'btl', (save) => {
      giveTeam(save, PREVIEW_TEAM, 1)
    })

    await openStageDetail(page, 1)

    // 弹窗里能看到关卡概要与掉落预览（规则写在玩家眼前）
    await expect(page.getByTestId('stage-detail-modal')).toContainText(getStage(1).name)

    // 战斗预览出画布
    await page.getByRole('button', { name: '战斗预览', exact: true }).click()

    const canvas = page.locator('canvas.battle-canvas')
    await expect(canvas).toBeVisible()
    await expect(page.getByText('战斗预览').first()).toBeVisible()

    // 高分屏必须按 DPR 建缓冲并设置变换矩阵（铁律 #17）
    const probe = await probeCanvas(page)
    const dpr = Math.min(2, await page.evaluate(() => window.devicePixelRatio || 1))
    expect(probe.scale).toBeGreaterThan(0)
    expect(Math.abs(probe.scale - dpr)).toBeLessThan(0.01)
    expect(probe.width).toBe(Math.floor(probe.clientWidth * dpr))
    expect(probe.height).toBe(Math.floor(probe.clientHeight * dpr))
    // 画布不能是空白
    expect(probe.paintedRatio).toBeGreaterThan(0.9)

    // 画面上确实有人（我方 6 人 + 敌方若干）
    const visible = await canvas.getAttribute('data-visible-units')
    expect(Number(visible)).toBeGreaterThanOrEqual(3)

    // 演出在推进：回合数会往前走
    await expect(canvas).toHaveAttribute('data-round', /[1-9]\d*/)
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-round')), { timeout: 15_000 })
      .toBeGreaterThan(1)

    // 控制条齐全
    await expect(page.getByRole('button', { name: '重播', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '跳过', exact: true })).toBeVisible()
    for (const s of [1, 2, 4, 8]) {
      await expect(page.getByRole('button', { name: `×${s}`, exact: true })).toBeVisible()
    }

    // 重播：时间轴回到开头（纯函数模型的直接体现）
    await page.getByRole('button', { name: '重播', exact: true }).click()
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-progress')), { timeout: 5_000 })
      .toBeLessThan(0.3)

    // 跳过 → 战后结算面板
    await page.getByRole('button', { name: '跳过', exact: true }).click()
    const panel = page.locator('.result-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('战后结算')
    await expect(panel).toContainText('回合数')
    await expect(panel).toContainText('存活')
    await expect(panel).toContainText('伤害统计')
    await expect(panel).toContainText('掉落')
    // 胜败标签二选一
    await expect(panel.locator('.tag').first()).toHaveText(/胜利|失败/)
  })

  test('推征页的「详情」就地开弹窗，URL 不变', async ({ page }) => {
    await importFixture(page, 'btlmodal', (save) => {
      giveTeam(save, PREVIEW_TEAM, 1)
    })
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    const urlBefore = page.url()

    await page.getByTestId('stage-detail-open').click()
    await expect(page.getByTestId('stage-detail-modal')).toBeVisible()
    // v11 的关卡详情是**弹窗**（推征页不切页）
    expect(page.url()).toBe(urlBefore)

    await page.getByTestId('stage-detail-close').click()
    await expect(page.getByTestId('stage-detail-modal')).toHaveCount(0)
  })

  test('设置页开启「跳过演出」后，战斗预览直接出战后结算', async ({ page }) => {
    await importFixture(page, 'btlskip', (save) => {
      giveTeam(save, PREVIEW_TEAM, 1)
    })

    // 设置页打开「跳过演出」
    await page.goto('/#/settings')
    await page.waitForLoadState('networkidle')
    const row = page.locator('.setting-row').filter({ hasText: '跳过演出' })
    await expect(row).toBeVisible()
    await row.locator('button.switch').click()
    await expect(row.locator('button.switch')).toHaveClass(/on/)

    // 战斗预览：不播演出，直接出结算
    await openStageDetail(page, 1)
    await page.getByRole('button', { name: '战斗预览', exact: true }).click()

    await expect(page.locator('.result-panel')).toBeVisible()
    await expect(page.locator('.result-panel')).toContainText('战后结算')
    // 时间轴被推到末尾
    await expect(page.locator('canvas.battle-canvas')).toHaveAttribute('data-progress', '1.0000')
  })

  test('倍速切换会写回存档（跨页面保持）', async ({ page }) => {
    const { accountId } = await importFixture(page, 'btlspeed', (save) => {
      giveTeam(save, PREVIEW_TEAM, 1)
    })

    await openStageDetail(page, 1)
    await page.getByRole('button', { name: '战斗预览', exact: true }).click()
    await expect(page.locator('canvas.battle-canvas')).toBeVisible()

    await page.getByRole('button', { name: '×4', exact: true }).click()
    await expect(page.locator('canvas.battle-canvas')).toHaveAttribute('data-speed', '4')

    // 写进了本地存档槽位（每账号一个槽位）
    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.settings?.speed, { timeout: 8000 })
      .toBe(4)
  })

  test('未编队时点战斗预览会提示，不出画布', async ({ page }) => {
    await importFixture(page, 'btlnoteam', (save) => {
      // 只给英灵、不编队
      giveTeam(save, [], 1)
    })

    await openStageDetail(page, 1)
    await page.getByRole('button', { name: '战斗预览', exact: true }).click()

    await expect(page.getByText('请先在阵位中编队')).toBeVisible()
    await expect(page.locator('canvas.battle-canvas')).toHaveCount(0)
  })

  test('文字战报是可滚动列表，随演出增长，跳过后给出完整战报', async ({ page }) => {
    await importFixture(page, 'btllog', (save) => {
      giveTeam(save, PREVIEW_TEAM, 1)
    })

    await openStageDetail(page, 1)
    await page.getByRole('button', { name: '战斗预览', exact: true }).click()

    const panel = page.locator('[data-testid="battle-log"]')
    const list = page.locator('[data-testid="battle-log-list"]')
    await expect(panel).toBeVisible()
    await expect(list).toBeVisible()

    // 开局条目很少：战报随演出推进才铺开（不是事后一次性铺满）
    // ⚠ 不用「恰好 0 条」：断言与页面之间隔着几次往返，
    //   机器一忙就可能已经推进到第 1 个条目（那是正常的演出节奏，不是 bug）。
    const startCount = await list.locator('.log-line').count()
    expect(startCount).toBeLessThan(5)

    // 演出推进 → 条目逐渐出现（与画面同源）
    await expect
      .poll(async () => list.locator('.log-line').count(), { timeout: 15_000 })
      .toBeGreaterThan(startCount)

    // 跳到结束 → 完整战报都在列表里
    await page.getByRole('button', { name: '跳过', exact: true }).click()
    await expect
      .poll(async () => list.locator('.log-line').count(), { timeout: 10_000 })
      .toBeGreaterThan(5)

    // 战报文字取自 core：条目内容是中文句子，不是内部 id
    const firstLine = await list.locator('.log-line').first().innerText()
    expect(firstLine.length).toBeGreaterThan(2)
    expect(firstLine).not.toContain('#')

    // 内容超出可视高度时列表可滚动，且自动跟底
    const { scrollHeight, clientHeight, scrollTop } = await list.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }))
    expect(scrollHeight).toBeGreaterThanOrEqual(clientHeight)
    if (scrollHeight > clientHeight + 4) {
      // 自动跟底：播放中列表贴着底部
      expect(scrollHeight - scrollTop - clientHeight).toBeLessThanOrEqual(32)
      // 手动上滚后能停住，并出现「回到最新」按钮
      await list.evaluate((el) => {
        el.scrollTop = 0
      })
      await expect(page.locator('[data-testid="log-latest"]')).toBeVisible()
      await page.locator('[data-testid="log-latest"]').click()
      await expect
        .poll(async () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
        .toBeLessThanOrEqual(32)
    }

    // 折叠 / 展开
    await page.locator('.log-title').click()
    await expect(list).toBeHidden()
    await page.locator('.log-title').click()
    await expect(list).toBeVisible()
  })
})

/**
 * 手动挑战主线关卡（挂机改版 v11）。
 *
 * ⚠ **主线推进改为纯手动挑战**：挂机不再自动推进关卡，
 *   唯一的推进路径是 `campaign.challenge`（服务端执行真实战斗）。
 */
test.describe('手动挑战主线关卡（挂机改版 v11）', () => {
  test('挑战胜利：推进 clearedStage，首胜发奖（经验书 + 银两 + 圣杯结晶）', async ({ page }) => {
    const { accountId } = await importFixture(page, 'btlwin', (save) => {
      giveTeam(save, STRONG_TEAM, 60)
    })

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('campaign-challenge')).toBeVisible()

    const body = await waitForAction(page, 'campaign.challenge', {
      trigger: async () => {
        await page.getByTestId('campaign-challenge').click()
      },
    })
    const result = body.result as unknown as {
      stageId: number
      win: boolean
      firstClear: boolean
      rewards: { silver?: number; crystals?: number; items?: Record<string, number> }
    }

    expect(result.stageId).toBe(1)
    expect(result.win).toBe(true)
    expect(result.firstClear).toBe(true)
    // 首通三项奖励全部到账（数量读配置，不写死）
    expect(result.rewards.crystals).toBe(FIRST_CLEAR_CRYSTALS.normal)
    expect(result.rewards.silver ?? 0).toBeGreaterThan(0)
    // 首通保底：至少一本经验书
    expect(result.rewards.items?.[EXP_BOOK.small.id] ?? 0).toBeGreaterThan(0)

    // 主线进度被推进（**只有手动挑战**能推进）
    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.campaign?.clearedStage, { timeout: 10_000 })
      .toBe(1)
    // ⚠ **推征页一屏化 v13**：关卡网格下沉到二级页 `/stages` ⇒ 推征页不再有
    //   「已通关 N 关」那行字；**主卡必须立刻指向新的下一关**（这是同一件事的
    //   新落点：界面要跟着通关进度走）。
    await expect(page.getByTestId('stage-detail-open')).toContainText(getStage(2).name)
  })

  test('战斗回放由服务端的 replay 字段带回（不进幂等日志）', async ({ page }) => {
    await importFixture(page, 'btlreplay', (save) => {
      giveTeam(save, STRONG_TEAM, 60)
    })

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    const body = await waitForAction(page, 'campaign.challenge', {
      trigger: async () => {
        await page.getByTestId('campaign-challenge').click()
      },
    })

    // 回放在**响应的 replay 字段**（一次性回传，不写进 24 小时幂等日志）
    const replay = body.replay as BattleResult | undefined
    expect(replay, '服务端必须把战斗回放放在响应的 replay 字段').toBeTruthy()
    expect(replay!.win).toBe(true)
    expect(replay!.rounds).toBeGreaterThan(0)
    expect(replay!.log.length).toBeGreaterThan(0)
    // 名册里我方与敌方都要在（渲染器靠它画血条）
    expect(replay!.roster.some((u) => u.side === 'ally')).toBe(true)
    expect(replay!.roster.some((u) => u.side === 'enemy')).toBe(true)

    // 轻量结果里**不含** battle（服务端已摘走）
    const light = body.result as unknown as Record<string, unknown>
    expect(light.battle).toBeUndefined()
  })

  /**
   * **战斗回放真的演出来了**（表现层可达性守护）。
   *
   * ⚠ 曾经的缺口：服务端把回放放在响应的 `replay` 字段（一次性回传），
   *   客户端 `runAction` 只取 `result` ⇒ `res.battle` 恒为 `undefined`
   *   ⇒ `store.lastBattle` **永远没有消费方** ⇒ 玩家点完「挑战此关」只看到一条 toast，
   *   战斗根本没演（设计稿 §3.8.2「回放沿用已有的跳过演出设置」形同虚设）。
   *
   * 这条用例守的是「**看得见**」：面板出现 → 画布上真的有人 → 跳过演出后出战后结算与实发奖励。
   */
  test('挑战后播放战斗回放，出战后结算与实发奖励', async ({ page }) => {
    await importFixture(page, 'btlshow', (save) => {
      giveTeam(save, STRONG_TEAM, 60)
    })

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    await waitForAction(page, 'campaign.challenge', {
      trigger: async () => {
        await page.getByTestId('campaign-challenge').click()
      },
    })

    // ① 回放面板出现（服务端执行 → 响应的一次性 replay → 表现层演出）
    const panel = page.getByTestId('challenge-replay')
    await expect(panel).toBeVisible({ timeout: 10_000 })

    // ② 画布上真的有人（不是一张空画布）
    const canvas = panel.locator('canvas.battle-canvas')
    await expect(canvas).toBeVisible()
    await expect(canvas).toHaveAttribute('data-visible-units', /[1-9]/)

    // ③ 跳过演出 → 战后结算 + 实发奖励
    await panel.getByTestId('battle-skip').click()
    await expect(panel.locator('.result-panel')).toBeVisible()
    await expect(panel).toContainText('本次获得')
  })

  test('战败：win=false、不发奖、不推进进度', async ({ page }) => {    const { accountId } = await importFixture(page, 'btllose', (save) => {
      // 一级小队打第 1 关 → 必败
      giveTeam(save, ['libai'], 1)
    })

    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')

    const body = await waitForAction(page, 'campaign.challenge', {
      trigger: async () => {
        await page.getByTestId('campaign-challenge').click()
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

    // 进度不动
    await expect
      .poll(async () => (await cachedSaveOf(page, accountId))?.campaign?.clearedStage, { timeout: 8000 })
      .toBe(0)
    // 界面给出失败提示
    await expect(page.locator('.toast')).toContainText('挑战失败', { timeout: 8000 })
  })
})
