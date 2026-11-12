/**
 * 云存档路由：GET 拉取 / PUT 推送。
 *
 * 冲突语义（与前端 `core/save/conflict.ts` 保持同一口径）：
 * - 服务端 `saved_at <= 请求的 savedAt` → 接受并更新
 * - 服务端 `saved_at >  请求的 savedAt` → 409 STALE_SAVE + 返回服务端版本，
 *   客户端采纳服务端版本并提示「进度已在其他设备更新」
 *
 * 不做字段级合并：挂机游戏全量覆盖可接受，合并成本高收益低。
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { getRow, type Db, type SaveRow } from '../db.ts'
import { ApiError, ERROR_CODES } from '../errors.ts'

export interface SaveContext {
  db: Db
  /** 鉴权 preHandler */
  authGuard: preHandlerHookHandler
}

/** 单份存档的体积上限（字符数），防止异常大包撑爆数据库 */
const MAX_PAYLOAD_CHARS = 4 * 1024 * 1024

export function registerSaveRoutes(app: FastifyInstance, ctx: SaveContext): void {
  app.get('/api/save', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const row = getRow<SaveRow>(ctx.db, 'SELECT * FROM saves WHERE user_id = ?', auth.sub)
    if (!row) throw new ApiError(404, ERROR_CODES.NO_SAVE, '该账号还没有存档')
    return reply.code(200).send({ payload: row.payload, savedAt: row.saved_at })
  })

  app.put('/api/save', { preHandler: ctx.authGuard }, async (req, reply) => {
    const auth = req.auth
    if (!auth) throw new ApiError(401, ERROR_CODES.UNAUTHORIZED, '请先登录')
    const body = (req.body ?? {}) as { payload?: unknown; savedAt?: unknown }
    const payload = typeof body.payload === 'string' ? body.payload : ''
    const savedAt = typeof body.savedAt === 'number' && Number.isFinite(body.savedAt) ? body.savedAt : 0
    if (!payload) throw new ApiError(400, ERROR_CODES.INVALID_PAYLOAD, '存档内容为空')
    if (payload.length > MAX_PAYLOAD_CHARS) {
      throw new ApiError(400, ERROR_CODES.INVALID_PAYLOAD, '存档内容过大')
    }

    const now = Date.now()
    const current = getRow<SaveRow>(ctx.db, 'SELECT * FROM saves WHERE user_id = ?', auth.sub)

    if (current && current.saved_at > savedAt) {
      // 落后的一方：交回服务端版本，由客户端采纳
      return reply.code(409).send({
        error: ERROR_CODES.STALE_SAVE,
        message: '进度已在其他设备更新',
        server: { payload: current.payload, savedAt: current.saved_at },
      })
    }

    ctx.db
      .prepare(
        `INSERT INTO saves (user_id, payload, saved_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, saved_at = excluded.saved_at, updated_at = excluded.updated_at`,
      )
      .run(auth.sub, payload, savedAt, now)
    return reply.code(200).send({ savedAt })
  })
}
