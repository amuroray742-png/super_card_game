/**
 * 服务端进程入口。
 *
 * 用法：
 *   npm run server:start                       # 默认 127.0.0.1:8787，DB 落在 server/data/app.db
 *   npm run server:start -- --port 9000 --db /tmp/x.db
 */
import { buildApp } from './app.ts'
import { isProduction, loadConfig } from './config.ts'

const config = loadConfig()

if (isProduction(config) && config.jwtSecret === 'dev-only-secret-change-me') {
  console.error('[server] 生产环境必须设置 SGW_JWT_SECRET，否则重启后所有会话失效')
  process.exit(1)
}

const { app, close } = buildApp({
  dbPath: config.dbPath,
  jwtSecret: config.jwtSecret,
  accessTokenTtlSec: config.accessTokenTtlSec,
  refreshTokenTtlSec: config.refreshTokenTtlSec,
  corsOrigins: config.corsOrigins,
  logger: true,
})

app
  .listen({ host: config.host, port: config.port })
  .then(() => {
    console.log(`[server] 已启动 http://${config.host}:${config.port}（DB: ${config.dbPath}）`)
  })
  .catch((err) => {
    console.error('[server] 启动失败', err)
    process.exit(1)
  })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void close().then(() => process.exit(0))
  })
}
