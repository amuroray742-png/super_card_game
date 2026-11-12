/**
 * 令牌签发与校验。
 *
 * - access token：JWT（HS256），载荷只含 `sub`（账号 id）与 `username`，
 *   **绝不包含口令哈希等敏感信息**。
 * - refresh token：32 字节随机串（base64url），服务端只存它的 sha256；
 *   刷新时轮换（旧 refresh 立即吊销），登出时吊销。
 */
import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'

export interface AccessPayload {
  /** 账号 id */
  sub: number
  /** 展示用用户名（原样大小写） */
  username: string
}

export function signAccessToken(
  user: { id: number; username: string },
  secret: string,
  ttlSec: number,
): string {
  return jwt.sign({ username: user.username }, secret, {
    subject: String(user.id),
    expiresIn: ttlSec,
    algorithm: 'HS256',
  })
}

export function verifyAccessToken(token: string, secret: string): AccessPayload | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload
    const id = Number(decoded.sub)
    if (!Number.isInteger(id)) return null
    return { sub: id, username: typeof decoded.username === 'string' ? decoded.username : '' }
  } catch {
    return null
  }
}

/** 生成 refresh token（明文只在此刻存在一次） */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

/** refresh token 的存储形式：只存哈希 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
