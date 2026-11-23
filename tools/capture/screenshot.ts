/**
 * 界面截图工具（可复用，替代一次性脚本）。
 *
 * ## 为什么要有这个工具
 *
 * 历史上写过若干一次性 Playwright 截图脚本，其中一个打开了
 * `http://localhost:5173/#/gacha` 并**真的点了一次十连**——那是玩家正在游玩的
 * dev server origin，于是脚本把玩家的存档抽走了（3000 结晶清零、10 位英灵入库）。
 *
 * 根因不是游戏逻辑，而是**工具和玩家共用同一个 origin**：
 * localStorage 按 origin 隔离，`localhost:5173` 的存档对所有访问该 origin 的
 * 上下文都是同一份。
 *
 * 因此本工具内置两条硬约束：
 * 1. **origin 守卫**：禁止对玩家可能正在使用的 origin 截图（默认禁 `localhost:5173`）；
 * 2. **隔离上下文**：每次都用全新的 browser context（空 localStorage），
 *    截图需要存档时自行在隔离环境里造，绝不碰玩家的真实存档。
 *
 * 用法：
 * ```bash
 * # 先起一个隔离的预览服务（端口与玩家正在用的 dev server 不同）
 * npm run build
 * npm run preview -- --port 4188 --host 127.0.0.1
 *
 * npx tsx tools/capture/screenshot.ts --route /gacha --out artifacts/art-preview/gacha.png
 * npx tsx tools/capture/screenshot.ts --route /gacha --pull --out artifacts/art-preview/gacha-result.png
 *
 * # 观战场景（需要一台隔离的后端：注册账号 → 十连 → 编队 → 推征页点「观战」）
 * npx tsx tools/capture/screenshot.ts --battle --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/battle.png
 *
 * # 英灵详情场景（注册账号 → 十连 → 圣殿点开第一个英灵）
 * npx tsx tools/capture/screenshot.ts --hero --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/hero.png
 *
 * # 抽卡券场景（注册账号 → 十连扣光结晶 → 召唤页看十连改用抽卡券）
 * npx tsx tools/capture/screenshot.ts --gacha-ticket --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/gacha-ticket.png
 *
 * # 抽卡演出场景（注册账号 → 十连 → 抓「逐张翻牌」「SSR 全屏爆点」「爆点停住等点击」三帧）
 * npx tsx tools/capture/screenshot.ts --gacha-reveal --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/gacha-reveal.png
 *
 * # 遗物场景（注册账号 → 十连 → 编队 → 推征产遗物 → 铸造页 + 英灵页）
 * npx tsx tools/capture/screenshot.ts --relic --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/relic.png
 *
 * # 背包场景（导入前置 → 背包 5 分类 + 五行筛选 + 材料→副本直达 + 副本页）
 * npx tsx tools/capture/screenshot.ts --backpack --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/backpack.png
 *
 * # 每日任务场景（注册账号 → 十连 → 每日页：签到 / 每日任务 / 周目标）
 * npx tsx tools/capture/screenshot.ts --daily --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/daily.png
 *
 * # 演武场场景（注册账号 → 十连 → 演武场页：三队编成 / 敌方梯队 / 挑战）
 * npx tsx tools/capture/screenshot.ts --ladder --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/ladder.png
 *
 * npx tsx tools/capture/screenshot.ts --dungeon-challenge --api http://127.0.0.1:8791 \
 *   --url http://127.0.0.1:4188 --out artifacts/art-preview/dungeon.png
 *
 * # 浏览器兼容性测量（Safari 引擎 / 微信 UA / 低端 Android + 4G 首屏）
 * npx tsx tools/capture/screenshot.ts --compat --route /login \
 *   --url http://127.0.0.1:4188 --compat-out artifacts/baselines/browser-compat.json
 * ```
 */
import { chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertSafeOrigin, ISOLATED_PREVIEW_URL } from './origin-guard.ts'
import { buildRelicFixture, buildBackpackFixture, importRelicFixture } from './relic-fixture.ts'
import { buildDungeonFixture, importDungeonFixture } from './dungeon-fixture.ts'
import { dungeonStageId, dungeonStagesOf } from '../../src/core/config/dungeons.ts'

/** 隔离预览服务默认端口（与 dev server 刻意不同） */
const DEFAULT_URL = ISOLATED_PREVIEW_URL

interface Options {
  url: string
  route: string
  out: string
  pull: boolean
  battle: boolean
  /** 英灵详情场景（登录 → 十连 → 圣殿点开第一个英灵） */
  hero: boolean
  /** 抽卡券场景：召唤页「结晶耗尽 → 十连改用抽卡券」 */
  gachaTicket: boolean
  /** 抽卡演出场景：抓「逐张翻牌」与「SSR 全屏爆点」两帧 */
  gachaReveal: boolean
  /** 遗物场景：登录 → 十连 → 编队 → 推征产遗物 → 铸造页 + 英灵页 */
  relic: boolean
  /** 背包场景：导入前置 → 背包 5 分类 + 五行筛选 + 材料→副本直达 + 副本页 */
  backpack: boolean
  /** 每日任务场景：登录 → 十连 → 每日页（签到 / 每日任务 / 周目标） */
  daily: boolean
  /** 演武场场景：登录 → 十连 → 演武场页（三队编成 / 敌方梯队 / 挑战） */
  ladder: boolean
  /** 副本挑战场景：登录 → 十连 → 副本页（24 关列表 / 挑战 / 设为挂机通道） */
  dungeonChallenge: boolean
  /** 浏览器兼容性测量模式（Safari 引擎 / 微信 UA / 低端 Android + 4G 首屏） */
  compat: boolean
  /** 兼容性报告的输出路径（JSON） */
  compatOut: string
  /** 隔离后端地址（观战场景要注册账号） */
  api: string
  /** 视口尺寸（`宽x高`）；不填用默认的手机尺寸 */
  viewport: string
  /** 指定关卡 id（走关卡详情页的「战斗预览」；不填则走推征页的「观战」） */
  stage: string
  fullPage: boolean
  /** 截图前把内部滚动容器滚到底（长页面用；容器是 .body，不是整页） */
  scrollBottom: boolean
  waitMs: number
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    url: get('--url') ?? DEFAULT_URL,
    route: get('--route') ?? '/expedition',
    out: get('--out') ?? 'artifacts/art-preview/screenshot.png',
    pull: argv.includes('--pull'),
    battle: argv.includes('--battle'),
    hero: argv.includes('--hero'),
    gachaTicket: argv.includes('--gacha-ticket'),
    gachaReveal: argv.includes('--gacha-reveal'),
    relic: argv.includes('--relic'),
    backpack: argv.includes('--backpack'),
    daily: argv.includes('--daily'),
    ladder: argv.includes('--ladder'),
    dungeonChallenge: argv.includes('--dungeon-challenge'),
    compat: argv.includes('--compat'),
    compatOut: get('--compat-out') ?? 'artifacts/baselines/browser-compat.json',
    api: get('--api') ?? '',
    viewport: get('--viewport') ?? '',
    stage: get('--stage') ?? '',
    fullPage: argv.includes('--full-page'),
    scrollBottom: argv.includes('--scroll-bottom'),
    waitMs: Number(get('--wait') ?? 1200),
  }
}

