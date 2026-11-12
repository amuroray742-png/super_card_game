/**
 * 服务端认证与会话单测（注册 / 登录 / 刷新 / 登出 / 频率限制）。
 *
 * 用 `:memory:` 库 + `app.inject()`，不占端口、不落盘。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'
import { hashPassword, verifyPassword } from '../../../server/src/password.ts'

let bundle: AppBundle

function makeApp(): AppBundle {
  return buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    corsOrigins: ['http://127.0.0.1:4173'],
  })
}

const PASSWORD = 'correct-horse-1'

async function register(username = 'tester', password = PASSWORD) {
  return bundle.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password },
  })
}

beforeEach(() => {
  bundle = makeApp()
})

afterEach(async () => {
  await bundle.close()
})

describe('注册', () => {
  it('注册成功并签发双令牌', async () => {
    const res = await register()
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.user.username).toBe('tester')
    expect(typeof body.accessToken).toBe('string')
    expect(typeof body.refreshToken).toBe('string')
    expect(body.expiresIn).toBe(900)
  })

  it('用户名重复 → 409', async () => {
    await register()
    const res = await register()
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('USERNAME_TAKEN')
  })

  it('用户名大小写不同视为同一账号', async () => {
    const first = await register('Tester')
    expect(first.statusCode).toBe(201)
    // 入库统一小写，展示也统一小写
    expect(first.json().user.username).toBe('tester')
    const res = await register('tester')
    expect(res.statusCode).toBe(409)
  })

  it('弱口令 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'tester', password: 'short' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('INVALID_PAYLOAD')
  })

  it('非法用户名 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: '名字带中文', password: PASSWORD },
    })
    expect(res.statusCode).toBe(400)
  })

  it('响应里不回显口令或哈希', async () => {
    const res = await register()
    expect(res.body).not.toContain(PASSWORD)
    expect(res.body).not.toContain('scrypt')
  })
})

describe('口令哈希', () => {
  it('同一口令两次哈希不同（随机盐）', async () => {
    const a = await hashPassword(PASSWORD)
    const b = await hashPassword(PASSWORD)
    expect(a).not.toBe(b)
    expect(a.startsWith('scrypt$')).toBe(true)
  })

  it('校验通过 / 失败', async () => {
    const stored = await hashPassword(PASSWORD)
    expect(await verifyPassword(PASSWORD, stored)).toBe(true)
    expect(await verifyPassword('wrong-password', stored)).toBe(false)
  })

  it('哈希串损坏时判定失败而不是抛错', async () => {
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false)
  })
})

describe('登录', () => {
  it('正确口令 → 200 并签发双令牌', async () => {
    await register()
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'tester', password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().accessToken).toBe('string')
  })

  it('口令错误 → 401', async () => {
    await register()
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'tester', password: 'wrong-password' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('INVALID_CREDENTIALS')
  })

  it('用户不存在与口令错误返回同一错误码（防账号枚举）', async () => {
    const missing = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: PASSWORD },
    })
    await register()
    const wrong = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'tester', password: 'wrong-password' },
    })
    expect(missing.statusCode).toBe(401)
    expect(wrong.statusCode).toBe(401)
    expect(missing.json().error).toBe(wrong.json().error)
  })

  it('连续失败触发频率限制 → 429', async () => {
    await register()
    for (let i = 0; i < 5; i++) {
      await bundle.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'tester', password: 'wrong-password' },
      })
    }
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'tester', password: 'wrong-password' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.json().error).toBe('RATE_LIMITED')
  })
})

describe('刷新与登出', () => {
  it('刷新成功并轮换 refresh token', async () => {
    const reg = (await register()).json()
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: reg.refreshToken },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.refreshToken).not.toBe(reg.refreshToken)
    expect(typeof body.accessToken).toBe('string')
  })

  it('旧 refresh token 轮换后失效 → 401', async () => {
    const reg = (await register()).json()
    await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: reg.refreshToken },
    })
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: reg.refreshToken },
    })
    expect(res.statusCode).toBe(401)
  })

  it('登出后 refresh 失效 → 401', async () => {
    const reg = (await register()).json()
    const out = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: { refreshToken: reg.refreshToken },
    })
    expect(out.statusCode).toBe(204)
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: reg.refreshToken },
    })
    expect(res.statusCode).toBe(401)
  })

  it('伪造的 access token → 401', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer forged.token.value' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('缺少令牌时 me → 401', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.statusCode).toBe(401)
  })

  it('me 返回当前账号', async () => {
    const reg = (await register()).json()
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${reg.accessToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.username).toBe('tester')
  })
})
