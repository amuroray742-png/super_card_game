/**
 * 服务端权威的游戏服务：**唯一**能改存档的地方。
 *
 * 客户端只发「意图」（`POST /api/action`），服务端负责：
 *
 *   读存档 → 补算离线收益 → 执行动作（core 纯函数）→ 写回 → 记幂等日志
 *
 * ── 为什么规则不在这里写 ────────────────────────────────────────────
 * 「余额够不够」「扣多少给多少」「抽到什么」这些判定**全部**来自
 * `src/core/systems/actions.ts`（服务端与客户端 import 同一份）。
 * 服务端只负责「什么时候执行、怎么落库、怎么防重」——
 * 业务规则在服务端另写一份必然与 core 分叉（铁律 #4）。
 *
 * ── 铁律落点 ────────────────────────────────────────────────────────
 * - 失败即原子：动作失败 → 存档一个字节都没变（core 保证先校验后修改）
 * - 幂等：同一个 `actionId` 重放只回放上次结果，**不重复扣费**
 * - 随机序列归服务端：种子用 `node:crypto` 生成，客户端不再持有（铁律 #24）
 * - 余额校验在 core 里先做，失败直接拒绝，不产生负数（铁律 #10 / #22）
 * - 收益只经 `rewards` 入库（铁律 #4 / #26）
 */
import { randomInt } from 'node:crypto'
import type { SaveData } from '../../../src/core/model/types.ts'
import { deserialize, serialize } from '../../../src/core/save/serialize.ts'
import { createNewSave } from '../../../src/core/save/schema.ts'
import { Rng } from '../../../src/core/rng.ts'
import { IDLE } from '../../../src/core/config/economy.ts'
import { ACCOUNT } from '../../../src/core/config/account.ts'
import { GAME_ERROR_CODES, GAME_ERROR_MESSAGES } from '../../../src/core/config/game-errors.ts'
import {
  applyAction,
  applyRewardBundle,
  syncRngState,
  type ActionResultMap,
  type GameAction,
  type GameActionType,
} from '../../../src/core/systems/actions.ts'
import { buildTeam } from '../../../src/core/systems/derive.ts'
import { settleOffline, type OfflineSettlementResult } from '../../../src/core/systems/idle.ts'
import type { ActionRequest, ActionResponse, SaveSnapshot } from '../../../src/core/systems/action-protocol.ts'
import type { Db } from '../db.ts'
import { UserLock } from './lock.ts'
import { readActionLog, readSave, trimActionLogs, writeActionLog, writeSave } from './repo.ts'

/** 服务端随机种子（密码学随机源；**不得**用常量种子——所有玩家会抽到同一串） */
export function serverSeed(): number {
  return randomInt(0, 0x1_0000_0000)
}

/** 幂等日志里存的内容（只存成功动作的结果） */
interface StoredOutcome {
  ok: boolean
  result?: ActionResultMap[GameActionType]
  message?: string
  messageKind?: 'info' | 'ok' | 'warn'
  code?: string
  silent?: boolean
}

/** 入口检查的结果 */
interface PreparedSave {
  /** 本次入口触发的离线结算明细（客户端据此弹结算窗） */
  offline: OfflineSettlementResult | null
  /** 存档是否被改动（补种子 / 离线结算 → 需要落库） */
  dirty: boolean
}

export class GameService {
  private readonly db: Db
  private readonly lock: UserLock

  constructor(db: Db, lock: UserLock) {
    this.db = db
    this.lock = lock
  }

  /**
   * 执行一个动作（同一账号串行）。
   *
   * 成功 → 写回存档 + 记幂等日志；
   * 失败 → 存档不变（离线结算若已产生收益则仍落库）。
   */
  async execute(userId: number, request: ActionRequest): Promise<ActionResponse> {
    return this.lock.run(userId, () => this.executeSync(userId, request))
  }

