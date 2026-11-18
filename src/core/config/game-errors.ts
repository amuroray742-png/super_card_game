/**
 * 动作错误码表（**单一数据源**，服务端与客户端共用）。
 *
 * 背景：服务端权威化后，客户端不再自己判定「余额够不够 / 状态合不合法」，
 * 这些判定全部由服务端执行。服务端只回一个**错误码**，客户端按码翻译成对外文案
 * （与 `core/config/account.ts` 的账号错误码同一套路）。
 *
 * ⚠ 铁律 #4：动作负载 / 动作结果 / 错误码表都**只有这一份**，
 *   服务端与客户端共同 import，不各写一套（两处各写一套必然对不上）。
 *
 * ⚠ 动作失败时**服务端不落库**（存档保持原样），
 *   因此错误码必须能完整表达「为什么没成功」，不能靠服务端 message 兜底。
 */

/** 动作错误码 */
export const GAME_ERROR_CODES = {
  /** 资源不足（银两 / 强化石 / 术式结晶 / 经验 / 印记 / 碎片等） */
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  /** 目标不存在（英灵 / 遗物 / 预设） */
  NOT_FOUND: 'NOT_FOUND',
  /** 等级已达上限 */
  MAX_LEVEL: 'MAX_LEVEL',
  /** 境界已达上限 */
  MAX_REALM: 'MAX_REALM',
  /** 还没到境界门槛 */
  REALM_GATE: 'REALM_GATE',
  /** 星级已达上限 */
  MAX_STAR: 'MAX_STAR',
  /** 当前等级无法继续提升技能 */
  SKILL_CAP: 'SKILL_CAP',
  /** 遗物强化等级已达上限 */
  MAX_RELIC_LEVEL: 'MAX_RELIC_LEVEL',
  /** 遗物已锁定，不可分解 */
  RELIC_LOCKED: 'RELIC_LOCKED',
  /** 批量操作没有选中任何遗物 */
  RELIC_BATCH_EMPTY: 'RELIC_BATCH_EMPTY',
  /** 批量操作超过单次上限 */
  RELIC_BATCH_TOO_LARGE: 'RELIC_BATCH_TOO_LARGE',
  /** 编队为空 */
  TEAM_EMPTY: 'TEAM_EMPTY',
  /** 今天已经签到过了 */
  ALREADY_SIGNED: 'ALREADY_SIGNED',
  /** 兑换码无效 */
  CODE_INVALID: 'CODE_INVALID',
  /** 兑换码已使用 */
  CODE_USED: 'CODE_USED',
  /** 圣杯重启条件未满足 */
  REBIRTH_LOCKED: 'REBIRTH_LOCKED',
  /** 存档导入内容无效 */
  IMPORT_INVALID: 'IMPORT_INVALID',
  IMPORT_FORBIDDEN: 'IMPORT_FORBIDDEN',
  /** 动作类型不认识 */
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  /** 服务端暂时不可用 */
  SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE',
  /** 账号还没有存档（需要先建档） */
  SAVE_MISSING: 'SAVE_MISSING',
  /** 账号已经有存档了（不能重复建档） */
  SAVE_EXISTS: 'SAVE_EXISTS',
  /** 动作已执行，原结果超过重放保留期 */
  ACTION_REPLAY_EXPIRED: 'ACTION_REPLAY_EXPIRED',
} as const

export type GameErrorCode = (typeof GAME_ERROR_CODES)[keyof typeof GAME_ERROR_CODES]

/**
 * 错误码 → 对外文案（兜底）。
 *
 * 大多数动作会带**更具体**的 message（例如「经验不足（1234 / 1000）」），
 * 这张表只在没有具体文案时兜底。
 */
export const GAME_ERROR_MESSAGES: Record<GameErrorCode, string> = {
  INSUFFICIENT_FUNDS: '资源不足',
  NOT_FOUND: '目标不存在',
  MAX_LEVEL: '该英灵已达等级上限',
  MAX_REALM: '已达境界上限',
  REALM_GATE: '尚未达到境界门槛',
  MAX_STAR: '已达星级上限',
  SKILL_CAP: '当前等级无法继续提升',
  MAX_RELIC_LEVEL: '已达强化等级上限',
  RELIC_LOCKED: '遗物已锁定',
  RELIC_BATCH_EMPTY: '没有选中任何遗物',
  RELIC_BATCH_TOO_LARGE: '单次批量操作的数量过多',
  TEAM_EMPTY: '请先在阵位中编队',
  ALREADY_SIGNED: '今天已经签到过了',
  CODE_INVALID: '兑换码无效',
  CODE_USED: '该兑换码已使用',
  REBIRTH_LOCKED: '暂不满足圣杯重启条件',
  IMPORT_INVALID: '存档数据无效',
  IMPORT_FORBIDDEN: '仅无云端存档且未迁移的账号可迁移一次旧档，已有进度不可覆盖',
  UNKNOWN_ACTION: '未知的操作',
  SERVER_UNAVAILABLE: '服务器暂时不可用，请稍后再试',
  SAVE_MISSING: '账号还没有存档',
  SAVE_EXISTS: '账号已经有存档了',
  ACTION_REPLAY_EXPIRED: '该操作已执行，结果已过重试期限，请查看当前进度',
}

/** 是否属于「已知的动作错误码」 */
export function isGameErrorCode(code: string): code is GameErrorCode {
  return (Object.values(GAME_ERROR_CODES) as string[]).includes(code)
}
