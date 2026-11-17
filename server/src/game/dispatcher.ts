/**
 * 动作分发：协议解析 → 限流 → 调用服务 → 返回结果。
 *
 * 分层原因：路由只负责「HTTP → 服务」，协议形状与限流口径放在这一层，
 * 便于单测直接调用（不必起 HTTP）。
 */
import { parseActionRequest } from '../../../src/core/systems/action-protocol.ts'
import type { ActionResponse } from '../../../src/core/systems/action-protocol.ts'
import { ApiError, ERROR_CODES } from '../errors.ts'
import type { WindowLimiter } from '../rateLimit.ts'
import type { GameService } from './service.ts'

export interface DispatcherContext {
  service: GameService
  /** 动作限流器（按账号计数） */
  limiter: WindowLimiter
}

/**
 * 处理一次动作请求。
 *
 * - 负载不合法 → 400（协议级失败）
 * - 触发限流 → 429（协议级失败）
 * - 业务失败（余额不足等）→ 200 + `{ ok: false, code }`（由 core 判定）
 */
export async function dispatchAction(
  ctx: DispatcherContext,
  userId: number,
  body: unknown,
): Promise<ActionResponse> {
  const parsed = parseActionRequest(body)
  if (!parsed.ok) {
    throw new ApiError(400, ERROR_CODES.INVALID_PAYLOAD, parsed.message)
  }

  // 限流：同一账号窗口内的动作次数（配置来自 core/config/account.ts，前后端同一份）
  const key = `action:${userId}`
  ctx.limiter.hit(key)
  if (ctx.limiter.isBlocked(key)) {
    throw new ApiError(429, ERROR_CODES.RATE_LIMITED, '操作过于频繁，请稍后再试')
  }

  return ctx.service.execute(userId, parsed.request)
}
