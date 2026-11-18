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
 * # 浏览器兼容性测量（Safari 引擎 / 微信 UA / 低端 Android + 4G 首屏）
 * npx tsx tools/capture/screenshot.ts --compat --route /login \
 *   --url http://127.0.0.1:4188 --compat-out artifacts/baselines/browser-compat.json
 * ```
 */
import { chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertSafeOrigin, ISOLATED_PREVIEW_URL } from './origin-guard.ts'

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
  /** 浏览器兼容性测量模式（Safari 引擎 / 微信 UA / 低端 Android + 4G 首屏） */
  compat: boolean
  /** 兼容性报告的输出路径（JSON） */
  compatOut: string
  /** 隔离后端地址（观战场景要注册账号） */
  api: string
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
    compat: argv.includes('--compat'),
    compatOut: get('--compat-out') ?? 'artifacts/baselines/browser-compat.json',
    api: get('--api') ?? '',
    stage: get('--stage') ?? '',
    fullPage: argv.includes('--full-page'),
    scrollBottom: argv.includes('--scroll-bottom'),
    waitMs: Number(get('--wait') ?? 1200),
  }
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
 */
async function injectSession(context: BrowserContext, opts: Options): Promise<ShotSession> {
  const session = await registerSession(opts.api)
  await context.addInitScript(
    ({ apiBase, sess }: { apiBase: string; sess: ShotSession }) => {
      localStorage.setItem('sgw.apiBase', apiBase)
      // ⚠ 只在还没有会话时注入：refresh token 是一次性轮换的，
      //   无条件覆盖会把页面刚轮换出来的新 token 换回最初那个 → 立刻失效。
      if (!localStorage.getItem('sgw.session')) {
        localStorage.setItem('sgw.session', JSON.stringify(sess))
      }
    },
    { apiBase: opts.api.replace(/\/$/, ''), sess: session },
  )
  return session
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

  // 3) 进战斗：默认走推征页「观战」，指定 --stage 则走关卡详情页「战斗预览」
  //    （关卡详情页能拍到 BOSS 关，验证 BOSS 描边与分段血条）
  if (opts.stage) {
    await page.goto(`${base}/#/stage/${opts.stage}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '战斗预览', exact: true }).click()
  } else {
    await page.goto(`${base}/#/expedition`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '观战', exact: true }).click()
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
  await page.getByRole('button', { name: '跳过', exact: true }).click()
  await page.locator('.result-panel').waitFor({ state: 'visible' })
  await page.waitForTimeout(300)

  return opts.out.replace(/\.png$/, '') + '-result.png'
}

/**
 * 遗物场景：登录 → 十连 → 编队 → 推征挂机（产遗物）→ 铸造页 + 英灵页。
 *
 * 截图用于验收三件事：
 * 1. **遗物图标**：仓库里每件遗物都该有自己的徽章（不是一排同名文字）；
 * 2. **一键推荐装备**：英灵页的「一键推荐装备」按钮与战力增量；
 * 3. **套装效果可见**：2/4/6 件阶梯加成与「还差几件」的提示。
 *
 * ⚠ 为什么要先推征：遗物**只**从推征（挂机）与离线结算产出，
 *   新号仓库是空的 → 截出来的图只能看到空态。
 * ⚠ 满编 6 人：人不够会在第 1 关卡关，卡关后不再有掉落。
 */
async function runRelicScenario(
  context: BrowserContext,
  page: Page,
  opts: Options,
  outPath: string,
): Promise<string> {
  const base = await setupAccount(context, page, opts)

  // 编队（满编 6 人，保证推征打得赢、掉得到遗物）
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

  // 推征挂机 → 产遗物（每场必掉 1 件）
  await page.goto(`${base}/#/expedition`, { waitUntil: 'networkidle' })
  for (let i = 0; i < 3; i++) {
    await page.locator('button', { hasText: '推征 10 场' }).click()
    await page.waitForTimeout(700)
  }

  // 铸造页：遗物仓库（图标 + 套装名）
  await page.goto(`${base}/#/forge`, { waitUntil: 'networkidle' })
  await page.locator('.relic-cell').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: outPath.replace(/\.png$/, '-forge.png'), fullPage: opts.fullPage })

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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  assertSafeOrigin(opts.url)
  // 兼容性测量是独立模式：自己开 context、自己量指标，不走截图流程
  if (opts.compat) {
    await runCompatScenario(opts)
    return
  }
  if ((opts.battle || opts.hero || opts.gachaTicket || opts.gachaReveal || opts.relic) && !opts.api) {
    throw new Error('观战 / 英灵详情 / 抽卡券 / 抽卡演出 / 遗物场景需要 --api <隔离后端地址>（用于注册临时账号）')
  }

  const target = `${opts.url.replace(/\/$/, '')}/#${opts.route}`
  const outPath = resolve(process.cwd(), opts.out)
  mkdirSync(dirname(outPath), { recursive: true })

  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    // 全新 context：localStorage 为空，与玩家存档完全隔离
    const context = await browser.newContext({
      viewport: { width: 430, height: 932 },
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

    if (!opts.battle && !opts.hero && !opts.gachaTicket && !opts.gachaReveal && !opts.relic) {
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