/** 默认手机视口（常见机型逻辑宽度附近） */
const DEFAULT_VIEWPORT = { width: 430, height: 932 }

/**
 * 解析 `--viewport 360x800`。
 *
 * ⚠ 为什么要能改视口：顶栏资源条是**按最窄的机型**设计的——
 *   360px（低端 Android）比 430px 少 70px，
 *   「6 项资源能不能全露出来」只在最窄机型上才验得出来。
 */
function parseViewport(raw: string): { width: number; height: number } {
  const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/.exec(raw.trim())
  if (!m) return { ...DEFAULT_VIEWPORT }
  const width = Number(m[1])
  const height = Number(m[2])
  if (width < 240 || height < 200) throw new Error(`视口尺寸不合法：${raw}（形如 360x800）`)
  return { width, height }
}

/** origin 守卫：命中玩家可能正在使用的 origin 直接拒绝执行（实现见 origin-guard.ts） */
export { assertSafeOrigin }

/** 在隔离上下文里造一份存档：十连需要结晶与保底资格 */
async function prepareIsolatedSave(page: Page, pull: boolean): Promise<void> {
  if (!pull) return
  // 打开召唤页 → 首次十连（新手保底会消耗资格并给出 1 位传说英灵）
  await page.goto(`${page.url().split('#')[0]}#/gacha`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const tenBtn = page.locator('button', { hasText: '十连' }).first()
  if ((await tenBtn.count()) > 0) {
    await tenBtn.click()
    await page.waitForTimeout(900)
  }
}

// ─────────────────────────── 观战场景 ───────────────────────────

interface ShotSession {
  accessToken: string
  refreshToken: string
  user: { id: number; username: string }
}

/** 在隔离后端上注册一个临时账号（账号只存在于隔离后端的临时库里） */
async function registerSession(api: string): Promise<ShotSession> {
  const username = `shot_${Math.random().toString(36).slice(2, 10)}`
  const res = await fetch(`${api.replace(/\/$/, '')}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'shot-password-1' }),
  })
  if (res.status !== 201) {
    throw new Error(`注册失败：${res.status} ${await res.text()}`)
  }
  return (await res.json()) as ShotSession
}

/**
 * 注入登录态。
 *
 * 会话与后端地址必须在**导航前**写入（路由守卫靠它们恢复登录态）。
 *
 * @param session 已有会话（截图场景要先用同一个会话导入前置存档时传进来）；
 *                 不传就现注册一个。
 */
async function injectSession(
  context: BrowserContext,
  opts: Options,
  session?: ShotSession,
): Promise<ShotSession> {
  const sess = session ?? await registerSession(opts.api)
  await context.addInitScript(
    ({ apiBase, sess }: { apiBase: string; sess: ShotSession }) => {
      localStorage.setItem('sgw.apiBase', apiBase)
      // ⚠ 只在还没有会话时注入：refresh token 是一次性轮换的，
      //   无条件覆盖会把页面刚轮换出来的新 token 换回最初那个 → 立刻失效。
      if (!localStorage.getItem('sgw.session')) {
        localStorage.setItem('sgw.session', JSON.stringify(sess))
      }
    },
    { apiBase: opts.api.replace(/\/$/, ''), sess },
  )
  return sess
}

/**
 * 准备一个可用的登录态 + 一批英灵（注册 → 注入会话 → 十连）。
 */
async function setupAccount(context: BrowserContext, page: Page, opts: Options): Promise<string> {
  await injectSession(context, opts)

  const base = opts.url.replace(/\/$/, '')
  await page.goto(`${base}/#/gacha`, { waitUntil: 'networkidle' })
  await page.locator('button', { hasText: '十连' }).first().click()
  // ⚠ 抽卡演出会**停在 SSR 爆点等玩家点击**（不会自己演完），
  //   不跳过的话「收下」按钮永远不出现，脚本会一直等到超时。
  const skip = page.getByTestId('gacha-skip')
  await skip.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await skip.isVisible().catch(() => false)) {
    await skip.click({ timeout: 3000 }).catch(() => {})
  }
  await page.getByRole('button', { name: '收下' }).click()
  await page.waitForTimeout(400)
  return base
}

/**
 * 抽卡演出场景：注册 → 召唤页点十连 → 抓「逐张翻牌」与「SSR 全屏爆点」两帧。
 *
 * 新手保底让**首个十连必出 1 位 SSR**，所以这条链路一定有全屏爆点可拍。
 */
async function runGachaRevealScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  await injectSession(context, opts)
  const base = opts.url.replace(/\/$/, '')
  await page.goto(`${base}/#/gacha`, { waitUntil: 'networkidle' })
  await page.getByTestId('pull-ten').click()

  // 演出层出现 = 演出 t=0，从这一刻开始计时
  await page.getByTestId('gacha-reveal').waitFor({ state: 'visible' })
  await page.waitForTimeout(330)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-charge.png') })
  await page.waitForTimeout(450)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-cards.png') })

  // 全屏爆点：SSR 落在第 10 张，等它自己出现
  await page.locator('.burst-card').waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForTimeout(380)
  await page.screenshot({ path: outPath })

  // 停住：爆点动画放完后画面停住等玩家点击，提示「点击任意处继续」
  await page.getByTestId('gacha-hold-hint').waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForTimeout(260)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-hold.png') })

  return ''
}

