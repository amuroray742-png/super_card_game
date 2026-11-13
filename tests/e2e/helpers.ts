import type { Page } from '@playwright/test'

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
