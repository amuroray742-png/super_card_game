import { expect, type Page } from '@playwright/test'
import { BATTLE } from '../../src/core/config/economy.ts'
import type { ActionResponse } from '../../src/core/systems/action-protocol.ts'
import type { IdleActionResult } from '../../src/core/systems/actions.ts'
import { ACCOUNT_STORAGE_KEYS, accountSlotKey } from '../../src/core/config/account.ts'

/**
 * E2E 公共helper。
 *
 * 端到端用例走**真实后端**（server/ 的 Fastify 代码 + 临时 SQLite 库），
 * 因此需要：
 * - 把后端地址写进 `localStorage['sgw.apiBase']`（前端唯一的地址覆盖入口）
 * - 造一个已登录会话写进 `localStorage['sgw.session']`
 *
 * 注意：账号是**每个用例现注册的**，不是共用一个——
 * 云存档按账号隔离，共用账号会让前一个用例的抽卡结果影响后一个用例
 * （原本每个用例都是全新的浏览器上下文 = 全新的存档）。
 */

/** 与 playwright.config.ts 里的 webServer 端口保持一致 */
export const E2E_API_BASE = 'http://127.0.0.1:8790'

/** 测试用口令（满足后端 8 位下限） */
export const E2E_PASSWORD = 'e2e-password-1'

export interface E2eSession {
  refreshToken: string
  user: { id: number; username: string }
}

let counter = 0

/**
 * 造一个本次运行内唯一的用户名。
 *
 * 用户名上限 16 位（后端规则），前缀 + 6 位随机 + 2 位序号刚好留出余量。
 */
