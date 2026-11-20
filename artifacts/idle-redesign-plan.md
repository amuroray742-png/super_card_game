# 挂机系统改版：三通道并行 + 已通关直挂 + 副本独立关卡 + 关卡详情弹窗

> 本文是《超级圣杯战争》**挂机系统改版**的实施方案，独立于 `artifacts/plan.md` 的 19 章设计基线。
> 与基线冲突处以本方案为准；实施时须把结论同步回写基线 §5.7 / §12 与 `AGENTS.md` 铁律。

## Summary

把当前「单一挂机去向 + 回放真实战斗」的整体挂机系统，改造成「**三条并行通道 + 已通关内容直接发奖**」：

1. **主线 / 技能副本 / 强化副本各自一条独立通道**，各自计量同一段墙钟时间、各自记账，产出互不干扰（玩家可同时挂三个）。
2. **挂机不再跑战斗**：通道目标必须是「已通关」的内容，结算时按掉落表逐次掷奖直接入库——所以永远不会卡关、不会有战败、不会空转。
3. **主线推进改为纯手动挑战**：新增 `campaign.challenge`（打下一个未通关关卡，真实战斗，首通给奖，重复通关无掉落）；副本同理新增 `dungeon.challenge`（打赢该副本关卡一次即通关）。
4. **副本独立成 24 个关卡**：`(变体 × 难度) = 1 个关卡`（技能 5×3 + 强化 3×3），有自己的关卡定义、难度锚点、战力门槛与通关记录；**不再借用主线波次**（现状是「难度 = 取材主线某章」）。
5. **关卡详情改为弹窗**：从推征页直接弹出，不再切页面。
6. **副本单独入口**：推征页放「技能副本 / 强化副本」两张入口卡，底层仍是同一个副本页的两个 tab，底部导航保持 5 项。

**关键设计决策**（用户已逐项拍板）：

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 三通道**各自独立**计量同一段墙钟时间 | 「同时挂机分开计算」= 总量约 3×，需重标定经济 |
| D2 | 挂机**只挂已通关内容**，且**不跑战斗**，直接按掉落表掷奖 | 永不卡关；掉落仍逐次掷骰，保证与概率公示一致 |
| D3 | 主线推进改**纯手动挑战**（`campaign.challenge`） | 挂机不再承担推进职责，收益全部来自被动通道 |
| D4 | 副本同样需**手动挑战通关**才可挂机 | 与 D3 同构，副本进度与主线进度分开记账 |
| D5 | 主线通道目标**默认 = 最后一个通关的关卡**（`campaign.clearedStage`），可改挂其他已通关关卡 | 「默认挂机最后一个通过了的关卡」 |
| D6 | 关卡详情改**弹窗组件**，但保留 `/stage/:id` 路由 | E2E（`battle.spec.ts`）与截图工具（`screenshot.ts --stage`）依赖该深链，不能破 |
| D7 | 副本入口走**推征页入口卡**，底层仍是 `/dungeon` 的两个 tab | 底部导航保持 5 项（360px 窄机型约束，AGENTS.md 已记录） |
| D8 | 存档版本 **v10 → v11** | 挂机账本结构整体重构 |
| D9 | **副本是独立关卡**：`(变体 × 难度) = 1 关`，共 24 关，打赢一次即通关 | 副本不再借用主线波次，有自己的关卡实体、门槛与通关记录 |
| D10 | **副本自建难度锚点表**，用与主线同款的二分流程实测标定 | 铁律 #41：锚点不许手填；副本难度与主线数值解耦 |

**本次交付边界**：**只交付本方案文档本身**——把本文作为文档提交进仓库
（`artifacts/idle-redesign-plan.md`）并推送到远端 `origin/main`。
**本次不落地任何代码**：不改 core / server / presentation / tools / tests，不跑基线重标定，
不改任何数值配置。实施须在本方案获批后另行开工。

**实现阶段的授权范围（本次不执行，供参考）**：届时可读写工程源码、跑测试与构建、跑数值脚本；
**不得**改动 Git 提交历史以外的任何外部系统状态；不涉及部署、发布、账号操作。

---

## 1. 目标与范围

### 1.1 目标

- 挂机从「回放战斗」变成「已通关内容的稳定被动产出」，消除卡关 / 战败 / 空转三种负反馈。
- 三个内容线（主线 / 技能副本 / 强化副本）可**同时**挂机，玩家不再需要为了「今晚刷什么」做取舍。
- 主线推进变成**玩家主动、可观看**的行为（手动挑战 + 回放演出），收益边界清晰（首通才有奖）。
- 副本成为**真正独立的内容线**：有自己的关卡列表、难度曲线与通关进度，而不是主线的附庸。
- 关卡详情、挂机设置、副本入口都在**一屏之内可达**，不再切页面。

### 1.2 范围内

- core：存档结构与迁移、挂机账本（三通道）、结算层、动作层、**副本独立关卡配置（24 关）+ 难度锚点标定**、副本通关判定、首通发奖。
- 服务端：入口预结算、心跳、动作幂等、回包装配（战斗回放不进幂等日志）。
- 表现层：推征页（挑战 + 三通道面板 + 副本入口卡）、关卡详情弹窗、副本页（24 关列表 + 通关状态 + 挑战）、离线结算弹窗（三段）。
- 数值工具：`dungeon-loop.ts` / `newplayer.ts` / `recalibrate.ts` / `report.ts` / `validate-config.ts` 适配新模型，**新增** `recalibrate-dungeon.ts` 标定副本 24 关，并重跑基线。
- 测试：单测重写 + 新增、E2E 改写、截图场景更新。
- 文档：`artifacts/plan.md` §5.7 与 `AGENTS.md` 铁律同步。

### 1.3 非目标（本次不做）

- **不做**：竞技场 / 天梯 / 圣杯重启的挂机化（仍是一次性结算，不产挂机收益）。
- **不做**：关卡难度锚点（`STAGE.SCALE_ANCHORS` 与新增的 `DUNGEON.SCALE_ANCHORS`）的**手工**调整——只允许按 M5 实测结果重跑 `npm run balance:recalibrate` / `balance:recalibrate:dungeon` 重新标定，禁止手填（铁律 #41）。
- **不做**：新增副本专属敌人与美术资源——本次副本关卡复用现有 30 只敌人（元素主题仍只体现在产出材料上）。
- **不做**：底部导航扩容（保持 5 项）。
- **不做**：新的材料 / 货币种类；副本产量仍 = 现有 `DUNGEON_DROPS` × 难度倍率，不新增数值来源。
- **不做**：抽卡、体检、账号体系的任何改动。

---

## 2. 实施前必须知道的现状（已逐条核实）

