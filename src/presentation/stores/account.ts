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
  accountSlotKey,
  type AccountErrorCode,
} from '../../core/config/account.ts'
import {
  AccountError,
  accountClient,
  clearStoredSession,
  readApiBaseOverride,
  readStoredSession,
  resolveApiBase,
  writeApiBaseOverride,
  writeStoredSession,
  type AccountUser,
  type AuthResult,
  type CloudSave,
  type RelicPage,
  type RelicStats,
} from '../../platform/account.ts'
import { storage } from '../../platform/storage.ts'
import type { GameAction } from '../../core/systems/actions.ts'
import type { ActionResponse } from '../../core/systems/action-protocol.ts'
import type { RelicInstance } from '../../core/model/types.ts'
import type { RelicAdvice } from '../../core/systems/relic-advice.ts'

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
  /**
   * 离线：连不上服务器，但本地还有会话。
   *
   * 此时**不踢回登录页**——移动端断网时不该把玩家挡在门外，
   * 而是让他进游戏看进度（只读），等网络恢复再自动续上（铁律 #28）。
   */
  const offline = ref(false)
  /** 面向玩家的错误提示 */
  const error = ref<string | null>(null)
  /** 正在提交（登录 / 注册 / 登出） */
  const busy = ref(false)
  /** access token 只在内存里，不落盘 */
  const accessToken = ref<string | null>(null)

  const isAuthenticated = computed(() => status.value === 'authenticated' && user.value !== null)

  /**
   * **后端地址覆盖**（`localStorage['sgw.apiBase']`）。
   *
   * ⚠ 必须放在 **ref** 里，不能让界面直接读 `localStorage`：
   *   `computed(() => resolveApiBase())` 没有任何响应式依赖 ⇒ 只算一次、
   *   **之后再也不会更新** ⇒ 改完地址，界面显示的还是旧值。
   */
  const apiBaseOverride = ref(readApiBaseOverride())

  /** 当前生效的后端地址（登录页与设置页的唯一显示来源） */
  const apiBase = computed(() => apiBaseOverride.value || resolveApiBase())

  /**
   * 后端地址的**显示文案**。
   *
   * ⚠ 空串 = 同源（请求走当前域名，由反代转发）⇒ 直接显示会是一片空白，
   *   玩家会以为「地址没配好」。写清楚。
   */
  const apiBaseLabel = computed(() => apiBase.value || '同源（当前域名）')

  /**
   * 保存后端地址（传空串 = 清除覆盖，回到环境变量 / 默认值）。
   *
   * ⚠ **登录前也要能改**：设置页在路由守卫后面 ⇒ 连不上后端时玩家
   *   进不去设置页，就没法改地址 ⇒ 死路。所以登录页也提供同一个入口。
   */
  function saveApiBase(value: string): void {
    writeApiBaseOverride(value)
    // ⚠ 与落盘口径保持一致（去掉末尾斜杠）：显示的地址与实际请求地址不能两套。
    apiBaseOverride.value = value.trim().replace(/\/+$/, '')
  }

  let restoreTask: Promise<void> | null = null

  function applyAuth(auth: AuthResult): void {
    user.value = auth.user
    accessToken.value = auth.accessToken
    offline.value = false
    writeStoredSession({ refreshToken: auth.refreshToken, user: auth.user })
  }

  function clearSession(): void {
    user.value = null
    accessToken.value = null
    offline.value = false
    clearStoredSession()
    status.value = 'guest'
  }

  /**
   * 恢复会话：拿本地存的 refresh token 换一对新令牌。
   *
   * 只有服务端明确回了 UNAUTHORIZED 才清掉本地会话——网络不通时**保留**
   * refresh token，避免一次断网就把玩家的登录状态抹掉；
   * 此时进入**离线模式**（能看进度，不能操作）。
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
        status.value = 'guest'
      } else if (err instanceof AccountError && err.code === ACCOUNT_ERROR_CODES.NETWORK) {
        // 连不上服务器 → 离线模式：保留身份，进游戏看进度（只读）
        user.value = stored.user
        accessToken.value = null
        offline.value = true
        status.value = 'authenticated'
      } else {
        status.value = 'guest'
      }
      error.value = describeAccountError(err)
    }
  }

  /** 幂等：多处调用只会真正恢复一次（离线时允许重试——网络可能已恢复） */
  async function ensureRestored(): Promise<void> {
    if (status.value === 'unknown' || offline.value) {
      if (!restoreTask) {
        restoreTask = restore().finally(() => {
          restoreTask = null
        })
      }
      await restoreTask
    }
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
    if (busy.value) return false
    busy.value = true
    error.value = null
    try {
      const accountId = user.value?.id
      if (accountId == null) throw new AccountError(ACCOUNT_ERROR_CODES.UNAUTHORIZED, 401)
      if (offline.value) throw new AccountError(ACCOUNT_ERROR_CODES.NETWORK, 0)
      await authorized((token) => {
        if (user.value?.id !== accountId) throw new AccountError(ACCOUNT_ERROR_CODES.UNAUTHORIZED, 401)
        return accountClient.deleteAccount(token)
      })

      try {
        if (user.value?.id === accountId) clearSession()
        await storage.clear(accountSlotKey(accountId))
      } catch {
        error.value = '云端数据已删除，本机数据清理失败，请清理浏览器站点数据'
      }
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
      if (!unauthorized) {
        // 连不上服务器 → 记为离线（游戏层据此切成只读）
        if (err instanceof AccountError && err.code === ACCOUNT_ERROR_CODES.NETWORK) {
          offline.value = true
        }
        throw err
      }
      await refreshSession()
      const fresh = accessToken.value
      if (!fresh) throw err
      return await fn(fresh)
    }
  }

  /** 主动续期（服务端会轮换 refresh token，本地同步覆盖） */
  async function refreshSession(): Promise<void> {
    const stored = readStoredSession()
    const accountId = user.value?.id
    if (!stored || stored.user.id !== accountId) throw new AccountError(ACCOUNT_ERROR_CODES.UNAUTHORIZED, 401)
    const auth = await accountClient.refresh(stored.refreshToken)
    if (user.value?.id !== accountId || auth.user.id !== accountId) {
      throw new AccountError(ACCOUNT_ERROR_CODES.UNAUTHORIZED, 401)
    }
    applyAuth(auth)
    status.value = 'authenticated'
  }

  /** 拉取云存档（服务端权威版本）；服务端还没有存档时返回 null */
  async function pullCloudSave(): Promise<CloudSave | null> {
    return authorized((token) => accountClient.pullSave(token))
  }

  /**
   * 发送动作意图（服务端权威）。
   *
   * 客户端**不再自己算结果**，只发「我要做什么」；
   * 服务端按同一份 core 规则算完落库，再把结果与新存档回传。
   */
  async function sendAction(actionId: string, action: GameAction): Promise<ActionResponse> {
    return authorized((token) => accountClient.sendAction(token, actionId, action))
  }

  // ─────────────────────── 只读查询（仓库 / 预览 / 导出） ───────────────────────

  /** 仓库分页（服务端权威） */
  async function fetchRelicPage(
    query: {
      page?: number
      size?: number
      rarity?: string
      setId?: string
      defId?: string
      sort?: string
    } = {},
  ): Promise<RelicPage> {
    return authorized((token) => accountClient.fetchRelicPage(token, query))
  }

  /** 遗物统计（仓库总数 / 按定义分组） */
  async function fetchRelicStats(): Promise<RelicStats> {
    return authorized((token) => accountClient.fetchRelicStats(token))
  }

  /** 单件遗物 */
  async function fetchRelicByUid(uid: string): Promise<RelicInstance> {
    return authorized((token) => accountClient.fetchRelicByUid(token, uid))
  }

  /** 遗物推荐预览（与服务端执行同一函数） */
  async function fetchRelicAdvice(heroId: string): Promise<RelicAdvice> {
    return authorized((token) => accountClient.fetchRelicAdvice(token, heroId))
  }

  /** 导出存档串（服务端产出，含全部遗物） */
  async function fetchSaveExport(): Promise<string> {
    return authorized((token) => accountClient.fetchSaveExport(token))
  }

  return {
    user,
    status,
    offline,
    error,
    busy,
    accessToken,
    isAuthenticated,
    apiBase,
    apiBaseLabel,
    apiBaseOverride,
    saveApiBase,
    ensureRestored,
    restore,
    login,
    register,
    logout,
    deleteAccount,
    refreshSession,
    pullCloudSave,
    sendAction,
    fetchRelicPage,
    fetchRelicStats,
    fetchRelicByUid,
    fetchRelicAdvice,
    fetchSaveExport,
  }
})

export type { AccountErrorCode }
