/**
 * 账号适配层：与后端认证 / 云存档通信的**唯一出口**。
 *
 * 铁律：表现层（presentation）**不得**直接 fetch 后端接口，一律经本模块。
 * 本模块属于 platform 层，可以直接读写 localStorage（铁律 #6）。
 *
 * 错误处理约定：后端统一返回 `{ error: <错误码>, message?: string }`，
 * 本模块把非 2xx 响应转成 `AccountError`（携带错误码），
 * 由表现层按 `ACCOUNT_ERROR_MESSAGES` 映射成对外文案。
 */
import {
  ACCOUNT,
  ACCOUNT_ERROR_CODES,
  ACCOUNT_STORAGE_KEYS,
  type AccountErrorCode,
} from '../core/config/account.ts'

/** 账号信息 */
export interface AccountUser {
  id: number
  username: string
}

/** 一次签发返回的令牌对 */
export interface AuthResult {
  user: AccountUser
  accessToken: string
  refreshToken: string
  /** access token 有效期（秒） */
  expiresIn: number
}

/** 云端存档的一份快照 */
export interface CloudSave {
  /** 序列化后的存档文本 */
  payload: string
  /** 存档版本时间戳（越大越新） */
  savedAt: number
}

/** 推送结果：写入成功，或服务端版本更新（冲突） */
export type PushSaveResult =
  | { ok: true; savedAt: number }
  | { ok: false; conflict: true; server: CloudSave }

/** 本地保存的会话（只有 refresh token 落盘，access token 只在内存里） */
export interface StoredSession {
  refreshToken: string
  user: AccountUser
}

/** 账号接口错误 */
export class AccountError extends Error {
  readonly code: AccountErrorCode
  readonly statusCode: number

  constructor(code: AccountErrorCode, statusCode: number, message?: string) {
    super(message ?? code)
    this.name = 'AccountError'
    this.code = code
    this.statusCode = statusCode
  }
}

/** localStorage 在无存储环境（SSR / 测试）下可能不存在 */
function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/**
 * 解析后端地址。
 *
 * 优先级：`localStorage['sgw.apiBase']` → `VITE_API_BASE` → 默认值。
 * 放在 localStorage 是为了让**静态托管**的同一份构建指向不同后端，
 * 也让 E2E 不必跨平台设置环境变量。
 */
export function resolveApiBase(): string {
  const override = store()?.getItem(ACCOUNT_STORAGE_KEYS.API_BASE)?.trim()
  const fromEnv = import.meta.env?.VITE_API_BASE ? String(import.meta.env.VITE_API_BASE) : ''
  const raw = override || fromEnv || ACCOUNT.DEFAULT_API_BASE
  return raw.replace(/\/+$/, '')
}

/** 读取本地会话；损坏的存档按「没有会话」处理 */
export function readStoredSession(): StoredSession | null {
  const text = store()?.getItem(ACCOUNT_STORAGE_KEYS.SESSION)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Partial<StoredSession>
    if (typeof parsed?.refreshToken !== 'string' || !parsed.refreshToken) return null
    if (typeof parsed?.user?.id !== 'number') return null
    return {
      refreshToken: parsed.refreshToken,
      user: { id: parsed.user.id, username: String(parsed.user.username ?? '') },
    }
  } catch {
    return null
  }
}

/** 落盘会话 */
export function writeStoredSession(session: StoredSession): void {
  store()?.setItem(ACCOUNT_STORAGE_KEYS.SESSION, JSON.stringify(session))
}

/** 清除本地会话（登出 / 会话失效） */
export function clearStoredSession(): void {
  store()?.removeItem(ACCOUNT_STORAGE_KEYS.SESSION)
}

/** 读取后端地址覆盖值（设置页展示用） */
export function readApiBaseOverride(): string {
  return store()?.getItem(ACCOUNT_STORAGE_KEYS.API_BASE)?.trim() ?? ''
}

/** 写入后端地址覆盖值；传空串表示清除 */
export function writeApiBaseOverride(value: string): void {
  const s = store()
  if (!s) return
  const trimmed = value.trim()
  if (!trimmed) {
    s.removeItem(ACCOUNT_STORAGE_KEYS.API_BASE)
    return
  }
  s.setItem(ACCOUNT_STORAGE_KEYS.API_BASE, trimmed.replace(/\/+$/, ''))
}