| # | 事实 | 出处 |
|---|---|---|
| F1 | **主线进度只有挂机一条路**：`campaign.clearedStage` 仅在 `settleIdleLedger()` 内被推进，没有独立的「通关关卡」动作；观战（`fight()`）是纯客户端预览，不发奖、不推进 | `src/core/systems/actions.ts:718`；`src/presentation/views/ExpeditionView.vue:115-133` |
| F2 | **掉落与战斗已解耦**：`rollRewards(stage, rng)` 不读战斗结果，直接掷银两 / 道具 / 遗物 → 「不跑战斗直接发奖」可直接复用 | `src/core/systems/idle.ts:245` |
| F3 | **三去向共用一份时间账本**（`idle.effectiveMs` / `measuredAt` / `offlineElapsedMs`），切换去向时先结清旧去向 | `src/core/systems/actions.ts:628-731` |
| F4 | **经济工具与「共用一份时间」强耦合**：`dungeon-loop.ts` 的 `decideIdleTarget()` 用「一夜能换多少战力（ln 口径）」在三个去向间**分配**同一份时间 | `tools/balance/dungeon-loop.ts:30-67, 397` |
| F5 | **`BATTLE.SECONDS_PER_BATTLE = 6`** 是挂机节奏单位（时间 → 场次），被 core 与工具共用 | `src/core/config/economy.ts:304` |
| F6 | **副本难度 = 取材章**：easy=第 1 章 / normal=第 4 章 / hard=第 8 章，产量倍率 1.0 / 1.6 / 2.6 | `src/core/config/economy.ts:770` |
| F7 | **副本门槛口径 = 取材章的 BOSS 门槛**（`dungeonGatePower()`） | `tools/balance/dungeon-loop.ts:301` |
| F8 | **`/stage/:id` 深链被外部依赖**：E2E `battle.spec.ts:201`、截图工具 `screenshot.ts:383` | 见左 |
| F9 | **`/dungeon?kind=…` 深链被外部依赖**：E2E `backpack.spec.ts:150/163`、`dungeon.spec.ts`、`relic.spec.ts:143`、截图工具 `screenshot.ts:580` | 见左 |
| F10 | **任务口径**：`TaskMetric = 'battle' | 'pull' | 'relicUpgrade' | 'signIn'`，每日「推征 30 场」/ 周「累计推征 200 场」按 `advanceTasks(daily,'battle',n)` 累计 | `src/core/config/tasks.ts:43`；`src/core/systems/actions.ts:729` |
| F11 | **遗物是唯一随挂机线性增长的字段**，仓库上限 3000，超限自动分解「最没用」的（锁定件 / 已装备件永不自动分解） | `src/core/config/economy.ts:281`；`src/core/systems/actions.ts:436-438` |
| F12 | **心跳必须保持轻量**：不回传存档主体、只载入已装备遗物（≤36）、不写遗物行 | AGENTS.md 铁律 #33 |
| F13 | **导入路径会重置控制字段**：`validateImportedSave` 会 `delete save.idle.farm`、重置 `rng`、重置时间戳 → 新的三通道账本同样要在导入路径被重置 | `src/core/save/import-validation.ts:114-117` |
| F14 | **副本当前没有自己的关卡**：难度 = 取材主线章，波次 = `dungeonStages(chapter)` 取该章主线关卡 id，门槛 = `dungeonGatePower()` 读主线章 BOSS 的 `powerRequired` | `src/core/config/economy.ts:770`；`src/core/systems/dungeons.ts:102-109`；`tools/balance/dungeon-loop.ts:301` |
| F15 | **主线标定工具已具备可复用的二分流程**：`maxWinnableScale()` 二分「通关率 ≥ 90% 的最大缩放」→ 取一半 → ÷ 章内总跨度 → 锚点；配套 `referenceTeam(level)` 参考队伍 | `tools/balance/recalibrate.ts:189, 248-273` |
| F16 | **敌人库共 30 只**（10 章 × 2 普通 + 1 BOSS），五行分布不均（土仅 2 只普通怪）；`dungeons.ts` 已注明「元素主题落在产出材料上，不落在敌人上」 | `src/core/config/enemies.ts:53-103`；`src/core/config/dungeons.ts:19-21` |
| F17 | **副本变体共 8 个**：技能 5（金木水火土）+ 强化 3（初/中/高阶石档）；每个变体一个产出道具 id | `src/core/config/dungeons.ts:57-122` |

---

## 3. 目标架构

### 3.1 核心语义

```
                 ┌──────────── 墙钟时间（服务端 now）────────────┐
                 │                                              │
   通道 A 主线 ──┤  effectiveMs_A ← 在线×3 + 离线曲线          │→ 掷该关掉落表 ×N 次 → rewards
   通道 B 技能 ──┤  effectiveMs_B ← 同上，但独立累计           │→ 掷该副本关卡产量 ×N 次 → rewards
   通道 C 强化 ──┤  effectiveMs_C ← 同上，但独立累计           │→ 掷该副本关卡产量 ×N 次 → rewards
                 └──────────────────────────────────────────────┘

   手动挑战（不占时间预算、不产被动收益）：
     campaign.challenge → 打下一个未通关主线关卡 → 首通给奖（结晶 + 一次掉落）
     dungeon.challenge  → 打一个副本关卡           → 记入 dungeons.cleared + 一次产量
```

**四条硬规则**：

1. **挂机永不失败**。通道目标全是已通关内容 ⇒ 结算只有「产出」，没有「战败 / 卡关 / 回退刷取」分支。`idle.farm` 机制整体退场。
2. **推进只由手动挑战产生**。`campaign.clearedStage` 只在 `campaign.challenge` 成功时 +1；挂机结算**不碰** `campaign`（含 `creditedStages`）。
3. **掉落口径不变**。每次「结算次数」都独立掷一次掉落表（银两 / 道具 / 遗物），与现在 `rollRewards` 完全一致 —— 概率公示口径不变。
4. **副本是独立关卡**。副本关卡有自己的敌人组合、缩放锚点、战力门槛与通关记录；主线进度与副本进度**分开记账**（沿用既有规则）。

### 3.2 存档结构（v10 → v11）

`src/core/model/types.ts`：

```ts
/** 挂机通道种类 */
export type IdleChannelKind = 'main' | 'skill' | 'enhance'

/** 单条通道的目标 */
export type IdleChannelTarget =
  /** 主线：stageId = null 表示「跟随最新通关的关卡」 */
  | { kind: 'main'; stageId: number | null }
  /** 技能副本：目标 = 已通关的副本关卡 id */
  | { kind: 'skill'; dungeonStageId: string }
  /** 强化副本：目标 = 已通关的副本关卡 id */
  | { kind: 'enhance'; dungeonStageId: string }

/** 单条通道的独立时间账本 */
export interface IdleChannelState {
  /** 目标（null = 通道关闭，不计量） */
  target: IdleChannelTarget | null
  /** 已计量到的时刻（服务端权威水位） */
  measuredAt: number
  /** 有效预算（毫秒）= 可结算次数 × IDLE.SECONDS_PER_ROLL */
  effectiveMs: number
  /** 连续离线累计时长（衰减曲线用） */
  offlineElapsedMs: number
}
```

`SaveData.idle` 改为：

```ts
idle: {
  /** 三条通道，各自独立账本 */
  channels: {
    main: IdleChannelState
    skill: IdleChannelState
    enhance: IdleChannelState
  }
  /** 在线租约（服务端向未来续约，三通道共用同一份时间轴） */
  activeUntil: number
  totalIdleSeconds: number
}
```