/**
 * 抽卡券场景：注册 → 首次十连（扣光 3000 结晶）→ 回召唤页。
 *
 * 截图用于验收「结晶耗尽后十连自动改用抽卡券」：
 * 十连按钮的扣费文案应从「结晶 3000」变成「券 10」，资源条显示结晶 0 / 券 10。
 */
async function runGachaTicketScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  const base = await setupAccount(context, page, opts)
  await page.goto(`${base}/#/gacha`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: outPath })
  return ''
}

/**
 * 英灵详情场景：登录 → 十连 → 编队 → 推征攒经验 → 圣殿点开第一个英灵。
 *
 * 详情页要有属性面板与提升预览，截图用于验收养成信息的可读性。
 *
 * ⚠ 为什么要先推征：喂经验的**唯一来源**是玩家经验池，
 *   新号经验池是 0 → 喂经验按钮全禁用、提示「经验不足（0 / 1,000）」，
 *   截出来的图看不到真实可用状态。
 * ⚠ 至少编 3 人：实测 2 人队在第 1 关每轮只打 3 场就卡关，攒不到经验。
 */
async function runHeroScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  const base = await setupAccount(context, page, opts)

  // 编队（满编 6 人，保证推征打得赢）
  await page.goto(`${base}/#/formation`, { waitUntil: 'networkidle' })
  for (const [slotText, index] of [
    ['空位 1', 0],
    ['空位 2', 1],
    ['空位 3', 2],
    ['空位 4', 3],
    ['空位 5', 4],
    ['空位 6', 5],
  ] as const) {
    await page.locator('.slot', { hasText: slotText }).click()
    await page.locator('.dialog .pick-row').nth(index).click()
    await page.waitForTimeout(120)
  }

  // 推征攒经验进池子
  await page.goto(`${base}/#/expedition`, { waitUntil: 'networkidle' })
  for (let i = 0; i < 3; i++) {
    await page.locator('button', { hasText: '推征 10 场' }).click()
    await page.waitForTimeout(700)
  }

  await page.goto(`${base}/#/temple`, { waitUntil: 'networkidle' })
  await page.locator('.hero-cell').first().click()
  // 等提示条（toast 2.2s 自动消失）淡出，否则会盖住「经验不足」这类行内提示
  await page.waitForTimeout(2600)
  await page.screenshot({ path: outPath, fullPage: opts.fullPage })
  return ''
}

/**
 * 观战场景：登录 → 十连 → 编队 → 推征页点「观战」。
 *
 * 为什么要一整套编排：观战画布要**有编队、有登录态**才会出现，
 * 光导航到 /expedition 只能截到登录页或「请先在阵位中编队」。
 */
async function runBattleScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  const base = await setupAccount(context, page, opts)

  // 2) 编队：**满编 6 人**（前排 3 + 后排 3），
  //    少编就看不到三排纵向排布，遮挡类问题会漏检
  await page.goto(`${base}/#/formation`, { waitUntil: 'networkidle' })
  for (const [slotText, index] of [
    ['空位 1', 0],
    ['空位 2', 1],
    ['空位 3', 2],
    ['空位 4', 3],
    ['空位 5', 4],
    ['空位 6', 5],
  ] as const) {
    await page.locator('.slot', { hasText: slotText }).click()
    const dialog = page.locator('.dialog')
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('.pick-row').nth(index).click()
    await dialog.waitFor({ state: 'detached' })
  }

  // 3) 进战斗：
  //    - 指定 --stage → 走**关卡详情弹窗**的「战斗预览」（客户端本地预览，不发奖）
  //    - 不指定 → 走推征页的「挑战此关」（**服务端真实战斗** → 回放一次性回传 → 页面级回放面板）
  //
  // ⚠ **挂机改版 v11：关卡详情改成弹窗**（`StageDetailModal.vue`），
  //   推征页的关卡网格点一下就开弹窗（`stage-cell-<id>`），
  //   深链 `/#/stage/:id` 仍在（`StageDetailView.vue` 是薄壳）但不再是主入口。
  //   ⇒ 截图走**弹窗**这条真实路径，才截得到玩家实际看到的界面。
  if (opts.stage) {
    await page.goto(`${base}/#/expedition`, { waitUntil: 'networkidle' })
    await page.locator(`[data-testid="stage-cell-${opts.stage}"]`).first().click()
    await page.locator('[data-testid="stage-detail-modal"]').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '战斗预览', exact: true }).click()
  } else {
    await page.goto(`${base}/#/expedition`, { waitUntil: 'networkidle' })
    await page.getByTestId('campaign-challenge').click()
    // ⚠ 战斗在**服务端**执行，回放走响应的一次性 `replay` 字段 ⇒ 面板会晚一点出现
    await page.getByTestId('challenge-replay').waitFor({ state: 'visible', timeout: 30_000 })
  }
  await page.locator('canvas.battle-canvas').waitFor({ state: 'visible' })
  // 让演出推进几秒，好让画面上有伤害数字与血条变化
  await page.waitForTimeout(opts.waitMs)
  // 把战斗区滚进视口：画布 + 控制条 + 文字战报列表要一起入镜
  // （战报列表在画布下方，不滚动就只截到画布）
  await page.locator('.battle-box').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.screenshot({ path: outPath })

  // 4) 结算面板：跳过演出后出战后结算
  await page.locator('[data-testid="battle-skip"]').first().click()
  await page.locator('.result-panel').waitFor({ state: 'visible' })
  // ⚠ 结算面板在画布 + 战报**下方**，不滚过去就只截到战报（结算那张图看不到结算）
  await page.locator('.result-panel').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)

  return opts.out.replace(/\.png$/, '') + '-result.png'
}

