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
 * ```
 */
import { chromium, type Browser, type Page } from '@playwright/test'
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  assertSafeOrigin(opts.url)

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
    await page.goto(target, { waitUntil: 'networkidle' })
    await page.waitForTimeout(opts.waitMs)

    if (opts.pull) {
      await prepareIsolatedSave(page, true)
    }

    await page.screenshot({ path: outPath, fullPage: opts.fullPage })

    // 自检：隔离上下文里只应存在本次运行造出来的存档
    const keys = await page.evaluate(() => Object.keys(localStorage))
    console.log(`截图已保存：${outPath}`)
    console.log(`隔离上下文内的存储键：${keys.length ? keys.join(', ') : '（空）'}`)
    if (keys.some((k) => k !== 'sgw.save.main')) {
      console.warn('警告：隔离上下文内出现了预期之外的存储键，请检查工具实现')
    }
  } finally {
    await browser?.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
