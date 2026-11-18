/**
 * 遗物只读路由（仓库分页 / 单件详情 / 推荐预览）。
 *
 * ⚠ 这些接口**只读**，不改变存档 —— 写存档的唯一入口仍是 `POST /api/action`
 *   （铁律 #11 / #28）。
 *
 * 为什么要有它们：遗物是唯一随挂机时长线性增长的存档字段，
 * 12 小时离线能积出数千件。整包随存档回传会把每个动作的响应撑到 MB 级
 * （心跳每 5 秒一次）→ 仓库改走分页查询，存档主体只带**已装备**遗物。
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { ApiError, ERROR_CODES } from '../errors.ts'
import type { GameService } from '../game/service.ts'

export interface RelicContext {
  /** 鉴权 preHandler */
  authGuard: preHandlerHookHandler
  /** 服务端权威存档服务 */
  service: GameService
}

function intParam(raw: unknown, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

export function registerRelicRoutes(app: FastifyInstance, ctx: RelicContext): void {
  // 仓库分页
  app.get('/api/relics', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const query = req.query as Record<string, string | undefined>
    const page = await ctx.service.relicPage(auth.sub, {
      page: intParam(query.page, 1),
      size: intParam(query.size, 60),
      rarity: query.rarity,
      setId: query.setId,
      defId: query.defId,
      sort: query.sort,
    })
    return reply.code(200).send(page)
  })

  // 推荐预览（与服务端执行同一函数 → 预览 = 执行）
  app.get('/api/relics/advice', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const query = req.query as Record<string, string | undefined>
    const heroId = query.heroId
    if (!heroId) throw new ApiError(400, ERROR_CODES.INVALID_PAYLOAD, '缺少英灵编号')
    const advice = await ctx.service.relicAdvice(auth.sub, heroId)
    if (!advice) throw new ApiError(404, ERROR_CODES.NOT_FOUND, '找不到该英灵')
    return reply.code(200).send(advice)
  })

  // 遗物统计（仓库总数 + 按定义 id 分组）
  app.get('/api/relics/stats', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const stats = await ctx.service.relicStats(auth.sub)
    return reply.code(200).send(stats)
  })

  // 单件遗物详情
  app.get('/api/relics/:uid', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const params = req.params as { uid: string }
    const relic = await ctx.service.relicByUid(auth.sub, params.uid)
    if (!relic) throw new ApiError(404, ERROR_CODES.NOT_FOUND, '遗物不存在')
    return reply.code(200).send(relic)
  })
}
