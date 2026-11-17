/**
 * 主 Pinia Store（表现层唯一数据源）。
 *
 * 铁律：
 *   - 表现层**不得**直接访问 localStorage，一律经 src/platform/storage.ts
 *   - 所有规则计算走 core/ 的纯逻辑层，本 store 只做「存档 ↔ 运行时对象」的装配
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
  Rarity,
  ArenaMatch,
} from '../../core/model/types.ts'
import { createNewSave, normalizeSave } from '../../core/save/schema.ts'
import { hasExternalUpdate, nextStamp, pickNewer } from '../../core/save/conflict.ts'
import { deserialize, serialize } from '../../core/save/serialize.ts'
import { storage } from '../../platform/storage.ts'
import { randomSeed } from '../../platform/random.ts'
import { systemClock } from '../../core/time.ts'
import { Rng } from '../../core/rng.ts'
import { HEROES, HERO_INDEX } from '../../core/config/heroes/index.ts'
import { STAGES } from '../../core/config/stages.ts'
import { getTeamPower, computeBondState, isTeamEmpty } from '../../core/systems/team.ts'
import { type OfflineSettlementResult } from '../../core/systems/idle.ts'
import { getEquippedRelics, equippedOwnerMap, RELIC_SLOT_COUNT } from '../../core/systems/loadout.ts'
import { getPool, groupByRarity, resolvePoolHeroIds } from '../../core/config/pools.ts'
import { relicUpgradeCost, applyRelicUpgrade, decomposeValue, generateRelic, RELIC_SETS } from '../../core/systems/relic.ts'
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
import { computeEffectiveRates } from '../../core/systems/gachaRates.ts'
import { previewRebirth, performRebirth } from '../../core/systems/rebirth.ts'
import { arenaSnapshotHash, resolveArenaMatch, arenaContext, resolveArenaRewards, type ArenaReward } from '../../core/systems/arena.ts'
import { DAILY, LEVEL, REDEEM_CODES } from '../../core/config/economy.ts'
import { ACCOUNT, ACCOUNT_STORAGE_KEYS, accountSlotKey } from '../../core/config/account.ts'
import { dayIndex } from '../../core/time.ts'
import { useAccountStore } from './account.ts'
import { formatNumber } from '../utils/format.ts'
import '../../core/config/relics.ts'
import '../../core/config/enemies.ts'
import {
  applyAction,
  computeRelicAdvice,
  syncRngState,
  type ActionContext,
  type ActionOutcome,
  type ActionResultMap,
  type GameAction,
  type GameActionType,
} from '../../core/systems/actions.ts'
import {
  buildArenaSnapshot,
  buildEquippedMap,
  buildHeroIndex,
  buildRelicsByUid,
  buildTeam,
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
  const save = ref<SaveData>(createNewSave(clock.now(), randomSeed()))

  /**
   * 全局随机数发生器。
   *
   * ⚠ **种子不得写死常量**（历史教训，铁律 #24）：
   * 曾经写成 `new Rng(0x5eed)`，且计数器只在内存里 →
   * ① 所有玩家抽到的英灵序列**完全相同**；
   * ② 刷新页面后计数器归零，序列从头复现 → 玩家可以无限「刷新重抽」。
   *
   * 现在种子与计数器都随存档持久化（`save.rng`），载入时据此复原，
   * 序列只前进不复现；新存档的种子来自平台随机源（`platform/random.ts`）。
   */
  let rng = new Rng(0)

  /**
   * Action context.
   *
   * Time and random source are both injected; core does not read the clock,
   * nor does it use Math.random().
   */
  function actionCtx(): ActionContext {
    return { now: clock.now(), rng, randomSeed }
  }

  /**
   * Run one action and surface the outcome.
   *
   * The action layer lives in core (iron rule #29): validation and mutation
   * both happen there; the presentation layer only echoes the result.
   *
   * @param critical critical = a charge / irreversible action. This kind of
   *                 action pushes to the cloud immediately; the rest go through
   *                 debounce, so idle settlement and similar high-frequency
   *                 writes do not flood the endpoint.
   */
  async function runAction<T extends GameActionType>(
    action: Extract<GameAction, { type: T }>,
    critical = false,
  ): Promise<ActionResultMap[T] | null> {
    const outcome: ActionOutcome<ActionResultMap[T]> = applyAction(save.value, action, actionCtx())
    if (!outcome.ok) {
      if (!outcome.silent) notify(outcome.message, 'warn')
      return null
    }
    if (!(await persist(critical))) return null
    if (outcome.message) notify(outcome.message, outcome.messageKind ?? 'ok')
    return outcome.result
  }

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

  // ─────────────────────────── 持久化 ───────────────────────────

  /**
   * 从存档恢复随机数状态。
   *
   * 旧档（无 `rng` 字段）种子为 0 → 这里补一个**平台随机**种子，
   * 避免所有旧档玩家共用同一条抽卡序列（铁律 #24）。
   * 随后按计数器重放，复原到上次退出时的位置——刷新页面不会复现抽卡结果。
   *
   * @returns 是否补了种子（旧档首次载入 = true，需要把新种子推上云端，
   *          否则另一台设备会另生成一条序列）
   */
  function restoreRng(): boolean {
    const state = save.value.rng
    const assigned = !state.seed
    if (assigned) {
      state.seed = randomSeed()
      state.counter = 0
    }
    rng = Rng.fromSnapshot(state.seed, state.counter)
    return assigned
  }

  /** 把随机数计数器写回存档（持久化时调用，保证序列只前进不复现） */
  function persistRngState(): void {
    save.value.rng.counter = rng.snapshot().counter
  }

  /**
   * 本进程最后一次「读到 / 写入」存档时看到的时间戳。
   * 用于识别「另一个标签页 / 上下文在我们之后改过存档」。
   */
  let knownStamp = 0

  /**
   * 当前使用的本地存档槽位。
   *
   * 存档归属由**账号**决定：每账号一个槽位（`sgw.save.<账号 id>`），
   * 换账号即换槽位，不会串号。未登录时用存量单槽位 `main`。
   */
  const slot = ref<string>(ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT)

  /** 账号 id → 槽位名；未登录返回存量槽位 */
  function slotForAccount(accountId: number | null | undefined): string {
    return accountId == null
      ? ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT
      : accountSlotKey(accountId)
  }

  /**
   * 写入存档。
   *
   * 并发保护（先读后写 + 外部优先）：
   * 存档只有一个槽位，可能同时存在多个写入方（玩家开了两个标签页、自动化脚本
   * 访问了同一 origin）。后写入的一方手里可能握着一份**过期**的存档，直接覆盖
   * 会把另一方的进度整份抹掉且毫无提示（历史教训）。
   *
   * 因此写入前先看存储里的版本：若存储里的版本比本进程已知的更新，说明别人在
   * 我们之后改过存档——此时**不覆盖**，而是采纳对方版本并提示玩家。
   * 本次改动随之作废（整份存档是原子的，不会出现「扣了费却没出货」的中间态）。
   *
   * @param critical 是否为「扣费 / 不可逆」动作。这类动作立即推云端，
   *                 其余走防抖，避免挂机结算这类高频写入打爆接口。
   * @returns true = 已写入；false = 发生冲突，本次改动被撤销并已同步外部版本
   */
  async function persist(critical = false): Promise<boolean> {
    try {
      const stamp = nextStamp(clock.now(), knownStamp)
      const stored = await storage.load(slot.value)
      if (hasExternalUpdate(stored, knownStamp)) {
        // 外部更新 → 采纳外部版本，放弃本次写入
        save.value = normalizeSave(stored)
        knownStamp = stored?.savedAt ?? 0
        notify('进度已在其他页面更新，已同步为最新版本', 'warn')
        return false
      }
      save.value.savedAt = stamp
      // 随机数计数器随存档一起落盘：抽卡序列因此不会在刷新后从头复现
      persistRngState()
      await storage.save(slot.value, save.value)
      knownStamp = Math.max(knownStamp, stamp)
      pushDirty = true
      if (critical) await pushNow()
      else schedulePush()
      return true
    } catch {
      notify('存档保存失败，请检查浏览器存储空间', 'warn')
      return false
    }
  }

  // ─────────────────────────── 云存档同步 ───────────────────────────

  /** 云端推送防抖定时器 */
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  /** 本地存档是否有还没推上云端的改动 */
  let pushDirty = false

  /** 非关键写入合并上传 */
  function schedulePush(): void {
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      void pushNow()
    }, ACCOUNT.PUSH_DEBOUNCE_MS)
  }

  /**
   * 立即把当前存档推上云端。
   *
   * 冲突口径与服务端一致：服务端版本更新时返回 409，
   * 此时**采纳服务端版本**并提示玩家（不做字段级合并）。
   */
  async function pushNow(): Promise<boolean> {
    const account = useAccountStore()
    if (!account.isAuthenticated) return false
    try {
      const result = await account.pushCloudSave(serialize(save.value), save.value.savedAt ?? 0)
      if (result.ok) {
        pushDirty = false
        return true
      }
      // 服务端版本更新 → 采纳服务端版本，本地也跟着换成同一份
      const serverSave = normalizeSave(deserialize(result.server.payload))
      serverSave.savedAt = result.server.savedAt
      save.value = serverSave
      knownStamp = result.server.savedAt
      await storage.save(slot.value, save.value)
      notify('进度已在其他设备更新，已同步为最新版本', 'warn')
      return false
    } catch {
      notify('云端同步失败，进度已保存在本机', 'warn')
      return false
    }
  }

  /** 把待推送的存档立刻推上云端（登出 / 切号 / 页面隐藏时调用） */
  async function flushPush(): Promise<void> {
    if (pushTimer) {
      clearTimeout(pushTimer)
      pushTimer = null
    }
    if (!pushDirty) return
    await pushNow()
  }

  /**
   * 载入存档：本地 + 云端合并。
   *
   * 合并口径（同 core/save/conflict.ts 的 `pickNewer`）：**时间戳大者胜**。
   * - 云端更新 → 采纳云端（跨设备继续玩）
   * - 本地更新 → 保留本地，随后推上云端
   * - 两边都没有 → 新建存档
   *
   * 存量单槽位（`sgw.save.main`，首发无账号时的旧档）只在**第一个**账号登录时
   * 迁入该账号的槽位，用 `sgw.legacyMigrated` 标记防止迁给第二个账号。
   */
  async function load() {
    const account = useAccountStore()
    const accountId = account.user?.id ?? null
    slot.value = slotForAccount(accountId)

    let local: SaveData | null = null
    try {
      local = await storage.load(slot.value)
    } catch {
      local = null
    }

    let cloud: SaveData | null = null
    if (accountId != null) {
      try {
        const raw = await account.pullCloudSave()
        cloud = raw ? normalizeSave(deserialize(raw.payload)) : null
      } catch {
        // 云端不可用（离线 / 后端没起）→ 退回纯本地存档，不阻断游戏
        cloud = null
      }
    }

    const winner = pickNewer(local, cloud)
    let base: SaveData
    let stamp: number

    if (winner === 'cloud') {
      base = cloud as SaveData
      stamp = base.savedAt ?? 0
    } else if (winner === 'local') {
      base = local as SaveData
      stamp = base.savedAt ?? 0
    } else {
      // 两边都没有存档 → 尝试把存量单槽位的旧档迁进来
      const migrated = await migrateLegacySave(accountId)
      if (migrated) {
        base = migrated
        stamp = migrated.savedAt ?? 0
      } else {
        base = createNewSave(clock.now())
        // 全新存档：盖一个真实的时间戳（后续所有版本比较都以它为基准）
        stamp = nextStamp(clock.now(), knownStamp)
      }
    }

    save.value = normalizeSave(base)
    save.value.savedAt = stamp
    knownStamp = stamp

    // 随机数状态随存档恢复：刷新页面后抽卡序列继续前进，不复现上次的结果
    const assignedSeed = restoreRng()

    // 落盘本地槽位（与云端保持同一份内容）
    try {
      await storage.save(slot.value, save.value)
    } catch {
      notify('存档保存失败，请检查浏览器存储空间', 'warn')
    }
    loaded.value = true

    // 离线结算：离开超过 1 分钟才结算
    // （放在 load 里而不是 App 的 onMounted —— 登录后进入游戏同样要结算）
    const elapsed = (clock.now() - save.value.lastTickAt) / 1000
    if (elapsed > 60) void claimOffline()

    // 本地比云端新（或云端还没有存档）→ 推上去
    // 旧档首次补了随机种子 → 也要推上去（否则另一台设备会另生成一条序列）
    if (winner !== 'cloud' || assignedSeed) void pushNow()
  }

  /**
   * 存量单槽位迁移：把旧档 `sgw.save.main` 迁入当前账号的槽位。
   *
   * 只迁一次——`sgw.legacyMigrated` 标记防止把旧档迁给第二个账号。
   * 返回 null 表示没有可迁移的旧档。
   */
  async function migrateLegacySave(accountId: number | null): Promise<SaveData | null> {
    if (accountId == null) return null
    const legacyKey = ACCOUNT_STORAGE_KEYS.LEGACY_MIGRATED
    try {
      if (await storage.getFlag(legacyKey)) return null
      const legacy = await storage.load(ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT)
      if (!legacy) return null
      await storage.setFlag(legacyKey, true)
      return legacy
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
    loaded.value = false
    guideSeen.value = false
    knownStamp = 0
    // 换号 → 换一条随机序列：上一个账号的抽卡位置不能带到新账号
    save.value = createNewSave(clock.now(), randomSeed())
    restoreRng()
    // 上一个账号的离线结算报告不能带到新账号上
    offlineReport.value = null
  }

  /**
   * 重置进度：玩家主动操作，**允许强行写入**（与导入存档同理），
   * 不受「其它页面改过存档」的冲突保护限制——玩家就是要清空。
   */
  async function reset() {
    // 重置是「玩家主动覆盖」，允许强行写入（绕过冲突保护）
    const outcome = applyAction(save.value, { type: 'save.reset' }, actionCtx())
    if (!outcome.ok) {
      if (!outcome.silent) notify(outcome.message, 'warn')
      return
    }
    // 重置 → 换一条全新的随机序列（否则旧档的抽卡位置会被继承）
    restoreRng()
    knownStamp = nextStamp(clock.now(), knownStamp)
    save.value.savedAt = knownStamp
    await storage.save(slot.value, save.value)
    // 重置是不可逆动作：立刻推上云端，避免云端还留着旧进度
    await pushNow()
    notify('进度已重置', 'warn')
  }

  // ─────────────────────────── 运行时装配 ───────────────────────────

  const heroIndex = computed(() => buildHeroIndex(save.value))

  const relicsByUid = computed(() => buildRelicsByUid(save.value))

  /** 某英灵的 6 个遗物槽 */
  const equippedMap = computed(() => buildEquippedMap(save.value))

  /** 当前编队的运行时对象 */
  const team = computed<HeroRuntime[]>(() => buildTeam(save.value))

  const teamPower = computed(() => getTeamPower(team.value, { mode: 'pve' }))
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

  /** 推进挂机：跑 battles 场，结算掉落 */
  async function tickIdle(battles = 1) {
    if (teamEmpty.value) return null
    return runAction({ type: 'idle.tick', battles })
  }

  /** 离线结算 */
  async function claimOffline() {
    if (teamEmpty.value) return null
    const res = await runAction({ type: 'idle.claimOffline' })
    if (res) offlineReport.value = res
    return res
  }

  // ─────────────────────────── 英灵 ───────────────────────────

  /** 抽卡 */
  async function pull(poolId: string, count: 1 | 10) {
    // 扣费动作 → critical（立即推云端）；冲突时整份存档回滚，不会「扣了费却没出货」
    return runAction({ type: 'gacha.pull', poolId, count }, true)
  }

  /**
   * 概率公示快照。
   * 按**当前卡池**计算——纪元池只收录 SSR/SR，其概率与常驻池不同，
   * 公示必须展示该池的真实概率（合规要求：公示 = 实际）。
   */
  const currentPoolId = ref('standard')

  const poolRarities = computed<Rarity[]>(() => {
    const pool = getPool(currentPoolId.value)
    const byRarity = groupByRarity(resolvePoolHeroIds(pool))
    return (['SSR', 'SR', 'R', 'N'] as Rarity[]).filter((r) => (byRarity[r]?.length ?? 0) > 0)
  })

  const rates = computed(() =>
    computeEffectiveRates(
      { pitySSR: save.value.gacha.pitySSR, pity10: save.value.gacha.pity10 },
      poolRarities.value,
    ),
  )

  /** 指定卡池的概率公示快照（合规页需要逐池公示） */
  function ratesForPool(poolId: string) {
    const pool = getPool(poolId)
    const byRarity = groupByRarity(resolvePoolHeroIds(pool))
    const rarities = (['SSR', 'SR', 'R', 'N'] as Rarity[]).filter(
      (r) => (byRarity[r]?.length ?? 0) > 0,
    )
    return computeEffectiveRates(
      { pitySSR: save.value.gacha.pitySSR, pity10: save.value.gacha.pity10 },
      rarities,
    )
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

  /**
   * 战斗种子：取自**持久化**的随机数序列。
   *
   * 表现层不得直接用 `Math.random()`（铁律 #6 / #24）：
   * ① 平台随机要走 `platform/random.ts`；
   * ② 战斗种子走同一条持久化序列，刷新页面不会重复同一场战斗。
   */
  function nextBattleSeed(): number {
    return rng.nextSeed()
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
    // 导入是「玩家主动覆盖」，允许强行写入：先把已知戳提到最高，绕过冲突保护
    const outcome = applyAction(save.value, { type: 'save.import', payload: text }, actionCtx())
    if (!outcome.ok) {
      if (!outcome.silent) notify(outcome.message, 'warn')
      return false
    }
    // 导入的存档自带随机数状态 → 沿用，保持「备份恢复后序列连续」
    restoreRng()
    knownStamp = nextStamp(clock.now(), knownStamp)
    save.value.savedAt = knownStamp
    await storage.save(slot.value, save.value)
    // 导入覆盖是不可逆动作：立刻推上云端
    await pushNow()
    notify('存档已导入', 'ok')
    return true
  }

  /** 标记新手引导已完成 */
  function markGuideDone() {
    guideStep.value = -1
    save.value.stats.firstStartAt = save.value.stats.firstStartAt || clock.now()
    void persist()
  }

  return {
    // state
    save,
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
    invalidate,
    persist,
    pushNow,
    flushPush,
    reset,
    notify,
    tickIdle,
    claimOffline,
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