`SaveData` 新增（副本进度与主线**分开记账**，沿用既有规则）：

```ts
dungeons: {
  /** 已通关副本关卡：key = **副本关卡 id**（`dgn_<变体>_<难度>`），值恒为 true */
  cleared: Record<string, true>
}
```

**退场字段**：`idle.currentStage` / `idle.target` / `idle.farm` / `idle.autoAdvance` / `idle.measuredAt` / `idle.effectiveMs` / `idle.offlineElapsedMs`。

### 3.2.1 副本独立关卡配置（新增）

`src/core/config/dungeons.ts` 扩成「副本的唯一出处」，由三部分组成。

**① 关卡定义表（24 关）**

```ts
export interface DungeonStageDef {
  /** 关卡 id（`dgn_<变体>_<难度>`，全项目唯一） */
  id: string
  /** 所属变体（决定产出材料） */
  variantId: DungeonVariantId
  /** 难度档 */
  difficulty: DungeonDifficultyId
  /** 关卡名（如「金 · 简易 · 残响回廊」） */
  name: string
  /** 敌人组合（复用现有敌人库，见 ③） */
  enemyIds: string[]
  /** 敌方属性缩放倍率（由锚点算出，**不手填**） */
  enemyScale: number
  /** 战力门槛（放行线 / UI 提示） */
  powerRequired: number
  /** 每胜产量（材料 id → 数量区间） */
  drop: { itemId: ItemId; min: number; max: number }
}
```

**② 锚点表（24 关 × 3）**（`src/core/config/economy.ts` 新增 `DUNGEON` 常量块）

```ts
export const DUNGEON = {
  /** 每关的敌方缩放锚点（标定值，**禁止手填**） */
  SCALE_ANCHORS: readonly number[]   // 长度 24
  /** 每关的战力门槛锚点（标定值） */
  POWER_ANCHORS: readonly number[]   // 长度 24
  /** 每关的设计等级（标定的输入：参考队伍取哪一档养成） */
  DESIGN_LEVELS: readonly number[]   // 长度 24
}
```

**③ 敌人取材**

- ⚠ **本次不新增敌人**：副本关卡复用现有 `ENEMIES`（30 只）的子集；
  **元素主题仍落在「产出材料」上，不落在敌人上**（沿用 `dungeons.ts` 现有结论与 F16 的约束）。
  新增元素专属敌人列为**后续内容批次**，不在本次范围。
- 24 关的敌人组合允许复用同一批敌人：差异来自**缩放锚点 / 战力门槛 / 产量**，
  不靠改敌人表救难度（难度问题一律回标定工具）。

**④ 标定流程（新增 `npm run balance:recalibrate:dungeon`）**

与主线同款三步（复用 F15 的二分与参考队伍）：

1. **设计阶梯**：`DUNGEON.DESIGN_LEVELS[24]` 给出每关对应的**参考养成档**（默认映射见 6.2-U7）。
2. **标定锚点**：`referenceTeam(level)` 对该关二分「能稳过(≥90%)的最大缩放」→ 取其一半 → `SCALE_ANCHORS`；
   同时记下该档参考队伍战力 → `POWER_ANCHORS`。
3. **单调性核对**：**难度段之间**（简易 → 普通 → 困难）严格递增；
   同段内的 8 关因敌人组合不同，**允许互相波动**（与主线「章内允许波动、章首严格递增」同构）。

### 3.3 迁移 v10 → v11（`src/core/save/schema.ts`）

新增 `MIGRATIONS[10]`：

| 旧字段 | 新字段 | 规则 |
|---|---|---|
| `idle.target.kind === 'campaign'` | `channels.main.target = { kind:'main', stageId: null }` | 主线通道恒开；目标跟随最新通关关卡 |
| `idle.target` 为 `skill` / `enhance` | 对应通道的 `target` 原样搬过去（目标 = 旧 `(变体, 难度)` 对应的新副本关卡 id） | **不**自动写入 `dungeons.cleared`；服务端在结算时校验「已通关」，不通过则该通道回落为 `null`（UI 明示「需先挑战通关」） |
| `idle.currentStage` | 丢弃 | 新模型下主线目标只允许已通关关卡，旧值可能是 `clearedStage + 1` |
| `idle.effectiveMs` | 只给**旧去向对应的那个通道** | 其余两通道从 0 起算（避免旧预算被复制三份） |
| `idle.measuredAt` / `idle.offlineElapsedMs` | 三通道各自继承 | 保持时间轴一致；通道关闭时服务端会把 `measuredAt` 推到 now、`effectiveMs` 清 0 |
| `idle.activeUntil` | `idle.activeUntil` | 直接继承 |
| `idle.totalIdleSeconds` | `idle.totalIdleSeconds` | 直接继承 |
| — | `dungeons.cleared = {}` | 新字段 |

**幂等要求**：`MIGRATIONS` 每次载入都会跑（`migrate()`），所以迁移必须可重复执行（只做「缺失补齐」，不做「累加」）。

### 3.4 数值口径（`src/core/config/economy.ts`）

- **新增** `IDLE.SECONDS_PER_ROLL = 6`（挂机结算节奏单位：每 6 秒结算一次掉落）。
- **新增** `DUNGEON` 锚点块（3.2.1 ②）。
- **删除** `BATTLE.SECONDS_PER_BATTLE = 6`，全量替换引用点（core 4 处 + `tools/balance/*` + 测试）——保持「单一数据源」，不做别名兜底（铁律 #4/#5）。
- `IDLE.MAX_REPLAY_BATTLES = 2000` 语义改为**每通道**上限（三通道合计最多 6000 次结算）。
- `IDLE.FULL_EFFICIENCY_HOURS / CAP_HOURS / TAIL_RATE / ONLINE_MULTIPLIER / ACTIVE_LEASE_MS / HEARTBEAT_INTERVAL_MS / OFFLINE_SETTLE_THRESHOLD_SEC` **全部不变**（曲线形状不变，只是从 1 条变成 3 条）。
- **不改**任何掉落表数值（`DROP_TABLES` / `DUNGEON_DROPS` / `FIRST_CLEAR_CRYSTALS`）。

### 3.5 动作层（`src/core/systems/actions.ts` + `action-protocol.ts`）

`GameAction` 判别联合新增 3 个、下线 1 个：

```ts
| { type: 'campaign.challenge'; stageId?: number }   // 手动挑战主线关卡
| { type: 'dungeon.challenge'; stageId: string }      // 手动挑战一个副本关卡
| {
    type: 'idle.setChannel'
    channel: IdleChannelKind
    /** 主线通道：省略或 null = 跟随最新通关关卡 */
    stageId?: number | null
    /** 技能 / 强化通道：副本关卡 id（`dgn_<变体>_<难度>`） */
    dungeonStageId?: string
    /** 关闭通道（仅 skill / enhance 可关） */
    disabled?: boolean
  }
```

