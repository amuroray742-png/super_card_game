/**
 * 账号配置与账号适配层单测。
 *
 * 覆盖：用户名/口令规则、归一化、错误码文案、
 * 后端地址解析、会话落盘、HTTP 错误映射、存档冲突返回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT,
  ACCOUNT_ERROR_CODES,
  ACCOUNT_ERROR_MESSAGES,
  ACCOUNT_STORAGE_KEYS,
  accountSlotKey,
  normalizeUsername,
  validatePassword,
  validateUsername,
} from '../../src/core/config/account.ts'
import {
  AccountClient,
  AccountError,
  clearStoredSession,
  readApiBaseOverride,
  readStoredSession,
  resolveApiBase,
  selectApiBase,
  writeApiBaseOverride,
  writeStoredSession,
} from '../../src/platform/account.ts'

/** 内存版 localStorage（node 环境没有 DOM） */
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

let memory: MemoryStorage

beforeEach(() => {
  memory = new MemoryStorage()
  ;(globalThis as { localStorage?: Storage }).localStorage = memory as unknown as Storage
  vi.restoreAllMocks()
})

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('账号规则', () => {
  it('用户名长度与字符集校验', () => {
    expect(validateUsername('ab')).toContain('至少')
    expect(validateUsername('a'.repeat(17))).toContain('最多')
    expect(validateUsername('名字带中文')).toContain('字母')
    expect(validateUsername('ok_name_1')).toBeNull()
  })

  it('口令长度校验', () => {
    expect(validatePassword('short')).toContain('至少')
    expect(validatePassword('x'.repeat(129))).toContain('最长')
    expect(validatePassword('12345678')).toBeNull()
  })

  it('用户名归一化：去空格 + 转小写', () => {
    expect(normalizeUsername('  Tester  ')).toBe('tester')
    expect(normalizeUsername('TESTER')).toBe('tester')
  })

  it('账号槽位键就是账号 id', () => {
    expect(accountSlotKey(42)).toBe('42')
  })

  it('每个错误码都有对外文案', () => {
    for (const code of Object.values(ACCOUNT_ERROR_CODES)) {
      expect(ACCOUNT_ERROR_MESSAGES[code]).toBeTruthy()
    }
  })
})

describe('后端地址解析', () => {
  it('默认同源（core 默认值是空串，不是 localhost）', () => {
    // ⚠ 必须先把环境变量钉死：本地 `.env` 里若写了 VITE_API_BASE，
    //   断言会随开发机环境飘（这类「跟着环境变」的断言等于没有断言）。
    vi.stubEnv('VITE_API_BASE', undefined)
    expect(resolveApiBase()).toBe('')
    expect(resolveApiBase()).toBe(ACCOUNT.DEFAULT_API_BASE)
  })

  it('localStorage 覆盖优先，并去掉末尾斜杠', () => {
    vi.stubEnv('VITE_API_BASE', undefined)
    writeApiBaseOverride('https://api.example.com/')
    expect(resolveApiBase()).toBe('https://api.example.com')
    expect(readApiBaseOverride()).toBe('https://api.example.com')
  })

  it('写空串表示清除覆盖（回到默认 = 同源）', () => {
    vi.stubEnv('VITE_API_BASE', undefined)
    writeApiBaseOverride('https://api.example.com')
    writeApiBaseOverride('')
    expect(readApiBaseOverride()).toBe('')
    expect(resolveApiBase()).toBe('')
  })

  it('环境变量也能改地址（构建期指定的后端）', () => {
    vi.stubEnv('VITE_API_BASE', 'https://api.example.com')
    expect(resolveApiBase()).toBe('https://api.example.com')
  })
})

describe('后端地址口径（纯函数）', () => {
  it('base 只放后端 origin，不会自动补 /api', () => {
    expect(selectApiBase(null, 'https://api.example.com')).toBe('https://api.example.com')
  })

  it('空串 = 同源（不是「没配置」）', () => {
    expect(selectApiBase(null, '')).toBe('')
    expect(selectApiBase('', undefined)).toBe('')
  })

  it('本地覆盖优先于环境变量', () => {
    expect(selectApiBase('https://a.example.com', 'https://b.example.com')).toBe(
      'https://a.example.com',
    )
  })

  it('都缺省 ⇒ core 默认值（同源）', () => {
    expect(selectApiBase(null, undefined)).toBe(ACCOUNT.DEFAULT_API_BASE)
    expect(ACCOUNT.DEFAULT_API_BASE).toBe('')
  })

  it('末尾斜杠统一去掉', () => {
    expect(selectApiBase('https://api.example.com///', undefined)).toBe('https://api.example.com')
    expect(selectApiBase(null, 'https://api.example.com/')).toBe('https://api.example.com')
  })
})

