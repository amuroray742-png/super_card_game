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
} from '../../core/model/types.ts'
import { createNewSave, normalizeSave } from '../../core/save/schema.ts'
import { hasExternalUpdate, nextStamp, pickNewer } from '../../core/save/conflict.ts'
import { deserialize, serialize } from '../../core/save/serialize.ts'
import { storage } from '../../platform/storage.ts'
import { systemClock } from '../../core/time.ts'
import { Rng } from '../../core/rng.ts'
import { HEROES, HERO_INDEX } from '../../core/config/heroes/index.ts'
import { STAGES } from '../../core/config/stages.ts'
import { runIdle, settleOffline } from '../../core/systems/idle.ts'
import { getTeamPower, computeBondState, isTeamEmpty } from '../../core/systems/team.ts'
import { getEquippedRelics, equipRelic, unequipRelic, RELIC_SLOT_COUNT } from '../../core/systems/loadout.ts'
import { executePull, summarizePull, InsufficientFundsError } from '../../core/systems/gacha.ts'
import { getPool, groupByRarity, resolvePoolHeroIds } from '../../core/config/pools.ts'
import { relicUpgradeCost, applyRelicUpgrade, decomposeValue, generateRelic } from '../../core/systems/relic.ts'
import { applyExp, applySkillUp, starUpCost, applyStarUp } from '../../core/systems/growth.ts'
import { computeEffectiveRates } from '../../core/systems/gachaRates.ts'
import { previewRebirth, performRebirth } from '../../core/systems/rebirth.ts'
import { buildArenaLoadout, arenaSnapshotHash, resolveArenaMatch, arenaContext, resolveArenaRewards } from '../../core/systems/arena.ts'
import { DAILY, REDEEM_CODES } from '../../core/config/economy.ts'
import { ACCOUNT, ACCOUNT_STORAGE_KEYS, accountSlotKey } from '../../core/config/account.ts'
import { dayIndex } from '../../core/time.ts'
import { useAccountStore } from './account.ts'
import '../../core/config/relics.ts'
import '../../core/config/enemies.ts'