/**
 * 顶栏资源条：**6 项资源必须全部可见**（一项都不能被裁掉）。
 *
 * ⚠ 为什么把它做成断言：
 *   资源图标让每项宽了 22px，窄机型上原本只露得出 3 项，
 *   而横向滚动条的滚动条被藏着 → 玩家看不出右边还有资源。
 *   这类问题**看截图容易漏**（第一屏刚好露出的那几项都正常），
 *   所以改成「跑一次就量一次，露不全直接报错」。
 */
async function assertResourceBarFullyVisible(page: Page): Promise<void> {
  const bar = page.locator('.res-bar')
  if ((await bar.count()) === 0) return
  const measured = await bar.evaluate((el) => {
    const container = el as HTMLElement
    const box = container.getBoundingClientRect()
    const items = Array.from(container.querySelectorAll('.res-item')) as HTMLElement[]
    const rows = new Set<number>()
    let visible = 0
    for (const item of items) {
      const r = item.getBoundingClientRect()
      rows.add(Math.round(r.top))
      if (r.left >= box.left - 0.5 && r.right <= box.right + 0.5) visible += 1
    }
    return { total: items.length, visible, rows: rows.size, height: Math.round(box.height) }
  })
  console.log(
    `[relic] 顶栏资源条：${measured.visible}/${measured.total} 项可见`
    + `（${measured.rows} 行，高 ${measured.height}px）`,
  )
  if (measured.visible < measured.total) {
    throw new Error(`顶栏资源条有 ${measured.total - measured.visible} 项被裁掉`)
  }
}

/**
 * 遗物场景：导入前置存档（60 件遗物 + 满编队伍）→ 铸造页 + 英灵页。
 *
 * 截图用于验收三件事：
 * 1. **遗物图标**：仓库里每件遗物都该有自己的实物立绘（不是一排同名文字）；
 * 2. **一键推荐装备**：英灵页的「一键推荐装备」按钮与战力增量；
 * 3. **套装效果可见**：2/4/6 件阶梯加成与「还差几件」的提示。
 *
 * ⚠ 为什么用「导入前置」而不是「祈愿抽遗物」：
 *   挂机改版 v11 后遗物**已移出掉落表**，唯一来源是独立入口「遗物祈愿」
 *   （`relic.acquire`，5000 银两 / 次）。凑齐 60 件要祈愿 60 次（30 万银两），
 *   而且抽到的是**随机稀有度**，凑不出「12 套各 5 件」。
 *   导入前置一次到位，**60 张图标能在同一张仓库截图里全部验收**。
 *   详见 `tools/capture/relic-fixture.ts`。
 */
async function runRelicScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  // ① 先导入前置存档
  //    ⚠ 导入只对「服务端还没有存档」的账号开放 → 必须早于页面首屏建档，
  //    否则页面先 `save.create` 建了档，导入就被 IMPORT_FORBIDDEN 永久拒绝。
  const session = await registerSession(opts.api)
  await importRelicFixture(opts.api, session.accessToken, buildRelicFixture())
  await injectSession(context, opts, session)
  const base = opts.url.replace(/\/$/, '')

  // 铸造页：遗物仓库（图标 + 套装名）
  await page.goto(`${base}/#/forge`, { waitUntil: 'networkidle' })
  await page.locator('.relic-cell').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)
  await assertResourceBarFullyVisible(page)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-forge.png'), fullPage: opts.fullPage })

  // 顶栏资源说明弹窗（图标 → 名称 + 作用描述）
  await page.locator('.res-item[data-res="crystals"]').click()
  await page.getByTestId('resource-dialog').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-resource.png') })
  await page.getByTestId('resource-dialog').getByRole('button', { name: '关闭' }).click()
  await page.getByTestId('resource-dialog').waitFor({ state: 'detached', timeout: 5_000 })

  // 铸造页：选中一件 → 详情面板（强化按钮 + 花费 + 下一级预览）
  await page.locator('.relic-cell').first().click()
  await page.getByTestId('relic-upgrade').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(400)
  await page.getByTestId('relic-upgrade').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-upgrade.png') })

  // 英灵页：一键推荐装备 + 套装效果
  // ⚠ 页面是**内部滚动容器**（.body），不是整页滚动 → fullPage 拍不到下半部分，
  //   必须先把「遗物槽」滚进视口再拍。
  await page.goto(`${base}/#/temple`, { waitUntil: 'networkidle' })
  await page.locator('.hero-cell').first().click()
  await page.waitForTimeout(2600)
  await page.getByTestId('relic-recommend').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: outPath })

  // 点「一键推荐装备」→ 槽位填满、套装档位亮起
  await page.getByTestId('relic-recommend').click()
  await page.waitForTimeout(900)
  await page.getByTestId('relic-recommend').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-equipped.png') })

  // 套装效果区（往下滚一点）
  await page.getByText('套装效果', { exact: true }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-set.png') })

  return ''
}

