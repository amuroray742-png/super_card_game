/**
 * 账号与会话相关配置 —— 前后端共用的**唯一口径**。
 *
 * 服务端（`server/`）也 import 本文件，保证「用户名规则 / 口令强度 / 令牌有效期」
 * 在前后端不会出现两套实现（铁律 #3 数据驱动、#4 单一数据源）。
 *
 * 例外说明：AGENTS.md 铁律 #5 要求「数值常数集中在 `core/config/economy.ts`」，
 * 那条针对的是**经济数值调参**（曲线、概率、掉落率）。账号/会话类阈值不属于
 * 调参范畴，单独放本文件，并在此显式说明。
 */

/** 账号与令牌阈值 */
export const ACCOUNT = {
  /** 用户名长度下限 */
  USERNAME_MIN: 3,
  /** 用户名长度上限 */
  USERNAME_MAX: 16,
  /** 用户名只允许字母 / 数字 / 下划线（不做 Unicode 归一化，避开同形异码问题） */
  USERNAME_PATTERN: /^[A-Za-z0-9_]+$/,
  /** 口令长度下限 */
  PASSWORD_MIN: 8,
  /** 口令长度上限 */
  PASSWORD_MAX: 128,
  /** access token 有效期（秒） */
  ACCESS_TOKEN_TTL_SEC: 15 * 60,
  /** refresh token 有效期（秒） */
  REFRESH_TOKEN_TTL_SEC: 30 * 24 * 60 * 60,
  /** 同一「用户名 + IP」窗口内允许的登录失败次数 */
  LOGIN_MAX_FAILURES: 5,
  /** 登录失败计数窗口（毫秒） */
  LOGIN_FAIL_WINDOW_MS: 10 * 60 * 1000,
  /** 云端推送防抖（毫秒）：非关键写入合并上传 */
  PUSH_DEBOUNCE_MS: 1500,
  /** 默认后端地址（前端在未配置时使用） */
  DEFAULT_API_BASE: 'http://127.0.0.1:8787',
} as const

/**
 * 账号接口的错误码 —— 前后端共用的**唯一口径**。
 *
 * 服务端 `server/src/errors.ts` 直接复用本表，不另立一份。
 * `NETWORK` 由客户端本地判定（服务端不会返回该码）。
 */
export const ACCOUNT_ERROR_CODES = {
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
  /** 客户端本地判定：连不上服务器 */
  NETWORK: 'NETWORK',
} as const

export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[keyof typeof ACCOUNT_ERROR_CODES]

/**
 * 错误码 → 对外文案。
 *
 * 前端**按码映射**展示，不直接回显后端的 message，保证同一错误在任何入口
 * 都是同一句提示，也让对外文案有唯一出处（便于合规扫描）。
 */
export const ACCOUNT_ERROR_MESSAGES: Record<AccountErrorCode, string> = {
  INVALID_CREDENTIALS: '用户名或口令不正确',
  USERNAME_TAKEN: '该用户名已被占用',
  INVALID_PAYLOAD: '填写的内容不符合要求',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  RATE_LIMITED: '尝试过于频繁，请稍后再试',
  NO_SAVE: '云端还没有存档',
  STALE_SAVE: '进度已在其他设备更新',
  INTERNAL: '服务暂时不可用，请稍后再试',
  NETWORK: '无法连接服务器，请检查网络或后端地址',
}

/** localStorage 键名（唯一口径，避免各处手写字符串） */
export const ACCOUNT_STORAGE_KEYS = {
  /** 会话：`{ refreshToken, user }` */
  SESSION: 'sgw.session',
  /** 后端地址覆盖（设置页可改，供静态托管指向自建后端） */
  API_BASE: 'sgw.apiBase',
  /** 存档槽位前缀（平台层 storage.ts 统一拼装） */
  SAVE_SLOT_PREFIX: 'sgw.save.',
  /** 存量单槽位（首发无账号时的旧档，登录后迁入账号槽位） */
  LEGACY_SAVE_SLOT: 'main',
  /** 存量槽位已迁走的标记（避免把旧档迁给第二个账号） */
  LEGACY_MIGRATED: 'sgw.legacyMigrated',
} as const

/** 账号槽位名：每账号一个（存档归属由账号决定，不写进存档本体） */
export function accountSlotKey(accountId: number | string): string {
  return String(accountId)
}

/** 用户名校验；返回中文错误文案，null 表示通过 */
export function validateUsername(username: string): string | null {
  if (username.length < ACCOUNT.USERNAME_MIN) return `用户名至少 ${ACCOUNT.USERNAME_MIN} 位`
  if (username.length > ACCOUNT.USERNAME_MAX) return `用户名最多 ${ACCOUNT.USERNAME_MAX} 位`
  if (!ACCOUNT.USERNAME_PATTERN.test(username)) return '用户名只能包含字母、数字与下划线'
  return null
}

/** 口令校验；返回中文错误文案，null 表示通过 */
export function validatePassword(password: string): string | null {
  if (password.length < ACCOUNT.PASSWORD_MIN) return `口令至少 ${ACCOUNT.PASSWORD_MIN} 位`
  if (password.length > ACCOUNT.PASSWORD_MAX) return `口令最长 ${ACCOUNT.PASSWORD_MAX} 位`
  return null
}

/**
 * 用户名归一化：统一小写后存储与比较，账号身份**不区分大小写**
 * （注册 `Tester` 与登录 `tester` 视为同一账号，展示也统一为小写）。
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}
