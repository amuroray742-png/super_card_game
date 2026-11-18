/**
 * 动作协议（客户端 ↔ 服务端，**单一数据源**）。
 *
 * 服务端权威化后，客户端不再自己算结果，只发「意图」：
 *
 *   客户端 → `POST /api/action` { actionId, action }
 *   服务端 → 校验 → 改存档 → 落库 → 回 { ok, result, save, ... }
 *
 * ⚠ 铁律 #4：请求 / 响应结构、动作负载、动作结果、错误码表**各只有这一份**，
 *   服务端与客户端共同 import。客户端负责「把界面操作翻译成动作」，
 *   服务端负责「按动作改存档」，两边都不许自己复算数值。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────
 * 每次动作带一个 `actionId`（客户端生成，服务端不信任其内容，只当去重键）。
 * 除心跳外，已成功动作在保留期内回放结果，超期只返回已执行状态。
 * 已记账的 `actionId` 在账号存续期间均不会再次执行。
 *
 * ── 失败语义 ────────────────────────────────────────────────────────
 * - **业务失败**（余额不足 / 目标不存在 / 状态不合法）→ HTTP 200 + `{ ok: false, code }`，
 *   存档**一个字节都没变**，客户端按 `code` 翻译文案。
 * - **协议失败**（负载不合法 / 未登录 / 限流）→ 4xx，错误体 `{ error }`。
 */
import type { GameAction, GameActionType, ActionResultMap } from './actions.ts'
import { SAVE_IMPORT } from '../config/save-import.ts'
import type { GameErrorCode } from '../config/game-errors.ts'
import type { OfflineSettlementResult } from './idle.ts'

/** 动作请求体（客户端 → 服务端） */
export interface ActionRequest {
  /** 幂等键：同一个 actionId 重放不会重复扣费 */
  actionId: string
  /** 动作负载（判别联合，定义在 core/systems/actions.ts） */
  action: GameAction
}

/** 存档快照（服务端 → 客户端） */
export interface SaveSnapshot {
  /** 序列化后的客户端存档投影 */
  payload: string
  /** 存档版本时间戳（越大越新） */
  savedAt: number
}

/** 动作响应体（服务端 → 客户端） */
export interface ActionResponse {
  /** 是否成功 */
  ok: boolean
  /** 回显 actionId（客户端据此对齐请求与响应） */
  actionId: string
  /** 成功时的动作结果（类型由动作决定） */
  result?: ActionResultMap[GameActionType]
  /** 失败时的错误码（core/config/game-errors.ts） */
  code?: GameErrorCode
  /** 提示文案（服务端给的原文，客户端优先用它） */
  message?: string
  /** 提示语气 */
  messageKind?: 'info' | 'ok' | 'warn'
  /** 静默失败：不弹提示 */
  silent?: boolean
  /** 服务端权威存档快照（客户端据此刷新本地镜像） */
  save?: SaveSnapshot
  /** 本次入口触发的离线结算明细（客户端据此弹结算窗）；null = 本次没有离线收益 */
  offline?: OfflineSettlementResult | null
  /** 该 actionId 已执行，本次未重复执行 */
  replayed?: boolean
}

// ─────────────────────────── 负载校验 ───────────────────────────

/** actionId 允许的字符集（客户端生成 uuid / 递增序号） */
const ACTION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

/** 解析结果：要么得到合法请求，要么给出可回显的拒绝理由 */
export type ParsedActionRequest =
  | { ok: true; request: ActionRequest }
  | { ok: false; message: string }

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
}