/**
 * 背包场景（资源/背包版本 v10）：导入前置存档 → 背包 5 分类 + 五行筛选 + 副本页。
 *
 * 截图用于验收四件事：
 * 1. **5 个分类**都在（遗物 / 技能材料 / 强化材料 / 经验书 / 卡碎片），
 *    分类与筛选条件写在 URL 上（分享链接能还原同一屏）；
 * 2. **道具名称与数量**来自登记表（`ITEM_DEFS`），不是就地写的中文串；
 * 3. **材料 → 副本直达入口**摆在玩家眼前（铁律 #27「养成规则必须在玩家眼前」）；
 * 4. **副本页**的变体 / 难度 / 每胜产量与「设为挂机去向」。
 *
 * ⚠ 走「导入前置」而不是真去刷副本：副本一场要真实等 6 秒，
 *   而截图要的是「5 个分类都有货」的**版面**，不是产出速度。
 */
async function runBackpackScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  const session = await registerSession(opts.api)
  await importRelicFixture(opts.api, session.accessToken, buildBackpackFixture())
  await injectSession(context, opts, session)
  const base = opts.url.replace(/\/$/, '')

  // ① 技能材料分类（五行筛选 + 「去副本」直达入口）
  await page.goto(`${base}/#/forge?tab=skillMat`, { waitUntil: 'networkidle' })
  await page.getByTestId('backpack-tab-skillMat').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  await assertResourceBarFullyVisible(page)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-skillMat.png'), fullPage: opts.fullPage })

  // ② 切到「火」筛选（筛选项在 URL 上）
  await page.getByTestId('backpack-element-火').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-skillMat-fire.png'), fullPage: opts.fullPage })

  // ③ 强化材料分类（三档强化石）
  await page.goto(`${base}/#/forge?tab=relicStone`, { waitUntil: 'networkidle' })
  await page.getByTestId('backpack-tab-relicStone').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-relicStone.png'), fullPage: opts.fullPage })

  // ④ 经验书分类（面额 + 投喂入口）
  await page.goto(`${base}/#/forge?tab=expBook`, { waitUntil: 'networkidle' })
  await page.getByTestId('backpack-tab-expBook').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-expBook.png'), fullPage: opts.fullPage })

  // ⑤ 卡碎片分类（点一下跳英灵页）
  await page.goto(`${base}/#/forge?tab=shards`, { waitUntil: 'networkidle' })
  await page.getByTestId('backpack-tab-shards').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-shards.png'), fullPage: opts.fullPage })

  // ⑥ 材料 → 副本直达（点「去副本」应当真的跳到副本页）
  await page.goto(`${base}/#/forge?tab=skillMat`, { waitUntil: 'networkidle' })
  await page.getByTestId('backpack-go-dungeon-skillMatFire').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('backpack-go-dungeon-skillMatFire').click()
  await page.getByTestId('dungeon-kind-skill').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-dungeon.png'), fullPage: opts.fullPage })

  // ⑦ 强化副本页（三档石 + 每胜产量 + 设为挂机通道）
  //    ⚠ 挂机改版 v11：副本页是「24 个独立关卡」平铺，**变体不再是独立分组**，
  //    断言落在关卡行上（关卡 id 唯一出处是 core 的 `dungeonStageId`）。
  await page.goto(`${base}/#/dungeon?kind=enhance&tier=relicStoneTier1&difficulty=easy`, {
    waitUntil: 'networkidle',
  })
  await page
    .getByTestId(`dungeon-stage-${dungeonStageId('enhanceTier1', 'easy')}`)
    .waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-dungeon-enhance.png'), fullPage: opts.fullPage })

  return ''
}

// ─────────────────────────── 浏览器兼容性测量 ───────────────────────────
/**
 * 兼容性测量（roadmap P1-3「按设计基线实测 Safari、微信内置浏览器、低端 Android 及 4G 首屏」）。
 *
 * ## 为什么用「引擎 + 限速」而不是真机
 *
 * 真机（微信 iOS / 微信 Android / 低端安卓机）无法在 CI 里稳定复现，
 * 但**渲染引擎**是可以复现的：
 *
 * - **Safari** → Playwright WebKit 就是 Safari 同源引擎（WKWebView 同内核）；
 * - **微信内置浏览器** → iOS 版是 WKWebView（同 WebKit），Android 版是 X5/Chromium 内核；
 * - **低端 Android + 4G 首屏** → Chromium + 4 倍 CPU 降速 + 4G 网络限速近似。
 *
 * 真机仍需人工补测（见 artifacts/deploy.md 的「真机补测清单」），
 * 但**先在这里排掉引擎级问题**比每次找真机快得多。
 *
 * ## 硬约束
 *
 * 与截图场景共用同一套隔离机制：origin 守卫 + 全新 browser context（空 localStorage），
 * 只允许访问隔离预览端口。
 */

interface CompatProfile {
  name: string
  /** 覆盖的目标机型 */
  label: string
  engine: 'chromium' | 'webkit'
  ua: string
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  /** CPU 降速倍率（1 = 不降速） */
  cpuThrottle: number
  /** 网络限速 */
  network: '4g' | 'none'
}

/** 微信内置浏览器 UA（Android 版：X5/Chromium 内核） */
const WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014; wv) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36 '
  + 'MicroMessenger/8.0.42.2460(0x28002A35) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64'

/** iOS Safari UA（微信 iOS 版同内核） */
const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** 低端安卓机 UA */
const LOW_END_ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 10; RMX2001) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/114.0.0.0 Mobile Safari/537.36'

const COMPAT_PROFILES: CompatProfile[] = [
  {
    name: 'chromium-4g-lowend',
    label: '低端 Android（Chromium + 4 倍 CPU 降速 + 4G 限速）',
    engine: 'chromium',
    ua: LOW_END_ANDROID_UA,
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3,
    cpuThrottle: 4,
    network: '4g',
  },
  {
    name: 'chromium-wechat',
    label: '微信内置浏览器（Android 版，X5/Chromium 内核 + 4G 限速）',
    engine: 'chromium',
    ua: WECHAT_UA,
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 3,
    cpuThrottle: 2,
    network: '4g',
  },
  {
    name: 'webkit-ios',
    label: 'Safari 引擎（iOS / 微信 iOS 版同内核）',
    engine: 'webkit',
    ua: IOS_SAFARI_UA,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    cpuThrottle: 1,
    network: 'none',
  },
]