  /**
   * 载入存档（并补算离线收益）。
   *
   * 没有存档时返回 null（客户端据此判断「要不要先建档 / 导入存量档」）。
   */
  async load(userId: number): Promise<{ save: SaveSnapshot; offline: OfflineSettlementResult | null } | null> {
    return this.lock.run(userId, () => {
      const now = Date.now()
      const row = readSave(this.db, userId)
      if (!row) return null

      const save = deserialize(row.payload)
      const prepared = this.prepare(save, now)
      let payload = serialize(save)
      if (prepared.dirty) {
        save.savedAt = now
        payload = serialize(save)
        writeSave(this.db, userId, payload, save.savedAt, now)
      }
      return {
        save: { payload, savedAt: save.savedAt },
        offline: prepared.offline,
      }
    })
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  private executeSync(userId: number, request: ActionRequest): ActionResponse {
    const now = Date.now()

    // ① 幂等：命中日志 → 直接回放上次结果（**不重复扣费**）
    const logged = readActionLog(this.db, userId, request.actionId)
    if (logged) {
      const stored = JSON.parse(logged.result) as StoredOutcome
      const row = readSave(this.db, userId)
      return {
        ok: stored.ok,
        actionId: request.actionId,
        result: stored.result,
        code: stored.code as ActionResponse['code'],
        message: stored.message,
        messageKind: stored.messageKind,
        silent: stored.silent,
        replayed: true,
        save: row ? { payload: row.payload, savedAt: row.saved_at } : undefined,
      }
    }

    // ② 取存档
    const row = readSave(this.db, userId)
    const isCreate = request.action.type === 'save.create'
    if (!row && !isCreate) {
      return {
        ok: false,
        actionId: request.actionId,
        code: GAME_ERROR_CODES.SAVE_MISSING,
        message: GAME_ERROR_MESSAGES.SAVE_MISSING,
      }
    }
    if (row && isCreate) {
      return {
        ok: false,
        actionId: request.actionId,
        code: GAME_ERROR_CODES.SAVE_EXISTS,
        message: GAME_ERROR_MESSAGES.SAVE_EXISTS,
      }
    }

    const save = row ? deserialize(row.payload) : createNewSave(now, serverSeed())

    // ③ 入口检查：补随机种子 + 补算离线收益
    const prepared = this.prepare(save, now)
    let dirty = prepared.dirty

    // ④ 执行动作（规则全在 core 里）
    const seedBefore = save.rng.seed
    const rng = Rng.fromSnapshot(save.rng.seed, save.rng.counter)
    const outcome = applyAction<GameActionType>(
      save,
      request.action as Extract<GameAction, { type: GameActionType }>,
      { now, rng, randomSeed: serverSeed },
    )

    // ⑤ 失败：动作没改存档（core 保证先校验后修改），但离线收益要落库
    if (!outcome.ok) {
      if (dirty) {
        save.savedAt = now
        writeSave(this.db, userId, serialize(save), save.savedAt, now)
      }
      const current = readSave(this.db, userId)
      return {
        ok: false,
        actionId: request.actionId,
        code: outcome.code,
        message: outcome.message,
        silent: outcome.silent,
        save: current ? { payload: current.payload, savedAt: current.saved_at } : undefined,
        offline: prepared.offline,
      }
    }

    // ⑥ 随机数计数器写回存档（序列只前进不复现）
    if (save.rng.seed !== seedBefore) {
      // 动作换了整条随机序列（重置 / 导入）→ 用新种子重建，不回写旧计数器
      if (!save.rng.seed) {
        save.rng.seed = serverSeed()
        save.rng.counter = 0
      }
    } else {
      syncRngState(save, rng)
    }

    // ⑦ 落库：存档与幂等日志**同一事务**（避免「扣了费却没记日志」→ 重试再扣一次）
    save.savedAt = now
    const payload = serialize(save)
    const stored: StoredOutcome = {
      ok: true,
      result: outcome.result,
      message: outcome.message,
      messageKind: outcome.messageKind,
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      writeSave(this.db, userId, payload, save.savedAt, now)
      writeActionLog(this.db, userId, request.actionId, JSON.stringify(stored), now)
      trimActionLogs(this.db, userId, ACCOUNT.ACTION_LOG_LIMIT)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    return {
      ok: true,
      actionId: request.actionId,
      result: outcome.result,
      message: outcome.message,
      messageKind: outcome.messageKind,
      save: { payload, savedAt: save.savedAt },
      offline: prepared.offline,
    }
  }

  /**
   * 入口检查：补随机种子 + 补算离线收益。
   *
   * 离线收益**不依赖后台常驻 tick**——每次进入游戏 / 每次动作都检查一次，
   * 玩家断网期间不损失挂机收益（服务端时间说了算）。
   */
  private prepare(save: SaveData, now: number): PreparedSave {
    let dirty = false
    let offline: OfflineSettlementResult | null = null

    // 旧档没有随机种子 → 服务端补一条（客户端不再持有随机序列，铁律 #24）
    if (!save.rng.seed) {
      save.rng.seed = serverSeed()
      save.rng.counter = 0
      dirty = true
    }

    const elapsed = Math.max(0, Math.floor((now - save.lastTickAt) / 1000))
    if (elapsed < IDLE.OFFLINE_SETTLE_THRESHOLD_SEC) {
      return { offline, dirty }
    }

    const team = buildTeam(save)
    if (team.length === 0) {
      // 没有编队就没有挂机收益；但仍然要把 lastTickAt 推上去，
      // 否则每次入口都会重新算一遍空结算。
      save.lastTickAt = now
      return { offline, dirty: true }
    }

    const settleRng = Rng.fromSnapshot(save.rng.seed, save.rng.counter)
    const result = settleOffline(team, save.idle.currentStage, elapsed, settleRng.nextSeed())
    applyRewardBundle(save, result.rewards, settleRng, now)
    save.lastTickAt = now
    syncRngState(save, settleRng)
    offline = result
    dirty = true
    return { offline, dirty }
  }
}