/**
 * 后端 API 客户端。
 *
 * 只做「发请求 → 解析错误码」，不做令牌轮换与会话持久化——
 * 那是表现层 `stores/account.ts` 的职责，两层职责不混。
 */
export class AccountClient {
  /** 显式指定的后端地址；为空时每次请求都重新解析（设置页改了地址立刻生效） */
  private readonly override: string | null

  constructor(override?: string | null) {
    this.override = override ?? null
  }

  get baseUrl(): string {
    return (this.override ?? resolveApiBase()).replace(/\/+$/, '')
  }

  private async request<T>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: T | null }> {
    const headers: Record<string, string> = {}
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.token) headers.authorization = `Bearer ${options.token}`

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      })
    } catch {
      throw new AccountError(ACCOUNT_ERROR_CODES.NETWORK, 0)
    }

    const text = await res.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    return { status: res.status, body: body as T | null }
  }

  /** 把非 2xx 响应转成 AccountError */
  private fail(status: number, body: unknown): never {
    const code = (body as { error?: string } | null)?.error
    const known = Object.values(ACCOUNT_ERROR_CODES).includes(code as AccountErrorCode)
    throw new AccountError(
      known ? (code as AccountErrorCode) : ACCOUNT_ERROR_CODES.INTERNAL,
      status,
    )
  }

  /** 注册新账号 */
  async register(username: string, password: string): Promise<AuthResult> {
    const { status, body } = await this.request<AuthResult>('POST', '/api/auth/register', {
      body: { username, password },
    })
    if (status !== 201 || !body) this.fail(status, body)
    return body
  }

  /** 登录 */
  async login(username: string, password: string): Promise<AuthResult> {
    const { status, body } = await this.request<AuthResult>('POST', '/api/auth/login', {
      body: { username, password },
    })
    if (status !== 200 || !body) this.fail(status, body)
    return body
  }

  /** 刷新令牌（服务端会轮换 refresh token） */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const { status, body } = await this.request<AuthResult>('POST', '/api/auth/refresh', {
      body: { refreshToken },
    })
    if (status !== 200 || !body) this.fail(status, body)
    return body
  }

  /** 登出（吊销 refresh token） */
  async logout(refreshToken: string): Promise<void> {
    const { status, body } = await this.request<null>('POST', '/api/auth/logout', {
      body: { refreshToken },
    })
    if (status !== 204) this.fail(status, body)
  }

  /** 当前账号 */
  async me(accessToken: string): Promise<AccountUser> {
    const { status, body } = await this.request<{ user: AccountUser }>('GET', '/api/auth/me', {
      token: accessToken,
    })
    if (status !== 200 || !body?.user) this.fail(status, body)
    return body.user
  }

  /** 拉取云存档；服务端还没有存档时返回 null */
  async pullSave(accessToken: string): Promise<CloudSave | null> {
    const { status, body } = await this.request<CloudSave>('GET', '/api/save', { token: accessToken })
    if (status === 404) return null
    if (status !== 200 || !body) this.fail(status, body)
    return { payload: body.payload, savedAt: body.savedAt }
  }

  /** 推送云存档；服务端版本更新时返回冲突结果 */
  async pushSave(accessToken: string, payload: string, savedAt: number): Promise<PushSaveResult> {
    const { status, body } = await this.request<{
      savedAt?: number
      server?: CloudSave
    }>('PUT', '/api/save', { token: accessToken, body: { payload, savedAt } })
    if (status === 409) {
      const server = (body as { server?: CloudSave } | null)?.server
      if (!server) this.fail(status, body)
      return { ok: false, conflict: true, server: { payload: server.payload, savedAt: server.savedAt } }
    }
    if (status !== 200) this.fail(status, body)
    return { ok: true, savedAt: body?.savedAt ?? savedAt }
  }

  /** 注销账号（服务端级联删除账号 / 会话 / 存档） */
  async deleteAccount(accessToken: string): Promise<void> {
    const { status, body } = await this.request<null>('DELETE', '/api/account', { token: accessToken })
    if (status !== 204) this.fail(status, body)
  }
}

/** 默认客户端实例（后端地址在构造时解析一次） */
export const accountClient = new AccountClient()