interface CompatResult {
  profile: string
  label: string
  phase: 'login' | 'home'
  engine: string
  skipped?: string
  fcpMs?: number
  lcpMs?: number
  domContentLoadedMs?: number
  loadMs?: number
  transferredKB?: number
  jsKB?: number
  requestCount?: number
  rendered?: boolean
  errors: string[]
}

/** 4G 网络参数（CDP）：下行 1.6 Mbps / 上行 750 Kbps / RTT 150 ms */
const FOUR_G = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
}

async function measureProfile(
  profile: CompatProfile,
  phase: 'login' | 'home',
  target: string,
  session: ShotSession | null,
  apiBase: string,
): Promise<CompatResult> {
  const result: CompatResult = {
    profile: profile.name,
    label: profile.label,
    phase,
    engine: profile.engine,
    errors: [],
  }
  const browserType = profile.engine === 'webkit' ? webkit : chromium
  let browser: Browser | null = null
  try {
    browser = await browserType.launch()
  } catch (err) {
    result.skipped = `运行时不可用：${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
    return result
  }

  try {
    const context = await browser.newContext({
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
      userAgent: profile.ua,
    })
    // 后端地址必须在导航前写入（否则会去打玩家自己的 8787）
    await context.addInitScript(
      ({ base, sess }: { base: string; sess: ShotSession | null }) => {
        if (base) localStorage.setItem('sgw.apiBase', base)
        if (sess && !localStorage.getItem('sgw.session')) {
          localStorage.setItem('sgw.session', JSON.stringify(sess))
        }
      },
      { base: apiBase, sess: phase === 'home' ? session : null },
    )
    // LCP 观察器要在导航前注册，否则会漏掉首屏最大内容绘制
    await context.addInitScript(() => {
      ;(window as unknown as { __lcp?: number }).__lcp = 0
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries()
          const last = entries[entries.length - 1]
          if (last) (window as unknown as { __lcp?: number }).__lcp = Math.round(last.startTime)
        }).observe({ type: 'largest-contentful-paint', buffered: true })
      } catch {
        /* 引擎不支持 LCP：报告里留空即可 */
      }
    })
    const page = await context.newPage()
    page.on('pageerror', (e) => result.errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') result.errors.push(`console.error: ${m.text()}`)
    })

    // 限速只在 Chromium 上可用（CDP）
    if (profile.engine === 'chromium') {
      const cdp = await context.newCDPSession(page)
      if (profile.cpuThrottle > 1) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuThrottle })
      }
      if (profile.network === '4g') {
        await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', FOUR_G)
      }
    }

    await page.goto(target, { waitUntil: 'load', timeout: 90_000 })
    // 等首屏绘制稳定（限速下图片与字体是异步到的）
    await page.waitForTimeout(1500)

    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      const paints = performance.getEntriesByType('paint')
      const fcp = paints.find((p) => p.name === 'first-contentful-paint')
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const app = document.querySelector('#app')
      return {
        fcpMs: fcp ? Math.round(fcp.startTime) : null,
        lcpMs: (window as unknown as { __lcp?: number }).__lcp ?? null,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadMs: nav ? Math.round(nav.loadEventEnd) : null,
        transferredBytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
        jsBytes: resources
          .filter((r) => /javascript|\.js(\?|$)/.test(r.name))
          .reduce((sum, r) => sum + (r.transferSize || 0), 0),
        requestCount: resources.length,
        rendered: !!app && app.childElementCount > 0,
        bodyText: (document.body.innerText || '').trim().length,
      }
    })

    result.fcpMs = metrics.fcpMs ?? undefined
    result.lcpMs = metrics.lcpMs ?? undefined
    result.domContentLoadedMs = metrics.domContentLoadedMs ?? undefined
    result.loadMs = metrics.loadMs ?? undefined
    result.transferredKB = Math.round((metrics.transferredBytes / 1024) * 10) / 10
    result.jsKB = Math.round((metrics.jsBytes / 1024) * 10) / 10
    result.requestCount = metrics.requestCount
    result.rendered = metrics.rendered && metrics.bodyText > 0
    await context.close()
  } catch (err) {
    result.errors.push(`运行失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await browser.close()
  }
  return result
}

/**
 * 造一个「已登录且有进度」的隔离账号。
 *
 * ⚠ 为什么要**每个测量单独造**：
 *   refresh token 是**一次性轮换**的（用一次就作废），
 *   同一个 token 给第二个 context 用必然 401。
 *   所以每个配置都独立注册一次。
 *
 * ⚠ 为什么要先 `save.create` + 十连：
 *   新注册账号**没有存档行**，`GET /api/save` 会返回 404（NO_SAVE）→
 *   测到的首屏是「空壳」。补上存档与英灵才是真实首屏。
 */
async function prepareCompatSession(api: string): Promise<ShotSession> {
  const session = await registerSession(api)
  const base = api.replace(/\/$/, '')
  const act = async (actionId: string, action: unknown) => {
    await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({ actionId, action }),
    })
  }
  await act('compat-create', { type: 'save.create' })
  await act('compat-pull', { type: 'gacha.pull', poolId: 'standard', count: 10 })
  return session
}

