/**
 * 认证路由：注册 / 登录 / 刷新 / 登出 / 当前账号。
 *
 * 安全要点：
 * - 用户不存在与口令错误返回**同一个**错误码（防账号枚举）
 * - refresh token 轮换：刷新时旧 token 立即吊销
 * - 口令与哈希永不出现在响应与日志里
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { getRow, type Db, type SessionRow, type UserRow } from '../db.ts'
import { ApiError, ERROR_CODES } from '../errors.ts'
import { hashPassword, verifyPassword } from '../password.ts'
import { hashToken, newRefreshToken, signAccessToken } from '../token.ts'
import { RateLimiter } from '../rateLimit.ts'
import {
  ACCOUNT,
  normalizeUsername,
  validatePassword,
  validateUsername,
} from '../../../src/core/config/account.ts'

export interface AuthContext {
  db: Db
  jwtSecret: string
  accessTokenTtlSec: number
  refreshTokenTtlSec: number
  limiter: RateLimiter
  /** 鉴权 preHandler */
  authGuard: preHandlerHookHandler
}

interface CredentialsBody {
  username?: unknown
  password?: unknown
}

function readCredentials(body: unknown): { username: string; password: string } {
  const b = (body ?? {}) as CredentialsBody
  const username = typeof b.username === 'string' ? b.username.trim() : ''
  const password = typeof b.password === 'string' ? b.password : ''
  if (!username || !password) {
    throw new ApiError(400, ERROR_CODES.INVALID_PAYLOAD, '请填写用户名与口令')
  }
  return { username, password }
}

function issueSession(ctx: AuthContext, user: UserRow): Record<string, unknown> {
  const refreshToken = newRefreshToken()
  const now = Date.now()
  ctx.db
    .prepare(
      `INSERT INTO sessions (user_id, refresh_hash, expires_at, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(user.id, hashToken(refreshToken), now + ctx.refreshTokenTtlSec * 1000, now)
  ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id)

  return {
    user: { id: user.id, username: user.username },
    accessToken: signAccessToken({ id: user.id, username: user.username }, ctx.jwtSecret, ctx.accessTokenTtlSec),
    refreshToken,
    expiresIn: ctx.accessTokenTtlSec,
  }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AuthContext): void {
  app.post('/api/auth/register', async (req, reply) => {
    const { username, password } = readCredentials(req.body)
    const usernameError = validateUsername(username)
    if (usernameError) throw new ApiError(400, ERROR_CODES.INVALID_PAYLOAD, usernameError)
    const passwordError = validatePassword(password)
    if (passwordError) throw new ApiError(400, ERROR_CODES.INVALID_PAYLOAD, passwordError)

    const key = `register:${normalizeUsername(username)}:${req.ip}`
    if (ctx.limiter.isBlocked(key)) {
      throw new ApiError(429, ERROR_CODES.RATE_LIMITED, '尝试过于频繁，请稍后再试')
    }

    // 账号身份不区分大小写：入库与比较都用归一化后的值
    const normalized = normalizeUsername(username)
    const existing = getRow<{ id: number }>(ctx.db, 'SELECT id FROM users WHERE username = ?', normalized)
    if (existing) {
      ctx.limiter.recordFailure(key)
      throw new ApiError(409, ERROR_CODES.USERNAME_TAKEN, '该用户名已被占用')
    }

    const passwordHash = await hashPassword(password)
    const now = Date.now()
    const info = ctx.db
      .prepare(
        `INSERT INTO users (username, password_hash, created_at, last_login_at)
         VALUES (?, ?, ?, NULL)`,
      )
      .run(normalized, passwordHash, now)

    const user = getRow<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid))
    if (!user) throw new ApiError(500, ERROR_CODES.INTERNAL, '账号创建失败')
    ctx.limiter.clear(key)
    return reply.code(201).send(issueSession(ctx, user))
  })

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = readCredentials(req.body)
    const key = `login:${normalizeUsername(username)}:${req.ip}`
    if (ctx.limiter.isBlocked(key)) {
      throw new ApiError(429, ERROR_CODES.RATE_LIMITED, '尝试过于频繁，请稍后再试')
    }

    const user = getRow<UserRow>(ctx.db, 'SELECT * FROM users WHERE username = ?', normalizeUsername(username))

    // 用户不存在与口令错误走同一条路径、同一个错误码（防账号枚举）
    const ok = user ? await verifyPassword(password, user.password_hash) : false
    if (!user || !ok) {
      ctx.limiter.recordFailure(key)
      throw new ApiError(401, ERROR_CODES.INVALID_CREDENTIALS, '用户名或口令不正确')
    }

    ctx.limiter.clear(key)
    return reply.code(200).send(issueSession(ctx, user))
  })

  app.post('/api/auth/refresh', async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: unknown }
    const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : ''
    if (!refreshToken) throw new ApiError(400, ERROR_CODES.INVALID_PAYLOAD, '缺少刷新令牌')

    const row = getRow<SessionRow>(ctx.db, 'SELECT * FROM sessions WHERE refresh_hash = ?', hashToken(refreshToken))
    const now = Date.now()
    if (!row || row.revoked_at !== null || row.expires_at <= now) {
      throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '登录已过期，请重新登录')
    }

    const user = getRow<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = ?', row.user_id)
    if (!user) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '账号不存在')

    // 轮换：旧 refresh 立即吊销
    ctx.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now, row.id)
    return reply.code(200).send(issueSession(ctx, user))
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: unknown }
    const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : ''
    if (refreshToken) {
      ctx.db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE refresh_hash = ?')
        .run(Date.now(), hashToken(refreshToken))
    }
    return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const user = getRow<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = ?', auth.sub)
    if (!user) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '账号不存在')
    return reply.code(200).send({ user: { id: user.id, username: user.username } })
  })
}

/** 限流器工厂（阈值来自 core 配置，前后端同一份） */
export function createLimiter(): RateLimiter {
  return new RateLimiter(ACCOUNT.LOGIN_MAX_FAILURES, ACCOUNT.LOGIN_FAIL_WINDOW_MS)
}
