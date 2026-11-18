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
} from '../../core/model/types.ts'
import { createNewSave, normalizeSave } from '../../core/save/schema.ts'
import { deserializePublicSave } from '../../core/save/serialize.ts'
import { storage } from '../../platform/storage.ts'
import { newActionId, randomSeed } from '../../platform/random.ts'
import { systemClock } from '../../core/time.ts'
import { HEROES, HERO_INDEX } from '../../core/config/heroes/index.ts'
import { STAGES } from '../../core/config/stages.ts'
import { computeBondState, isTeamEmpty } from '../../core/systems/team.ts'
import { type OfflineSettlementResult } from '../../core/systems/idle.ts'
import { getEquippedRelics, equippedOwnerMap, RELIC_SLOT_COUNT } from '../../core/systems/loadout.ts'
import { getPool } from '../../core/config/pools.ts'
import { relicUpgradeCost, applyRelicUpgrade, decomposeValue, RELIC_SETS } from '../../core/systems/relic.ts'
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
import { DAILY, LEVEL, REDEEM_CODES } from '../../core/config/economy.ts'
import { ACCOUNT, ACCOUNT_STORAGE_KEYS, ACCOUNT_ERROR_CODES, accountSlotKey } from '../../core/config/account.ts'
import { GAME_ERROR_MESSAGES } from '../../core/config/game-errors.ts'
import { dayIndex } from '../../core/time.ts'
import { useAccountStore } from './account.ts'
import { describeAccountError } from './account.ts'
import { AccountError } from '../../platform/account.ts'
import { formatNumber } from '../utils/format.ts'
import '../../core/config/relics.ts'
import '../../core/config/enemies.ts'
import {
  computeRelicAdvice,
  type ActionResultMap,
  type GameAction,
  type GameActionType,
} from '../../core/systems/actions.ts'
import type { ActionResponse, SaveSnapshot } from '../../core/systems/action-protocol.ts'
import {
  buildArenaSnapshot,
  buildEquippedMap,
  buildHeroIndex,
  buildRelicsByUid,
  buildTeam,
  buildTeamPower,
} from '../../core/systems/derive.ts'

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

  /** 最近一次战斗的完整回放（供 Canvas 渲染器播放） */
  const lastBattle = shallowRef<BattleResult | null>(null)
  /** 离线结算结果 */
  const offlineReport = shallowRef<OfflineSettlementResult | null>(null)
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
        if (response.offline) offlineReport.value = response.offline

        if (!response.ok) {
          if (!response.silent) {
            notify(response.message || messageOf(response.code), 'warn')
          }
          return null
        }
        if (response.message) notify(response.message, response.messageKind ?? 'ok')
        return response.result as ActionResultMap[T]
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
        if (cloud.offline) offlineReport.value = cloud.offline
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
      if (cloud.offline) offlineReport.value = cloud.offline
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

  const currentStage = computed(() => STAGES.find((s) => s.id === save.value.idle.currentStage) ?? STAGES[0])
  const clearedStage = computed(() => save.value.campaign.clearedStage)

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

  let heartbeatTask: Promise<true | null> | null = null
  /** 可见性由App传达；store不读DOM。复用动作队列与账号世代检查。 */
  function heartbeat(): Promise<true | null> {
    if (!loaded.value || offline.value || !useAccountStore().isAuthenticated) return Promise.resolve(null)
    if (heartbeatTask) return heartbeatTask
    const task = runAction({ type: 'idle.heartbeat' })
    heartbeatTask = task
    void task.finally(() => { if (heartbeatTask === task) heartbeatTask = null })
    return task
  }

  /** 推进挂机：跑 battles 场，结算掉落（服务端执行） */
  async function tickIdle(battles = 1) {
    if (teamEmpty.value) return null
    return runAction({ type: 'idle.tick', battles })
  }

  /** 离线结算（服务端在入口自动补算，这里取回明细） */
  async function claimOffline() {
    if (teamEmpty.value) return null
    const res = await runAction({ type: 'idle.claimOffline' })
    if (res) offlineReport.value = res
    return res
  }

  /** 设定挂机目标关卡 */
  async function setIdleTarget(stageId: number) {
    return runAction({ type: 'idle.setTarget', stageId })
  }

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
   * 喂经验：从**玩家经验池**取经验投给英灵。
   *
   * ⚠ 原实现只加不减——`applyExp` 直接把经验塞给英灵，玩家经验池
   *   （`player.exp`，战斗与挂机掉落的主要来源）只增不减，等于**白嫖等级**：
   *   池子里的经验是死资源，喂经验却凭空给经验。
   *   现在改为「池子扣 N → 英灵吃 N」，与数值模型一致
   *   （tools/balance/report.ts 的经验回收表一直按「池子付费」计算）。
   *
   * 扣减口径：按**请求量**扣。喂不完的部分（境界门槛卡住 / 已满级）
   * 不会消失，它存在英灵自己的 `hero.exp` 里，突破境界后立刻兑现。
   */
  async function feedExp(heroId: string, amount: number) {
    return runAction({ type: 'hero.feedExp', heroId, amount }, true)
  }

  /**
   * 境界突破：消耗**英灵印记**把英灵送进下一个境界。
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

  async function upgradeRelic(uid: string) {
    return runAction({ type: 'relic.upgrade', uid }, true)
  }

  async function decomposeRelic(uid: string) {
    return runAction({ type: 'relic.decompose', uid }, true)
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
   * 遗物一键推荐的**预览**（纯计算，不改存档）。
   *
   * 规则一律由 core 的 `recommendRelicLoadout` 产出，表现层不自己算
   * 「哪件更强」——那会与战斗里的属性口径分叉（铁律 #2）。
   */
  function relicAdvice(heroId: string): RelicAdvice | null {
    return computeRelicAdvice(save.value, heroId)
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

  // ─────────────────────────── 每日 / 兑换码 / 存档 ───────────────────────────

  /** 每日签到：按 core 配置发放奖励并推进连续签到天数 */
  async function signInDaily() {
    return runAction({ type: 'daily.signIn' }, true)
  }

  /** 兑换一次性兑换码 */
  async function redeemCode(code: string): Promise<boolean> {
    const res = await runAction({ type: 'code.redeem', code }, true)
    return res !== null
  }

  /** 导出存档（base64 文本，供玩家备份） */
  async function exportSaveText(): Promise<string> {
    return storage.export(save.value)
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
    lastBattle,
    offlineReport,
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
    ownedHeroes,
    heroIndex,
    relicsByUid,
    equippedMap,
    rates,
    ratesForPool,
    rebirthPreview,
    arenaLoadout,
    arenaHash,
    // actions
    load,
    reconnect,
    reconnecting,
    invalidate,
    persist,
    reset,
    notify,
    heartbeat,
    tickIdle,
    claimOffline,
    setIdleTarget,
    pull,
    nextBattleSeed,
    feedExp,
    breakRealm,
    upgradeSkill,
    upgradeStar,
    upgradeRelic,
    decomposeRelic,
    setSlot,
    savePreset,
    applyPreset,
    removePreset,
    equip,
    unequip,
    relicAdvice,
    autoEquipRelics,
    updateSettings,
    doRebirth,
    runArenaMatch,
    settleArena,
    signInDaily,
    redeemCode,
    exportSaveText,
    importSaveText,
    markGuideDone,
  }
})
