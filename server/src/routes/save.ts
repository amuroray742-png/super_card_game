/**
 * 云存档路由：GET 拉取。
 *
 * ⚠ 服务端权威化后，**没有 PUT 了**：
 *   存档的唯一写入入口是 `POST /api/action`（服务端算完落库）。
 *   保留 PUT 等于留一条「客户端整份覆盖」的旁路——那会绕过服务端的
 *   校验与扣费逻辑，权威模型当场失效（铁律 #28 / #29）。
 *
 * GET 语义：
 * - 404 = 该账号还没有存档（客户端据此建档 / 导入存量旧档）
 * - 200 = 返回**服务端权威版本**（规范化后的存档 + 离线结算明细）
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { ApiError, ERROR_CODES } from '../errors.ts'
import type { GameService } from '../game/service.ts'

export interface SaveContext {
  /** 鉴权 preHandler */
  authGuard: preHandlerHookHandler
  /** 服务端权威存档服务（载入时会补算离线收益） */
  service: GameService
}

export function registerSaveRoutes(app: FastifyInstance, ctx: SaveContext): void {
  app.get('/api/save', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    // 载入时顺带补算离线收益（服务端时间说了算，断网不损失挂机收益）
    const loaded = await ctx.service.load(auth.sub)
    if (!loaded) throw new ApiError(404, ERROR_CODES.NO_SAVE, '该账号还没有存档')
    return reply.code(200).send({
      payload: loaded.save.payload,
      savedAt: loaded.save.savedAt,
      offline: loaded.offline,
    })
  })

  /**
   * 导出存档串（只读）。
   *
   * ⚠ 必须由**服务端**产出：分包后客户端镜像里只有已装备遗物，
   *   客户端自己拼出来的「备份」会丢掉整个仓库。
   *
   * 定位：玩家级小档备份 / 早期迁移。**正式恢复路径是数据库备份**
   *   （见 roadmap P1-3）；超过导入通道上限（`SAVE_IMPORT.MAX_ENCODED_CHARS`）
   *   的大档无法靠导出串恢复。
   */
  app.get('/api/save/export', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const text = await ctx.service.exportSaveText(auth.sub)
    if (!text) throw new ApiError(404, ERROR_CODES.NO_SAVE, '该账号还没有存档')
    return reply.code(200).send({ text })
  })
}