describe('会话落盘', () => {
  it('写入后可读回', () => {
    writeStoredSession({ refreshToken: 'rt-1', user: { id: 7, username: 'tester' } })
    const stored = readStoredSession()
    expect(stored?.refreshToken).toBe('rt-1')
    expect(stored?.user.id).toBe(7)
  })

  it('清除后读不到', () => {
    writeStoredSession({ refreshToken: 'rt-1', user: { id: 7, username: 'tester' } })
    clearStoredSession()
    expect(readStoredSession()).toBeNull()
  })

  it('损坏的会话按「没有会话」处理', () => {
    memory.setItem(ACCOUNT_STORAGE_KEYS.SESSION, '{不是 json')
    expect(readStoredSession()).toBeNull()
  })
})

/** 造一个假的 fetch 响应 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('后端客户端', () => {
  const client = new AccountClient('http://127.0.0.1:9999')

  it('登录成功返回令牌对', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(200, {
          user: { id: 1, username: 'tester' },
          accessToken: 'at',
          refreshToken: 'rt',
          expiresIn: 900,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const auth = await client.login('tester', 'correct-horse-1')
    expect(auth.accessToken).toBe('at')
    expect(auth.user.username).toBe('tester')
    // 请求体带上了用户名与口令
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      username: 'tester',
      password: 'correct-horse-1',
    })
  })

  it('同源（base 为空）时请求路径不重复 /api 前缀', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse(200, {
        user: { id: 1, username: 'tester' },
        accessToken: 'at',
        refreshToken: 'rt',
        expiresIn: 900,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const sameOrigin = new AccountClient('')
    await sameOrigin.login('tester', 'correct-horse-1')
    // ⚠ 回归：base 若写成 `/api`，这里会变成 `/api/api/auth/login` ⇒ 404。
    //   历史上 Dockerfile 正是这么写的（生产构建每个接口都 404，只有真部署才暴露）。
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/login')
  })

  it('凭据错误 → AccountError(INVALID_CREDENTIALS)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(401, { error: 'INVALID_CREDENTIALS' })),
    )
    await expect(client.login('tester', 'wrong-one')).rejects.toBeInstanceOf(AccountError)
    await expect(client.login('tester', 'wrong-one')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      statusCode: 401,
    })
  })

  it('连不上服务器 → AccountError(NETWORK)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('failed to fetch')),
    )
    await expect(client.login('tester', 'correct-horse-1')).rejects.toMatchObject({
      code: 'NETWORK',
      statusCode: 0,
    })
  })

  it('未知错误码按 INTERNAL 处理', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(418, { error: 'TEAPOT' })),
    )
    await expect(client.login('tester', 'correct-horse-1')).rejects.toMatchObject({
      code: 'INTERNAL',
      statusCode: 418,
    })
  })

  it('拉取云存档：服务端没有存档时返回 null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(404, { error: 'NO_SAVE' })),
    )
    expect(await client.pullSave('at')).toBeNull()
  })

  it('拉取云存档：正常返回快照', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(200, { payload: '{"v":4}', savedAt: 1234 })),
    )
    const cloud = await client.pullSave('at')
    expect(cloud?.payload).toBe('{"v":4}')
    expect(cloud?.savedAt).toBe(1234)
  })

  it('发送动作：业务失败也返回 200（ok:false + 错误码）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        jsonResponse(200, { ok: false, actionId: 'a1', code: 'INSUFFICIENT_FUNDS', message: '余额不足' }),
      ),
    )
    const res = await client.sendAction('at', 'a1', { type: 'daily.signIn' })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('INSUFFICIENT_FUNDS')
  })

  it('发送动作：协议级失败（限流）按错误码抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(429, { error: 'RATE_LIMITED' })),
    )
    await expect(
      client.sendAction('at', 'a1', { type: 'daily.signIn' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 })
  })
})
