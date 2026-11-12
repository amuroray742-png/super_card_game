/**
 * Fastify 应用装配。
 *
 * `buildApp` 把「配置 → 数据库 → 路由」组装成一个可测试的实例：
 * 测试用 `:memory:` 库 + 临时密钥注入，E2E 用真实 server 代码 + 临时 DB 文件，
 * 保证测的就是生产代码路径。
 */
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { openDb, type Db } from './db.ts'
import { makeAuthGuard } from './authGuard.ts'
import { createLimiter, registerAuthRoutes } from './routes/auth.ts'
import { registerSaveRoutes } from './routes/save.ts'
import { registerAccountRoutes } from './routes/account.ts'
import { registerHealthRoutes } from './routes/health.ts'
import { ApiError, ERROR_CODES } from './errors.ts'

export interface AppOptions {
  dbPath: string
  jwtSecret: string
  accessTokenTtlSec: number
  refreshTokenTtlSec: number
  corsOrigins: string[]
  logger?: boolean
}

export interface AppBundle {
  app: FastifyInstance
  db: Db
  close: () => Promise<void>
}

export function buildApp(options: AppOptions): AppBundle {
  const app = Fastify({ logger: options.logger ?? false })
  const db = openDb(options.dbPath)
  const limiter = createLimiter()
  const authGuard = makeAuthGuard(options.jwtSecret)

  app.register(cors, {
    origin: options.corsOrigins,
    credentials: false,
    // ⚠ 必须显式列出方法：@fastify/cors v11 的默认方法表是 `GET,HEAD,POST`，
    // **不含 PUT**——云存档推送（PUT /api/save）会被浏览器预检直接拦掉。
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })

  // 统一错误体：{ error, message? }
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
        ...(err.extra ?? {}),
      })
    }
    const status = (err as { statusCode?: number }).statusCode
    if (status === 400) {
      return reply.code(400).send({ error: ERROR_CODES.INVALID_PAYLOAD, message: '请求格式不正确' })
    }
    req.log.error(err)
    return reply.code(500).send({ error: ERROR_CODES.INTERNAL, message: '服务器内部错误' })
  })

  registerHealthRoutes(app)
  registerAuthRoutes(app, {
    db,
    jwtSecret: options.jwtSecret,
    accessTokenTtlSec: options.accessTokenTtlSec,
    refreshTokenTtlSec: options.refreshTokenTtlSec,
    limiter,
    authGuard,
  })
  registerSaveRoutes(app, { db, authGuard })
  registerAccountRoutes(app, { db, authGuard })

  return {
    app,
    db,
    close: async () => {
      await app.close()
      db.close()
    },
  }
}
