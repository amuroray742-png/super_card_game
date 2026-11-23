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
import type { RelicInstance, SaveData } from '../../../src/core/model/types.ts'
import {
  exportSave,
  readSaveBody,
  restoreSave,
  serializePublicSave,
  serializeSaveBody,
} from '../../../src/core/save/serialize.ts'
import { createNewSave, createChannelRng } from '../../../src/core/save/schema.ts'
import { Rng } from '../../../src/core/rng.ts'
import { ACCOUNT, LEGACY_MIGRATED_FLAG, FIRST_CLEAR_COMPENSATED_FLAG } from '../../../src/core/config/account.ts'
import { IDLE } from '../../../src/core/config/economy.ts'
import { firstClearCrystalsForRange } from '../../../src/core/systems/first-clear.ts'
import { GAME_ERROR_CODES, GAME_ERROR_MESSAGES } from '../../../src/core/config/game-errors.ts'
import {
  applyAction,
  settleIdleAndApply,
  syncRngState,
  type ActionResultMap,
  type GameAction,
  type GameActionType,
  type IdleActionResult,
} from '../../../src/core/systems/actions.ts'
import type { BattleResult } from '../../../src/core/model/types.ts'
import { rollLadderPeriods } from '../../../src/core/systems/ladder.ts'
import { computeRelicAdvice } from '../../../src/core/systems/actions.ts'
import type { RelicAdvice } from '../../../src/core/systems/relic-advice.ts'
import type { ActionRequest, ActionResponse, SaveSnapshot } from '../../../src/core/systems/action-protocol.ts'
import type { Db } from '../db.ts'
import { UserLock } from './lock.ts'
import {
  countRelics,
  expireActionResults,
  readActionLog,
  readFlag,
  readRelicByUid,
  readRelicPage,
  readRelicStats,
  readRelics,
  readRelicsByUids,
  readSave,
  replaceRelics,
  syncRelics,
  writeActionLog,
  writeFlag,
  writeSave,
} from './repo.ts'

/** 服务端随机种子（密码学随机源；**不得**用常量种子——所有玩家会抽到同一串） */
export function serverSeed(): number {
  return randomInt(1, 0x1_0000_0000)
}

function publicSnapshot(save: SaveData): SaveSnapshot {
  return { payload: serializePublicSave(save), savedAt: save.savedAt }
}

/** 遗物快照（uid → 等级 / 锁定）：增量同步遗物行时用来判断「变了没」 */
function relicSnapshot(relics: RelicInstance[]): Map<string, { level: number; locked: boolean }> {
  const map = new Map<string, { level: number; locked: boolean }>()
  for (const relic of relics) {
    map.set(relic.uid, { level: relic.level, locked: relic.locked })
  }
  return map
}

/**
 * 离线结算明细的**回包过滤**。
 *
 * 收益照算、照落库（玩家断网期间不损失收益），但只有「离线时长达到阈值」
 * 才把明细回传去弹窗——否则在线期间每点一下都会弹一次「离线结算」。
 *
 * ⚠ **挂机改版 v11**：阈值按**本次有产出的通道所报告的最大实际离线时长**判定
 *   （在线计量不计入该时长）。三通道各自独立 ⇒ 取最大值。
 */
function offlineForClient(offline: IdleActionResult | null): IdleActionResult | null {
  if (!offline || offline.channels.length === 0) return null
  const maxOffline = offline.channels.reduce((max, c) => Math.max(max, c.elapsedSeconds), 0)
  return maxOffline >= IDLE.OFFLINE_SETTLE_THRESHOLD_SEC ? offline : null
}

/**
 * 从动作结果里**摘出战斗回放**（设计稿 §3.7）。
 *
 * ⚠ `BattleResult.log` 上限 1500 条，单条约 120 KB ⇒ 存进 24 小时幂等日志
 *   = 每天几十 MB。回放改为**一次性回传**（响应的 `replay` 字段），
 *   幂等日志只存轻量结果（胜负 / 通关状态 / 奖励）。
 *
 * 副作用：24 小时内重放同一 actionId 时拿不到回放数据 → 客户端按「已结算」
 *   处理，不再重播演出（结果与奖励仍一致）。
 */
function splitReplay<T extends { battle?: BattleResult }>(
  result: T,
): { light: Omit<T, 'battle'>; replay?: BattleResult } {
  if (!result || typeof result !== 'object' || !('battle' in result)) {
    return { light: result }
  }
  const { battle, ...light } = result
  return { light, replay: battle ?? undefined }
}