export const useGameStore = defineStore('game', () => {
  const save = ref<SaveData>(createNewSave(Date.now()))
  /**
   * 时钟必须是**会走动**的。
   *
   * 历史教训：这里曾用 `ManualClock`，只在 load() 时 set 一次，于是整局游戏的
   * `history.at` / `obtainedAt` / `lastTickAt` 全部等于「页面加载那一刻」——
   * 抽卡记录的时间戳全部一样，离线结算时长也算不准。注入时钟是为了可测试，
   * 不是为了冻结时间；需要伪造时间的测试用 core 层的 `ManualClock`。
   */
  const clock = systemClock
  const rng = new Rng(0x5eed)

  /** 最近一次战斗的完整回放（供 Canvas 渲染器播放） */
  const lastBattle = shallowRef<BattleResult | null>(null)
  /** 离线结算结果 */
  const offlineReport = shallowRef<ReturnType<typeof settleOffline> | null>(null)
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
    if (winner !== 'cloud') void pushNow()
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
    save.value = createNewSave(clock.now())
    // 上一个账号的离线结算报告不能带到新账号上
    offlineReport.value = null
  }

  /**
   * 重置进度：玩家主动操作，**允许强行写入**（与导入存档同理），
   * 不受「其它页面改过存档」的冲突保护限制——玩家就是要清空。
   */
  async function reset() {
    save.value = createNewSave(clock.now())
    knownStamp = nextStamp(clock.now(), knownStamp)
    save.value.savedAt = knownStamp
    await storage.save(slot.value, save.value)
    // 重置是不可逆动作：立刻推上云端，避免云端还留着旧进度
    await pushNow()
    notify('进度已重置', 'warn')
  }

  // ─────────────────────────── 运行时装配 ───────────────────────────

  const heroIndex = computed(() => {
    const map = new Map<string, HeroState>()
    for (const [id, state] of Object.entries(save.value.heroes)) map.set(id, state)
    return map
  })

  const relicsByUid = computed(() => {
    const map = new Map<string, RelicInstance>()
    for (const r of save.value.relics) map.set(r.uid, r)
    return map
  })

  /** 某英灵的 6 个遗物槽 */
  const equippedMap = computed(() => {
    const map = new Map<string, (RelicInstance | null)[]>()
    for (const heroId of Object.keys(save.value.heroes)) {
      map.set(heroId, getEquippedRelics(save.value, heroId))
    }
    return map
  })

  /** 当前编队的运行时对象 */
  const team = computed<HeroRuntime[]>(() => {
    const out: HeroRuntime[] = []
    for (const id of save.value.team.slots) {
      if (!id) continue
      const def = HERO_INDEX.get(id)
      const state = heroIndex.value.get(id)
      if (!def || !state) continue
      out.push({
        def,
        state,
        relics: equippedMap.value.get(id) ?? new Array(RELIC_SLOT_COUNT).fill(null),
      })
    }
    return out
  })

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
    const result = runIdle(
      team.value,
      save.value.idle.currentStage,
      battles,
      rng.next(),
    )
    applyRewards(result.rewards)
    if (result.blockedAtStage !== null) {
      save.value.idle.currentStage = result.blockedAtStage
    } else {
      save.value.idle.currentStage = result.reachedStage
    }
    save.value.campaign.clearedStage = Math.max(save.value.campaign.clearedStage, result.reachedStage)
    save.value.idle.totalIdleSeconds += battles * 6
    save.value.lastTickAt = clock.now()
    // 写入失败（存档冲突）时本次结算整体回滚，不能把没落盘的收益报给玩家
    if (!(await persist())) return null
    return result
  }

  /** 离线结算 */
  async function claimOffline() {
    if (teamEmpty.value) return null
    const elapsed = Math.max(0, Math.floor((clock.now() - save.value.lastTickAt) / 1000))
    if (elapsed < 60) return null
    const result = settleOffline(
      team.value,
      save.value.idle.currentStage,
      elapsed,
      rng.next(),
    )
    applyRewards(result.rewards)
    save.value.lastTickAt = clock.now()
    if (!(await persist())) return null
    offlineReport.value = result
    return result
  }

  function applyRewards(rewards: RewardBundle) {
    const p = save.value.player
    if (rewards.silver) p.silver += rewards.silver
    if (rewards.exp) p.exp += rewards.exp
    if (rewards.emblems) p.emblems += rewards.emblems
    if (rewards.crystals) p.crystals += rewards.crystals
    if (rewards.tickets) p.tickets += rewards.tickets
    if (rewards.skillStones) p.skillStones += rewards.skillStones
    if (rewards.relicStones) p.relicStones += rewards.relicStones
    if (rewards.shards) {
      for (const [id, n] of Object.entries(rewards.shards)) {
        p.shards[id] = (p.shards[id] ?? 0) + n
      }
    }
    if (rewards.relics) {
      for (const defId of rewards.relics) {
        save.value.relics.push(generateRelic(defId, rng, 1))
      }
    }
    if (rewards.heroes) {
      for (const heroId of rewards.heroes) grantHero(heroId)
    }
  }

  // ─────────────────────────── 英灵 ───────────────────────────

  function grantHero(heroId: string): boolean {
    if (save.value.heroes[heroId]) return false
    const def = HERO_INDEX.get(heroId)
    if (!def) return false
    save.value.heroes[heroId] = {
      id: heroId,
      level: 1,
      exp: 0,
      star: 1,
      skillLevels: [1, 1, 1],
      shards: 0,
      coreAwakened: false,
      obtainedAt: clock.now(),
    }
    return true
  }

  /** 抽卡 */
  async function pull(poolId: string, count: 1 | 10) {
    const pool = getPool(poolId)
    let outcome: ReturnType<typeof executePull>
    try {
      outcome = executePull(
        {
          pity: { pitySSR: save.value.gacha.pitySSR, pity10: save.value.gacha.pity10 },
          owned: save.value.heroes,
          crystals: save.value.player.crystals,
          tickets: save.value.player.tickets,
          newbieUsed: save.value.gacha.newbieUsed,
        },
        pool,
        count,
        rng.next(),
      )
    } catch (err) {
      // 余额不足：拒绝本次抽卡，不产生任何扣费与产出
      if (err instanceof InsufficientFundsError) {
        notify('圣杯结晶与抽卡券都不足，无法召唤', 'warn')
        return null
      }
      throw err
    }
    save.value.player.crystals -= outcome.crystalsUsed
    save.value.player.tickets -= outcome.ticketsUsed
    save.value.gacha.pitySSR = outcome.pity.pitySSR
    save.value.gacha.pity10 = outcome.pity.pity10
    if (outcome.newbieUsedConsumed) {
      save.value.gacha.newbieUsed = true
    }

    for (const r of outcome.results) {
      save.value.gacha.history.push({
        poolId,
        heroId: r.heroId,
        rarity: r.rarity,
        isNew: r.isNew,
        at: clock.now(),
      })
      if (r.isNew) {
        grantHero(r.heroId)
      } else {
        // 重复 → 通用英灵印记 + 同名碎片 + 银两（合规：重复不直接提升强度）
        save.value.player.emblems += r.emblems
        save.value.player.shards[r.heroId] = (save.value.player.shards[r.heroId] ?? 0) + r.shards
        save.value.player.silver += r.silver
      }
    }
    save.value.stats.totalPulls += count
    // 写入冲突 → 本次召唤整体作废（不会「扣了费却没出货」），由 persist 统一提示
    // 扣费动作 → 立即推云端
    if (!(await persist(true))) return null
    return {
      ...summarizePull(outcome),
      /** 新手保底是否触发 */
      guaranteedTriggered: outcome.guaranteedTriggered,
      /** 本次是否消耗掉新手保底资格 */
      newbieUsedConsumed: outcome.newbieUsedConsumed,
    }
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

  function feedExp(heroId: string, amount: number) {
    const state = save.value.heroes[heroId]
    if (!state) return
    const res = applyExp(state, amount)
    void persist().then((ok) => {
      if (!ok) return
      if (res.levelsGained > 0) {
        notify(`${HERO_INDEX.get(heroId)?.name ?? '英灵'} 提升了 ${res.levelsGained} 级`, 'ok')
      }
    })
  }

  async function upgradeSkill(heroId: string, index: number) {
    const state = save.value.heroes[heroId]
    if (!state) return
    const crystals = 12
    const silver = 800
    if (save.value.player.crystals < crystals || save.value.player.silver < silver) {
      notify('资源不足', 'warn')
      return
    }
    if (!applySkillUp(state, index)) {
      notify('当前等级无法继续提升', 'warn')
      return
    }
    save.value.player.crystals -= crystals
    save.value.player.silver -= silver
    // 冲突时整份存档回滚，扣费与提升一起撤销
    if (!(await persist(true))) return
    notify('技能等级已提升', 'ok')
  }

  async function upgradeStar(heroId: string) {
    const state = save.value.heroes[heroId]
    if (!state) return
    const cost = starUpCost(state.star)
    if (!cost) {
      notify('已达最高星级', 'warn')
      return
    }
    const shards = save.value.player.shards[heroId] ?? 0
    if (shards < cost.shards || save.value.player.emblems < cost.emblems) {
      notify('碎片或印记不足', 'warn')
      return
    }
    save.value.player.shards[heroId] = shards - cost.shards
    save.value.player.emblems -= cost.emblems
    applyStarUp(state)
    if (!(await persist(true))) return
    notify('星级已提升', 'ok')
  }

  async function upgradeRelic(uid: string) {
    const relic = relicsByUid.value.get(uid)
    if (!relic) return
    const cost = relicUpgradeCost(relic.level)
    if (!cost) {
      notify('已达最高强化等级', 'warn')
      return
    }
    if (save.value.player.silver < cost.silver || save.value.player.relicStones < cost.stones) {
      notify('银两或强化石不足', 'warn')
      return
    }
    save.value.player.silver -= cost.silver
    save.value.player.relicStones -= cost.stones
    applyRelicUpgrade(relic)
    await persist(true)
  }

  async function decomposeRelic(uid: string) {
    const idx = save.value.relics.findIndex((r) => r.uid === uid)
    if (idx < 0) return
    const relic = save.value.relics[idx]
    const value = decomposeValue(relic)
    save.value.player.silver += value.silver
    save.value.player.relicStones += value.stones
    save.value.relics.splice(idx, 1)
    for (const key of Object.keys(save.value.equipped)) {
      if (save.value.equipped[key].relicId === uid) delete save.value.equipped[key]
    }
    if (!(await persist(true))) return
    notify('已分解遗物', 'ok')
  }

  // ─────────────────────────── 编队 ───────────────────────────

  async function setSlot(index: number, heroId: string | null) {
    const slots = save.value.team.slots
    if (heroId) {
      const existing = slots.indexOf(heroId)
      if (existing >= 0) slots[existing] = null
    }
    slots[index] = heroId
    await persist()
  }

  async function savePreset(name: string) {
    save.value.team.presets.push({
      id: `preset_${Date.now()}`,
      name,
      slots: [...save.value.team.slots],
    })
    if (!(await persist())) return
    notify('编队已保存', 'ok')
  }

  async function applyPreset(id: string) {
    const preset = save.value.team.presets.find((p) => p.id === id)
    if (!preset) return
    save.value.team.slots = [...preset.slots]
    await persist()
  }

  async function removePreset(id: string) {
    save.value.team.presets = save.value.team.presets.filter((p) => p.id !== id)
    await persist()
  }

  async function equip(heroId: string, slot: number, relicId: string) {
    equipRelic(save.value, heroId, slot, relicId)
    await persist()
  }

  async function unequip(heroId: string, slot: number) {
    unequipRelic(save.value, heroId, slot)
    await persist()
  }

  // ─────────────────────────── 圣杯重启 ───────────────────────────

  const rebirthPreview = computed(() => previewRebirth(save.value))

  async function doRebirth() {
    const preview = rebirthPreview.value
    if (!preview.eligible) {
      notify(preview.reason || '暂不可重启', 'warn')
      return null
    }
    const result = performRebirth(save.value)
    // 圣杯重启不可逆 → 立即推云端
    if (!(await persist(true))) return null
    notify(`圣杯重启完成 · 永久加成 ${Math.round(result.nextPermBoost * 100)}%`, 'ok')
    return result
  }

  // ─────────────────────────── 竞技场 ───────────────────────────

  const arenaLoadout = computed(() =>
    buildArenaLoadout({
      slots: save.value.team.slots,
      heroes: save.value.heroes,
      relicSetsByHero: Object.fromEntries(
        save.value.team.slots
          .filter((id): id is string => !!id)
          .map((id) => [
            id,
            (equippedMap.value.get(id) ?? []).map((r) => r?.defId ?? null),
          ]),
      ),
      runes: save.value.arena.runes ?? [],
      arenaLevel: save.value.arena.arenaLevel ?? 1,
    }),
  )

  const arenaHash = computed(() => arenaSnapshotHash(arenaLoadout.value))

  function runArenaMatch() {
    return resolveArenaMatch({
      challengeId: 'daily_1',
      attacker: arenaLoadout.value,
      defender: arenaLoadout.value,
      attackerId: 'me',
      attackerName: '我',
      defenderId: 'foe',
      defenderName: '试炼对手',
      seed: rng.next(),
    })
  }

  /**
   * 结算一场竞技对局：积分入账 + 发放竞技专属产出。
   *
   * 产出只来自 `resolveArenaRewards`（竞技专属池：勋章 / 竞技材料 / 兑换券），
   * **绝不回流**银两 / 经验 / 强化石 / 圣杯结晶（合规红线）。
   */
  async function settleArena(match: ReturnType<typeof runArenaMatch>) {
    const a = save.value.arena
    a.tierPoints = Math.max(0, (a.tierPoints ?? 0) + match.pointsDelta)
    a.pvpPoints = (a.pvpPoints ?? 0) + (match.result.win ? 20 : 5)
    a.snapshotHash = arenaHash.value
    a.defenseLoadout = arenaLoadout.value

    const { reward, weeklyMedals, weeklyTickets } = resolveArenaRewards(
      match.result.win,
      a.weeklyMedals ?? 0,
      a.weeklyTickets ?? 0,
    )
    a.medals = (a.medals ?? 0) + reward.medals
    a.weeklyMedals = weeklyMedals
    a.weeklyTickets = weeklyTickets
    // 兑换券进入玩家背包（竞技专属产出，不回流 PVE 经济）
    if (reward.tickets) save.value.player.tickets += reward.tickets

    if (!(await persist())) return null
    return reward
  }

  // ─────────────────────────── 每日 / 兑换码 / 存档 ───────────────────────────

  /** 每日签到：按 core 配置发放奖励并推进连续签到天数 */
  async function signInDaily() {
    const d = save.value.daily
    const today = dayIndex(clock.now())
    if (d.lastSignInDay === today) {
      notify('今天已经签到过了', 'warn')
      return null
    }
    // 断签（上次签到不是昨天）则从第一天重新开始
    const continued = d.lastSignInDay === today - 1
    const index = continued ? d.signInStreak % DAILY.SIGN_IN_CYCLE : 0
    const reward = DAILY.SIGN_IN_REWARDS[index]

    const p = save.value.player
    if (reward.crystals) p.crystals += reward.crystals
    if (reward.silver) p.silver += reward.silver
    if (reward.tickets) p.tickets += reward.tickets
    if (reward.skillStones) p.skillStones += reward.skillStones
    if (reward.relicStones) p.relicStones += reward.relicStones

    d.signInStreak = index + 1
    d.lastSignInDay = today
    // 领奖 → 立即推云端
    if (!(await persist(true))) return null
    notify('签到成功', 'ok')
    return reward
  }

  /** 兑换一次性兑换码 */
  async function redeemCode(code: string): Promise<boolean> {
    const key = code.trim().toUpperCase()
    if (!key) return false
    if (save.value.codes.includes(key)) {
      notify('该兑换码已使用', 'warn')
      return false
    }
    const def = REDEEM_CODES[key]
    if (!def) {
      notify('兑换码无效', 'warn')
      return false
    }
    const p = save.value.player
    if (def.crystals) p.crystals += def.crystals
    if (def.tickets) p.tickets += def.tickets
    if (def.emblems) p.emblems += def.emblems
    if (def.silver) p.silver += def.silver
    save.value.codes.push(key)
    // 兑换码是一次性的 → 立即推云端
    if (!(await persist(true))) return false
    notify('兑换成功', 'ok')
    return true
  }

  /** 导出存档（base64 文本，供玩家备份） */
  async function exportSaveText(): Promise<string> {
    return storage.export(save.value)
  }

  /** 导入存档（校验失败时不覆盖当前进度） */
  async function importSaveText(text: string): Promise<boolean> {
    try {
      const loaded = await storage.import(text)
      save.value = normalizeSave(loaded)
      // 导入是「玩家主动覆盖」，允许强行写入：先把已知戳提到最高，绕过冲突保护
      knownStamp = nextStamp(clock.now(), knownStamp)
      save.value.savedAt = knownStamp
      await storage.save(slot.value, save.value)
      // 导入覆盖是不可逆动作：立刻推上云端
      await pushNow()
      notify('存档已导入', 'ok')
      return true
    } catch {
      notify('存档数据无效', 'warn')
      return false
    }
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
    feedExp,
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
