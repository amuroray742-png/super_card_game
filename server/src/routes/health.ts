/**
 * 健康检查：供 Playwright 的 webServer 等待服务就绪。
 */
import type { FastifyInstance } from 'fastify'

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async (_req, reply) => {
    return reply.code(200).send({ ok: true })
  })
}