/** 存档主体里已装备的遗物 id（心跳只需要这几件） */
function equippedIdsOf(body: { equipped?: Record<string, { relicId?: string }> }): string[] {
  const out: string[] = []
  for (const entry of Object.values(body.equipped ?? {})) {
    if (entry && typeof entry.relicId === 'string' && entry.relicId) out.push(entry.relicId)
  }
  return out
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
  offline: IdleActionResult | null
  /** 存档是否被改动（补种子 / 离线结算 → 需要落库） */
  dirty: boolean
  /**
   * 本次是否发放了「首通结晶一次性补发」。
   *
   * ⚠ 记账标记必须与存档**同一事务**写入（实现文档 §2）——
   *   所以这里只回报「要不要写标记」，写标记由调用方在事务里做。
   */
  firstClearCompensated: boolean
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
  async load(userId: number): Promise<{ save: SaveSnapshot; offline: IdleActionResult | null } | null> {
    return this.lock.run(userId, () => {
      const now = Date.now()
      const loaded = this.readSaveForUser(userId)
      if (!loaded) return null
      const { save } = loaded

      const prepared = this.prepare(save, now, true, userId)
      if (prepared.dirty) {
        save.savedAt = now
        this.writeSaveAndRelics(userId, save, loaded.before, now, {
          writeFirstClearFlag: prepared.firstClearCompensated,
        })
      }
      return {
        save: publicSnapshot(save),
        offline: offlineForClient(prepared.offline),
      }
    })
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 读存档（主体 + 遗物 → 完整存档）。
   *
   * ⚠ 旧格式兼容：早期 payload 是一整份存档（顶层带 `relics` 数组）。
   *   读到这种 payload 时当场拆表（同一事务、幂等），之后一律走新路径。
   *
   * @param equippedOnly 只取「已装备」的遗物（心跳用：≤36 件，不必拉整张表）
   */
  private readSaveForUser(userId: number, opts: { equippedOnly?: boolean } = {}): {
    save: SaveData
    /** 载入时的遗物快照（uid → 等级 / 锁定），用于增量同步 */
    before: Map<string, { level: number; locked: boolean }>
  } | null {
    const row = readSave(this.db, userId)
    if (!row) return null
    const { body, legacyRelics } = readSaveBody(row.payload)
    const relics = legacyRelics ?? (opts.equippedOnly
      ? readRelicsByUids(this.db, userId, equippedIdsOf(body))
      : readRelics(this.db, userId))
    const save = restoreSave(body, relics)

    if (legacyRelics) {
      // 存量大档：就地拆表（幂等；拆完 payload 只剩主体）
      this.splitLegacyRelics(userId, save)
    }
    return { save, before: relicSnapshot(save.relics) }
  }

  /** 存量 payload → 拆表（同一事务；拆完 payload 只剩主体） */
  private splitLegacyRelics(userId: number, save: SaveData): void {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      replaceRelics(this.db, userId, save.relics)
      writeSave(this.db, userId, serializeSaveBody(save), save.savedAt, now)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * 落库：存档主体 + 遗物行（**同一事务**）。
   *
   * 遗物行只写**变化的部分** —— 仓库几千件时，全量重写会让事务时间
   * 随遗物数线性增长，而心跳每 5 秒就来一次。
   *
   * @param syncRelics 是否同步遗物行。**心跳必须传 false**：
   *   心跳只载入「已装备」的遗物（见 `readSaveForUser`），
   *   若此时同步遗物行，会把仓库里其余几千件当成「已删除」抹掉。
   */
  private writeSaveAndRelics(
    userId: number,
    save: SaveData,
    before: Map<string, { level: number; locked: boolean }>,
    now: number,
    opts: { syncRelics?: boolean; writeFirstClearFlag?: boolean } = {},
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      writeSave(this.db, userId, serializeSaveBody(save), save.savedAt, now)
      if (opts.syncRelics !== false) syncRelics(this.db, userId, before, save.relics)
      // ⚠ 「首通补发已处理」标记与存档**同一事务**写入（实现文档 §2）：
      //   崩了重来不会重复发，也不会出现「发了钱没记账 / 记了账没发钱」。
      if (opts.writeFirstClearFlag) writeFlag(this.db, userId, FIRST_CLEAR_COMPENSATED_FLAG, 1)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private executeSync(userId: number, request: ActionRequest): ActionResponse {
    const now = Date.now()
    const isHeartbeat = request.action.type === 'idle.heartbeat'
    const expiresBefore = now - ACCOUNT.ACTION_REPLAY_WINDOW_MS

    // ① 成功动作 ID 永久防重，心跳只按服务端时间续约。
    const logged = isHeartbeat ? undefined : readActionLog(this.db, userId, request.actionId)
    if (logged) {
      const loaded = this.readSaveForUser(userId)
      const save = loaded ? publicSnapshot(loaded.save) : undefined
      if (!logged.result || logged.created_at <= expiresBefore) {
        return {
          ok: false,
          actionId: request.actionId,
          code: GAME_ERROR_CODES.ACTION_REPLAY_EXPIRED,
          message: GAME_ERROR_MESSAGES.ACTION_REPLAY_EXPIRED,
          replayed: true,
          save,
        }
      }
      const stored = JSON.parse(logged.result) as StoredOutcome
      return {
        ok: stored.ok,
        actionId: request.actionId,
        result: stored.result,
        code: stored.code as ActionResponse['code'],
        message: stored.message,
        messageKind: stored.messageKind,
        silent: stored.silent,
        replayed: true,
        save,
      }
    }

    // ② 取存档
    const row = readSave(this.db, userId)
    const isCreate = request.action.type === 'save.create'
    const isImport = request.action.type === 'save.import'
    // 建档 / 导入存档都允许「服务端还没有存档」；其余动作必须已有存档
    if (!row && !isCreate && !isImport) {
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

    // 迁移资格先于 prepare：拒绝请求不得触发结算或覆盖。
    // legacy 只是兼容旧客户端的提示，绝不是授权凭证。
    if (isImport && (row || readFlag(this.db, userId, LEGACY_MIGRATED_FLAG))) {
      return {
        ok: false, actionId: request.actionId,
        code: GAME_ERROR_CODES.IMPORT_FORBIDDEN,
        message: GAME_ERROR_MESSAGES.IMPORT_FORBIDDEN,
      }
    }
    // 读存档（主体 + 遗物 → 完整存档）；旧格式 payload 会在读取时就地拆表
    // ⚠ 心跳是「轻量心跳」：只载入**已装备**的遗物（≤36 件），不拉整张遗物表
    const loaded = row ? this.readSaveForUser(userId, { equippedOnly: isHeartbeat }) : null
    const save = loaded ? loaded.save : createNewSave(now, serverSeed())
    // 遗物快照取自**载入时**（prepare / 动作新增的遗物要在落库时插进表里）
    const relicBefore = loaded ? loaded.before : new Map<string, { level: number; locked: boolean }>()

    // ③ 挂机动作自己消费账本，避免入口预结算吞掉其上限与返回结果。
    const prepared = this.prepare(
      save,
      now,
      request.action.type !== 'idle.tick' && request.action.type !== 'idle.claimOffline' && !isHeartbeat,
      // ⚠ **导入路径排除首通补发**：导入的进度不是可信凭证
      //   （实现文档 §2「客户端导入数据不能作为历史补偿凭证」），
      //   所以导入时不补发，而是把标记直接置为「已处理」。
      isImport ? undefined : userId,
    )

    // ④ 执行动作（规则全在 core 里）
    const rngBefore = save.rng
    const rng = Rng.fromSnapshot(save.rng.seed, save.rng.counter)
    const outcome = applyAction<GameActionType>(
      save,
      request.action as Extract<GameAction, { type: GameActionType }>,
      { now, rng, randomSeed: serverSeed },
    )

    // ⑤ 失败：动作没改存档（core 保证先校验后修改），但离线收益要落库
    if (!outcome.ok) {
      /**
       * ⚠ **导入失败不得留下空存档**。
       *
       * 导入是唯一「账号还没有存档也允许执行」的动作 → 失败时手里捏着一份
       * 刚 `createNewSave` 出来的空档。若把它落库，账号就「有存档了」，
       * `save.create` 会被拒、`save.import` 也会被 `IMPORT_FORBIDDEN` 拦下——
       * 玩家真正的旧档从此**再也迁不过来**（静默丢档）。
       *
       * 空档没有离线收益可保，所以这里直接不写。
       */
      const failedImportWithoutSave = isImport && !row
      if (prepared.dirty && !failedImportWithoutSave) {
        save.savedAt = now
        this.writeSaveAndRelics(userId, save, relicBefore, now, {
          syncRelics: !isHeartbeat,
          writeFirstClearFlag: prepared.firstClearCompensated,
        })
      }
      return {
        ok: false,
        actionId: request.actionId,
        code: outcome.code,
        message: outcome.message,
        silent: outcome.silent,
        // ⚠ 心跳是「轻量心跳」：只续约租约，不回传存档主体
        //   （心跳每 5 秒一次，回包会变成一笔持续的带宽成本）。
        save: isHeartbeat ? undefined : (row ? publicSnapshot(save) : undefined),
        offline: offlineForClient(prepared.offline),
      }
    }

    // ⑥ 随机数计数器写回存档（序列只前进不复现）
    if (save.rng === rngBefore) {
      syncRngState(save, rng)
    }

    // ⑦ 落库：存档主体、遗物行与幂等日志**同一事务**
    //    （避免「扣了费却没记日志」→ 重试再扣一次；也避免「主体写了、遗物没写」）
    save.savedAt = now
    // ⚠ **战斗回放不进幂等日志**（设计稿 §3.7）：摘出来单独回传。
    const split = outcome.ok
      ? splitReplay(outcome.result as { battle?: BattleResult })
      : { light: undefined as unknown, replay: undefined }
    const stored: StoredOutcome = {
      ok: true,
      result: split.light as ActionResultMap[GameActionType],
      message: outcome.message,
      messageKind: outcome.messageKind,
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      writeSave(this.db, userId, serializeSaveBody(save), save.savedAt, now)
      // ⚠ 心跳不碰遗物行：它只载入过「已装备」的那几件，
      //   此时同步遗物行会把仓库里其余几千件当成「已删除」抹掉。
      if (!isHeartbeat) syncRelics(this.db, userId, relicBefore, save.relics)
      if (!isHeartbeat) {
        writeActionLog(this.db, userId, request.actionId, JSON.stringify(stored), now)
        expireActionResults(this.db, userId, expiresBefore)
      }
      // 存量旧档迁移：记一笔账号标记（同一份旧档不会被迁给第二个账号）
      if (isImport) {
        writeFlag(this.db, userId, LEGACY_MIGRATED_FLAG, 1)
        // ⚠ 导入档**永远拿不到**首通补发 → 标记直接置为「已处理」
        writeFlag(this.db, userId, FIRST_CLEAR_COMPENSATED_FLAG, 1)
      }
      // 首通补发：标记与存档同一事务写入（崩了重来不会重复发）
      if (prepared.firstClearCompensated) {
        writeFlag(this.db, userId, FIRST_CLEAR_COMPENSATED_FLAG, 1)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    return {
      ok: true,
      actionId: request.actionId,
      result: split.light as ActionResultMap[GameActionType],
      message: outcome.message,
      messageKind: outcome.messageKind,
      // ⚠ 战斗回放**一次性回传**，不写进幂等日志
      replay: split.replay,
      // ⚠ 轻量心跳：心跳不发放任何奖励，客户端镜像无需刷新 →
      //   不回传存档主体（省掉每 5 秒一次的整包回传）。
      save: isHeartbeat ? undefined : publicSnapshot(save),
      offline: offlineForClient(prepared.offline),
    }
  }

  /**
   * 入口检查：补随机种子 + 补算离线收益 + 首通结晶一次性补发。
   *
   * 离线收益**不依赖后台常驻 tick**——每次进入游戏 / 每次动作都检查一次，
   * 玩家断网期间不损失挂机收益（服务端时间说了算）。
   *
   * @param userId 账号（读「首通补发已处理」标记用）
   */
  private prepare(save: SaveData, now: number, settle = true, userId?: number): PreparedSave {
    let dirty = false
    let offline: IdleActionResult | null = null
    let firstClearCompensated = false

    // 旧档没有随机种子 → 服务端补一条（客户端不再持有随机序列，铁律 #24）
    if (!save.rng.seed) {
      save.rng.seed = serverSeed()
      save.rng.counter = 0
      // ⚠ 挂机改版 v11：三条通道的随机序列由**根种子**派生，
      //   根种子换了 → 三条通道的序列一起换（否则旧档玩家会共用同一条挂机序列）。
      save.rng.channels = createChannelRng(save.rng.seed)
      dirty = true
    }

    // ── 首通结晶的一次性补发（资源/背包版本 v10） ──
    //
    // ⚠ 口径（实现文档 §2）：按**服务端权威**的 `campaign.clearedStage`
    //   补发本版新增的首通结晶，**并在同一事务登记**账号标记。
    // ⚠ **导入路径排除**：`save.import` 不走这里（导入的进度不是可信凭证），
    //   而是由调用方直接把标记置为「已处理」。
    // ⚠ 补发**幂等**：标记 + 到账明细同事务写入，崩了重来不会重复发；
    //   且 `campaign.creditedStages` 被推到 `clearedStage`，增量判定也不重复。
    if (userId !== undefined && !readFlag(this.db, userId, FIRST_CLEAR_COMPENSATED_FLAG)) {
      const crystals = firstClearCrystalsForRange(1, save.campaign.clearedStage)
      if (crystals > 0) save.player.crystals += crystals
      // 已发放的关卡数与高水位对齐 → 之后的增量首通不会被误判成「本次首通」
      save.campaign.creditedStages = Math.max(
        save.campaign.creditedStages,
        save.campaign.clearedStage,
      )
      firstClearCompensated = true
      dirty = true
    }

    // 天梯周期滚动（周 / 赛季 / 回流判定）。
    //
    // ⚠ 规则在 core（`core/systems/ladder.ts`），服务端只负责**调用**——
    //   赛季结算与回流判定若在服务端另写一份，必然与 core 分叉（铁律 #4 / #29）。
    // ⚠ 必须放在 `settle` 早退之前：心跳也要刷新「上次活跃时间」，
    //   否则一个挂着页面三天不点任何按钮的玩家会被误判成回流。
    const rolled = rollLadderPeriods(save, now)
    dirty ||= rolled.changed

    if (!settle) return { offline, dirty, firstClearCompensated }
    const before = JSON.stringify([save.lastTickAt, save.idle])
    const settleRng = Rng.fromSnapshot(save.rng.seed, save.rng.counter)
    // ⚠ **挂机改版 v11**：入口预结算走**三条通道**（各自独立账本），
    //   奖励经 `applyRewardBundle` 入库（铁律 #26）。
    offline = settleIdleAndApply(save, { now, rng: settleRng, randomSeed: serverSeed })
    syncRngState(save, settleRng)
    dirty ||= JSON.stringify([save.lastTickAt, save.idle]) !== before
    return { offline, dirty, firstClearCompensated }
  }

  // ─────────────────────────── 只读查询（仓库 / 导出） ───────────────────────────

  /**
   * 仓库分页（只读）。
   *
   * ⚠ 遗物不再随存档回包下发：仓库里可能有数千件，
   *   整包回传会把每个动作的响应撑到 MB 级。
   */
  async relicPage(
    userId: number,
    query: {
      page: number
      size: number
      rarity?: string
      setId?: string
      defId?: string
      sort?: string
    },
  ): Promise<{ items: RelicInstance[]; total: number; page: number; size: number; pages: number }> {
    return this.lock.run(userId, () => {
      const size = Math.min(Math.max(1, query.size), 200)
      const page = Math.max(1, query.page)
      // ⚠ total 必须与 items 用同一套筛选，否则页数按全量算 → 后面全是空页
      const total = countRelics(this.db, userId, {
        rarity: query.rarity,
        setId: query.setId,
        defId: query.defId,
      })
      const items = readRelicPage(this.db, userId, {
        limit: size,
        offset: (page - 1) * size,
        rarity: query.rarity,
        setId: query.setId,
        defId: query.defId,
        sort: query.sort,
      })
      return { items, total, page, size, pages: Math.max(1, Math.ceil(total / size)) }
    })
  }

  /** 单件遗物（只读） */
  async relicByUid(userId: number, uid: string): Promise<RelicInstance | null> {
    return this.lock.run(userId, () => readRelicByUid(this.db, userId, uid) ?? null)
  }

  /**
   * 遗物统计（只读）：仓库总数 + 按定义 id 分组 + 仓库最高等级。
   *
   * 客户端镜像里只有已装备遗物，顶栏件数、图鉴收藏数与**强化副本解锁线**
   * 都必须由服务端给（客户端看不见仓库里那件 Lv60）。
   */
  async relicStats(userId: number): Promise<{ total: number; byDefId: Record<string, number>; maxLevel: number }> {
    return this.lock.run(userId, () => readRelicStats(this.db, userId))
  }

  /**
   * 遗物推荐预览（只读）。
   *
   * ⚠ 预览与服务端执行**必须同源**：客户端镜像里只有已装备遗物，
   *   本地算不出「仓库里哪件更强」。这里用全量候选池算，
   *   与 `relic.autoEquip` 动作是**同一个函数** → 预览 = 执行（铁律 #2 / #4）。
   */
  async relicAdvice(userId: number, heroId: string): Promise<RelicAdvice | null> {
    return this.lock.run(userId, () => {
      const loaded = this.readSaveForUser(userId)
      if (!loaded) return null
      return computeRelicAdvice(loaded.save, heroId)
    })
  }

  /**
   * 导出存档串（只读）。
   *
   * ⚠ 必须由**服务端**产出：客户端镜像里只有已装备遗物，
   *   自己拼出来的「备份」会丢掉整个仓库。
   */
  async exportSaveText(userId: number): Promise<string | null> {
    return this.lock.run(userId, () => {
      const loaded = this.readSaveForUser(userId)
      if (!loaded) return null
      return exportSave(loaded.save)
    })
  }
}
