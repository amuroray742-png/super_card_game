/**
 * 账号配置与账号适配层单测。
 *
 * 覆盖：用户名/口令规则、归一化、错误码文案、
 * 后端地址解析、会话落盘、HTTP 错误映射、存档冲突返回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
  it('默认走 core 配置里的地址', () => {
    expect(resolveApiBase()).toBe('http://127.0.0.1:8787')
  })

  it('localStorage 覆盖优先，并去掉末尾斜杠', () => {
    writeApiBaseOverride('https://api.example.com/')
    expect(resolveApiBase()).toBe('https://api.example.com')
    expect(readApiBaseOverride()).toBe('https://api.example.com')
  })

  it('写空串表示清除覆盖', () => {
    writeApiBaseOverride('https://api.example.com')
    writeApiBaseOverride('')
    expect(readApiBaseOverride()).toBe('')
    expect(resolveApiBase()).toBe('http://127.0.0.1:8787')
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

  it('推送云存档：服务端版本更新时返回冲突', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        jsonResponse(409, {
          error: 'STALE_SAVE',
          server: { payload: '{"v":"new"}', savedAt: 2000 },
        }),
      ),
    )
    const result = await client.pushSave('at', '{"v":"old"}', 1000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.conflict).toBe(true)
      expect(result.server.savedAt).toBe(2000)
      expect(result.server.payload).toBe('{"v":"new"}')
    }
  })

  it('推送云存档：正常写入', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse(200, { savedAt: 1000 })))
    const result = await client.pushSave('at', '{"v":1}', 1000)
    expect(result.ok).toBe(true)
  })
})
