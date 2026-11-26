import { expect, type Page } from '@playwright/test'
import { IDLE } from '../../src/core/config/economy.ts'
import type { ActionRequest, ActionResponse } from '../../src/core/systems/action-protocol.ts'
import type { IdleActionResult } from '../../src/core/systems/actions.ts'
import type { SaveData } from '../../src/core/model/types.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { exportSave } from '../../src/core/save/serialize.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
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
 *
 * ## 挂机改版 v11 的口径变更
 *
 * - 挂机**不跑战斗**，按掉落表**逐次掷奖**；一次掷奖 = `IDLE.SECONDS_PER_ROLL` 秒。
 * - 四条通道（主线 / 技能副本 / 强化副本 / **遗物副本**）**各自独立**计量同一段墙钟时间。
 * - `idle.tick` **不带负载**（不再有 `battles`）——领取次数完全由服务端按时间账本决定。
 *   旧实现里的「推征 N 场」按钮已不存在，领取入口是推征页唯一的「全部领取」。
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

/**
 * 换一对新令牌（拿 access token）。
 *
 * ⚠ refresh token 是**一次性轮换**的：刷新后旧 refresh token 立即作废。
 *   需要第二个独立会话时用 `loginAccount` 重新登录，别复用同一个 refresh token。
 */
