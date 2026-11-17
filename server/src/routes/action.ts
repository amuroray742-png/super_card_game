/**
 * 动作路由：POST /api/action。
 *
 * 客户端只发「意图」，服务端算完再回结果（服务端权威化）。
 * 请求体：`{ actionId, action }`；响应体见 `core/systems/action-protocol.ts`。
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { ApiError, ERROR_CODES } from '../errors.ts'
import type { WindowLimiter } from '../rateLimit.ts'
import { dispatchAction } from '../game/dispatcher.ts'
import type { GameService } from '../game/service.ts'

export interface ActionRouteContext {
  service: GameService
  limiter: WindowLimiter
  /** 鉴权 preHandler */
  authGuard: preHandlerHookHandler
}

export function registerActionRoutes(app: FastifyInstance, ctx: ActionRouteContext): void {
  app.post('/api/action', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const response = await dispatchAction(
      { service: ctx.service, limiter: ctx.limiter },
      auth.sub,
      req.body,
    )
    return reply.code(200).send(response)
  })
}