**下线** `idle.setTarget`（旧三态去向整体退场）。老客户端不会被服务到（前后端同构建），无需兼容分支；旧 actionId 仍在幂等日志里防重。

新增动作结果：

```ts
/** 单条通道的一次结算明细 */
export interface ChannelSettlement {
  channel: IdleChannelKind
  /** 目标显示名（取登记表面，不就地写中文名） */
  targetName: string
  /** 实际结算次数 */
  rolls: number
  /** 本次产出（唯一入库口径） */
  rewards: RewardBundle
  /** 仓库溢出（自动分解）明细 */
  overflow: InventoryOverflowResult
  /** 本次新获得的遗物（仅提示用） */
  newRelics: string[]
}

export interface IdleActionResult {
  /** 三通道明细（只含本次有产出的通道） */
  channels: ChannelSettlement[]
  /** 本次结算总次数 */
  rolls: number
}

export interface CampaignChallengeResult {
  stageId: number
  win: boolean
  /** 是否为首通（首次通关） */
  firstClear: boolean
  /** 首通奖励（重复通关为空） */
  rewards: RewardBundle
  /** 战斗回放数据（**不进幂等日志**，见 3.7） */
  battle?: BattleResult
}

export interface DungeonChallengeResult {
  /** 副本关卡 id */
  stageId: string
  win: boolean
  /** 本次是否首次通关（并已记入 dungeons.cleared） */
  firstClear: boolean
  rewards: RewardBundle
  battle?: BattleResult
}
```

**动作契约**（沿用铁律 #29）：

| 动作 | 校验（先校验后修改） | 副作用 |
|---|---|---|
| `campaign.challenge` | `stageId` 必须是合法关卡；`stageId ≤ clearedStage + 1`（不能跳关）；队伍非空 | 胜且 `stageId > clearedStage` → `clearedStage = stageId`；`grantFirstClearCrystals()` 发首通结晶；掷**一次**该关掉落表；`advanceTasks(daily,'challenge',1)` |
| `dungeon.challenge` | 关卡 id 必须存在（= 变体 × 难度）；`dungeonUnlocked()` 通过；队伍非空 | 胜 → `dungeons.cleared[关卡 id] = true`；掷**一次**该关产量 |
| `idle.setChannel` | main：`stageId` 必须 `1..clearedStage`（**只能挂已通关**），或省略 / null = 跟随最新；skill / enhance：`dungeonStageId` 必须是**该类**副本关卡 id 且已在 `dungeons.cleared`；关闭通道时 `disabled=true` | 写入通道 target；**该通道 `measuredAt = now`、`effectiveMs = 0`**（不追溯） |
| `idle.tick` | 队伍非空 | 结算三条通道（见 3.6） |
| `idle.claimOffline` | 队伍非空 | 同 `idle.tick`，但不限次数（走完整预算） |
| `idle.heartbeat` | — | 只计量 + 续约租约，不发奖 |

**任务口径**：`TaskMetric` 新增 `'challenge'`；每日 / 周任务的 `battle` 口径**改为统计挂机结算次数**（`advanceTasks(daily,'battle',rolls)`），手动挑战另计 `'challenge'`。任务标题文案随之调整（「推征 30 场」→「结算 30 次」），保持 `tasks.ts` 单一出处。

### 3.6 结算流程（`src/core/systems/idle.ts` 重写）

```
settleIdleChannels(save, ctx) → OfflineSettlementResult
  ├─ for each channel in [main, skill, enhance]:
  │    ├─ target = resolveChannelTarget(save, channel)   // 见下
  │    ├─ if (!target) { ch.measuredAt = now; ch.effectiveMs = 0; continue }   // 未启用
  │    ├─ elapsedMs = now - ch.measuredAt
  │    ├─ onlineMs  = max(0, min(now, save.idle.activeUntil) - ch.measuredAt)
  │    ├─ offlineMs = elapsedMs - onlineMs
  │    ├─ effectiveOffline = offlineEffectiveSeconds((ch.offlineElapsedMs + offlineMs)/1000)
  │    │                      - offlineEffectiveSeconds(ch.offlineElapsedMs/1000)
  │    ├─ ch.offlineElapsedMs += offlineMs
  │    ├─ ch.effectiveMs = min(capMs, ch.effectiveMs + onlineMs*ONLINE_MULTIPLIER + effectiveOffline)
  │    ├─ ch.measuredAt = now
  │    ├─ rolls = min(floor(ch.effectiveMs / SECONDS_PER_ROLL), MAX_REPLAY_BATTLES)
  │    └─ 按通道产出（见下表）
  └─ 汇总成 OfflineSettlementResult
```

**通道产出**（**不跑战斗**）：

| 通道 | 目标解析 | 每次结算产出 |
|---|---|---|
| main | `stageId ??= save.campaign.clearedStage`；`stageId < 1` → 无产出 | `rollRewards(stage, rng)`（银两 + 道具 + 1 件遗物） |
| skill | 目标 = **已通关的技能类副本关卡 id** | `rng.int(drop.min, drop.max)` 件该关 `drop.itemId` |
| enhance | 目标 = **已通关的强化类副本关卡 id** | 同上 |

- **主线通道**：`stageId` 必须 `≤ clearedStage`（服务端强校验；越界即回落为 `null` 并在结算明细里报告）。
- **副本通道**：目标不是副本关卡 id / 未通关 / 变体种类与通道不符 → 该通道**本次不产出**、`target` 回落为 `null`、结算明细报告「需先挑战通关」。
- **遗物 / 道具入库**：统一走 `applyRewardBundle()`（`actions.ts:411`）——唯一入库入口，含库存溢出自动分解（`overflow` 必须进结算明细，玩家看得见）。
- **不写 `campaign`**：挂机结算**绝不**改 `clearedStage` / `creditedStages`（首通只由手动挑战发放）。
- **不再有 `farm` / `blockedAtStage` / `dungeon.blockedAtBattle`**：挂机永不失败。

**`OfflineSettlementResult` 改形状**：

```ts
export interface OfflineSettlementResult {
  /** 本次结算覆盖的最长离线时长（秒） */
  elapsedSeconds: number
  /** 折算后的有效时长（秒） */
  cappedSeconds: number
  /** 综合效率（0..1） */
  efficiency: number
  /** 三通道明细（只含有产出的通道） */
  channels: ChannelSettlement[]
}
```

### 3.7 服务端接线（`server/src/game/service.ts`）

- `prepare()` 里的 `settleIdleLedger(save, ctx)` → `settleIdleChannels(save, ctx)`（返回三通道明细）。
- `offlineForClient()` 的阈值判定改用 `max(通道 elapsedSeconds)`；仍只影响**是否弹窗**，不影响入账。
- **心跳保持轻量**（铁律 #33）：仍不回传存档主体、只载入已装备遗物、不写遗物行。心跳现在要计量**三条**通道 —— 计量是纯数值运算，成本与单条同量级。
- **战斗回放不进幂等日志**：`StoredOutcome.result` 只存**轻量结果**（不含 `battle`）；完整 `BattleResult` 通过响应新增字段 `replay?: BattleResult` 一次性回传。
  - 理由：`BattleResult.log` 上限 1500 条（铁律 #20），单条约 120 KB；存进 24 小时幂等日志 = 每天几十 MB。
  - 副作用：24 小时内重放同一 actionId 时拿不到回放数据 → 客户端按「已结算」处理，不再重播演出（结果与奖励仍一致）。

