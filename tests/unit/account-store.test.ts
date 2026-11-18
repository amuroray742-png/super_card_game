/**
 * 会话 Store 单测：恢复 / 登录 / 登出 / 401 自动续期。
 *
 * 用真实的 `accountClient` 单例 + spy 替换网络方法，
 * 覆盖的是 store 自己的逻辑（令牌轮换、落盘、错误文案），不重复测 HTTP 细节。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAccountStore } from '../../src/presentation/stores/account.ts'
import { AccountError, accountClient } from '../../src/platform/account.ts'
import { ACCOUNT_STORAGE_KEYS, accountSlotKey } from '../../src/core/config/account.ts'
import { storage } from '../../src/platform/storage.ts'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }
  get length(): number {
    return this.map.size
  }
}

const AUTH = {
  user: { id: 3, username: 'tester' },
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresIn: 900,
}

beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage
  setActivePinia(createPinia())
  vi.restoreAllMocks()
})

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage
  vi.restoreAllMocks()
})

describe('会话恢复', () => {
  it('本地没有会话 → 未登录', async () => {
    const store = useAccountStore()
    await store.ensureRestored()
    expect(store.status).toBe('guest')
    expect(store.isAuthenticated).toBe(false)
  })

  it('有会话 → 刷新令牌并进入已登录', async () => {
    localStorage.setItem(
      ACCOUNT_STORAGE_KEYS.SESSION,
      JSON.stringify({ refreshToken: 'rt-old', user: { id: 3, username: 'tester' } }),
    )
    const refresh = vi.spyOn(accountClient, 'refresh').mockResolvedValue(AUTH)

    const store = useAccountStore()
    await store.ensureRestored()

    expect(refresh).toHaveBeenCalledWith('rt-old')
    expect(store.status).toBe('authenticated')
    expect(store.user?.username).toBe('tester')
    expect(store.accessToken).toBe('at-1')
  })

  it('服务端判定会话失效 → 清掉本地会话', async () => {
    localStorage.setItem(
      ACCOUNT_STORAGE_KEYS.SESSION,
      JSON.stringify({ refreshToken: 'rt-old', user: { id: 3, username: 'tester' } }),
    )
    vi.spyOn(accountClient, 'refresh').mockRejectedValue(
      new AccountError('UNAUTHORIZED', 401),
    )

    const store = useAccountStore()
    await store.ensureRestored()

    expect(store.status).toBe('guest')
    expect(localStorage.getItem(ACCOUNT_STORAGE_KEYS.SESSION)).toBeNull()
  })

  it('网络不通时保留本地会话（不把玩家踢下线，进离线只读模式）', async () => {
    localStorage.setItem(
      ACCOUNT_STORAGE_KEYS.SESSION,
      JSON.stringify({ refreshToken: 'rt-old', user: { id: 3, username: 'tester' } }),
    )
    vi.spyOn(accountClient, 'refresh').mockRejectedValue(
      new AccountError('NETWORK', 0),
    )

    const store = useAccountStore()
    await store.ensureRestored()

    // 断网不该把玩家挡在门外：身份保留，进入离线模式（能看进度，不能操作）
    expect(store.status).toBe('authenticated')
    expect(store.offline).toBe(true)
    expect(store.user?.id).toBe(3)
    expect(localStorage.getItem(ACCOUNT_STORAGE_KEYS.SESSION)).not.toBeNull()
    expect(store.error).toBeTruthy()
  })

  it('网络恢复后自动续上（离线模式在导航时重试恢复）', async () => {
    localStorage.setItem(
      ACCOUNT_STORAGE_KEYS.SESSION,
      JSON.stringify({ refreshToken: 'rt-old', user: { id: 3, username: 'tester' } }),
    )
    const refresh = vi
      .spyOn(accountClient, 'refresh')
      .mockRejectedValueOnce(new AccountError('NETWORK', 0))

    const store = useAccountStore()
    await store.ensureRestored()
    expect(store.offline).toBe(true)

    // 网络恢复
    refresh.mockResolvedValue(AUTH)
    await store.ensureRestored()
    expect(store.offline).toBe(false)
    expect(store.accessToken).toBe('at-1')
  })

  it('多次调用只真正恢复一次', async () => {
    localStorage.setItem(
      ACCOUNT_STORAGE_KEYS.SESSION,
      JSON.stringify({ refreshToken: 'rt-old', user: { id: 3, username: 'tester' } }),
    )
    const refresh = vi.spyOn(accountClient, 'refresh').mockResolvedValue(AUTH)
    const store = useAccountStore()
    await Promise.all([store.ensureRestored(), store.ensureRestored(), store.ensureRestored()])
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('登录与登出', () => {
  it('登录成功 → 已登录并落盘会话', async () => {
    vi.spyOn(accountClient, 'login').mockResolvedValue(AUTH)
    const store = useAccountStore()

    const ok = await store.login('tester', 'correct-horse-1')
    expect(ok).toBe(true)
    expect(store.isAuthenticated).toBe(true)
    expect(localStorage.getItem(ACCOUNT_STORAGE_KEYS.SESSION)).toContain('rt-1')
  })

  it('登录失败 → 保持未登录并给出文案', async () => {
    vi.spyOn(accountClient, 'login').mockRejectedValue(
      new AccountError('INVALID_CREDENTIALS', 401),
    )
    const store = useAccountStore()

    const ok = await store.login('tester', 'wrong-one')
    expect(ok).toBe(false)
    expect(store.status).not.toBe('authenticated')
    expect(store.error).toBe('用户名或口令不正确')
  })

  it('登出 → 吊销服务端会话并清掉本地会话', async () => {
    vi.spyOn(accountClient, 'login').mockResolvedValue(AUTH)
    const logout = vi.spyOn(accountClient, 'logout').mockResolvedValue(undefined)
    const store = useAccountStore()
    await store.login('tester', 'correct-horse-1')

    await store.logout()

    expect(logout).toHaveBeenCalledWith('rt-1')
    expect(store.status).toBe('guest')
    expect(localStorage.getItem(ACCOUNT_STORAGE_KEYS.SESSION)).toBeNull()
  })

  it('服务端吊销失败也照样清掉本地会话', async () => {
    vi.spyOn(accountClient, 'login').mockResolvedValue(AUTH)
    vi.spyOn(accountClient, 'logout').mockRejectedValue(new Error('network down'))
    const store = useAccountStore()
    await store.login('tester', 'correct-horse-1')

    await store.logout()
    expect(store.status).toBe('guest')
  })
})

describe('401 自动续期', () => {
  it('令牌失效时自动换新令牌并重试一次', async () => {
    vi.spyOn(accountClient, 'login').mockResolvedValue(AUTH)
    const refresh = vi.spyOn(accountClient, 'refresh').mockResolvedValue({
      ...AUTH,
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    })
    const pullSave = vi
      .spyOn(accountClient, 'pullSave')
      .mockRejectedValueOnce(new AccountError('UNAUTHORIZED', 401))
      .mockResolvedValueOnce({ payload: '{"v":4}', savedAt: 7 })

    const store = useAccountStore()
    await store.login('tester', 'correct-horse-1')

    const cloud = await store.pullCloudSave()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(cloud?.savedAt).toBe(7)
    expect(store.accessToken).toBe('at-2')
    expect(pullSave).toHaveBeenCalledTimes(2)
  })
})

describe('注销账号', () => {
  it('离线恢复只有缓存时拒绝注销，保留本机会话与缓存', async () => {
    localStorage.setItem(ACCOUNT_STORAGE_KEYS.SESSION, JSON.stringify({ refreshToken: 'rt-1', user: AUTH.user }))
    vi.spyOn(accountClient, 'refresh').mockRejectedValue(new AccountError('NETWORK', 0))
    const remove = vi.spyOn(accountClient, 'deleteAccount')
    const clear = vi.spyOn(storage, 'clear')
    const store = useAccountStore()
    await store.ensureRestored()
    expect(store.offline).toBe(true)
    expect(store.accessToken).toBeNull()

    expect(await store.deleteAccount()).toBe(false)
    expect(store.isAuthenticated).toBe(true)
    expect(store.error).toContain('无法连接服务器')
    expect(remove).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(localStorage.getItem(ACCOUNT_STORAGE_KEYS.SESSION)).toContain('rt-1')
  })

  it('注销遇到过期令牌时续期，服务端确认后才清理正确的账号槽位', async () => {
    vi.spyOn(accountClient, 'login').mockResolvedValue(AUTH)
    vi.spyOn(accountClient, 'refresh').mockResolvedValue({ ...AUTH, accessToken: 'at-2', refreshToken: 'rt-2' })
    const remove = vi.spyOn(accountClient, 'deleteAccount')
      .mockRejectedValueOnce(new AccountError('UNAUTHORIZED', 401))
      .mockResolvedValueOnce(undefined)
    const clear = vi.spyOn(storage, 'clear')
    const store = useAccountStore()
    await store.login('tester', 'correct-horse-1')

    expect(await store.deleteAccount()).toBe(true)
    expect(remove.mock.calls).toEqual([['at-1'], ['at-2']])
    expect(clear).toHaveBeenCalledExactlyOnceWith(accountSlotKey(AUTH.user.id))
    expect(remove.mock.invocationCallOrder[1]).toBeLessThan(clear.mock.invocationCallOrder[0])
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem(ACCOUNT_STORAGE_KEYS.SESSION)).toBeNull()
  })
})
