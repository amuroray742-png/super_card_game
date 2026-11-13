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
 * ```
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * 禁止访问的 origin。
 *
 * `localhost:5173` 是开发服务器——玩家很可能正在这个地址游玩，
 * 自动化访问它等于动玩家的真实存档。
 */
const FORBIDDEN_HOSTS = new Set(['localhost', '127.0.0.1'])
const FORBIDDEN_PORTS = new Set(['5173'])

/** 隔离预览服务默认端口（与 dev server 刻意不同） */
const DEFAULT_URL = 'http://127.0.0.1:4188'

interface Options {
  url: string
  route: string
  out: string
  pull: boolean
  battle: boolean
  /** 隔离后端地址（观战场景要注册账号） */
  api: string
  /** 指定关卡 id（走关卡详情页的「战斗预览」；不填则走推征页的「观战」） */
  stage: string
  fullPage: boolean
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
    api: get('--api') ?? '',
    stage: get('--stage') ?? '',
    fullPage: argv.includes('--full-page'),
    waitMs: Number(get('--wait') ?? 1200),
  }
}

/** origin 守卫：命中玩家可能正在使用的 origin 直接拒绝执行 */
export function assertSafeOrigin(url: string): void {
  const u = new URL(url)
  if (FORBIDDEN_HOSTS.has(u.hostname) && FORBIDDEN_PORTS.has(u.port)) {
    throw new Error(
      [
        `拒绝访问 ${u.origin}：这是玩家可能正在游玩的开发服务器 origin。`,
        '自动化访问会与玩家共用同一份 localStorage，直接改动玩家的真实存档。',
        '请改用隔离的预览服务，例如：',
        '  npm run build && npm run preview -- --port 4188 --host 127.0.0.1',
        '  npx tsx tools/capture/screenshot.ts --url http://127.0.0.1:4188 ...',
      ].join('\n'),
    )
  }
}

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
  const session = await registerSession(opts.api)
  // 会话与后端地址必须在导航前写入（路由守卫靠它们恢复登录态）
  await context.addInitScript(
    ({ apiBase, sess }: { apiBase: string; sess: ShotSession }) => {
      localStorage.setItem('sgw.apiBase', apiBase)
      localStorage.setItem('sgw.session', JSON.stringify(sess))
    },
    { apiBase: opts.api.replace(/\/$/, ''), sess: session },
  )

  const base = opts.url.replace(/\/$/, '')

  // 1) 十连拿英灵
  await page.goto(`${base}/#/gacha`, { waitUntil: 'networkidle' })
  await page.locator('button', { hasText: '十连' }).first().click()
  await page.getByRole('button', { name: '收下' }).click()
  await page.waitForTimeout(400)

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
  await page.screenshot({ path: outPath })

  // 4) 结算面板：跳过演出后出战后结算
  await page.getByRole('button', { name: '跳过', exact: true }).click()
  await page.locator('.result-panel').waitFor({ state: 'visible' })
  await page.waitForTimeout(300)

  return opts.out.replace(/\.png$/, '') + '-result.png'
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  assertSafeOrigin(opts.url)
  if (opts.battle && !opts.api) {
    throw new Error('观战场景需要 --api <隔离后端地址>（用于注册临时账号）')
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
    if (opts.battle) {
      resultPath = await runBattleScenario(context, page, opts, outPath)
    } else {
      await page.goto(target, { waitUntil: 'networkidle' })
      await page.waitForTimeout(opts.waitMs)

      if (opts.pull) {
        await prepareIsolatedSave(page, true)
      }
    }

    if (!opts.battle) {
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