async function runCompatScenario(opts: Options): Promise<void> {
  if (!opts.api) {
    throw new Error(
      '兼容性测量需要 --api <隔离后端地址>：\n'
      + '  · 登录后首页要真实拉一次云档，否则测的是「空壳首屏」；\n'
      + '  · 不注入后端地址的话，前端会去打玩家自己的 8787 端口。',
    )
  }
  const apiBase = opts.api.replace(/\/$/, '')
  const results: CompatResult[] = []
  for (const profile of COMPAT_PROFILES) {
    for (const phase of ['login', 'home'] as const) {
      const route = phase === 'login' ? '/login' : opts.route
      const target = `${opts.url.replace(/\/$/, '')}/#${route}`
      console.log(`[compat] 测量中：${profile.label} · ${phase === 'login' ? '登录页' : '登录后首页'}`)
      // 每个配置单独造账号（refresh token 一次性轮换，不能复用）
      const session = phase === 'home' ? await prepareCompatSession(opts.api) : null
      const r = await measureProfile(profile, phase, target, session, apiBase)
      results.push(r)
      if (r.skipped) console.log(`[compat]   跳过：${r.skipped}`)
      else {
        console.log(
          `[compat]   FCP ${r.fcpMs}ms · LCP ${r.lcpMs}ms · load ${r.loadMs}ms · `
            + `传输 ${r.transferredKB}KB（JS ${r.jsKB}KB / ${r.requestCount} 请求）· `
            + `渲染 ${r.rendered ? '正常' : '异常'} · 错误 ${r.errors.length}`,
        )
      }
    }
  }

  const outPath = resolve(process.cwd(), opts.compatOut)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        target: opts.url,
        note:
          'Chromium 走 CDP 限速（4 倍 CPU / 4G）；WebKit 无 CDP，**未限速**，'
          + '其数值仅代表引擎兼容性、不代表弱网表现；真机（微信 iOS/Android、低端安卓机）仍需人工补测',
        profiles: results,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`[compat] 报告已保存：${outPath}`)

  const failed = results.filter((r) => !r.skipped && (!r.rendered || r.errors.length > 0))
  if (failed.length > 0) {
    console.error(`[compat] ${failed.length} 个配置未通过（渲染异常或存在脚本错误）`)
    for (const f of failed) {
      console.error(`[compat]   ${f.profile}/${f.phase}：${f.errors.slice(0, 3).join(' | ')}`)
    }
    process.exitCode = 1
  }
}

/**
 * 每日任务场景：登录 → 十连 → 每日页。
 *
 * 截图用于验收「每日任务 / 周目标看得到、点得动、知道还差多少」：
 * 任务条目、进度、奖励、领取与前往按钮都要在同一屏里。
 */
async function runDailyScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  const base = await setupAccount(context, page, opts)
  await page.goto(`${base}/#/daily`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: outPath, fullPage: opts.fullPage })
  return ''
}

/**
 * 演武场场景：登录 → 十连 → 演武场页。
 *
 * 截图用于验收「三队天梯看得懂、够得着」：
 * 玩法口径、三队编成、敌方梯队、段位与挑战按钮都要在同一屏里。
 */
async function runLadderScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  const base = await setupAccount(context, page, opts)
  await page.goto(`${base}/#/ladder`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  // 内容在内部滚动容器里：先按需求滚到顶 / 底，再截图
  await page.evaluate((toBottom) => {
    const body = document.querySelector('.body') as HTMLElement | null
    if (body) body.scrollTop = toBottom ? body.scrollHeight : 0
    window.scrollTo(0, toBottom ? document.body.scrollHeight : 0)
  }, opts.scrollBottom)
  await page.waitForTimeout(300)
  await page.screenshot({ path: outPath, fullPage: opts.fullPage })
  return ''
}

/**
 * 副本挑战场景（挂机改版 v11 新增）。
 *
 * ⚠ 为什么要有这个场景：副本从「取材主线波次」变成 **24 个独立关卡**之后，
 *   副本页多了一整张关卡列表（按难度段分组）、每关有「挑战」与「设为挂机通道」
 *   两个动作、还有「未通关 / 未解锁」两种状态——
 *   这些**只在副本页上验**得出，单测与 E2E 都看不到布局与文案。
 *
 * ⚠ **不许直连玩家 origin**：本脚本跑在隔离 context + 隔离后端里（见 `setupAccount`）。
 */
async function runDungeonChallengeScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  // ① 先导入前置存档（满编队伍 + 金属性英灵）
  //    ⚠ 手动挑战要**队伍非空**，新号十连只有散落英灵、编队是空的 ⇒ 挑战会被直接拒。
  //    ⚠ 导入只对「服务端还没有存档」的账号开放 → 必须早于页面首屏建档。
  const session = await registerSession(opts.api)
  await importDungeonFixture(opts.api, session.accessToken, buildDungeonFixture())
  await injectSession(context, opts, session)
  const base = opts.url.replace(/\/$/, '')

  // ② 进副本页（默认技能副本；深链 `?kind=` 是保留的入口）
  await page.goto(`${base}/#/dungeon?kind=skill`, { waitUntil: 'networkidle' })
  await page.locator('[data-testid="dungeon-kind-skill"]').waitFor({ state: 'visible' })
  await page.waitForTimeout(opts.waitMs)

  // ③ 列表完整性：副本页按 tab 分成**技能 15 关**（5 变体 × 3 难度）
  //    与**强化 9 关**（3 变体 × 3 难度），合计 24 关。
  //    ⚠ 断言的数量走 core 的 `dungeonStagesOf`（关卡表的唯一出处），
  //    不在脚本里另写一份「15 / 9」。
  const skillCount = dungeonStagesOf('skill').length
  const enhanceCount = dungeonStagesOf('enhance').length
  const rows = page.locator('[data-testid^="dungeon-stage-"]')
  const rowCount = await rows.count()
  if (rowCount !== skillCount) {
    throw new Error(`技能副本页应有 ${skillCount} 行，实际 ${rowCount} 行`)
  }

  // ④ 首关未通关 ⇒ 「挑战」可点、「设为挂机通道」被拒（目标必须已通关）
  const firstStageId = dungeonStageId('skillGold', 'easy')
  const firstRow = page.locator(`[data-testid="dungeon-stage-${firstStageId}"]`)
  await firstRow.waitFor({ state: 'visible' })
  const setChannel = firstRow.locator(`[data-testid="dungeon-set-channel-${firstStageId}"]`)
  const setDisabled = await setChannel.isDisabled()
  if (!setDisabled) {
    throw new Error(`${firstStageId} 尚未通关，「设为挂机通道」应当不可用`)
  }
  await firstRow.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.screenshot({ path: outPath })

  // ⑤ 挑战该关：战斗在服务端执行 → 回放一次性回传 → 页面级回放面板播出来
  await firstRow.locator(`[data-testid="dungeon-challenge-${firstStageId}"]`).click()
  await page.getByTestId('challenge-replay').waitFor({ state: 'visible', timeout: 30_000 })
  // 跳过演出：战斗可能打满 30 回合，逐帧等结算会超时（截图要的是**结算**那一帧）
  await page.getByTestId('battle-skip').click({ timeout: 10_000 })
  await page.locator('.result-panel').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('challenge-replay').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  const resultPath = outPath.replace(/\.png$/, '') + '-result.png'
  await page.screenshot({ path: resultPath })
  console.log(`副本挑战结算截图已保存：${resultPath}`)

  // ⑥ 打赢一次即通关 ⇒ 「已通关」+「设为挂机通道」变为可用（这是副本的核心契约）
  await expectEnabled(firstRow.locator(`[data-testid="dungeon-set-channel-${firstStageId}"]`), '设为挂机通道')

  // ⑦ 强化副本 tab：另有 enhanceCount 关（合计 24 关）
  await page.locator('[data-testid="dungeon-kind-enhance"]').click()
  await page.waitForTimeout(opts.waitMs)
  const enhanceRows = await page.locator('[data-testid^="dungeon-stage-"]').count()
  if (enhanceRows !== enhanceCount) {
    throw new Error(`强化副本页应有 ${enhanceCount} 行，实际 ${enhanceRows} 行`)
  }
  await page.screenshot({ path: outPath.replace(/\.png$/, '') + '-enhance.png' })

  // ⚠ 返回空串：本场景自己拍完三张（列表 / 结算 / 强化 tab），
  //   再让 main() 按 resultPath 补拍会**覆盖掉结算那张**（它拍的是切 tab 之后的画面）。
  return ''
}

