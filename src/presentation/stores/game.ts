/**
 * 主 Pinia Store（**服务端存档镜像** + 意图发送器）。
 *
 * ── 服务端权威（铁律 #28 / #29）────────────────────────────────────────
 * 客户端**不再自己算结果**，只做两件事：
 *   ① 发意图：把界面操作翻译成动作（`GameAction`）发给服务端；
 *   ② 渲染：把服务端回传的存档当成**只读镜像**展示。
 *
 * 存档的唯一权威在服务端（`POST /api/action` 落库）。
 * localStorage 里的存档降级为**只读缓存**：首屏加速 + 断网时能看进度，
 * 但它**不是**权威，也不再被本进程当作写入目标。
 *
 * 铁律：
 *   - 表现层**不得**直接访问 localStorage，一律经 src/platform/storage.ts
 *   - 所有规则计算走 core/ 的纯逻辑层（core 在**服务端**执行，与客户端同一份）
 *   - 时间经 core/time.ts 的 Clock 注入，不直接读 Date.now()
 *   - 后端接口一律经 src/platform/account.ts（表现层不直连 API）
 */
import { defineStore } from 'pinia'
import { ref, computed, shallowRef } from 'vue'
import type {
  SaveData,
  HeroState,
  HeroRuntime,
  RelicInstance,
  RewardBundle,
  BattleResult,
  ArenaMatch,
  Element,
  Rarity,
  IdleChannelKind,
} from '../../core/model/types.ts'
import { IDLE_CHANNEL_KINDS } from '../../core/model/types.ts'
import type { ItemId } from '../../core/config/items.ts'
import type { DungeonDifficultyId, RelicStoneTierId } from '../../core/config/economy.ts'
import { createNewSave, normalizeSave } from '../../core/save/schema.ts'
import { deserializePublicSave } from '../../core/save/serialize.ts'
import { storage } from '../../platform/storage.ts'
import { newActionId, randomSeed } from '../../platform/random.ts'
import { systemClock } from '../../core/time.ts'
import { HEROES, HERO_INDEX } from '../../core/config/heroes/index.ts'
import { STAGES } from '../../core/config/stages.ts'
import { computeBondState, isTeamEmpty } from '../../core/systems/team.ts'
import { type HeartbeatResult, type IdleActionResult } from '../../core/systems/actions.ts'
import { idlePendingRolls, type ChannelSettlement } from '../../core/systems/idle.ts'
import { getEquippedRelics, equippedOwnerMap, RELIC_SLOT_COUNT } from '../../core/systems/loadout.ts'
import { getPool } from '../../core/config/pools.ts'
import {
  relicUpgradeCost,
  applyRelicUpgrade,
  decomposeValue,
  RELIC_DEFS,
  RELIC_SETS,
} from '../../core/systems/relic.ts'
import { type RelicAdvice } from '../../core/systems/relic-advice.ts'
import {
  applyExp,
  applySkillUp,
  skillUpCost,
  skillLevelCap,
  starUpCost,
  applyStarUp,
  realmBreakCost,
  atRealmGate,
  applyRealmBreak,
} from '../../core/systems/growth.ts'
import { ratesForPool as computePoolRates } from '../../core/systems/gacha.ts'
import { previewRebirth, performRebirth } from '../../core/systems/rebirth.ts'
import { arenaSnapshotHash, resolveArenaMatch, arenaContext, resolveArenaRewards, type ArenaReward } from '../../core/systems/arena.ts'
import { ladderTierIndex as ladderTierIndexOf, ladderTierName } from '../../core/systems/ladder.ts'
import { arenaWeekIndex, dayIndex } from '../../core/time.ts'
import { DAILY, IDLE, LEVEL, REDEEM_CODES, RELIC } from '../../core/config/economy.ts'
import { ACCOUNT, ACCOUNT_STORAGE_KEYS, ACCOUNT_ERROR_CODES, accountSlotKey } from '../../core/config/account.ts'
import { GAME_ERROR_MESSAGES } from '../../core/config/game-errors.ts'
import { useAccountStore } from './account.ts'
import { describeAccountError } from './account.ts'
import { AccountError } from '../../platform/account.ts'
import { formatNumber } from '../utils/format.ts'
import '../../core/config/relics.ts'
import '../../core/config/enemies.ts'
import {
  type ActionResultMap,
  type GameAction,
  type GameActionType,
} from '../../core/systems/actions.ts'
import type { ActionResponse, SaveSnapshot } from '../../core/systems/action-protocol.ts'
import type { RelicPage, RelicStats } from '../../platform/account.ts'
import {
  buildArenaSnapshot,
  buildEquippedMap,
  buildHeroIndex,
  buildRelicsByUid,
  buildTeam,
  buildTeamPower,
} from '../../core/systems/derive.ts'

/**
 * **一次手动挑战的回放状态**（表现层播放战斗演出用）。
 *
 * ⚠ 只装**战斗事实**（core 产出的东西）：胜负、首通、实发奖励、战斗回放。
 *   关卡名 / 章节由表现层按关卡 id 从 core 配置表查（唯一出处，铁律 #8）。
 */
export interface ChallengeReplay {
  /** 挑战类型：主线 / 副本 */
  kind: 'campaign' | 'dungeon'
  /** 关卡 id（主线为数字，副本为字符串） */
  stageId: number | string
  /** 是否胜利 */
  win: boolean
  /** 是否首次通关 */
  firstClear: boolean
  /** 实发奖励（战败时为空包） */
  rewards: RewardBundle
  /** 战斗回放（`null` = 服务端这次没回传，见 `challengeReplay` 注释） */
  battle: BattleResult | null
}

