/**
 * 统一错误类型。
 *
 * 错误码表来自 `src/core/config/account.ts`（前后端唯一口径），本文件不再另立一份。
 * 错误体固定为 `{ error: string, message?: string }`，
 * 前端按 `error` 码映射中文文案（不直接回显 message）。
 */
import { ACCOUNT_ERROR_CODES } from '../../src/core/config/account.ts'

export const ERROR_CODES = ACCOUNT_ERROR_CODES

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