### 3.8 表现层

#### 3.8.1 关卡详情弹窗（D6）

- 新增 `src/presentation/components/StageDetailModal.vue`：内容 = 现 `StageDetailView.vue` 的全部区块（概要 / 战力门槛 / 敌人 / 掉落预览 / 战斗预览 / 设为挂机目标），改为 `props: { stageId: number }` + `emit('close')`。
- `src/presentation/views/StageDetailView.vue` 改为**薄壳**：读 `route.params.id` → 渲染同一个弹窗组件（深链可用，E2E / 截图工具不破）。
- 推征页「详情 ›」与关卡网格点击 → **就地开弹窗**（不切路由，不改 URL）。
- 弹窗内按钮语义调整：
  - 「设为挂机目标」→ **仅对已通关关卡可用**（未通关按钮禁用 + 文案「通关后才能挂机」）。
  - 新增「挑战此关」→ `campaign.challenge`（未通关关卡可用；已通关关卡为「重复挑战（无掉落）」）。

#### 3.8.2 推征页（`ExpeditionView.vue`）

自上而下：

1. **主线面板**：当前章节 / 关卡名 / 战力对比条（保留） + 「**挑战下一关**」按钮（`campaign.challenge`，显示第 N+1 关名）+ 「观战」按钮（保留，预览不推进）。
2. **三通道挂机面板**：三张卡片，每张显示
   - 通道名 + 目标（主线：关卡名 / 技能副本：副本关卡名 / 强化副本：副本关卡名）
   - 可结算次数（`floor(effectiveMs / 6)`）
   - 「领取」按钮 → `idle.tick`
   - 「更换目标」→ 主线：开关卡选择弹窗（只列已通关）；技能 / 强化：跳 `/dungeon?kind=…`
   - 未启用 / 未通关的通道：显示解锁原因与「去挑战」入口（铁律 #27：规则写在玩家眼前）
3. **副本入口卡**（D7）：「技能副本」「强化副本」两张卡 → `/dungeon?kind=skill` / `/dungeon?kind=enhance`。
4. **本章关卡网格**（保留）：点击 → 开关卡详情弹窗。
5. **编队概览**（保留）。

#### 3.8.3 副本页（`DungeonView.vue`）

- 保留种类 tab（技能 / 强化）。
- **关卡列表**：按「难度段（简易 / 普通 / 困难）× 变体」展示 24 关，每行显示
  关卡名 / 难度 / **通关状态** / 战力门槛 vs 当前战力 / 每胜产量。
- 「**挑战**」按钮 → `dungeon.challenge`（该关一场真实战斗），胜利后播放回放并标记已通关。
- 「**设为挂机通道**」按钮 → `idle.setChannel`（仅已通关可设；已设则显示「已挂机」）。
- 未解锁的关卡显示解锁原因（`dungeonUnlocked()` 的口径）与直达养成入口（铁律 #27）。
- 现有「设为挂机去向」按钮改造为「设为挂机通道」（同一通道重复设置 = 无操作，不报错）。

#### 3.8.4 离线结算弹窗（`App.vue`）

- `store.offlineReport` 的类型改为新的 `OfflineSettlementResult`；弹窗按**通道分段**展示（通道名 + 目标 + 场次 + 掉落明细）。
- 阈值仍由 `IDLE.OFFLINE_SETTLE_THRESHOLD_SEC` 控制（服务端 + 客户端双闸门，保持现状）。

#### 3.8.5 入口与导航

- 底部导航 **5 项不变**（`App.vue` 的 `TABS`）。
- 背包页 → 副本的直达链接（`/#/dungeon?kind=…`）**保持不变**（E2E 依赖）。
- `store.setIdleTarget()` → 改为 `store.setIdleChannel()`；新增 `store.challengeStage()` / `store.challengeDungeon()`。

### 3.9 数值工具（M5）

| 工具 | 改动 |
|---|---|
| `tools/balance/dungeon-loop.ts` | 「三去向分配一份时间」模型 → 「三通道同时跑」模型：`decideIdleTarget()` 改为 `decideChannels()`，为三通道各选最优目标（主线 = 跟随最新通关关卡；技能 = 缺口最大的五行对应副本关卡中**打得赢的最高一关**；强化 = 缺口最大的石档同理）。**这是本次最大的工具改动** |
| `tools/balance/recalibrate-dungeon.ts`（**新增**） | **副本 24 关的难度标定**（与主线同款二分 + 参考队伍），产出 `DUNGEON.SCALE_ANCHORS` / `POWER_ANCHORS` / `DESIGN_LEVELS`；锚点禁止手填（铁律 #41） |
| `tools/balance/newplayer.ts` | 首日模拟改为「手动挑战 N 次 + 三通道并行结算」；新增「手动挑战速率」假设 |
| `tools/balance/recalibrate.ts` | 40 天曲线改为手动挑战驱动；重跑关卡难度标定（`npm run balance:recalibrate`） |
| `tools/balance/report.ts` | 回收比口径适配三通道（主线产物 + 两种副本材料） |
| `tools/validate-config.ts` | 校验新的通道目标 / **副本 24 关配置（齐全、敌人存在、段间单调、产量登记）** / 掉落口径 |
| `tools/perf/long-hang.ts` | 长挂压测改为三通道 |

**经济影响预估**（供 M5 验证，非结论）：

- 经验 / 银两 / 遗物：仍**只**由主线通道产出 → 相对「玩家整晚刷主线」不变；相对「整晚刷副本」的玩家会**多**出主线产出。
- 五行材料 / 强化石：此前一晚只能刷一种，现在两种**同时**刷 → 相对「刷材料的玩家」约 ×2。
- 遗物：每结算次数 1 件，主线通道单独承担 → **不随三通道翻倍**。

### 3.10 状态、并发、失败与恢复语义