export const useGameStore = defineStore('game', () => {
  /**
   * 时钟必须是**会走动**的。
   *
   * 历史教训：这里曾用 `ManualClock`，只在 load() 时 set 一次，于是整局游戏的
   * `history.at` / `obtainedAt` / `lastTickAt` 全部等于「页面加载那一刻」——
   * 抽卡记录的时间戳全部一样，离线结算时长也算不准。注入时钟是为了可测试，
   * 不是为了冻结时间；需要伪造时间的测试用 core 层的 `ManualClock`。
   */
  const clock = systemClock

  /**
   * 服务端存档的**本地镜像**。
   *
   * ⚠ 它由服务端的响应覆盖，客户端**不得**直接改它——
   *   改了也会在下一次响应时丢失（那正是「服务端权威」的意义）。
   *   要改存档，一律走 `runAction`。
   */
  const save = ref<SaveData>(createNewSave(clock.now()))

  /**
   * 离线模式：服务端不可达。
   *
   * 此时只能**看**（展示本地缓存里的存档），不能操作——
   * 操作必须由服务端执行，客户端自己算就是「客户端权威」了。
   */
  const offline = ref(false)

  /** 正在发动作（UI 可据此禁用按钮） */
  const busy = ref(false)

  /**
   * **手动挑战的战斗回放**（表现层播放用）。
   *
   * ⚠ 战斗在**服务端**执行（core 同一份），回放由响应**一次性**回传
   *   （不进 24 小时幂等日志，设计稿 §3.7）⇒ 这里存的是「刚打完那一场」。
   * ⚠ `battle` 可能为 `null`：24 小时内重放同一 `actionId` 时服务端不再回传回放，
   *   客户端按「已结算」处理——只出结算，不重播演出（结果与奖励仍一致）。
   */
  const challengeReplay = shallowRef<ChallengeReplay | null>(null)

  /** 关掉挑战回放面板（玩家点「收起」） */
  function clearChallengeReplay() {
    challengeReplay.value = null
  }
  /** 离线结算结果（分通道明细） */
  const offlineReport = shallowRef<IdleActionResult | null>(null)
  /**
   * 四条挂机通道的**待结算次数**（界面显示「可结算 N 次」的唯一来源）。
   *
   * ⚠ **不能读客户端镜像里的 `effectiveMs`**：
   *   镜像只在服务端回包时刷新，而服务端**回包前必先结算**
   *   ⇒ 镜像里的余额恒是「不足一次」的余数 ⇒ 界面会永远显示「0 次」，
   *     而点下去服务端照发（数字自相矛盾）。
   *
   * ⚠ 真相有两个来源，**都取服务端口径**：
   *   ① **心跳回执**（`idle.heartbeat` 的 `pending`）——实时；
   *   ② **收到存档快照时按同一份换算重算**（服务端刚结算过 ⇒ 与服务端一致）。
   *
   * ⚠ **遗物通道是第四条**（存档 v12）：主 / 技能 / 强化 / 遗物。
   */
  const idlePending = ref<Record<IdleChannelKind, number>>({
    main: 0,
    skill: 0,
    enhance: 0,
    relic: 0,
  })
  /** 全局提示 */
  const toast = ref<{ text: string; kind: 'info' | 'ok' | 'warn' } | null>(null)
  /** 新手引导步骤（-1 = 结束） */
  const guideStep = ref(-1)
  /**
   * 本次会话是否已经触发过首启引导。
   *
   * 只在内存里：玩家本次游玩不该被引导反复打断；
   * 跨会话是否再引导由「有没有英灵」决定（没英灵 = 还没真正开始玩）。
   */
  const guideSeen = ref(false)
  /**
   * 存档是否已经载入。
   *
   * 路由守卫用它决定「要不要载入存档」——每次导航都载一遍既慢又会
   * 把存档的时间戳刷掉；登出 / 换账号时由 `invalidate()` 清掉。
   */
  const loaded = ref(false)
  /** 战斗播放器倍速 */
  const battleSpeed = ref(1)

  let toastTimer: ReturnType<typeof setTimeout> | null = null
  function notify(text: string, kind: 'info' | 'ok' | 'warn' = 'info') {
    toast.value = { text, kind }
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.value = null), 2200)
  }

  // ─────────────────────────── 动作队列 ───────────────────────────

  /**
   * 动作请求队列（串行）。
   *
   * 服务端本来就按账号串行执行，但**响应**回到客户端的顺序未必与请求顺序
   * 一致。若乱序应用响应，本地镜像会「回退」到旧版本（用户会看到
   * 「刚抽到的英灵又没了」）。这里在客户端也串一次，保证镜像单调前进。
   */
  let actionQueue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = actionQueue.then(fn, fn)
    actionQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // ─────────────────────────── 持久化（只读缓存） ───────────────────────────

  /**
   * 写本地缓存。
   *
   * ⚠ 服务端权威后，这里**不再**是「存档写入入口」，只是把服务端返回的
   *   存档顺手落到 localStorage：首屏能秒开、断网时还能看进度。
   *   它**不是**权威，也不会被当成写入目标（铁律 #28）。
   */
  async function persist(_critical = false): Promise<boolean> {
    /**
     * ⚠ 存量单槽位 `sgw.save.main` 是**旧档迁移通道**，不是缓存槽位。
     *
     * 新版客户端往那里写新档会污染迁移：
     * ① 第一个账号登录时，`takeLegacySave` 会把这份新档当成「旧档」导入服务端
     *    （`save.create` 被跳过），服务端存档的内容其实来自这份本地新档；
     * ② 更糟的是它顺手置上了 `sgw.legacyMigrated` 标记 → 玩家**真正的旧档**
     *    此后永远迁不过来（静默丢档）。
     *
     * 存档归属由账号决定（铁律 #15）：未登录 → 没有账号槽位 → 没有档可缓存。
     */
    if (slot.value === ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT) return true
    try {
      await storage.save(slot.value, save.value)
      return true
    } catch {
      notify('本地缓存保存失败，请检查浏览器存储空间', 'warn')
      return false
    }
  }

  /**
   * 当前使用的本地缓存槽位。
   *
   * 缓存归属由**账号**决定：每账号一个槽位（`sgw.save.<账号 id>`），
   * 换账号即换槽位，不会串号。未登录时用存量单槽位 `main`。
   */
  const slot = ref<string>(ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT)

  /** 账号 id → 槽位名；未登录返回存量槽位 */
  function slotForAccount(accountId: number | null | undefined): string {
    return accountId == null
      ? ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT
      : accountSlotKey(accountId)
  }

  /** 把服务端返回的存档覆盖到本地镜像，并顺手写缓存 */
  async function applyServerSave(snapshot: SaveSnapshot | undefined): Promise<void> {
    if (!snapshot) return
    const next = deserializePublicSave(snapshot.payload)
    next.savedAt = snapshot.savedAt
    save.value = next
    // ⚠ 收到存档快照 = 服务端**刚结算过**（回包前必先结算）⇒ 此刻的待结算次数
    //   按**同一份换算**重算即可与服务端对齐（心跳回包是另一条实时来源）。
    //
    // ⚠ **必须传 `now`**：遗物通道的待结算次数还要受「每日额度」裁剪
    //   （core 的 `idlePendingRolls` 内部按 `relicQuotaLeft(save, now)` 取上限），
    //   少传一个参数就等于把「今天还能领多少件遗物」算错（铁律 #62：界面只能少写）。
    //   时间一律取**注入时钟**（铁律 #12：禁止 `Date.now()`）。
    idlePending.value = idlePendingRolls(next, clock.now())
    // 回放倍速跟随服务端设置（设置本身也是服务端权威的）
    battleSpeed.value = next.settings.speed ?? 1
    // 缓存同步写完再返回：界面与自动化脚本读缓存时拿到的就是最新版本
    await persist()
  }

  // ─────────────────────────── 动作 ───────────────────────────

  /**
   * 发一个动作给服务端，并同步本地镜像。
   *
   * 契约（铁律 #29）：
   * - 动作的**校验与执行**都在服务端（core 纯函数，同一份）；
   * - 客户端只负责发意图、翻译错误码、渲染结果；
   * - 业务失败 → 返回 null 并提示（服务端没改存档，镜像不变）；
   * - 网络不可达 → 进入离线模式（只能看，不能操作）。
   */
  async function runAction<T extends GameActionType>(
    action: Extract<GameAction, { type: T }>,
    critical = false,
  ): Promise<ActionResultMap[T] | null> {
    const account = useAccountStore()
    if (!account.isAuthenticated) {
      notify('请先登录', 'warn')
      return null
    }
    if (offline.value || account.offline) {
      offline.value = true
      notify('当前处于离线模式，只能查看进度', 'warn')
      return null
    }

    const epoch = generation
    const owner = account.user?.id
    const current = () => generation === epoch && account.user?.id === owner
    const actionId = newActionId()
    busy.value = true
    try {
      return await enqueue(async () => {
        if (!current()) return null
        let response: ActionResponse
        try {
          response = await account.sendAction(actionId, action)
        } catch (err) {
          if (!current()) return null
          if (isNetworkFailure(err)) {
            offline.value = true
            notify('无法连接服务器，已切换到离线模式', 'warn')
          } else {
            notify(describeAccountError(err), 'warn')
          }
          return null
        }

        if (!current()) return null
        // 服务端回传的存档 = 权威版本（覆盖本地镜像）
        await applyServerSave(response.save)
        if (!current()) return null
        // 离线结算明细：只有「离线时长达到阈值」才弹窗。
        // ⚠ 服务端已经过滤过一次，这里再挡一道——在线期间累计的时间账本
        //   被下一次动作结算掉时，那明明是在线收益，不该弹「离线结算」。
        const report = offlineReportable(response.offline)
        if (report) offlineReport.value = report
        if (!response.ok) {
          if (!response.silent) {
            notify(response.message || messageOf(response.code), 'warn')
          }
          return null
        }
        if (response.message) notify(response.message, response.messageKind ?? 'ok')
        const result = response.result as ActionResultMap[T] | undefined
        // ⚠ **战斗回放一次性回传**（设计稿 §3.7）：服务端在落库前把它从结果里
        //   摘出来放进响应的 `replay` 字段（`BattleResult.log` 太大，不能进幂等日志）。
        //   客户端在这里把它接回结果的 `battle` 字段 ⇒ 表现层统一从 `res.battle` 取回放，
        //   不用在每个调用点各写一套「replay 从哪来」。
        //   24 小时内重放同一 actionId 时服务端不再回传 ⇒ `battle` 缺失 ⇒ 只出结算不重播。
        if (response.replay && result && typeof result === 'object') {
          return { ...result, battle: response.replay } as ActionResultMap[T]
        }
        return result ?? null
      })
    } finally {
      if (current()) busy.value = false
    }
  }

  /** 错误码 → 兜底文案 */
  function messageOf(code: string | undefined): string {
    if (!code) return '操作失败'
    return GAME_ERROR_MESSAGES[code as keyof typeof GAME_ERROR_MESSAGES] ?? '操作失败'
  }

  /**
   * 离线结算明细的**阈值判定**（服务端已过滤一道，这里再挡一道）。
   *
   * ⚠ **挂机改版 v11**：四条通道各自报告自己的实际离线时长 ⇒ 取**最大值**判定。
   *   在线计量不计入该时长（只有离线段才累加）。
   */
  function offlineReportable(report: IdleActionResult | null | undefined): IdleActionResult | null {
    if (!report || report.channels.length === 0) return null
    const max = report.channels.reduce((m, c) => Math.max(m, c.elapsedSeconds), 0)
    return max >= IDLE.OFFLINE_SETTLE_THRESHOLD_SEC ? report : null
  }

  /** 是不是「连不上服务器」 */
  function isNetworkFailure(err: unknown): boolean {
    return err instanceof AccountError && err.code === ACCOUNT_ERROR_CODES.NETWORK
  }

  // ─────────────────────────── 载入 ───────────────────────────

  /**
   * 载入存档。
   *
   * 口径（服务端权威）：
   * - 服务端**有**存档 → 采纳服务端版本（本地缓存只用于首屏加速）；
   * - 服务端**没有**存档 → 先把存量旧档（`sgw.save.main`）导入过去，
   *   没有旧档就让服务端建一份新档；
   * - 服务端**连不上** → 离线模式：展示本地缓存，不能操作。
   */
  let generation = 0
  let reconnectTask: Promise<boolean> | null = null
  const reconnecting = ref(false)

  /** 不依赖loaded；恢复必须成功拉到权威存档才解锁动作。 */
  function reconnect(): Promise<boolean> {
    if (reconnectTask) return reconnectTask
    const account = useAccountStore()
    const id = account.user?.id
    const epoch = generation
    const current = () => generation === epoch && account.user?.id === id
    reconnecting.value = true
    const task = enqueue(async () => {
      try {
        if (!id || !current()) return false
        if (!account.accessToken) await account.ensureRestored()
        if (!current() || !account.isAuthenticated) return false
        const cloud = await account.pullCloudSave()
        if (!current() || !cloud) return false
        await applyServerSave(cloud)
        if (!current()) return false
        const cloudReport = offlineReportable(cloud.offline)
        if (cloudReport) offlineReport.value = cloudReport
        account.offline = false
        offline.value = false
        loaded.value = true
        return true
      } catch (err) {
        if (current()) { offline.value = true; notify(describeAccountError(err), 'warn') }
        return false
      }
    })
    reconnectTask = task
    void task.finally(() => {
      if (reconnectTask === task) { reconnectTask = null; reconnecting.value = false }
    })
    return task
  }

  /**
   * **刷新服务端存档镜像**（只拉取，不建档 / 不迁移）。
   *
   * ⚠ 为什么需要它：客户端镜像只在**动作回包**时刷新，
   *   而「副本通关记录」这类事实可能刚被**另一条链路**改掉
   *   （另一台设备打赢的副本、后台脚本跑的动作）。
   *   镜像不刷新 ⇒ 副本页把「已通关」显示成「未通关」，
   *   「设为挂机通道」按钮**一直禁用** ⇒ 玩家以为功能坏了（铁律 #10）。
   *
   * ⚗ 与 `load()` 的区别：`load()` 还负责建档 / 旧档迁移（**有副作用**），
   *   页面级刷新不能走那条路 —— 每进一次页面都跑一遍迁移检查既慢又危险。
   *
   * ⚠ **走动作队列**（`enqueue`）：刷新与动作**串行**——
   *   否则「刷新拉到的快照」可能比「并发动作的结果」旧，
   *   后落地的刷新会把刚生效的进度**回滚**掉（镜像倒退 = 玩家看到的东西凭空消失）。
   */
  async function refreshSave(): Promise<boolean> {
    const account = useAccountStore()
    if (offline.value || account.offline || !account.isAuthenticated) return false
    return enqueue(async () => {
      try {
        const cloud = await account.pullCloudSave()
        if (!cloud) return false
        await applyServerSave(cloud)
        return true
      } catch (err) {
        if (isNetworkFailure(err)) offline.value = true
        return false
      }
    })
  }

  async function load() {
    const account = useAccountStore()
    const accountId = account.user?.id ?? null
    const epoch = generation
    const current = () => generation === epoch && account.user?.id === accountId
    slot.value = slotForAccount(accountId)
    offline.value = false

    // 本地缓存（首屏加速 / 离线兜底）
    let local: SaveData | null = null
    try {
      local = await storage.load(slot.value)
    } catch {
      local = null
    }

    if (!current()) return
    // 会话层已经判定离线（连不上服务器）→ 只读模式，直接用本地缓存
    if (account.offline) {
      offline.value = true
      save.value = normalizeSave(local)
      battleSpeed.value = save.value.settings.speed ?? 1
      loaded.value = true
      notify('当前处于离线模式，只能查看进度', 'warn')
      return
    }

    // 服务端权威存档
    let cloud = null as Awaited<ReturnType<typeof account.pullCloudSave>>
    if (accountId != null) {
      try {
        cloud = await account.pullCloudSave()
        if (!current()) return
      } catch (err) {
        if (!current()) return
        if (isNetworkFailure(err)) {
          offline.value = true
        } else {
          notify(describeAccountError(err), 'warn')
        }
        cloud = null
      }
    }

    if (cloud) {
      // 服务端有存档 → 以服务端为准
      const server = deserializePublicSave(cloud.payload)
      server.savedAt = cloud.savedAt
      save.value = server
      battleSpeed.value = server.settings.speed ?? 1
      const serverReport = offlineReportable(cloud.offline)
      if (serverReport) offlineReport.value = serverReport
      await persist()
      if (!current()) return
      loaded.value = true
      return
    }

    if (offline.value) {
      // 离线且服务端还没有存档 → 用本地缓存兜底（只读）
      save.value = normalizeSave(local)
      loaded.value = true
      notify('当前处于离线模式，只能查看进度', 'warn')
      return
    }

    // 服务端还没有存档：先把存量旧档迁过去，没有就让服务端建一份
    const legacy = await takeLegacySave(accountId)
    if (!current()) return
    if (legacy) {
      const imported = await runAction({ type: 'save.import', payload: legacy, legacy: true })
      if (!current()) return
      if (!imported) {
        // 响应可能丢失：先独立拉档确认，绝不静默建档吞掉旧档。
        try {
          const confirmed = await account.pullCloudSave()
          if (!current() || !confirmed) return
          await applyServerSave(confirmed)
          if (!current()) return
          account.offline = false
          offline.value = false
        } catch { return }
      }
      try { await storage.setFlag(ACCOUNT_STORAGE_KEYS.LEGACY_MIGRATED, true) }
      catch { notify('云端迁移已完成，本地标记保存失败；旧档仍保留', 'warn') }
    } else {
      const created = await runAction({ type: 'save.create' })
      if (!created || !current()) return
    }
    if (!current()) return
    loaded.value = true
  }

  /**
   * 取走存量单槽位旧档（`sgw.save.main`）。
   *
   * 只迁一次——`sgw.legacyMigrated` 标记防止把旧档迁给第二个账号；
   * 服务端也会记一份账号标记（`user_flags`），两边都拦一道。
   *
   * ⚠ 这个槽位是**迁移通道**：新版客户端**不得**往里写（见 persist 注释），
   *   里面躺着的就当旧档迁走。
   */
  async function takeLegacySave(accountId: number | null): Promise<string | null> {
    if (accountId == null) return null
    const legacyKey = ACCOUNT_STORAGE_KEYS.LEGACY_MIGRATED
    try {
      if (await storage.getFlag(legacyKey)) return null
      const legacy = await storage.load(ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT)
      if (!legacy) return null
      return await storage.export(legacy)
    } catch {
      return null
    }
  }

  /**
   * 登出 / 换账号：清掉已载入标记与内存中的存档。
   *
   * 不清会让上一个账号的进度短暂显示在新账号下（串号），
   * 路由守卫在未登录时会调用本方法。
   */
  function invalidate() {
    generation++
    reconnectTask = null
    heartbeatTask = null
    busy.value = false
    reconnecting.value = false
    loaded.value = false
    guideSeen.value = false
    offline.value = false
    // 未登录 → 没有账号槽位：回到存量单槽位。
    // persist() 会跳过它（迁移通道不能被新档污染，见 persist 注释）。
    slot.value = ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT
    // 换号 → 换一条随机序列：上一个账号的抽卡位置不能带到新账号
    save.value = createNewSave(clock.now())
    // 上一个账号的离线结算报告不能带到新账号上
    offlineReport.value = null
    // 同理：上一个账号的挂机待结算次数不能带到新账号上（会显示成「有 N 次可领」）
    idlePending.value = { main: 0, skill: 0, enhance: 0, relic: 0 }
    // 同理：上一场战斗的回放不能带到新账号
    challengeReplay.value = null
  }

  /**
   * 重置进度：玩家主动操作，服务端直接换一份新存档。
   */
  async function reset() {
    await runAction({ type: 'save.reset' }, true)
  }

  // ─────────────────────────── 运行时装配 ───────────────────────────

  const heroIndex = computed(() => buildHeroIndex(save.value))

  const relicsByUid = computed(() => buildRelicsByUid(save.value))

  /** 某英灵的 6 个遗物槽 */
  const equippedMap = computed(() => buildEquippedMap(save.value))

  /** 当前编队的运行时对象 */
  const team = computed<HeroRuntime[]>(() => buildTeam(save.value))

  /**
   * 每日入口的红点状态。
   *
   * ⚠ 跨天判定一律走 core 的 `dayIndex`（北京时间），
   *   表现层不自己算「今天是不是新的一天」（铁律 #2 / #8）。
   */
  const dailyStatus = computed(() => ({
    signedToday: save.value.daily.lastSignInDay === dayIndex(clock.now()),
  }))

  const teamPower = computed(() => buildTeamPower(save.value))
  const bondStates = computed(() => computeBondState(team.value))
  const teamEmpty = computed(() => isTeamEmpty(save.value.team.slots))

  /**
   * **当前主线关卡**（跟随最新通关关卡）。
   *
   * ⚠ 挂机改版 v11：主线通道默认「跟随最新通关关卡」，
   *   所以「当前关卡」= `campaign.clearedStage`（首胜前是第 1 关）。
   */
  const currentStage = computed(() => {
    const id = Math.max(1, save.value.campaign.clearedStage)
    return STAGES.find((s) => s.id === id) ?? STAGES[0]
  })
  const clearedStage = computed(() => save.value.campaign.clearedStage)

  /** 下一关可挑战的关卡（首胜前是第 1 关） */
  const nextChallengeStage = computed(() => {
    const id = Math.min(STAGES.length, save.value.campaign.clearedStage + 1)
    return STAGES.find((s) => s.id === id) ?? STAGES[0]
  })

  /**
   * 四条挂机通道的**可结算次数**（界面显示用）。
   *
   * ⚠ 取 `idlePending`（服务端口径），**不是**客户端镜像里的 `effectiveMs`——
   *   镜像里的余额恒是「不足一次」的余数 ⇒ 永远显示 0 次（见 `idlePending` 注释）。
   *
   * ⚠ 通道清单走 core 的 `IDLE_CHANNEL_KINDS`（**唯一一份**，铁律 #3）：
   *   漏掉一条 = 界面少一个入口（遗物通道曾被漏过）。
   */
  const idleChannels = computed(() =>
    IDLE_CHANNEL_KINDS.map((kind) => ({
      kind,
      state: save.value.idle.channels[kind],
      rolls: idlePending.value[kind],
    })),
  )

  /** 玩家持有的英灵列表（按稀有度、等级排序） */
  const ownedHeroes = computed(() => {
    const list = HEROES.filter((h) => save.value.heroes[h.id])
    const rarityRank: Record<string, number> = { SSR: 3, SR: 2, R: 1, N: 0 }
    return list.sort((a, b) => {
      const r = rarityRank[b.rarity] - rarityRank[a.rarity]
      if (r !== 0) return r
      const la = save.value.heroes[a.id]?.level ?? 0
      const lb = save.value.heroes[b.id]?.level ?? 0
      return lb - la
    })
  })

  // ─────────────────────────── 挂机 ───────────────────────────

  let heartbeatTask: Promise<HeartbeatResult | null> | null = null
  /** 可见性由App传达；store不读DOM。复用动作队列与账号世代检查。 */
  function heartbeat(): Promise<HeartbeatResult | null> {
    if (!loaded.value || offline.value || !useAccountStore().isAuthenticated) return Promise.resolve(null)
    if (heartbeatTask) return heartbeatTask
    const task = runAction({ type: 'idle.heartbeat' }).then((res) => {
      // ⚠ 心跳回执带**各通道待结算次数**（服务端账本的真相）——
      //   客户端镜像拿不到（心跳不回传存档主体），界面只能靠这个数显示。
      if (res) idlePending.value = res.pending
      return res
    })
    heartbeatTask = task
    void task.finally(() => { if (heartbeatTask === task) heartbeatTask = null })
    return task
  }

  /**
   * **一键领取挂机收益**（四条通道同时结算）。
   *
   * ⚠ **挂机改版 v11**：挂机**不跑战斗**，领取次数由服务端按各通道的
   *   可用预算决定；客户端**不能**创造时间（不再传 `battles`）。
   * ⚠ 挂机**不需要编队**：当前编队变化不影响已通关目标的挂机资格。
   */
  async function tickIdle() {
    return runAction({ type: 'idle.tick' })
  }

  /** 离线结算（服务端在入口自动补算，这里取回明细） */
  async function claimOffline() {
    const res = await runAction({ type: 'idle.claimOffline' })
    if (res) offlineReport.value = res
    return res
  }

  /**
   * **设置挂机通道**（主线 / 技能副本 / 强化副本 / 遗物副本）。
   *
   * ⚠ 四条通道**各自独立**账本：设置一条**不影响**另外三条。
   * ⚠ 主线只能选**已通关**的关卡；副本只能选**已通关**的副本关卡。
   */
  async function setIdleChannel(payload: {
    channel: IdleChannelKind
    stageId?: number | null
    dungeonStageId?: string
    disabled?: boolean
  }) {
    return runAction({ type: 'idle.setChannel', ...payload })
  }

  /**
   * **手动挑战主线关卡**（主线推进的唯一路径）。
   *
   * ⚠ 战斗执行在服务端（core 同一份），回放一次性回传（不进幂等日志）。
   */
  async function challengeStage(stageId?: number) {
    const res = await runAction({ type: 'campaign.challenge', ...(stageId !== undefined ? { stageId } : {}) })
    if (!res) return null
    challengeReplay.value = {
      kind: 'campaign',
      stageId: res.stageId,
      win: res.win,
      firstClear: res.firstClear,
      rewards: res.rewards,
      battle: res.battle ?? null,
    }
    return res
  }

  /** **手动挑战副本关卡**（打赢一次即通关） */
  async function challengeDungeon(stageId: string) {
    const res = await runAction({ type: 'dungeon.challenge', stageId })
    if (!res) return null
    challengeReplay.value = {
      kind: 'dungeon',
      stageId: res.stageId,
      win: res.win,
      firstClear: res.firstClear,
      rewards: res.rewards,
      battle: res.battle ?? null,
    }
    return res
  }

  /**
   * ⚠ **存档 v12 起「遗物祈愿」已下线**（core 的动作 `relic.acquire` 已删除）。
   *
   * 遗物的**唯一来源**是遗物副本（手动挑战 / 遗物挂机通道），
   * 表现层不再有「花银两换一件遗物」这条路——留着这个包装函数
   * 只会让编译期报错（动作层已无此动作），所以这里**整段删掉**，
   * 而不是留一个空壳。
   */

  // ─────────────────────────── 英灵 ───────────────────────────

  /** 抽卡 */
  async function pull(poolId: string, count: 1 | 10) {
    return runAction({ type: 'gacha.pull', poolId, count }, true)
  }

  /**
   * 概率公示快照。
   * 按**当前卡池**计算——纪元池只收录 SSR/SR，其概率与常驻池不同，
   * 公示必须展示该池的真实概率（合规要求：公示 = 实际）。
   */
  const currentPoolId = ref('standard')

  const rates = computed(() => ratesForPool(currentPoolId.value))

  /** 指定卡池的概率公示快照（合规页需要逐池公示） */
  function ratesForPool(poolId: string) {
    const { gacha } = save.value
    return computePoolRates(getPool(poolId), gacha, !loaded.value || gacha.newbieUsed === true)
  }

  // ─────────────────────────── 养成 ───────────────────────────

  /**
   * 喂经验书：消耗**背包里的经验书**投给英灵。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：玩家经验池退役 →
   *   经验改由「主线掉落经验书 → 手动喂给英灵」产出（设计稿 §2）。
   *   扣的是**书**（本数），不是银两、不是经验池。
   */
  async function feedBooks(heroId: string, bookId: ItemId, count: number) {
    return runAction({ type: 'hero.feedBooks', heroId, bookId, count }, true)
  }

  /**
   * 境界突破：消耗**银两**把英灵送进下一个境界。
   *
   * ⚠ **实施修正（资源/背包版本 v10）**：英灵印记已退役，
   *   突破改扣银两（设计稿 §2「建议 Lv60、120、180 的境界突破改扣银两」）。
   */
  async function breakRealm(heroId: string) {
    return runAction({ type: 'hero.breakRealm', heroId }, true)
  }

  async function upgradeSkill(heroId: string, index: number) {
    return runAction({ type: 'hero.upgradeSkill', heroId, index }, true)
  }

  async function upgradeStar(heroId: string) {
    return runAction({ type: 'hero.upgradeStar', heroId }, true)
  }

  /**
   * 强化遗物。
   *
   * ⚠ 强化后要**重拉仓库页**：客户端镜像里只有已装备遗物，
   *   仓库里那件的等级变了，界面得从服务端重新取（否则详情面板显示旧等级）。
   */
  async function upgradeRelic(uid: string) {
    const res = await runAction({ type: 'relic.upgrade', uid }, true)
    if (res) {
      await loadRelicPage()
      await loadRelicStats()
    }
    return res
  }

  async function decomposeRelic(uid: string) {
    const res = await runAction({ type: 'relic.decompose', uid }, true)
    if (res) {
      await loadRelicPage()
      await loadRelicStats()
    }
    return res
  }

  // ─────────────────────────── 遗物仓库（分页） ───────────────────────────

  /**
   * 仓库当前页（服务端权威）。
   *
   * ⚠ **分包后客户端镜像里只有已装备遗物**（≤36 件）：
   *   仓库里可能有数千件，整包随存档回传会把每个动作的响应撑到 MB 级。
   *   仓库改走 `GET /api/relics` 分页查询（只读，不改存档）。
   */
  const relicPage = ref<RelicPage>({ items: [], total: 0, page: 1, size: 60, pages: 1 })
  /** 仓库是否正在加载 */
  const relicPageLoading = ref(false)
  /** 仓库加载失败的原因（离线 / 未登录 / 服务端错误） */
  const relicPageError = ref<string | null>(null)
  /** 遗物统计（仓库总数 + 按定义 id 分组 + 仓库最高等级）：顶栏件数与图鉴收藏数用它 */
  const relicStats = ref<RelicStats>({ total: 0, byDefId: {}, maxLevel: 0 })
  /**
   * 仓库统计是否**已经读到过**服务端数据。
   *
   * ⚠ 客户端镜像里 `save.relics` 只有**已装备**件（存档分包），
   *   仓库里那件 Lv60 的客户端看不见 → 强化副本的解锁线要用服务端统计的
   *   `relicStats.maxLevel`。**没读到之前不能给结论**，
   *   否则会把「已解锁」误判成「未解锁」（玩家明明有 Lv60 却点不了）。
   */
  const relicStatsLoaded = ref(false)

  /**
   * **仓库里各套装共有多少件**（套装 id → 件数）。
   *
   * ⚠ **套装进度只有这一份口径**：副本页（这个副本覆盖的套装已有几件）
   *   与遗物仓库（12 个套装各 x / 5 件）都读它——两处各算一套的话，
   *   玩家会看到「仓库说 3 件、副本页说 2 件」这种自相矛盾的数字。
   *
   * ⚠ 数据源是**服务端统计**（`relicStats.byDefId`）：客户端镜像里
   *   只有已装备遗物，直接数 `save.relics` 会漏掉仓库里的大部分件。
   */
  const relicSetCounts = computed(() => {
    const map = new Map<string, number>()
    for (const [defId, count] of Object.entries(relicStats.value.byDefId)) {
      const def = RELIC_DEFS.get(defId)
      if (!def) continue
      map.set(def.setId, (map.get(def.setId) ?? 0) + count)
    }
    return map
  })
  /**
   * 最近一次仓库查询条件。
   *
   * 批量操作后要**按原条件重载**（还在第 3 页、还带着稀有度筛选），
   * 所以要把查询条件记下来，不能每次都重置成第一页。
   */
  let lastRelicQuery: {
    page?: number
    size?: number
    rarity?: string
    setId?: string
    defId?: string
    sort?: string
  } = {}

  /** 加载仓库某页 */
  async function loadRelicPage(query: {
    page?: number
    size?: number
    rarity?: string
    setId?: string
    defId?: string
    sort?: string
  } = {}): Promise<RelicPage | null> {
    const account = useAccountStore()
    if (offline.value || account.offline || !account.isAuthenticated) {
      relicPageError.value = '离线状态下无法加载仓库，恢复连接后再试'
      return null
    }
    const effective = { ...lastRelicQuery, ...query }
    lastRelicQuery = effective
    relicPageLoading.value = true
    try {
      const page = await account.fetchRelicPage(effective)
      relicPage.value = page
      relicPageError.value = null
      return page
    } catch (err) {
      if (isNetworkFailure(err)) offline.value = true
      relicPageError.value = describeAccountError(err)
      return null
    } finally {
      relicPageLoading.value = false
    }
  }

  /** 加载遗物统计（仓库总数 / 按定义分组 / 仓库最高等级） */
  async function loadRelicStats(): Promise<RelicStats | null> {
    const account = useAccountStore()
    if (offline.value || account.offline || !account.isAuthenticated) return null
    try {
      const stats = await account.fetchRelicStats()
      relicStats.value = stats
      relicStatsLoaded.value = true
      return stats
    } catch (err) {
      if (isNetworkFailure(err)) offline.value = true
      return null
    }
  }

  /**
   * 临时拉一页仓库（**不**写入仓库页状态）。
   *
   * 用于「遗物选择器」这类一次性场景：它要的是仓库里的一页，
   * 不该把铸造页的页码 / 筛选状态冲掉。
   */
  async function queryRelics(query: {
    page?: number
    size?: number
    rarity?: string
    setId?: string
    defId?: string
    sort?: string
  } = {}): Promise<RelicPage | null> {
    const account = useAccountStore()
    if (offline.value || account.offline || !account.isAuthenticated) return null
    try {
      return await account.fetchRelicPage(query)
    } catch (err) {
      if (isNetworkFailure(err)) offline.value = true
      return null
    }
  }

  /** 取单件遗物（详情页用；仓库列表里没有的那件也要能看） */
  async function fetchRelic(uid: string): Promise<RelicInstance | null> {
    const account = useAccountStore()
    if (offline.value || account.offline || !account.isAuthenticated) return null
    try {
      return await account.fetchRelicByUid(uid)
    } catch (err) {
      if (isNetworkFailure(err)) offline.value = true
      return null
    }
  }

  /** 锁定 / 解锁遗物（锁定件永不被自动分解） */
  async function lockRelic(uid: string, locked: boolean) {
    const res = await runAction({ type: 'relic.lock', uid, locked }, true)
    if (res) {
      await loadRelicPage()
      await loadRelicStats()
    }
    return res
  }

  /** 批量分解 */
  async function decomposeRelics(uids: string[]) {
    const res = await runAction({ type: 'relic.decomposeBatch', uids }, true)
    if (res) {
      await loadRelicPage()
      await loadRelicStats()
    }
    return res
  }

  /** 批量强化 */
  async function upgradeRelics(uids: string[], targetLevel?: number) {
    const res = await runAction(
      targetLevel === undefined
        ? { type: 'relic.upgradeBatch', uids }
        : { type: 'relic.upgradeBatch', uids, targetLevel },
      true,
    )
    if (res) {
      await loadRelicPage()
      await loadRelicStats()
    }
    return res
  }

  /**
   * 按筛选条件一键分解（默认清 1 级的未锁定未装备件）。
   *
   * ⚠ 单次动作上限 `RELIC.BATCH_MAX`（服务端同步执行，不能让事务长时间持锁），
   *   所以「一键清理」要**循环到清完**——否则仓库里几千件低等级遗物
   *   要点十几次才能清干净。
   */
  async function decomposeByFilter(filter: {
    rarity?: Rarity
    maxLevel?: number
    setId?: string
    includeEquipped?: boolean
  }) {
    let decomposed = 0
    let silver = 0
    let rounds = 0
    // 轮次上限只是防失控（64 × 200 = 12,800 件，远超库存上限）
    for (let i = 0; i < 64; i++) {
      const res = await runAction({ type: 'relic.decomposeByFilter', ...filter }, true)
      if (!res) return null
      rounds += 1
      decomposed += res.decomposed
      silver += res.silver
      // 不足一批 = 已经清完
      if (res.decomposed < RELIC.BATCH_MAX) break
    }
    if (decomposed > 0) {
      await loadRelicPage()
      await loadRelicStats()
    }
    // ⚠ 分解**只返银两**（不再返强化石，设计稿 §2）
    return { decomposed, silver, rounds }
  }

  // ─────────────────────────── 编队 ───────────────────────────

  async function setSlot(index: number, heroId: string | null) {
    return runAction({ type: 'team.setSlot', index, heroId })
  }

  async function savePreset(name: string) {
    return runAction({ type: 'team.savePreset', name })
  }

  async function applyPreset(id: string) {
    return runAction({ type: 'team.applyPreset', presetId: id })
  }

  async function removePreset(id: string) {
    return runAction({ type: 'team.removePreset', presetId: id })
  }

  async function equip(heroId: string, slot: number, relicId: string) {
    return runAction({ type: 'relic.equip', heroId, slot, relicId })
  }

  async function unequip(heroId: string, slot: number) {
    return runAction({ type: 'relic.equip', heroId, slot, relicId: null })
  }

  /**
   * 遗物一键推荐的**预览**（服务端计算，不改存档）。
   *
   * ⚠ 分包后客户端镜像里只有**已装备**遗物，本地算不出「仓库里哪件更强」。
   *   所以预览必须走服务端，且用的是与 `relic.autoEquip` **同一个函数**
   *   → 预览 = 执行（铁律 #2 / #4）。
   */
  async function fetchRelicAdvice(heroId: string): Promise<RelicAdvice | null> {
    const account = useAccountStore()
    if (offline.value || account.offline || !account.isAuthenticated) return null
    try {
      return await account.fetchRelicAdvice(heroId)
    } catch (err) {
      if (isNetworkFailure(err)) offline.value = true
      return null
    }
  }

  /** 一键按推荐装备遗物 */
  async function autoEquipRelics(heroId: string): Promise<RelicAdvice | null> {
    return runAction({ type: 'relic.autoEquip', heroId })
  }

  // ─────────────────────────── 播放设置 ───────────────────────────

  /**
   * 更新播放设置（倍速 / 音效 / 跳过演出）。
   *
   * 设置存在存档里 → 服务端权威后必须由服务端落库，
   * 否则下一次响应会把本地改动覆盖掉。
   */
  async function updateSettings(patch: {
    speed?: number
    sfx?: boolean
    skipAnim?: boolean
  }): Promise<void> {
    await runAction({ type: 'settings.update', ...patch })
    if (patch.speed !== undefined) battleSpeed.value = patch.speed
  }

  // ─────────────────────────── 圣杯重启 ───────────────────────────

  const rebirthPreview = computed(() => previewRebirth(save.value))

  async function doRebirth() {
    return runAction({ type: 'rebirth.do' }, true)
  }

  // ─────────────────────────── 竞技场 ───────────────────────────

  const arenaLoadout = computed(() => buildArenaSnapshot(save.value))

  const arenaHash = computed(() => arenaSnapshotHash(arenaLoadout.value))

  /**
   * 最近一场竞技对局的产出。
   *
   * 对局与结算在服务端**一次完成**（原子），这里只暂存结果供界面回显。
   */
  let lastArenaReward: ArenaReward | null = null

  /**
   * 发起一场竞技对局。
   *
   * 产出只来自 `resolveArenaRewards`（竞技专属池：勋章 / 竞技材料 / 兑换券），
   * **绝不回流**银两 / 经验 / 强化石 / 圣杯结晶（合规红线）。
   */
  async function runArenaMatch(): Promise<ArenaMatch | null> {
    const res = await runAction({ type: 'arena.settle' }, true)
    if (!res) return null
    lastArenaReward = res.reward
    return res.match
  }

  /** 观战预览只使用独立的平台种子。 */
  function nextBattleSeed(): number {
    return randomSeed()
  }

  /**
   * 取回刚刚那场对局的产出（服务端已入账）。
   */
  async function settleArena(_match?: ArenaMatch): Promise<ArenaReward | null> {
    const reward = lastArenaReward
    lastArenaReward = null
    return reward
  }

  // ─────────────────────────── 三队天梯（PVE 长线挑战） ───────────────────────────

  /** 天梯的三队阵容（存档镜像） */
  const ladderSquads = computed(() => save.value.arena.ladder.squads)

  /** 当前天梯段位名 */
  const ladderTier = computed(() => ladderTierName(save.value.arena.tierPoints ?? 0))

  /** 当前梯队层（决定这一轮会遇到哪三层敌方梯队） */
  const ladderTierIndex = computed(() => ladderTierIndexOf(save.value.arena.tierPoints ?? 0))

  /** 本周是否已经挑战过 */
  const ladderSettledThisWeek = computed(
    () => save.value.arena.ladder.lastSettledWeek === arenaWeekIndex(clock.now()),
  )

  /** 是否有待领取的回流奖励 */
  const returnPending = computed(() => save.value.arena.ladder.returnPending === true)

  /**
   * 保存演武场阵容。
   *
   * 校验在服务端（core 动作层）：英灵必须已拥有、同队不能重复。
   * 客户端**不改** `save.arena.ladder.squads`——那是服务端回传的权威镜像。
   */
  async function saveLadderSquads(squads: (string | null)[][]) {
    return runAction({ type: 'arena.ladderSaveSquads', squads }, true)
  }

  /**
   * 发起一轮天梯挑战（3 队 × 3 梯队）。
   *
   * 战斗与结算在服务端**一次完成**（原子），这里只回显结果。
   */
  async function runLadderChallenge() {
    return runAction({ type: 'arena.ladderChallenge' }, true)
  }

  /** 领取回流奖励 */
  async function claimReturnReward() {
    return runAction({ type: 'arena.ladderClaimReturn' }, true)
  }

  // ─────────────────────────── 每日 / 兑换码 / 存档 ───────────────────────────

  /** 每日签到：按 core 配置发放奖励并推进连续签到天数 */
  async function signInDaily() {
    return runAction({ type: 'daily.signIn' }, true)
  }

  /**
   * 当前时间（注入的时钟）。
   *
   * 界面按**同一个**时钟判定周期（每日 0 点 / 每周一 0 点），
   * 不自己调 `Date.now()`——否则设备时间偏差会让显示与服务端判定对不上。
   */
  function now(): number {
    return clock.now()
  }

  /**
   * 领取任务奖励（每日任务 / 周目标）。
   *
   * 判定与发奖都在服务端（core 纯函数）：客户端只发意图。
   * 断线重试由服务端幂等日志兜底；换设备看到的是同一份进度。
   */
  async function claimTask(taskId: string) {
    return runAction({ type: 'daily.claimTask', taskId }, true)
  }

  /** 兑换一次性兑换码 */
  async function redeemCode(code: string): Promise<boolean> {
    const res = await runAction({ type: 'code.redeem', code }, true)
    return res !== null
  }

  /**
   * 导出存档（base64 文本，供玩家备份）。
   *
   * ⚠ **由服务端产出**：分包后客户端镜像里只有已装备遗物，
   *   客户端自己拼出来的「备份」会丢掉整个仓库（假备份比没备份更糟）。
   */
  async function exportSaveText(): Promise<string> {
    const account = useAccountStore()
    if (offline.value || account.offline || !account.isAuthenticated) {
      notify('离线状态下无法导出存档', 'warn')
      return ''
    }
    try {
      return await account.fetchSaveExport()
    } catch (err) {
      notify(describeAccountError(err), 'warn')
      return ''
    }
  }

  /** 导入存档（校验失败时不覆盖当前进度） */
  async function importSaveText(text: string): Promise<boolean> {
    const res = await runAction({ type: 'save.import', payload: text }, true)
    return res !== null
  }

  /** 标记新手引导已完成 */
  function markGuideDone() {
    guideStep.value = -1
    void persist()
  }

  return {
    // state
    save,
    offline,
    busy,
    challengeReplay,
    offlineReport,
    idlePending,
    toast,
    guideStep,
    guideSeen,
    loaded,
    slot,
    battleSpeed,
    currentPoolId,
    // getters
    team,
    teamPower,
    teamEmpty,
    bondStates,
    dailyStatus,
    currentStage,
    clearedStage,
    nextChallengeStage,
    idleChannels,
    ownedHeroes,
    heroIndex,
    relicsByUid,
    equippedMap,
    rates,
    ratesForPool,
    rebirthPreview,
    arenaLoadout,
    arenaHash,
    // 仓库（分页，服务端权威）
    relicPage,
    relicPageLoading,
    relicPageError,
    relicStats,
    relicStatsLoaded,
    relicSetCounts,
    // actions
    load,
    refreshSave,
    reconnect,
    reconnecting,
    invalidate,
    persist,
    reset,
    notify,
    heartbeat,
    tickIdle,
    claimOffline,
    setIdleChannel,
    challengeStage,
    challengeDungeon,
    clearChallengeReplay,
    pull,
    nextBattleSeed,
    feedBooks,
    breakRealm,
    upgradeSkill,
    upgradeStar,
    upgradeRelic,
    decomposeRelic,
    lockRelic,
    decomposeRelics,
    upgradeRelics,
    decomposeByFilter,
    loadRelicPage,
    loadRelicStats,
    queryRelics,
    fetchRelic,
    fetchRelicAdvice,
    setSlot,
    savePreset,
    applyPreset,
    removePreset,
    equip,
    unequip,
    autoEquipRelics,
    updateSettings,
    doRebirth,
    runArenaMatch,
    settleArena,
    ladderSquads,
    ladderTier,
    ladderTierIndex,
    ladderSettledThisWeek,
    returnPending,
    saveLadderSquads,
    runLadderChallenge,
    claimReturnReward,
    signInDaily,
    claimTask,
    now,
    redeemCode,
    exportSaveText,
    importSaveText,
    markGuideDone,
  }
})
