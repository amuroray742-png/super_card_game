/**
 * 服务端配置（环境变量 + 命令行参数）。
 *
 * 优先级：命令行参数 > 环境变量 > 默认值。
 * 命令行参数让 Playwright 的 webServer 能跨平台地指定临时 DB 与端口
 * （npm script 里设置环境变量在 Windows 上需要额外的 cross-env 依赖）。
 */
export interface ServerConfig {
  host: string
  port: number
  /** SQLite 文件路径；`:memory:` 表示内存库（测试用） */
  dbPath: string
  jwtSecret: string
  /** access token 有效期（秒） */
  accessTokenTtlSec: number
  /** refresh token 有效期（秒） */
  refreshTokenTtlSec: number
  /** 允许跨域的来源 */
  corsOrigins: string[]
}

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  // 截图工具的隔离预览端口（tools/capture/screenshot.ts，AGENTS.md 约定用 4188）
  // ⚠ 漏了它 → 截图场景的账号登录被 CORS 预检拦掉，页面停在登录页找不到「十连」按钮
  'http://127.0.0.1:4188',
  'http://localhost:4188',
]

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i < 0) return undefined
  const value = argv[i + 1]
  return value && !value.startsWith('--') ? value : undefined
}

function intOf(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
): ServerConfig {
  const origins = (env.SGW_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    host: argValue(argv, '--host') ?? env.SGW_HOST ?? '127.0.0.1',
    port: intOf(argValue(argv, '--port') ?? env.SGW_PORT, 8787),
    dbPath: argValue(argv, '--db') ?? env.SGW_DB_PATH ?? 'server/data/app.db',
    jwtSecret: env.SGW_JWT_SECRET ?? 'dev-only-secret-change-me',
    accessTokenTtlSec: intOf(env.SGW_ACCESS_TOKEN_TTL, 15 * 60),
    refreshTokenTtlSec: intOf(env.SGW_REFRESH_TOKEN_TTL, 30 * 24 * 60 * 60),
    corsOrigins: origins.length > 0 ? origins : DEFAULT_CORS_ORIGINS,
  }
}

/** 生产环境必须显式配置 JWT 密钥（否则重启后所有会话失效） */
export function isProduction(config: ServerConfig, env = process.env): boolean {
  return env.NODE_ENV === 'production'
}