| 维度 | 语义 |
|---|---|
| **权威** | 服务端唯一写入口。客户端改 `save.idle.*` 会被下一次回包覆盖（铁律 #28） |
| **幂等** | 成功动作结果保留 24 小时可重放；已执行 actionId 在账号存续期间永久防重。`campaign.challenge` / `dungeon.challenge` 走同一套（铁律 #11） |
| **并发** | 同账号动作进 Promise 串行队列（`server/src/game/lock.ts`）；存档与幂等日志同事务落库 |
| **时钟回退** | `ctx.now < ch.measuredAt` → 该通道本次不计量、不产出（沿用现有 `settleIdleLedger` 的 `if (ctx.now < from) return null` 口径） |
| **余数保留** | 不足一次结算的毫秒余数留在 `effectiveMs` 里；分批领取与一次领取等价（现有 `idle-authority.test.ts:136` 的性质必须继续成立） |
| **零时间** | 零时间不产出、**不消耗随机序列**（现有 `idle-authority.test.ts:37`） |
| **通道关闭** | `target = null` → 不计量；服务端在关闭 / 启用瞬间把该通道 `measuredAt = now`、`effectiveMs = 0`（不追溯、不跨设备重复） |
| **副本未通关** | 结算时校验失败 → 该通道本次无产出、`target` 回落为 null、明细报告原因；**不产生负数、不报错中断整个结算** |
| **导入** | `validateImportedSave` 重置三通道账本（`measuredAt = now`、各 `effectiveMs = 0`）、清空 `dungeons.cleared`、重置 `rng` 与时间戳（沿用 F13 的现有口径 + 补新字段） |
| **离线只读** | 服务端不可达 → 客户端进入只读模式，操作一律拒绝并提示（铁律 #28） |
| **库存溢出** | 每通道结算都走 `applyRewardBundle` → `enforceInventoryCap`；溢出并入该通道明细，锁定件 / 已装备件永不自动分解（铁律 #32） |
| **断线** | 挂机收益不依赖后台常驻 tick：每次动作 / 每次载入都补算，断网期间不损失收益 |

---

## 4. 分阶段实施

每个里程碑结束都必须 `npm run check`（配置校验 + 禁用词扫描 + 单测 + 类型检查 + 构建）全绿。

### M1 · Core 数据模型、存档迁移与副本关卡配置

**落点**：`src/core/model/types.ts`、`src/core/save/schema.ts`、`src/core/save/import-validation.ts`、`src/core/config/economy.ts`、`src/core/config/dungeons.ts`

1. 新增 `IdleChannelKind` / `IdleChannelTarget` / `IdleChannelState`；改写 `SaveData.idle`；新增 `SaveData.dungeons`。
2. `SAVE_VERSION` 10 → 11；新增 `MIGRATIONS[10]`（表见 3.3，幂等）。
3. `normalizeSave()` 改写 `idle` 归一化：逐通道兜底（`target` 形状非法 → 该通道 `target = null`；数值非法 → 0 / `lastTickAt`）；`dungeons.cleared` 只保留 `true` 值的合法 key。
4. `import-validation.ts`：`requireValid` 补三通道结构；导入路径重置三通道账本 + 清空 `dungeons.cleared`。
5. `economy.ts`：新增 `IDLE.SECONDS_PER_ROLL = 6` 与 `DUNGEON` 锚点块（锚点值先留占位，由 M5 标定产出）；删除 `BATTLE.SECONDS_PER_BATTLE`，全量替换引用点。
6. 删除 `IdleTarget`（`core/model/types.ts`）与 `normalizeIdleTarget()`。
7. **副本关卡配置**：新增 `DungeonStageDef` 与 **24 关定义表**（`core/config/dungeons.ts`）；
   每关含 id / 变体 / 难度 / 名称 / 敌人组合 / `enemyScale` / `powerRequired` / `drop`；
   `enemyScale` 与 `powerRequired` 由锚点表算出（**配置里只放锚点，不放手填值**）。
   另提供 `dungeonStageById()` / `dungeonStagesOf(kind)` / `dungeonStageId(variant, difficulty)` 三个索引函数
   （表现层与动作层都从这里取，**禁止自行拼 id**）。

**验收**：`tests/unit/migration-v11.test.ts` 新增 —— v10 旧档迁移后三通道结构正确、旧预算只落在旧去向通道、迁移幂等（跑两次结果一致）、畸形档不崩；`tests/unit/dungeon-stages.test.ts` 新增 —— 24 关齐全、id 唯一、敌人存在、产量与变体材料一致。

### M2 · Core 结算层与动作层重写

**落点**：`src/core/systems/idle.ts`、`src/core/systems/actions.ts`、`src/core/systems/dungeons.ts`、`src/core/systems/action-protocol.ts`、`src/core/config/tasks.ts`

1. `idle.ts` 重写：`settleIdleChannels()` + `resolveChannelTarget()` + `rollChannelRewards()`；`runIdle()` / `settleOffline()` 退场（`runIdle` 仅被测试与工具引用 → 一并清理）。
2. `dungeons.ts` 重写：`runDungeon()` / `dungeonStages()` / `dungeonChapter()` **退场**；
   新增 `runDungeonLevel(save, stageId, seed, ctx)`：打该副本关卡**一场**真实战斗
   （敌人 = 关卡定义，缩放 = 关卡 `enemyScale`），返回 `{ win, battle }`；
   `dungeonGatePower()` 改为读副本关卡自己的 `powerRequired`；
   `dungeonUnlocked()` 保留（元素有可升技能英灵 / 遗物等级达线）。
3. `actions.ts`：
   - 新增 `actionCampaignChallenge` / `actionDungeonChallenge` / `actionIdleSetChannel`。
   - `settleIdleLedger` → `settleIdleChannels`（三通道）。
   - `actionIdleTick` / `actionIdleClaimOffline` 返回新的 `IdleActionResult`。
   - `actionIdleHeartbeat` 计量三通道 + 续约租约。
   - 删除 `actionIdleSetTarget` 与 `idle.setTarget`。
   - `applyRewardBundle` / `mergeRewardBundles` 复用不变（铁律 #26：入库只认 `rewards`）。
4. `action-protocol.ts`：新负载校验（`campaign.challenge` / `dungeon.challenge` / `idle.setChannel`），删 `idle.setTarget`；响应加 `replay?: BattleResult`。
5. `tasks.ts`：`TaskMetric` 加 `'challenge'`；每日 / 周任务 `battle` 口径文案调整。

**验收**：
- `tests/unit/idle.test.ts` 重写：曲线不变（三通道各算各的）、通道独立累计、余数保留、零时间不耗随机、溢出并入明细。
- `tests/unit/idle-authority.test.ts` 重写：分批领取 == 一次领取、时钟回退不重发、通道关闭不追溯、重复领取不重复发。
- `tests/unit/idle-target.test.ts` 重写为 `idle-channel.test.ts`：主线只能选已通关关卡（未通关被拒）、副本未通关不能设为通道、切换通道立即生效且不追溯。
- `tests/unit/challenge.test.ts`：推征首通给奖 + 推进 `clearedStage`、重复通关无掉落、不能跳关；副本挑战一次即通关并记入 `dungeons.cleared`、失败不记。

### M3 · 服务端接线

**落点**：`server/src/game/service.ts`、`server/src/game/*.ts`（必要时）

1. `prepare()` 改调 `settleIdleChannels`。
2. `offlineForClient()` 改用三通道最大 elapsed。
3. 响应装配：`replay` 字段透传（**不写入幂等日志**）。
4. `StoredOutcome.result` 保持轻量（不含 battle）。

**验收**：`tests/unit/server/idle-authority.test.ts` 重写（服务端载入与动作使用同一账本、余数写回）；`tests/unit/server/action.test.ts` 补「挑战类动作的幂等重放不重复发奖」。

### M4 · 表现层

