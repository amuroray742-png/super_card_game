/**
 * 统一错误码与错误类型。
 *
 * 错误体固定为 `{ error: string, message?: string }`，
 * 前端按 `error` 枚举映射中文文案（不直接展示 message）。
 */
export const ERROR_CODES = {
  /** 凭据错误（用户不存在与口令错误共用同一码，避免账号枚举） */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** 用户名已被占用 */
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  /** 参数不合法（用户名格式、口令强度、存档体积等） */
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  /** 未登录 / 令牌无效 */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** 触发频率限制 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 服务端尚无该账号的存档 */
  NO_SAVE: 'NO_SAVE',
  /** 推送的存档比服务端旧（冲突），响应里带服务端版本 */
  STALE_SAVE: 'STALE_SAVE',
  /** 服务器内部错误 */
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export class ApiError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  /** 冲突时携带服务端版本 */
  readonly extra?: Record<string, unknown>

  constructor(statusCode: number, code: ErrorCode, message?: string, extra?: Record<string, unknown>) {
    super(message ?? code)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
    this.extra = extra
  }
}
