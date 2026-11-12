/**
 * 账号注销：删除账号并级联删除其会话与存档。
 *
 * 合规要求：玩家可随时删除账号与数据（合规页有入口）。
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { Db } from '../db.ts'
import { ApiError, ERROR_CODES } from '../errors.ts'

export interface AccountContext {
  db: Db
  /** 鉴权 preHandler */
  authGuard: preHandlerHookHandler
}

export function registerAccountRoutes(app: FastifyInstance, ctx: AccountContext): void {
  app.delete('/api/account', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    // 外键 ON DELETE CASCADE 会连带删除 sessions 与 saves
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(auth.sub)
    return reply.code(204).send()
  })
}