**落点**：`src/presentation/components/StageDetailModal.vue`（新）、`src/presentation/views/StageDetailView.vue`、`src/presentation/views/ExpeditionView.vue`、`src/presentation/views/DungeonView.vue`、`src/presentation/App.vue`、`src/presentation/stores/game.ts`

1. `StageDetailModal.vue` 抽离自现 `StageDetailView.vue`；`StageDetailView.vue` 变薄壳（深链保活）。
2. 推征页改造：挑战按钮 + 三通道面板 + 副本入口卡 + 关卡网格开弹窗。
3. 副本页改造：**24 关列表** + 通关状态 / 挑战 / 设为挂机通道。
4. `App.vue` 离线结算弹窗改三通道分段。
5. `stores/game.ts`：`setIdleTarget` → `setIdleChannel`；新增 `challengeStage` / `challengeDungeon`；`offlineReport` 类型更新。

**验收**：`tests/e2e/battle.spec.ts`（深链 `/stage/1` 仍可战斗预览）、`tests/e2e/dungeon.spec.ts`（副本挑战 → 挂机拿材料）、`tests/e2e/smoke.spec.ts`、`tests/e2e/relic.spec.ts`（副本刷石头路径）全部改写并通过。

### M5 · 数值工具适配、副本标定与基线重跑

**落点**：`tools/balance/*.ts`、`tools/validate-config.ts`、`tools/perf/long-hang.ts`

1. `dungeon-loop.ts` 改为三通道并行模型（见 3.9）。
2. **新增 `tools/balance/recalibrate-dungeon.ts`**：标定副本 24 关的
   `SCALE_ANCHORS` / `POWER_ANCHORS` / `DESIGN_LEVELS`（见 3.2.1 ④），
   并把结果写回 `core/config/economy.ts` 的 `DUNGEON` 常量块（标定值禁止手填）。
3. `newplayer.ts` / `recalibrate.ts` 适配手动挑战驱动。
4. `report.ts` / `validate-config.ts` / `long-hang.ts` 适配
   （`validate-config.ts` 新增：24 关配置齐全、敌人存在、段间单调、产量登记）。
5. **重跑基线**：`npm run balance` / `balance:newplayer` / `balance:recalibrate` /
   `balance:recalibrate:dungeon` / `balance:report` / `balance:rates`。
6. 若关卡曲线因「手动推进」而失配 → 用 `npm run balance:recalibrate` **重新标定**锚点（禁止手填，铁律 #41）。
7. 输出一张**副本 vs 主线门槛对照表**（副本关卡门槛 vs 同档主线门槛），供策划核对两条线的相对难度。

**验收**：全部脚本退出码 0；回收比报告口径更新且数值合理；若锚点重标定，产出新旧对照表。

### M6 · 文档与收尾

1. `artifacts/plan.md` §5.7 重写（离线曲线 → 三通道账本 + 副本独立关卡）、§4 核心循环图更新、§12 实施修正补记。
2. `AGENTS.md`：新增 / 修订铁律（三通道独立账本、挂机不跑战斗、首通只在手动挑战发放、战斗回放不进幂等日志、副本锚点必须标定）。
3. 截图工具 `tools/capture/screenshot.ts`：新增 `--dungeon-challenge` 场景；`--stage` 场景改走弹窗。
4. `npm run check` + 全量 E2E 全绿。

---

## 5. 测试与验收标准

### 5.1 新增 / 重写的单测

| 文件 | 覆盖 |
|---|---|
| `tests/unit/migration-v11.test.ts`（新） | v10→v11 迁移、幂等、畸形档 |
| `tests/unit/dungeon-stages.test.ts`（新） | 副本 24 关配置齐全、关卡 id 唯一、段间缩放 / 门槛单调、每关产量与变体材料一致、挑战一次即通关 |
| `tests/unit/idle.test.ts`（重写） | 曲线、通道独立、余数、溢出、零时间 |
| `tests/unit/idle-authority.test.ts`（重写） | 分批 == 一次、时钟回退、通道关闭、重复领取 |
| `tests/unit/idle-channel.test.ts`（重写自 `idle-target`） | 通道目标校验（已通关主线关卡 / 已通关副本关卡）、切换即时生效 |
| `tests/unit/challenge.test.ts`（新） | 推征首通、重复无掉落、跳关拒绝、副本首通记录 |
| `tests/unit/dungeons.test.ts`（扩） | `runDungeonLevel` 口径、`dungeonUnlocked` 不变 |
| `tests/unit/server/action.test.ts`（扩） | 挑战类动作幂等重放不重复发奖 |
| `tests/unit/server/idle-authority.test.ts`（重写） | 服务端与动作同账本 |
| `tests/unit/dungeon-loop.test.ts`（重写） | 三通道并行模型 |

### 5.2 E2E

| 文件 | 覆盖 |
|---|---|
| `tests/e2e/battle.spec.ts` | 关卡详情弹窗（深链 + 推征页开弹窗）、战斗预览仍可用 |
| `tests/e2e/dungeon.spec.ts` | 副本挑战通关 → 设为挂机通道 → 挂机拿材料 → 未通关不能挂 |
| `tests/e2e/relic.spec.ts` | 强化副本通道刷石头 |
| `tests/e2e/growth.spec.ts` | 手动挑战推进主线 → 真实挂机刷经验 → 喂经验 → 境界突破（**前置改用 `save.import` 导入 Lv59 主角**，与 AGENTS.md 铁律 #22 一致） |
| `tests/e2e/smoke.spec.ts` | 首屏、导航、推征页三通道面板可见 |

> ⚠ E2E 必须走真实「上线 → 心跳 → 领奖」序列（铁律：不得直接改 `save.idle.measuredAt` / `activeUntil`）。

### 5.3 验收口径

1. `npm run check` 全绿（配置校验 / 禁用词扫描 / 全量单测 / 类型检查 / 构建）。
2. 全量 E2E 全绿。
3. `npm run balance` / `balance:newplayer` / `balance:recalibrate` / `balance:recalibrate:dungeon` / `balance:report` 全部退出码 0，报告口径已更新。
4. 人工验收清单：
   - 挂机结算**不跑战斗**（服务端日志里结算路径无 `runBattle` 调用；单测断言通道结算只调 `rollRewards`）。
   - 三通道**同时**产出，互不扣减（结算明细三段独立）。
   - 主线通道只能选已通关关卡；未通关的「设为挂机目标」按钮禁用。
   - 重复通关无掉落（背包银两不变）。
   - 副本页展示 24 个独立关卡，各有通关状态 / 门槛 / 产量；未通关不能挂机。
   - 关卡详情为弹窗（URL 不变），深链 `/stage/:id` 仍可用。
   - 推征页可直达技能副本 / 强化副本。

---

## 6. 风险与未决事项