function str(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function int(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null
}

function nullableStr(raw: unknown): string | null | undefined {
  if (raw === null) return null
  return typeof raw === 'string' ? raw : undefined
}

/**
 * 把任意 JSON 解析成合法的动作负载。
 *
 * 解析失败返回 `null` → 服务端回 400（协议级失败）。
 * 这里只做**协议层**的形状与量纲校验（类型 / 范围 / 长度），
 * 业务合法性（余额够不够、目标存不存在）一律由 core 的动作层判定——
 * 两处各判一套必然对不上（铁律 #4）。
 */
export function parseGameAction(raw: unknown): GameAction | null {
  if (!isRecord(raw)) return null
  const type = raw.type

  switch (type) {
    case 'gacha.pull': {
      const poolId = str(raw.poolId)
      const count = raw.count === 10 ? 10 : raw.count === 1 ? 1 : null
      if (!poolId || poolId.length > 64 || count === null) return null
      return { type: 'gacha.pull', poolId, count }
    }
    case 'idle.tick': {
      const battles = int(raw.battles)
      if (battles === null || battles < 1 || battles > 1000) return null
      return { type: 'idle.tick', battles }
    }
    case 'idle.heartbeat':
      return { type: 'idle.heartbeat' }
    case 'idle.claimOffline':
      return { type: 'idle.claimOffline' }
    case 'idle.setTarget': {
      const stageId = int(raw.stageId)
      if (stageId === null || stageId < 1) return null
      return { type: 'idle.setTarget', stageId }
    }
    case 'settings.update': {
      const out: Extract<GameAction, { type: 'settings.update' }> = { type: 'settings.update' }
      if (raw.speed !== undefined) {
        const speed = int(raw.speed)
        if (speed === null) return null
        out.speed = speed
      }
      if (raw.sfx !== undefined) {
        if (typeof raw.sfx !== 'boolean') return null
        out.sfx = raw.sfx
      }
      if (raw.skipAnim !== undefined) {
        if (typeof raw.skipAnim !== 'boolean') return null
        out.skipAnim = raw.skipAnim
      }
      // 一个字段都没给 = 空操作，直接判非法
      if (out.speed === undefined && out.sfx === undefined && out.skipAnim === undefined) return null
      return out
    }
    case 'hero.feedExp': {
      const heroId = str(raw.heroId)
      const amount = int(raw.amount)
      if (!heroId || heroId.length > 64 || amount === null || amount < 1) return null
      return { type: 'hero.feedExp', heroId, amount }
    }
    case 'hero.breakRealm': {
      const heroId = str(raw.heroId)
      if (!heroId) return null
      return { type: 'hero.breakRealm', heroId }
    }
    case 'hero.upgradeSkill': {
      const heroId = str(raw.heroId)
      const index = int(raw.index)
      if (!heroId || index === null || index < 0) return null
      return { type: 'hero.upgradeSkill', heroId, index }
    }
    case 'hero.upgradeStar': {
      const heroId = str(raw.heroId)
      if (!heroId) return null
      return { type: 'hero.upgradeStar', heroId }
    }
    case 'relic.upgrade': {
      const uid = str(raw.uid)
      if (!uid || uid.length > 64) return null
      return { type: 'relic.upgrade', uid }
    }
    case 'relic.decompose': {
      const uid = str(raw.uid)
      if (!uid || uid.length > 64) return null
      return { type: 'relic.decompose', uid }
    }
    case 'relic.equip': {
      const heroId = str(raw.heroId)
      const slot = int(raw.slot)
      const relicId = nullableStr(raw.relicId)
      if (!heroId || slot === null || slot < 0 || slot > 16 || relicId === undefined) return null
      return { type: 'relic.equip', heroId, slot, relicId }
    }
    case 'relic.autoEquip': {
      const heroId = str(raw.heroId)
      if (!heroId) return null
      return { type: 'relic.autoEquip', heroId }
    }
    case 'team.setSlot': {
      const index = int(raw.index)
      const heroId = nullableStr(raw.heroId)
      if (index === null || index < 0 || index > 16 || heroId === undefined) return null
      return { type: 'team.setSlot', index, heroId }
    }
    case 'team.savePreset': {
      const name = str(raw.name)
      if (!name || name.length > 24) return null
      return { type: 'team.savePreset', name }
    }
    case 'team.applyPreset': {
      const presetId = str(raw.presetId)
      if (!presetId || presetId.length > 64) return null
      return { type: 'team.applyPreset', presetId }
    }
    case 'team.removePreset': {
      const presetId = str(raw.presetId)
      if (!presetId || presetId.length > 64) return null
      return { type: 'team.removePreset', presetId }
    }
    case 'rebirth.do':
      return { type: 'rebirth.do' }
    case 'arena.settle':
      return { type: 'arena.settle' }
    case 'daily.signIn':
      return { type: 'daily.signIn' }
    case 'code.redeem': {
      const code = str(raw.code)
      if (!code || code.length > 64) return null
      return { type: 'code.redeem', code }
    }
    case 'save.create':
      return { type: 'save.create' }
    case 'save.reset':
      return { type: 'save.reset' }
    case 'save.import': {
      const payload = str(raw.payload)
      if (!payload || payload.length > SAVE_IMPORT.MAX_ENCODED_CHARS) return null
      // legacy = 存量旧档迁移（服务端据此记账号标记，防止旧档被迁给第二个账号）
      return { type: 'save.import', payload, legacy: raw.legacy === true }
    }
    default:
      return null
  }
}

/** 解析整个请求体 */
export function parseActionRequest(raw: unknown): ParsedActionRequest {
  if (!isRecord(raw)) return { ok: false, message: '请求格式不正确' }
  const actionId = str(raw.actionId)
  if (!actionId || !ACTION_ID_PATTERN.test(actionId)) {
    return { ok: false, message: '缺少合法的动作编号' }
  }
  const action = parseGameAction(raw.action)
  if (!action) return { ok: false, message: '未知的操作' }
  return { ok: true, request: { actionId, action } }
}
