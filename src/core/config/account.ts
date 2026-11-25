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
  /**
   * 同一账号在限流窗口内允许的动作次数。
   *
   * 服务端权威化后，客户端**每个养成动作**都会打一次 `POST /api/action`，
   * 不限流会被脚本刷爆（也容易被拿来反复试探扣费接口）。
   */
  ACTION_MAX_PER_WINDOW: 120,
  /** 动作限流窗口（毫秒） */
  ACTION_WINDOW_MS: 60 * 1000,
  /** 成功动作的结果保留 24 小时，过期后仍保留动作 ID 防止重复执行。 */
  ACTION_REPLAY_WINDOW_MS: 24 * 60 * 60 * 1000,
  /**
   * 默认后端地址（前端在未配置时使用）—— **空串 = 同源**。
   *
   * ⚠ 口径（前后端共用，改动前先读 `src/platform/account.ts` 的 `selectApiBase`）：
   *   - base 只放「**后端 origin**」，**绝不能带 `/api`**：
   *     客户端请求路径本身以 `/api/` 开头（`/api/auth/register` …），
   *     base 只负责前缀 ⇒ 写成 `/api` 会拼出 `/api/api/auth/register` ⇒ 404。
   *   - **空串 = 同源**：请求走当前域名，由反代转发到后端。
   *     开发期是 Vite dev server 的 `/api` 代理，生产期是 nginx 的 `/api` 反代。
   *   - 默认取同源而不是 `http://127.0.0.1:8787`：手机 / 局域网设备上
   *     `127.0.0.1` 指的是**设备自己**，写死必然连不上（铁律 #14 的同源口径）。
   */
  DEFAULT_API_BASE: '',
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
  /** 目标不存在（只读查询接口用） */
  NOT_FOUND: 'NOT_FOUND',
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
  NOT_FOUND: '目标不存在',
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
  /** 路由 chunk 拉取失败后的兜底次数（会话级，见 presentation/utils/route-recovery.ts） */
  ROUTE_CHUNK_RETRY: 'sgw.routeChunkRetry',
  /** 路由 chunk 拉取失败时**想去**的路由（重载后自动重试到这里） */
  ROUTE_CHUNK_TARGET: 'sgw.routeChunkTarget',
} as const

/** 账号槽位名：每账号一个（存档归属由账号决定，不写进存档本体） */
export function accountSlotKey(accountId: number | string): string {
  return String(accountId)
}

/**
 * 存量旧档已迁走的标记（**服务端**账号标记的键名）。
 *
 * 服务端权威后，`sgw.save.main` 这类存量单槽位旧档要迁到账号名下，
 * 只迁一次——本地标记（`ACCOUNT_STORAGE_KEYS.LEGACY_MIGRATED`）与服务端
 * 标记各拦一道，防止同一份旧档被迁给第二个账号。
 */
export const LEGACY_MIGRATED_FLAG = 'legacyMigrated'

/**
 * 「首通结晶一次性补发」已处理的账号标记（**服务端**账号标记的键名）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：本版新增「主线首通给结晶」，
 *   老账号在版本上线前打过的关卡要**补发**一次
 *   （实现文档 §2「建议按可信服务端通关进度补发本版新增的首通结晶，
 *   并在同一事务登记」）。
 *
 * ⚠ **导入路径排除**：客户端导入的数据**不能**作为历史补偿凭证，
 *   所以 `save.import` 会把本标记直接置为「已处理」——
 *   导入档永远拿不到这笔补发（否则一次导入就能凭空刷出几千万结晶）。
 *
 * ⚠ 标记与存档**同一事务**写入：崩了重来不会重复发。
 */
export const FIRST_CLEAR_COMPENSATED_FLAG = 'firstClearCompensated'

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