export function uniqueUsername(prefix = 'e2e'): string {
  counter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix.slice(0, 4)}_${rand}${(counter % 100).toString().padStart(2, '0')}`
}

/**
 * 直接调后端注册一个账号，拿回会话。
 *
 * 走接口而不是界面，是为了让「进入已登录状态」这一步足够快、足够确定；
 * 界面流程本身由 login.spec.ts 单独覆盖。
 */
export async function registerAccount(
  username: string,
  password: string = E2E_PASSWORD,
): Promise<E2eSession> {
  const res = await fetch(`${E2E_API_BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.status !== 201) {
    throw new Error(`注册失败：${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as E2eSession
  return { refreshToken: body.refreshToken, user: body.user }
}

/**
 * 往页面注入会话与后端地址（必须在 goto 之前调用）。
 *
 * ⚠ **只在本地还没有会话时注入**：refresh token 是**一次性轮换**的
 *   （refresh 即轮换，后端只存 hash），
 *   而 `addInitScript` 会在**每次导航**时重新执行——
 *   若无条件覆盖，页面刷新后会把「页面刚轮换出来的新 token」又换回最初那个，
 *   立刻失效（表现为「登录状态已失效」并被踢回登录页）。
 *   所以这里改成「有会话就不动」，让页面自己管理轮换。
 */
export async function seedSession(page: Page, session: E2eSession): Promise<void> {
  await page.addInitScript(
    ({ apiBase, sess }) => {
      localStorage.setItem('sgw.apiBase', apiBase)
      if (!localStorage.getItem('sgw.session')) {
        localStorage.setItem('sgw.session', JSON.stringify(sess))
      }
    },
    { apiBase: E2E_API_BASE, sess: session },
  )
}

/** 只注入后端地址（不注入会话）——用于未登录场景 */
export async function seedApiBase(page: Page): Promise<void> {
  await page.addInitScript((apiBase) => {
    localStorage.setItem('sgw.apiBase', apiBase)
  }, E2E_API_BASE)
}

/**
 * 直接调后端登录一个账号，拿回会话。
 *
 * 与 `registerAccount` 的区别：登录会签发**新的** refresh token。
 * 多设备用例需要两个独立会话（refresh token 是一次性轮换的，
 * 两个设备共用一个会被第二个设备轮换掉，第一个随即失效）。
 */
export async function loginAccount(
  username: string,
  password: string = E2E_PASSWORD,
): Promise<E2eSession> {
  const res = await fetch(`${E2E_API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.status !== 200) {
    throw new Error(`登录失败：${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as E2eSession
  return { refreshToken: body.refreshToken, user: body.user }
}

/** 走界面注册 */
export async function registerViaUi(
  page: Page,
  username: string,
  password: string = E2E_PASSWORD,
): Promise<void> {
  await page.goto('/#/login')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await page.getByPlaceholder('3-16 位字母、数字或下划线').fill(username)
  await page.getByPlaceholder('至少 8 位').fill(password)
  await page.getByRole('button', { name: '注册并进入' }).click()
}

/** 走界面登录 */
export async function loginViaUi(
  page: Page,
  username: string,
  password: string = E2E_PASSWORD,
): Promise<void> {
  await page.goto('/#/login')
  await page.getByPlaceholder('3-16 位字母、数字或下划线').fill(username)
  await page.getByPlaceholder('至少 8 位').fill(password)
  // 页面里有两个「登录」按钮（模式切换 + 提交），提交按钮在后面
  await page.getByRole('button', { name: '登录', exact: true }).last().click()
}

/**
 * 读某个账号槽位里的本地缓存（服务端存档的**镜像**，只读缓存）。
 *
 * ⚠ **不能**用「`Object.keys(localStorage).find(k => k.startsWith('sgw.save.'))`」：
 *   浏览器里还可能存在存量单槽位 `sgw.save.main`（旧档迁移通道），
 *   而 localStorage 的键序**不保证是写入顺序**——读到哪个槽位是随机的，
 *   断言会时对时错（实测约 1/3 概率读错）。
 *
 *   缓存归属由**账号**决定（AGENTS.md 铁律 #15），所以这里按账号 id 取槽位，
 *   槽位名与拼装口径一律取 core 的唯一来源（`ACCOUNT_STORAGE_KEYS`）。
 */
export async function cachedSaveOf(page: Page, accountId: number | string): Promise<CachedSave | null> {
  // 键名在 Node 侧算好传进去：evaluate 的回调跑在浏览器里，
  // 拿不到模块作用域（ACCOUNT_STORAGE_KEYS 等）。
  const key = `${ACCOUNT_STORAGE_KEYS.SAVE_SLOT_PREFIX}${accountSlotKey(accountId)}`
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k)
    if (!raw) return null
    return JSON.parse(raw) as CachedSave
  }, key)
}

/**
 * 清空编队，**暂停挂机收益**。
 *
 * ⚠ 为什么端到端里必须先做这一步：
 *   挂机用的是**时间账本**（`save.idle.effectiveMs`），在线时长按 3 倍倍率
 *   （`IDLE.ONLINE_MULTIPLIER`）持续累积，凑够一场战斗的时长就在
 *   **下一次动作**里一次性结算掉。
 *   于是「这次动作到底扣了多少」是**不可确定**的——玩家钱包在扣费的同时还在进账。
 *   实测：强化扣 2 枚强化石，同一次动作结算出 1 场战斗又补回 4 枚 → 净额 +2。
 *
 *   清空编队后 `settleIdleLedger` 直接返回 null（无编队 → 无战斗 → 无掉落），
 *   扣费口径就能被**精确断言**（银两正好 -500、强化石正好 -2）。
 *
 *   growth.spec.ts 用的是同一套做法 —— 两边共用这个 helper，避免两处各写一套。
 */
export async function pauseFarming(page: Page): Promise<void> {
  await page.goto('/#/formation')
  await page.waitForLoadState('networkidle')
  const slots = page.locator('.slot')
  const picker = page.locator('.dialog').filter({ hasText: '选择英灵' })
  const total = await slots.count()
  expect(total).toBeGreaterThan(0)
  for (let i = 0; i < total; i++) {
    const slot = slots.nth(i)
    if ((await slot.locator('.slot-empty').count()) > 0) continue
    await slot.click()
    await picker.getByRole('button', { name: new RegExp(`清空第 ${i + 1} 槽`) }).click()
    await expect(slot.locator('.slot-empty')).toHaveCount(1)
    await picker.getByRole('button', { name: '关闭', exact: true }).click()
  }
  await expect(slots.locator('.slot-empty')).toHaveCount(total)
}

/**
 * 等真实挂机时间后，通过玩家按钮领取一次服务端结算。
 * 场次数只是领取上限；不改时钟、不注入收益，也不假定在线倍率。
 * 每轮至少等一个基础场次，兼容在线 3x 与离线效率账本。
 */
export async function settleIdleThroughUi(page: Page, accountId: number, battles = 10): Promise<IdleActionResult> {
  await page.waitForTimeout(BATTLE.SECONDS_PER_BATTLE * 1000)
  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/action') return false
    const request = response.request().postDataJSON()
    return request?.action?.type === 'idle.tick' && request.action.battles === battles
  })
  await page.getByRole('button', { name: `推征 ${battles} 场`, exact: true }).click()
  const response = await responsePromise
  expect(response.ok(), '挂机请求应成功到达真实服务端').toBe(true)
  const body = await response.json() as ActionResponse
  expect(body.ok, body.message ?? '挂机动作失败').toBe(true)
  expect(body.save, '成功动作应返回权威存档').toBeTruthy()
  const snapshot = JSON.parse(body.save!.payload) as CachedSave
  // 心跳会续租并写回更新的控制账本，不能要求整份 JSON 与旧响应精确相等。
  // 没有其它玩家消费动作：资源不可比本次快照少，实例也必须全部保留。
  await expect.poll(async () => {
    const cached = await cachedSaveOf(page, accountId)
    if (!cached || (cached.savedAt ?? 0) < body.save!.savedAt) return false
    for (const [key, value] of Object.entries(snapshot.player ?? {})) {
      if (typeof value === 'number' && ((cached.player as Record<string, number> | undefined)?.[key] ?? -1) < value) return false
    }
    return (snapshot.relics ?? []).every((relic) => cached.relics?.some((r) =>
      r.uid === relic.uid && r.defId === relic.defId && r.level === relic.level))
  }, { timeout: 10_000 }).toBe(true)
  expect(body.result, '挂机应返回结算明细').toBeTruthy()
  return body.result as IdleActionResult
}

/** 本地缓存里常用的一小片字段 */
export interface CachedSave {
  savedAt?: number
  stats?: { totalPulls: number }
  player?: {
    crystals: number
    tickets?: number
    exp?: number
    emblems?: number
    silver?: number
    skillStones?: number
    relicStones?: number
  }
  heroes?: Record<string, { level: number; exp: number }>
  relics?: Array<{ defId: string; uid: string; level: number }>
  equipped?: Record<string, { heroId: string }>
  settings?: { speed?: number }
}

/** 服务端遗物实例（分页接口回包里的一条） */
export interface ServerRelic {
  defId: string
  uid: string
  level: number
  locked: boolean
}

/** 服务端仓库分页回包 */
export interface ServerRelicPage {
  items: ServerRelic[]
  total: number
  page: number
  size: number
  pages: number
}

/**
 * 仓库总件数（铸造页上显示的是**服务端**统计）。
 *
 * ⚠ 存档分包后，客户端镜像里**只有已装备遗物**（≤36 件），
 *   「仓库里有几件」不能看本地缓存——那会永远显示 0 或几十。
 *
 * ⚠ 刷新方式必须是「换一个路由再回来」，不能 `page.reload()`：
 *   整页重载会触发 `GET /api/save`，服务端趁这次载入补算挂机收益
 *   → 仓库件数凭空多出几件，「这一轮掉了几件」的对账就算不准了。
 *   同理也不能 goto 到**当前就在的**那个 hash（可能整页重载）。
 */
export async function relicTotal(page: Page): Promise<number> {
  const onForge = page.url().includes('/#/forge')
  if (onForge) {
    // 已经在铸造页：先离开再回来，逼页面重新拉一次服务端统计
    await page.goto('/#/formation')
  }
  await page.goto('/#/forge')
  await page.waitForLoadState('networkidle')
  await page.getByTestId('relic-total').waitFor({ state: 'visible', timeout: 8000 })
  const text = await page.getByTestId('relic-total').innerText()
  const digits = text.replace(/,/g, '').match(/\d+/)?.[0] ?? '0'
  return Number(digits)
}

/**
 * 读服务端仓库的实例列表（抓 `GET /api/relics` 的真实响应）。
 *
 * ⚠ 不自己拿令牌去查：`/api/auth/refresh` 会**轮换** refresh token，
 *   在测试里刷新一次就把页面正在用的会话打断了。
 *   抓页面上真实发出的那个响应，既不打断会话，又拿的是权威数据。
 *
 * ⚠ **不要 `page.reload()`**：重新载入会触发一次 `GET /api/save`，
 *   服务端趁这次载入补算挂机收益 → 仓库件数凭空多出几件，
 *   「这一轮掉了几件」的对账就算不准了。
 *   改成「先离开铸造页 → 再进铸造页」，让页面自然发出那个请求。
 */
export async function serverRelics(page: Page): Promise<ServerRelicPage> {
  await page.goto('/#/formation')
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/relics'),
    page.goto('/#/forge'),
  ])
  return (await response.json()) as ServerRelicPage
}

/**
 * 跳过抽卡演出 → 直接进结算。
 *
 * SSR 爆点会**停住等玩家点击**（不自动结束，见 §7.6 实施修正），
 * 所以「只想拿结算」的用例必须显式跳过（或放行闸门），
 * 干等结算自己冒出来会一直等到超时。
 *
 * 没有 SSR 的短演出可能已经自己演完（跳过按钮已消失），
 * 此时点不到也无所谓——结算已经出来了。
 */
export async function skipGachaReveal(page: Page): Promise<void> {
  const skip = page.getByTestId('gacha-skip')
  const shown = await skip
    .waitFor({ state: 'visible', timeout: 4000 })
    .then(() => true)
    .catch(() => false)
  if (!shown) return
  await skip.click({ timeout: 3000 }).catch(() => {})
}