### 6.1 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **主线推进从「自动」变成「手动点击」**（F1 + D3）：玩家要通关 310 关需要大量点击 | 主线节奏完全改变，40 天曲线基线失效 | M5 必须按「每会话手动挑战次数」重跑基线；该假设见 6.2-U1 |
| R2 | **总产出上升**（三通道并行，D1） | 经验 / 银两 / 遗物相对「刷副本的玩家」上升；材料相对「刷材料的玩家」约 ×2 | M5 重跑回收比；若超标，优先收紧 `IDLE.CAP_HOURS` / `ONLINE_MULTIPLIER`（**只改配置**，不改逻辑） |
| R3 | **战斗回放体积**（3.7） | 若把 `BattleResult` 存进幂等日志，SQLite 日志表暴涨 | 已用 `replay` 非持久化字段规避；需在 M3 实测回包大小 |
| R4 | **大改动面**：core 存档 + 动作 + 服务端 + 表现层 + 工具 + 测试同时改 | 回归面大 | 按 M1→M6 顺序推进，每步 `npm run check`；core 先于表现层 |
| R5 | **「已通关副本」是新增进度维度**，旧档玩家迁移后没有副本通关记录 | 旧档玩家的副本通道需要重新挑战一次 | 迁移保留旧副本去向但**不自动标记已通关**；UI 明示「需先挑战通关」（不静默丢设置） |
| R6 | **`dungeon-loop.ts` 的理性玩家模型重写**（F4） | 数值工具可能与真实游戏对不上 | 工具口径与 core 动作层共用同一套函数（铁律 #4）；M5 必须用新模型重跑全部基线 |
| R7 | **遗物是唯一线性增长的字段**（F11） | 三通道并行后遗物增量不变（只有主线通道产遗物），但若未来某通道也产遗物会击穿 3000 上限 | 当前不产遗物的通道保持不产；库存上限与溢出上报保持不变 |
| R8 | **副本 24 关的配置与标定是新工作量**（D9 / D10） | 24 关 × (敌人组合 + 锚点 + 门槛 + 产量) 全部要配；标定工具是新建的 | 标定工具与主线同款（复用 F15 的二分与参考队伍）；24 关配置集中在 `core/config/dungeons.ts` 一份，不散落 |
| R9 | **副本难度与主线解耦后，主线改动不再自动影响副本** | 副本可能与主线难度脱节 | M5 一次性把两者都标定并出对照表（副本关卡门槛 vs 同档主线门槛） |

### 6.2 未决事项（实施中按默认处理，M5 复核）

| # | 未决 | 默认处理 |
|---|---|---|
| U1 | **手动挑战速率**（每会话尝试次数） | M5 暂按「每会话 20 次」建模，重跑后由实测曲线反推并写回文档 |
| U2 | **副本关卡的「通关」定义** | 打赢该关**一场**真实战斗即通关（D9：`(变体 × 难度) = 1 关`） |
| U3 | **副本挑战通关的奖励** | 发**一次**该关产量（与挂机每次结算同口径）。不叠加 |
| U4 | **主线通道默认跟随最新通关关卡时，玩家能否改挂旧关** | 能（可挂任意已通关关卡，含 BOSS）。`stageId = null` 表示「跟随最新」 |
| U5 | **三个通道是否需要独立的「关闭」开关** | 技能 / 强化通道可关；主线通道恒开（它是经验与银两的唯一来源，关掉等于卡死养成） |
| U6 | **经济是否需要同步收紧**（`CAP_HOURS` / `ONLINE_MULTIPLIER` / 掉落概率） | 本次**不改任何数值**，先跑基线看数据；确需调整时走 M5，且只改 `economy.ts` 配置 |
| U7 | **副本 24 关的设计等级阶梯**（`DUNGEON.DESIGN_LEVELS`） | 默认：难度段 = 主线第 1 / 4 / 8 章的目标等级（Lv24 / Lv96 / Lv192）；段内 8 关按变体顺序在「段起点 ~ 段终点」等比铺开；强化副本 tier2 / tier3 按解锁线向上取整到最近的 24 级档。M5 标定时按实测调整 |
| U8 | **副本关卡的敌人组合** | 复用现有 30 只敌人的子集，不新增敌人（见 3.2.1 ③）；元素主题仍只体现在产出材料上。若实测某关难度失真 → 回标定工具，不改敌人表 |

---

## 7. 受影响文件清单（预估）

**core**：`core/model/types.ts`、`core/save/schema.ts`、`core/save/import-validation.ts`、`core/save/serialize.ts`（投影确认）、`core/config/economy.ts`（新增 `IDLE.SECONDS_PER_ROLL` 与 `DUNGEON` 锚点块）、`core/config/dungeons.ts`（**新增 24 关定义表**）、`core/config/tasks.ts`、`core/systems/idle.ts`、`core/systems/actions.ts`、`core/systems/action-protocol.ts`、`core/systems/dungeons.ts`（重写）、`core/systems/tasks.ts`（若有）

**server**：`server/src/game/service.ts`

**presentation**：`presentation/components/StageDetailModal.vue`（新）、`presentation/views/StageDetailView.vue`、`presentation/views/ExpeditionView.vue`、`presentation/views/DungeonView.vue`、`presentation/App.vue`、`presentation/stores/game.ts`、`presentation/router.ts`（仅在需要时）

**tools**：`tools/balance/{dungeon-loop,newplayer,recalibrate,report}.ts`、`tools/balance/recalibrate-dungeon.ts`（**新增**）、`tools/validate-config.ts`、`tools/perf/long-hang.ts`、`tools/capture/screenshot.ts`

**tests**：`tests/unit/{idle,idle-authority,idle-target→idle-channel,dungeon-loop,dungeons,dungeon-stages,migration-v11,challenge,server/action,server/idle-authority}.test.ts`、`tests/e2e/{battle,dungeon,relic,growth,smoke}.spec.ts`

**docs**：`artifacts/plan.md`、`AGENTS.md`

---

## 8. 实施守则（继承项目铁律）

- **`src/core/` 零 DOM / 零平台 API**；时间经 `ctx.now`、随机经 `ctx.rng` 注入。
- **所有改存档的动作**走 `core/systems/actions.ts` 纯函数，服务端执行；客户端只发意图。
- **数值常量只进 `core/config/economy.ts`**；本次新增 `IDLE.SECONDS_PER_ROLL` 与 `DUNGEON` 锚点块，删除 `BATTLE.SECONDS_PER_BATTLE`（不做别名）。
- **难度锚点只由标定工具产出**（主线 `balance:recalibrate` / 副本 `balance:recalibrate:dungeon`），禁止手填（铁律 #41）。
- **关卡 id 只有一个出处**：副本关卡 id 由 `core/config/dungeons.ts` 的索引函数产出，表现层与动作层不得自行拼接（铁律 #3 / #8）。
- **收益入库只认 `rewards`**（铁律 #26）：遗物必须在 `rewards.relics`，不得另开旁路数组。
- **表现层不得自推导战斗事实 / 掉落口径 / 通道状态**：一律取 core 与服务端回包。
- **心跳保持轻量**（铁律 #33）。
- **战斗回放是时间的纯函数**（铁律 #20）：本次不改变 `battle-timeline.ts`，只改「回放数据从哪来」。
- **禁用词表只改 `src/content/compliance/forbidden-words.md`**。
