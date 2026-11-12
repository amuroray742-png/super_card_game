/**
 * 访问令牌校验（Fastify preHandler）。
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyAccessToken, type AccessPayload } from './token.ts'
import { ERROR_CODES } from './errors.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** 通过鉴权后写入的账号信息 */
    auth?: AccessPayload
  }
}

export function makeAuthGuard(secret: string) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const payload = token ? verifyAccessToken(token, secret) : null
    if (!payload) {
      await reply.code(401).send({ error: ERROR_CODES.UNAUTHORIZED, message: '请先登录' })
      return
    }
    req.auth = payload
  }
}
