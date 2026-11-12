/**
 * 服务端云存档单测（拉取 / 推送 / 冲突 / 越权 / 注销级联）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'

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

describe('云存档', () => {
  it('尚无存档时 GET → 404 NO_SAVE', async () => {
    const acc = await signUp('alice')
    const res = await bundle.app.inject({ method: 'GET', url: '/api/save', headers: auth(acc.accessToken) })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('NO_SAVE')
  })

  it('推送后拉取得到同一份内容', async () => {
    const acc = await signUp('alice')
    const put = await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(acc.accessToken),
      payload: { payload: '{"version":4}', savedAt: 1000 },
    })
    expect(put.statusCode).toBe(200)
    const get = await bundle.app.inject({ method: 'GET', url: '/api/save', headers: auth(acc.accessToken) })
    expect(get.statusCode).toBe(200)
    expect(get.json().payload).toBe('{"version":4}')
    expect(get.json().savedAt).toBe(1000)
  })

  it('推送较旧的 savedAt → 409 STALE_SAVE 并回传服务端版本', async () => {
    const acc = await signUp('alice')
    await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(acc.accessToken),
      payload: { payload: '{"v":"new"}', savedAt: 2000 },
    })
    const res = await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(acc.accessToken),
      payload: { payload: '{"v":"old"}', savedAt: 1000 },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBe('STALE_SAVE')
    expect(body.server.payload).toBe('{"v":"new"}')
    expect(body.server.savedAt).toBe(2000)
  })

  it('推送相同 savedAt 视为接受', async () => {
    const acc = await signUp('alice')
    await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(acc.accessToken),
      payload: { payload: '{"v":"a"}', savedAt: 1000 },
    })
    const res = await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(acc.accessToken),
      payload: { payload: '{"v":"b"}', savedAt: 1000 },
    })
    expect(res.statusCode).toBe(200)
  })

  it('空存档内容 → 400', async () => {
    const acc = await signUp('alice')
    const res = await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(acc.accessToken),
      payload: { payload: '', savedAt: 1000 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('越权：A 的令牌读不到 B 的存档', async () => {
    const a = await signUp('alice')
    const b = await signUp('bob')
    await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(b.accessToken),
      payload: { payload: '{"v":"bob"}', savedAt: 1000 },
    })
    const res = await bundle.app.inject({ method: 'GET', url: '/api/save', headers: auth(a.accessToken) })
    expect(res.statusCode).toBe(404)
  })

  it('无令牌访问存档 → 401', async () => {
    const get = await bundle.app.inject({ method: 'GET', url: '/api/save' })
    const put = await bundle.app.inject({ method: 'PUT', url: '/api/save', payload: { payload: 'x', savedAt: 1 } })
    expect(get.statusCode).toBe(401)
    expect(put.statusCode).toBe(401)
  })
})

describe('注销账号', () => {
  it('删除后账号、存档、会话全部消失', async () => {
    const acc = await signUp('alice')
    await bundle.app.inject({
      method: 'PUT',
      url: '/api/save',
      headers: auth(acc.accessToken),
      payload: { payload: '{"v":1}', savedAt: 1000 },
    })

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