/** 断言某个按钮**可用**（不可用就直接报错，不静默通过） */
async function expectEnabled(locator: import('@playwright/test').Locator, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await locator.isDisabled())) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`「${label}」应当变为可用，但仍是禁用态`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  assertSafeOrigin(opts.url)
  // 兼容性测量是独立模式：自己开 context、自己量指标，不走截图流程
  if (opts.compat) {
    await runCompatScenario(opts)
    return
  }
  if ((opts.battle || opts.hero || opts.gachaTicket || opts.gachaReveal || opts.relic || opts.backpack || opts.daily || opts.ladder || opts.dungeonChallenge) && !opts.api) {
    throw new Error('观战 / 英灵详情 / 抽卡券 / 抽卡演出 / 遗物 / 背包 / 每日任务 / 演武场 / 副本挑战场景需要 --api <隔离后端地址>（用于注册临时账号）')
  }

  const target = `${opts.url.replace(/\/$/, '')}/#${opts.route}`
  const outPath = resolve(process.cwd(), opts.out)
  mkdirSync(dirname(outPath), { recursive: true })

  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    // 全新 context：localStorage 为空，与玩家存档完全隔离
    const context = await browser.newContext({
      viewport: parseViewport(opts.viewport),
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
    const page = await context.newPage()

    let resultPath = ''
    if (opts.hero) {
      resultPath = await runHeroScenario(context, page, opts, outPath)
    } else if (opts.battle) {
      resultPath = await runBattleScenario(context, page, opts, outPath)
    } else if (opts.relic) {
      await runRelicScenario(context, page, opts, outPath)
    } else if (opts.backpack) {
      await runBackpackScenario(context, page, opts, outPath)
    } else if (opts.daily) {
      await runDailyScenario(context, page, opts, outPath)
    } else if (opts.ladder) {
      await runLadderScenario(context, page, opts, outPath)
    } else if (opts.dungeonChallenge) {
      resultPath = await runDungeonChallengeScenario(context, page, opts, outPath)
    } else if (opts.gachaTicket) {
      await runGachaTicketScenario(context, page, opts, outPath)
    } else if (opts.gachaReveal) {
      await runGachaRevealScenario(context, page, opts, outPath)
    } else {
      await page.goto(target, { waitUntil: 'networkidle' })
      await page.waitForTimeout(opts.waitMs)

      if (opts.pull) {
        await prepareIsolatedSave(page, true)
      }
    }

    // 长页面：内容在**内部滚动容器**（.body）里，整页滚动拍不到下半部分
    if (opts.scrollBottom) {
      await page.evaluate(() => {
        const body = document.querySelector('.body') as HTMLElement | null
        if (body) body.scrollTop = body.scrollHeight
        window.scrollTo(0, document.body.scrollHeight)
      })
      await page.waitForTimeout(400)
    }

    if (!opts.battle && !opts.hero && !opts.gachaTicket && !opts.gachaReveal && !opts.relic && !opts.backpack && !opts.daily && !opts.ladder && !opts.dungeonChallenge) {
      await page.screenshot({ path: outPath, fullPage: opts.fullPage })
    }
    if (resultPath) {
      await page.screenshot({ path: resolve(process.cwd(), resultPath), fullPage: opts.fullPage })
    }

    // 自检：隔离上下文里只应存在本次运行造出来的存档
    const keys = await page.evaluate(() => Object.keys(localStorage))
    console.log(`截图已保存：${outPath}`)
    if (resultPath) console.log(`结算截图已保存：${resolve(process.cwd(), resultPath)}`)
    console.log(`隔离上下文内的存储键：${keys.length ? keys.join(', ') : '（空）'}`)
    const unexpected = keys.filter((k) => !/^sgw\.(save\.|session$|apiBase$|legacyMigrated$)/.test(k))
    if (unexpected.length > 0) {
      console.warn(`警告：隔离上下文内出现了预期之外的存储键：${unexpected.join(', ')}`)
    }
  } finally {
    await browser?.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
