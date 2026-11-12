/**
 * 会话 Store：账号状态与令牌生命周期。
 *
 * 分工：
 * - `src/platform/account.ts` 只负责「发请求 → 解析错误码」
 * - 本 store 负责「令牌轮换 / 会话落盘 / 401 自动续期 / 对外错误文案」
 *
 * 铁律：表现层不得直接 fetch 后端接口，一律经 platform/account.ts。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  ACCOUNT_ERROR_CODES,
  ACCOUNT_ERROR_MESSAGES,
  type AccountErrorCode,
} from '../../core/config/account.ts'
import {
  AccountError,
  accountClient,
  clearStoredSession,
  readStoredSession,
  writeStoredSession,
  type AccountUser,
  type AuthResult,
  type CloudSave,
  type PushSaveResult,
} from '../../platform/account.ts'

export type AccountStatus = 'unknown' | 'guest' | 'authenticated'

/** 把任意异常翻译成对外文案（按错误码映射，不回显后端 message） */
export function describeAccountError(err: unknown): string {
  if (err instanceof AccountError) return ACCOUNT_ERROR_MESSAGES[err.code]
  return ACCOUNT_ERROR_MESSAGES.INTERNAL
}

export const useAccountStore = defineStore('account', () => {
  /** 当前账号；未登录为 null */
  const user = ref<AccountUser | null>(null)
  /** 会话状态：unknown = 尚未恢复，guest = 未登录，authenticated = 已登录 */
  const status = ref<AccountStatus>('unknown')
  /** 面向玩家的错误提示 */
  const error = ref<string | null>(null)
  /** 正在提交（登录 / 注册 / 登出） */
  const busy = ref(false)
  /** access token 只在内存里，不落盘 */
  const accessToken = ref<string | null>(null)

  const isAuthenticated = computed(() => status.value === 'authenticated' && user.value !== null)

  let restoreTask: Promise<void> | null = null

  function applyAuth(auth: AuthResult): void {
    user.value = auth.user
    accessToken.value = auth.accessToken
    writeStoredSession({ refreshToken: auth.refreshToken, user: auth.user })
  }

  function clearSession(): void {
    user.value = null
    accessToken.value = null
    clearStoredSession()
    status.value = 'guest'
  }

  /**
   * 恢复会话：拿本地存的 refresh token 换一对新令牌。
   *
   * 只有服务端明确回了 UNAUTHORIZED 才清掉本地会话——网络不通时**保留**
   * refresh token，避免一次断网就把玩家的登录状态抹掉。
   */
  async function restore(): Promise<void> {
    const stored = readStoredSession()
    if (!stored) {
      status.value = 'guest'
      return
    }
    try {
      const auth = await accountClient.refresh(stored.refreshToken)
      applyAuth(auth)
      status.value = 'authenticated'
      error.value = null
    } catch (err) {
      if (err instanceof AccountError && err.code === ACCOUNT_ERROR_CODES.UNAUTHORIZED) {
        clearStoredSession()
        user.value = null
        accessToken.value = null
      }
      status.value = 'guest'
      error.value = describeAccountError(err)
    }
  }

  /** 幂等：多处调用只会真正恢复一次 */
  async function ensureRestored(): Promise<void> {
    if (status.value !== 'unknown') return
    if (!restoreTask) {
      restoreTask = restore().finally(() => {
        restoreTask = null
      })
    }
    await restoreTask
  }

  /** 登录 */
  async function login(username: string, password: string): Promise<boolean> {
    busy.value = true
    error.value = null
    try {
      const auth = await accountClient.login(username, password)
      applyAuth(auth)
      status.value = 'authenticated'
      return true
    } catch (err) {
      error.value = describeAccountError(err)
      return false
    } finally {
      busy.value = false
    }
  }

  /** 注册（注册成功即视为已登录，服务端直接签发令牌） */
  async function register(username: string, password: string): Promise<boolean> {
    busy.value = true
    error.value = null
    try {
      const auth = await accountClient.register(username, password)
      applyAuth(auth)
      status.value = 'authenticated'
      return true
    } catch (err) {
      error.value = describeAccountError(err)
      return false
    } finally {
      busy.value = false
    }
  }

  /** 登出：吊销服务端会话并清掉本地会话 */
  async function logout(): Promise<void> {
    busy.value = true
    try {
      const stored = readStoredSession()
      if (stored) {
        try {
          await accountClient.logout(stored.refreshToken)
        } catch {
          // 服务端吊销失败也要清掉本地会话，否则玩家会一直卡在「已登录」
        }
      }
      clearSession()
      error.value = null
    } finally {
      busy.value = false
    }
  }

  /** 注销账号（服务端级联删除账号 / 会话 / 存档） */
  async function deleteAccount(): Promise<boolean> {
    busy.value = true
    error.value = null
    try {
      const token = accessToken.value
      if (!token) {
        clearSession()
        return true
      }
      await accountClient.deleteAccount(token)
      clearSession()
      return true
    } catch (err) {
      error.value = describeAccountError(err)
      return false
    } finally {
      busy.value = false
    }
  }

  /** 用当前 access token 调后端；遇 401 自动续期一次再重试 */
  async function authorized<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = accessToken.value
    if (!token) throw new AccountError(ACCOUNT_ERROR_CODES.UNAUTHORIZED, 401)
    try {
      return await fn(token)
    } catch (err) {
      const unauthorized =
        err instanceof AccountError && err.code === ACCOUNT_ERROR_CODES.UNAUTHORIZED
      if (!unauthorized) throw err
      await refreshSession()
      const fresh = accessToken.value
      if (!fresh) throw err
      return await fn(fresh)
    }
  }

  /** 主动续期（服务端会轮换 refresh token，本地同步覆盖） */
  async function refreshSession(): Promise<void> {
    const stored = readStoredSession()
    if (!stored) throw new AccountError(ACCOUNT_ERROR_CODES.UNAUTHORIZED, 401)
    const auth = await accountClient.refresh(stored.refreshToken)
    applyAuth(auth)
    status.value = 'authenticated'
  }

  /** 拉取云存档；服务端还没有存档时返回 null */
  async function pullCloudSave(): Promise<CloudSave | null> {
    return authorized((token) => accountClient.pullSave(token))
  }

  /** 推送云存档；服务端版本更新时返回冲突结果 */
  async function pushCloudSave(payload: string, savedAt: number): Promise<PushSaveResult> {
    return authorized((token) => accountClient.pushSave(token, payload, savedAt))
  }

  return {
    user,
    status,
    error,
    busy,
    accessToken,
    isAuthenticated,
    ensureRestored,
    restore,
    login,
    register,
    logout,
    deleteAccount,
    refreshSession,
    pullCloudSave,
    pushCloudSave,
  }
})

export type { AccountErrorCode }
