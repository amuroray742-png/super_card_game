/**
 * 服务端云存档路由单测（拉取 / 下线 PUT / 越权 / 注销级联）。
 *
 * ⚠ 服务端权威后**没有 PUT 了**：存档的唯一写入入口是 `POST /api/action`。
 *   留一条「客户端整份覆盖」的旁路 = 权威模型失效，所以这里专门守着它没了。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'
import { SAVE_VERSION } from '../../../src/core/save/schema.ts'

let bundle: AppBundle

const PASSWORD = 'correct-horse-1'

beforeEach(() => {
  bundle = buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    corsOrigins: ['http://127.0.0.1:4173'],
  })
})

afterEach(async () => {
  await bundle.close()
})

async function signUp(username: string) {
  const res = await bundle.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  })
  return res.json() as { accessToken: string; refreshToken: string; user: { id: number; username: string } }
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

/** 建档（走动作接口，服务端唯一写入入口） */
async function createSave(token: string) {
  return bundle.app.inject({
    method: 'POST',
    url: '/api/action',
    headers: auth(token),
    payload: { actionId: `create-${Math.random().toString(36).slice(2)}`, action: { type: 'save.create' } },
  })
}

describe('云存档', () => {
  it('尚无存档时 GET → 404 NO_SAVE', async () => {
    const acc = await signUp('alice')
    const res = await bundle.app.inject({ method: 'GET', url: '/api/save', headers: auth(acc.accessToken) })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('NO_SAVE')
  })

  it('建档后 GET 返回服务端权威存档', async () => {
    const acc = await signUp('alice')
    await createSave(acc.accessToken)
    const get = await bundle.app.inject({ method: 'GET', url: '/api/save', headers: auth(acc.accessToken) })
    expect(get.statusCode).toBe(200)
    const body = get.json()
    const save = JSON.parse(body.payload)
    expect(save.version).toBe(SAVE_VERSION)
    expect(save).not.toHaveProperty('rng')
    expect(save.player.crystals).toBe(3000)
    expect(body.savedAt).toBeGreaterThan(0)
  })

  it('PUT /api/save 已下线（不存在「客户端整份覆盖」的旁路）', async () => {
    const acc = await signUp('alice')
    const res = await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(acc.accessToken),
      payload: { payload: '{"version":4}', savedAt: 1000 },
    })
    expect(res.statusCode).toBe(404)
    // 服务端存档没被写进来
    const get = await bundle.app.inject({ method: 'GET', url: '/api/save', headers: auth(acc.accessToken) })
    expect(get.statusCode).toBe(404)
  })

  it('越权：A 的令牌读不到 B 的存档', async () => {
    const a = await signUp('alice')
    const b = await signUp('bob')
    await createSave(b.accessToken)
    const res = await bundle.app.inject({ method: 'GET', url: '/api/save', headers: auth(a.accessToken) })
    expect(res.statusCode).toBe(404)
  })

  it('无令牌访问存档 → 401', async () => {
    const get = await bundle.app.inject({ method: 'GET', url: '/api/save' })
    expect(get.statusCode).toBe(401)
  })
})

describe('注销账号', () => {
  it('删除后账号、存档、会话全部消失', async () => {
    const acc = await signUp('alice')
    await createSave(acc.accessToken)

    const del = await bundle.app.inject({ method: 'DELETE', url: '/api/account', headers: auth(acc.accessToken) })
    expect(del.statusCode).toBe(204)

    const me = await bundle.app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(acc.accessToken) })
    expect(me.statusCode).toBe(401)

    const refresh = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: acc.refreshToken },
    })
    expect(refresh.statusCode).toBe(401)

    const userRow = bundle.db.prepare('SELECT * FROM users WHERE id = ?').get(acc.user.id)
    expect(userRow).toBeUndefined()
    const saveRow = bundle.db.prepare('SELECT * FROM saves WHERE user_id = ?').get(acc.user.id)
    expect(saveRow).toBeUndefined()
    const sessionRow = bundle.db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(acc.user.id)
    expect(sessionRow).toBeUndefined()
  })
})

describe('健康检查', () => {
  it('返回 ok', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })
})

describe('跨域预检', () => {
  it('允许 POST（动作接口），否则浏览器会拦掉预检', async () => {
    const res = await bundle.app.inject({
      method: 'OPTIONS',
      url: '/api/action',
      headers: {
        origin: 'http://127.0.0.1:4173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    expect(res.headers['access-control-allow-methods']).toContain('POST')
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:4173')
  })
})