export async function accessTokenOf(session: { refreshToken: string }): Promise<string> {
  const res = await fetch(`${E2E_API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
  const body = (await res.json()) as { accessToken: string }
  return body.accessToken
}

/**
 * 直接调后端接口发一个动作。
 *
 * ⚠ **只有服务端能改存档**（铁律 #11）：这条通道走的就是玩家那条
 *   `POST /api/action`，服务端用 core 动作层执行后落库。
 *   测试要造前置存档时必须走它，不能直接改数据库。
 */
export async function postAction(
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

/**
 * 发一个动作，返回**HTTP 状态 + 回包**。
 *
 * ⚠ 与 `postAction` 的区别：后者只回回包正文，**协议级失败**（400 / 429）
 *   的回包里**没有 `ok` 字段**（那是 `{ error: … }` 的形状）⇒
 *   `res.ok` 是 `undefined` 而不是 `false`。
 *   断言「这个动作被拒」时必须看**状态码**，否则会把 `undefined` 当成通过。
 */
export async function postActionStatus(
  accessToken: string,
  actionId: string,
  action: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${E2E_API_BASE}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ actionId, action }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body }
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
 * 造一个前置存档（**玩家可用的 `save.import` 动作**）。
 *
 * ⚠ 走服务端动作层，不碰数据库（铁律 #11）。
 * ⚠ **导入只接受当前版本（v12）**，且导入后服务端会：
 *   - 把四条挂机通道的计量水位重置为导入时刻（有效预算清零）；
 *   - **清空副本通关记录**（`dungeons.cleared = {}`）与副本挂机目标；
 *   - **清空遗物保底计数与每日产出计数**（导入的进度不是可信的凭证）；
 *   - 主线通道恢复「跟随最新通关关卡」。
 *   ⇒ 想测「已通关的副本关卡才能挂机」，**必须真的打赢一次**，导入给不了。
 *
 * @returns 账号 id（读本地缓存槽位用）与 access token（直接调动作层用）
 */
export async function importFixture(
  page: Page,
  prefix: string,
  mutate: (save: SaveData) => void,
): Promise<{ accountId: number; token: string }> {
  const session = await registerAccount(uniqueUsername(prefix))
  const token = await accessTokenOf(session)
  const save = createNewSave(Date.now())
  mutate(save)
  const imported = await postAction(token, `${prefix}-fixture`, {
    type: 'save.import',
    payload: exportSave(save),
  })
  expect(imported.ok, '前置存档导入失败').toBe(true)
  await seedSession(page, await loginAccount(session.user.username))
  // 载入一次页面 → 让客户端把服务端存档写进**本地缓存槽位**
  // （`cachedSaveOf` 读的就是它；不载入的话槽位还是空的）
  await page.goto('/#/gacha')
  await page.waitForLoadState('networkidle')
  return { accountId: session.user.id, token }
}

/**
 * 给存档塞一支队伍（按槽位顺序）。
 *
 * ⚠ `save.import` 的校验要求队里的英灵**都在 `save.heroes` 里**，
 *   这里一并写入（等级可调——等级决定能不能打赢）。
 */
export function giveTeam(save: SaveData, ids: readonly string[], level = 60): void {
  ids.forEach((id, slot) => {
    save.heroes[id] = { ...createHeroState(id, Date.now()), level }
    save.team.slots[slot] = id
  })
}

/**
 * 等某个动作的**权威响应**（页面自己发起的那个 `POST /api/action`）。
 *
 * ⚠ 断言前必须先**等渲染**：SPA 走 hash 路由，
 *   `page.goto('/#/xxx')` 从另一个 hash 出发属于**同文档导航**——
 *   页面不重载，`networkidle` 立刻满足，但 Vue 可能还没渲染完。
 *   所以断言一律用 locator 的自动等待（`expect(...).toBeVisible()`）。
 *
 * @param expectOk 业务失败也是 HTTP 200（`{ ok: false, code }`），
 *   负向用例要把它关掉才能拿到错误码。
 * @param trigger 触发这个动作的操作（必须在**挂上监听之后**执行，
 *   否则动作可能在监听挂上之前就发完了）。
 */
export async function waitForAction(
  page: Page,
  type: string,
  options: { expectOk?: boolean; trigger?: () => Promise<void> } = {},
): Promise<ActionResponse> {
  const expectOk = options.expectOk ?? true
  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== 'POST') return false
    if (new URL(response.url()).pathname !== '/api/action') return false
    const request = response.request().postDataJSON() as ActionRequest | null
    return request?.action?.type === type
  })
  if (options.trigger) await options.trigger()
  const response = await responsePromise
  expect(response.ok(), `动作 ${type} 的请求应成功到达服务端`).toBe(true)
  const body = (await response.json()) as ActionResponse
  if (expectOk) expect(body.ok, body.message ?? `动作 ${type} 失败`).toBe(true)
  return body
}

/**
 * **收起战斗回放覆盖层**。
 *
 * ⚠ 推征页一屏化 v13：回放是**全屏覆盖层**（模态演出）⇒
 *   覆盖层开着的时候，底下的页面**点不动**（Playwright 会报「元素被遮挡」）。
 *   用例要继续操作页面，就必须先收起它 —— 对应玩家点右上「收起」/ 底部「返回」。
 *
 * ⚠ 顺带守住「换页 = 离开演出」：覆盖层是全局唯一的，
 *   不收它就换页的话，新页面会被演出层挡住。
 */
export async function dismissReplay(page: Page): Promise<void> {
  const overlay = page.getByTestId('challenge-replay')
  const shown = await overlay
    .waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true)
    .catch(() => false)
  if (!shown) return
  await page.getByTestId('challenge-replay-close').click()
  await expect(overlay).toHaveCount(0)
}

/**
 * 收下「离线挂机结算」弹窗（没有就什么都不做）。
 *
 * ⚠ 标题是「离线挂机结算」（v11 改成**分通道分段**），
 *   旧的「离线推征结算」文案已随挂机改版一起退役。
 */
export async function dismissOfflineReport(page: Page): Promise<void> {
  const dialog = page.getByTestId('offline-settlement')
  const shown = await dialog
    .waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true)
    .catch(() => false)
  if (!shown) return
  await dialog.getByRole('button', { name: '收下', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/**
 * **领取挂机收益**（推征页唯一的「全部领取」入口）。
 *
 * ⚠ 挂机改版 v11 的关键差异：
 *   - 动作是 `idle.tick`，**不带任何负载**——次数由服务端的**时间账本**决定，
 *     客户端**不能**创造时间（旧实现的「推征 N 场」按钮已下线）；
 *   - 结果是**分通道分段**（`channels[]`），不是单个 `rewards`。
 *
 * ⚠ 必须**真实等时间**：一次掷奖 = `IDLE.SECONDS_PER_ROLL` 秒。
 *   在线时长按 `IDLE.ONLINE_MULTIPLIER` 倍率计量，所以实际比 1:1 快，
 *   但「没等就领」必然是 0 次——这里按掷奖节奏等待并重试。
 *
 * @param minRolls 本次至少要拿到的掷奖次数（默认 1）
 */
export async function claimIdleThroughUi(
  page: Page,
  options: { minRolls?: number; timeoutMs?: number } = {},
): Promise<IdleActionResult> {
  const minRolls = options.minRolls ?? 1
  const timeoutMs = options.timeoutMs ?? 120_000
  const deadline = Date.now() + timeoutMs

  const claim = page.getByTestId('idle-claim-all')
  const onExpedition = await claim
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (!onExpedition) {
    await page.goto('/#/expedition')
    await page.waitForLoadState('networkidle')
  }
  await expect(claim).toBeVisible()
  await dismissOfflineReport(page)

  let last: IdleActionResult | null = null
  while (Date.now() < deadline) {
    // 真实等一个掷奖节奏（挂机不创造时间）
    await page.waitForTimeout(IDLE.SECONDS_PER_ROLL * 1000)
    const responsePromise = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST') return false
      if (new URL(response.url()).pathname !== '/api/action') return false
      const request = response.request().postDataJSON() as ActionRequest | null
      return request?.action?.type === 'idle.tick'
    })
    await claim.click()
    const response = await responsePromise
    expect(response.ok(), '挂机请求应成功到达真实服务端').toBe(true)
    const body = (await response.json()) as ActionResponse
    expect(body.ok, body.message ?? '挂机动作失败').toBe(true)
    last = body.result as IdleActionResult
    if ((last?.rolls ?? 0) >= minRolls) return last
  }
  throw new Error(`挂机未攒够 ${minRolls} 次掷奖（最后一次 ${last?.rolls ?? 0} 次）`)
}

/** 本地缓存里常用的一小片字段 */
export interface CachedSave {
  savedAt?: number
  stats?: { totalPulls: number }
  player?: {
    crystals: number
    silver?: number
    shards?: Record<string, number>
  }
  /** 背包堆叠物（经验书 / 五行技能材料 / 三档强化石） */
  items?: Record<string, number>
  heroes?: Record<string, { level: number; exp: number }>
  /** 主线进度（副本**不写**这里 → 分开记账的判据） */
  campaign?: { clearedStage: number; chapterProgress?: number }
  /**
   * 挂机账本（**四条通道各自独立**，挂机改版 v11 / 遗物副本 v12）。
   *
   * ⚠ 主线通道的 `stageId = null` = 「跟随最新通关关卡」。
   */
  idle?: {
    channels: {
      main: { target: { kind: 'main'; stageId: number | null } | null }
      skill: { target: { kind: 'skill'; dungeonStageId: string } | null }
      enhance: { target: { kind: 'enhance'; dungeonStageId: string } | null }
      /** 遗物副本通道（存档 v12 · 第 4 条） */
      relic: { target: { kind: 'relic'; dungeonStageId: string } | null }
    }
    totalIdleSeconds?: number
  }
  /** 副本通关记录（与主线分开记账） */
  dungeons?: { cleared: Record<string, boolean> }
  relics?: Array<{ defId: string; uid: string; level: number }>
  equipped?: Record<string, { heroId: string }>
  settings?: { speed?: number }
}

/**
 * 奖励包里的**经验总量**（经验书折算）。
 *
 * ⚠ 资源/背包版本 v10：玩家经验池退役 → 经验由「经验书」产出，
 *   奖励包里没有 `exp` 字段，只有一叠叠经验书（`rewards.items`）。
 */
export function expOfRewards(rewards: { items?: Record<string, number> }): number {
  const small = rewards.items?.expBookSmall ?? 0
  const large = rewards.items?.expBookLarge ?? 0
  return small * 1_000 + large * 10_000
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
 * 「仓库里有几件」不能看本地缓存——那会永远显示 0 或几十。
 *
 * ⚠ 刷新方式必须是「换一个路由再回来」，不能 `page.reload()`：
 *   整页重载会触发 `GET /api/save`，服务端趁这次载入补算挂机收益
 *   → 仓库/背包件数凭空多出几件，「这一轮掉了几件」的对账就算不准了。
 *   同理也不能 goto 到**当前就在的**那个 hash（可能整页重载）。
 */
export async function relicTotal(page: Page): Promise<number> {
  const onForge = page.url().includes('/#/forge')
  if (onForge) {
    // 已经在铸造页：先离开再回来，逼页面重新拉一次服务端统计
    await page.goto('/#/formation')
  }
  // ⚠ **读服务端回包，不要从 DOM 上刮数字**：
  //   `relic-total` 一进页面就渲染（先是 0），只等「可见」会读到**还没刷新的 0**
  //   → 偶发失败（实测踩到过一次「仓库多了一件却断言 0」）。
  //   这里等仓库请求真的回来，直接取权威 `total`（与 `serverRelics` 同一套路）。
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/relics'),
    page.goto('/#/forge'),
  ])
  const body = (await response.json()) as ServerRelicPage
  await page.getByTestId('relic-total').waitFor({ state: 'visible', timeout: 8000 })
  return body.total
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
