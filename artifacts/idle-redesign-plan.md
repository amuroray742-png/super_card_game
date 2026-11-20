# 挂机系统改版：三通道并行 + 已通关直挂 + 副本独立关卡 + 关卡详情弹窗

> 本文是《超级圣杯战争》**挂机系统改版**的实施方案，独立于 `artifacts/plan.md` 的 19 章设计基线。
> 与基线冲突处以本方案为准；实施时须把结论同步回写基线 §5.7 / §12 与 `AGENTS.md` 铁律。

## Summary

把当前「单一挂机去向 + 回放真实战斗」的整体挂机系统，改造成「**三条并行通道 + 已通关内容直接发奖**」：

1. **主线 / 技能副本 / 强化副本各自一条独立通道**，各自计量同一段墙钟时间、各自记账，产出互不干扰（玩家可同时挂三个）。
2. **挂机不再跑战斗**：通道目标必须是「已通关」的内容，结算时按掉落表逐次掷奖直接入库——所以永远不会卡关、不会有战败、不会空转。
3. **主线推进改为纯手动挑战**。主线首胜发经验书、银两和圣杯结晶，复战胜利与挂机发经验书和银两。技能副本和强化副本每次手动胜利发一份对应材料，首胜同时解锁该关挂机。
4. **副本独立成 24 个关卡**：`(变体 × 难度) = 1 个关卡`（技能 5×3 + 强化 3×3），有自己的关卡定义、难度锚点、战力门槛与通关记录；**不再借用主线波次**（现状是「难度 = 取材主线某章」）。
5. **关卡详情改为弹窗**：从推征页直接弹出，不再切页面。
6. **副本单独入口**：推征页放「技能副本 / 强化副本」两张入口卡，底层仍是同一个副本页的两个 tab，底部导航保持 5 项。

**关键设计决策**（用户已逐项拍板）：

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 三通道**各自独立**计量同一段墙钟时间 | 全开时三路同时产出，分别评估各资源的投放 |
| D2 | 挂机**只挂已通关内容**，且**不跑战斗**，直接按掉落表掷奖 | 永不卡关；掉落仍逐次掷骰，保证与概率公示一致 |
| D3 | 主线推进改为**纯手动挑战**（`campaign.challenge`） | 手动胜利发基础掉落，首胜追加一次圣杯结晶 |
| D4 | 副本同样需**手动挑战通关**才可挂机 | 与 D3 同构，副本进度与主线进度分开记账 |
| D5 | 主线通道目标**默认 = 最后一个通关的关卡**（`campaign.clearedStage`），可改挂其他已通关关卡 | 「默认挂机最后一个通过了的关卡」 |
| D6 | 关卡详情改**弹窗组件**，但保留 `/stage/:id` 路由 | E2E（`battle.spec.ts`）与截图工具（`screenshot.ts --stage`）依赖该深链，不能破 |
| D7 | 副本入口走**推征页入口卡**，底层仍是 `/dungeon` 的两个 tab | 底部导航保持 5 项（360px 窄机型约束，AGENTS.md 已记录） |
| D8 | 新档直接使用 **v11** | 按未上线项目的新档起步设计 |
| D9 | **副本是独立关卡**：`(变体 × 难度) = 1 关`，共 24 关，打赢一次即通关 | 副本不再借用主线波次，有自己的关卡实体、门槛与通关记录 |
| D10 | **副本自建难度锚点表**，用与主线同款的二分流程实测标定 | 铁律 #41：锚点不许手填；副本难度与主线数值解耦 |

**本次交付为本文修订。** 下文的开发、标定和测试属于后续实施。项目尚未上线，开发期旧档由项目方自行清理。

---

## 1. 目标与范围

### 1.1 目标

- 挂机从「回放战斗」变成「已通关内容的稳定被动产出」，消除卡关 / 战败 / 空转三种负反馈。
- 三个内容线（主线 / 技能副本 / 强化副本）可**同时**挂机，玩家不再需要为了「今晚刷什么」做取舍。
- 主线推进由玩家主动挑战完成。首次胜利发经验书、银两和圣杯结晶，后续胜利仍能获得经验书和银两。
- 副本成为**真正独立的内容线**：有自己的关卡列表、难度曲线与通关进度，而不是主线的附庸。
- 关卡详情、挂机设置、副本入口都在**一屏之内可达**，不再切页面。

### 1.2 后续实施范围

- core 包括 v11 新档、三通道账本、结算与挑战动作、奖励规则，以及 24 个独立副本关卡的配置、难度标定与通关记录。
- 服务端：入口预结算、心跳、动作幂等、回包装配（战斗回放不进幂等日志）。
- 表现层：推征页（挑战 + 三通道面板 + 副本入口卡）、关卡详情弹窗、副本页（24 关列表 + 通关状态 + 挑战）、离线结算弹窗（三段）。
- 数值工具：`dungeon-loop.ts` / `newplayer.ts` / `recalibrate.ts` / `report.ts` / `validate-config.ts` 适配新模型，**新增** `recalibrate-dungeon.ts` 标定副本 24 关，并重跑基线。
- 测试：单测重写 + 新增、E2E 改写、截图场景更新。
- 文档：`artifacts/plan.md` §5.7 与 `AGENTS.md` 铁律同步。

### 1.3 后续实施的范围边界

- **不做**：竞技场 / 天梯 / 圣杯重启的挂机化（仍是一次性结算，不产挂机收益）。
- **不做**：关卡难度锚点（`STAGE.SCALE_ANCHORS` 与新增的 `DUNGEON.SCALE_ANCHORS`）的**手工**调整——只允许按 M5 实测结果重跑 `npm run balance:recalibrate` / `balance:recalibrate:dungeon` 重新标定，禁止手填（铁律 #41）。
- **不做**：新增副本专属敌人与美术资源——本次副本关卡复用现有 30 只敌人（元素主题仍只体现在产出材料上）。
- **不做**：底部导航扩容（保持 5 项）。
- **不做**：新的材料 / 货币种类；副本产量仍 = 现有 `DUNGEON_DROPS` × 难度倍率，不新增数值来源。
- **不做**：抽卡、体检、账号体系的任何改动。
- 遗物采用独立获取入口，玩法与投放另行设计。首件遗物必须在初阶强化副本解锁前可达，作为完整养成链路的交付依赖。

---

## 2. 实施前必须知道的现状（已逐条核实）

| # | 事实 | 出处 |
|---|---|---|
| F1 | **主线进度只有挂机一条路**：`campaign.clearedStage` 仅在 `settleIdleLedger()` 内被推进，没有独立的「通关关卡」动作；观战（`fight()`）是纯客户端预览，不发奖、不推进 | `src/core/systems/actions.ts:718`；`src/presentation/views/ExpeditionView.vue:115-133` |
| F2 | **掉落与战斗已解耦**。可复用 `rollRewards(stage, rng)` 的做法，让主线手动胜利、挂机与预览共用更新后的基础掉落配置 | `src/core/systems/idle.ts:245` |
| F3 | **三去向共用一份时间账本**（`idle.effectiveMs` / `measuredAt` / `offlineElapsedMs`），切换去向时先结清旧去向 | `src/core/systems/actions.ts:628-731` |
| F4 | **经济工具与「共用一份时间」强耦合**：`dungeon-loop.ts` 的 `decideIdleTarget()` 用「一夜能换多少战力（ln 口径）」在三个去向间**分配**同一份时间 | `tools/balance/dungeon-loop.ts:30-67, 397` |
| F5 | **`BATTLE.SECONDS_PER_BATTLE = 6`** 是挂机节奏单位（时间 → 场次），被 core 与工具共用 | `src/core/config/economy.ts:304` |
| F6 | **副本难度 = 取材章**：easy=第 1 章 / normal=第 4 章 / hard=第 8 章，产量倍率 1.0 / 1.6 / 2.6 | `src/core/config/economy.ts:770` |
| F7 | **副本门槛口径 = 取材章的 BOSS 门槛**（`dungeonGatePower()`） | `tools/balance/dungeon-loop.ts:301` |
| F8 | **`/stage/:id` 深链被外部依赖**：E2E `battle.spec.ts:201`、截图工具 `screenshot.ts:383` | 见左 |
| F9 | **`/dungeon?kind=…` 深链被外部依赖**：E2E `backpack.spec.ts:150/163`、`dungeon.spec.ts`、`relic.spec.ts:143`、截图工具 `screenshot.ts:580` | 见左 |
| F10 | **现行任务按主线场次累计**。每日「推征 30 场」与每周「累计推征 200 场」经 `advanceTasks(daily, 'battle', n)` 累计 | `src/core/config/tasks.ts:43`、`src/core/systems/actions.ts:729` |
| F11 | **新档的遗物仓库为空**。初阶强化副本要求至少持有一件 Lv1 遗物，独立遗物入口必须先于该副本可用 | `src/core/save/schema.ts:276`、`src/core/systems/dungeons.ts:57` |
| F12 | **心跳必须保持轻量**：不回传存档主体、只载入已装备遗物（≤36）、不写遗物行 | AGENTS.md 铁律 #33 |
| F13 | **导入路径会重置控制字段**：`validateImportedSave` 会 `delete save.idle.farm`、重置 `rng`、重置时间戳 → 新的三通道账本同样要在导入路径被重置 | `src/core/save/import-validation.ts:114-117` |
| F14 | **副本当前没有自己的关卡**：难度 = 取材主线章，波次 = `dungeonStages(chapter)` 取该章主线关卡 id，门槛 = `dungeonGatePower()` 读主线章 BOSS 的 `powerRequired` | `src/core/config/economy.ts:770`；`src/core/systems/dungeons.ts:102-109`；`tools/balance/dungeon-loop.ts:301` |
| F15 | **主线标定工具已具备可复用的二分流程**：`maxWinnableScale()` 二分「通关率 ≥ 90% 的最大缩放」→ 取一半 → ÷ 章内总跨度 → 锚点；配套 `referenceTeam(level)` 参考队伍 | `tools/balance/recalibrate.ts:189, 248-273` |
| F16 | **敌人库共 30 只**（10 章 × 2 普通 + 1 BOSS），五行分布不均（土仅 2 只普通怪）；`dungeons.ts` 已注明「元素主题落在产出材料上，不落在敌人上」 | `src/core/config/enemies.ts:53-103`；`src/core/config/dungeons.ts:19-21` |
| F17 | **副本变体共 8 个**：技能 5（金木水火土）+ 强化 3（初/中/高阶石档）；每个变体一个产出道具 id | `src/core/config/dungeons.ts:57-122` |

---

## 3. 目标架构

### 3.1 奖励与通关规则

三条通道分别计量同一段墙钟时间。已通关目标在结算时按表直接发奖，当前编队变化不影响已通关目标的挂机资格。主线与副本分别记录进度，只有手动胜利可以推进。手动挑战独立于挂机时间预算。

| 内容 | 首次手动胜利 | 后续手动胜利 | 已通关挂机（每次结算） |
|---|---|---|---|
| 主线 | 经验书、银两、圣杯结晶 | 经验书、银两 | 经验书、银两 |
| 技能副本 | 对应五行的技能材料 | 对应五行的技能材料 | 对应五行的技能材料 |
| 强化副本 | 对应档位的强化石 | 对应档位的强化石 | 对应档位的强化石 |

- **主线**每次手动胜利或挂机结算按同一张表掷一次基础掉落。首通若未掷到经验书，补发一本小经验书，保证三种首通奖励到账。圣杯结晶按 `FIRST_CLEAR_CRYSTALS` 和账号级 `creditedStages` 发放，每关只发一次。预览与结算共用基础掉落和首通追加的配置。
- **副本**每次手动胜利发一份材料。首次胜利同时登记通关并解锁该关挂机。复战和挂机使用同一关卡产量区间，每个胜场或挂机结算各掷一次。
- **手动战败**只返回挑战结果，奖励包为空，通关记录保持原值。同一动作请求在结果保留期内重放原结算，新的挑战胜利照常发奖。
- **遗物**走独立获取入口，玩法另行设计。三条通道与手动挑战的奖励范围以本节表格为准。强化副本首件遗物的前置条件见 §1.3。

### 3.2 存档结构（v11）

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
  /** 待结算有效预算（毫秒），含不足一次的余数 */
  effectiveMs: number
  /** 连续离线累计时长（衰减曲线用） */
  offlineElapsedMs: number
  /** 待下次成功结算报告的实际离线时长（毫秒） */
  pendingOfflineMs: number
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
  /** 已消费的有效时长总和（秒），三通道分别累计后相加 */
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

### 3.3 新建与导入 v11 存档（`src/core/save/schema.ts`）

- 新档的 `campaign.clearedStage = 0`、`dungeons.cleared = {}`。主线目标默认跟随最新通关关卡，首胜前显示「挑战第 1 关」，首胜后开始计量。技能和强化通道开局关闭，玩家在首胜后主动设置目标。
- 建档时各通道的计量水位和在线租约设为服务端当前时刻，有效预算、连续离线时长、待报告时长均为零。
- 导入仅接受 v11。导入后清空副本通关记录与副本挂机目标，主线恢复跟随模式。按新建账本的方式重置时间字段，并重新生成服务端随机序列。
- 每条通道在权威存档的私有随机状态中保存独立的种子和计数器，建档和导入时由服务端生成。公开快照、缓存与导出均通过公开存档投影省略这些随机状态。

### 3.4 数值口径（`src/core/config/economy.ts`）

- **新增** `IDLE.SECONDS_PER_ROLL = 6`（挂机结算节奏单位：每 6 秒结算一次掉落）。
- **新增** `DUNGEON` 锚点块（3.2.1 ②）。
- **删除** `BATTLE.SECONDS_PER_BATTLE = 6`，全量替换引用点（core 4 处 + `tools/balance/*` + 测试）——保持「单一数据源」，不做别名兜底（铁律 #4/#5）。
- 将 `IDLE.MAX_REPLAY_BATTLES` 改名为 `IDLE.MAX_ROLLS_PER_SETTLEMENT`，保留每通道 2,000 次的保护上限。有效预算另按 `IDLE.CAP_HOURS` 封顶。按当前 3 小时预算和 6 秒一次的配置，在线积满时每通道最多 1,800 次，纯离线积满时每通道 1,560 次。
- `IDLE.FULL_EFFICIENCY_HOURS / CAP_HOURS / TAIL_RATE / ONLINE_MULTIPLIER / ACTIVE_LEASE_MS / HEARTBEAT_INTERVAL_MS / OFFLINE_SETTLE_THRESHOLD_SEC` **全部不变**（曲线形状不变，只是从 1 条变成 3 条）。
- 主线掉落表保留经验书概率、数量和银两区间，移除遗物掉落，单独配置 §3.1 的首通经验书保底。首轮标定保留 `DUNGEON_DROPS`、难度产量倍率和 `FIRST_CLEAR_CRYSTALS` 的现有数值。

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

**下线** `idle.setTarget`。`idle.tick` 作为一键领取动作，由服务端根据三个通道各自的可用预算确定结算次数。`idle.claimOffline` 复用同一结算入口和限额。

新增动作结果：

```ts
/** 单条通道的一次结算明细 */
export interface ChannelSettlement {
  channel: IdleChannelKind
  /** 目标显示名，由关卡登记表提供 */
  targetName: string
  /** 实际结算次数 */
  rolls: number
  /** 本次产出（唯一入库口径） */
  rewards: RewardBundle
  /** 本次结算覆盖的实际离线时长（秒） */
  elapsedSeconds: number
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
  /** 本次胜利奖励，战败时为空 */
  rewards: RewardBundle
}

export interface DungeonChallengeResult {
  /** 副本关卡 id */
  stageId: string
  win: boolean
  /** 本次是否首次通关（并已记入 dungeons.cleared） */
  firstClear: boolean
  rewards: RewardBundle
}
```

**动作契约**（沿用铁律 #29）：

| 动作 | 校验（先校验后修改） | 副作用 |
|---|---|---|
| `campaign.challenge` | `stageId` 必须是合法主线关卡且 ≤ `clearedStage + 1`，队伍非空。省略时挑战下一关 | 每次胜利发一次基础掉落。首胜推进 `clearedStage`，补足首通经验书并发放首通结晶。跟随模式在推进前结清旧目标的完整次数 |
| `dungeon.challenge` | 副本关卡存在、`dungeonUnlocked()` 通过、队伍非空 | 每次胜利发一份对应材料。首胜写入 `dungeons.cleared`，解锁该关的挂机设置 |
| `idle.setChannel` | 主线可选有效的已通关关卡，或省略／传 `null` 跟随最新。技能和强化必须选对应类型的已通关关卡，也可用 `disabled=true` 关闭 | 相同目标直接返回。切换或关闭前结清旧目标，响应包含通道的新状态及本次产生的旧目标结算明细 |
| `idle.tick` | 服务端解析各通道目标与可结算次数 | 一次领取所有可结算通道，返回分通道明细 |
| `idle.claimOffline` | 同 `idle.tick` | 使用同一账本、上限与发奖入口 |
| `idle.heartbeat` | — | 只计量 + 续约租约，不发奖 |

**任务口径**沿用每日 30 次和每周 200 次，只累计主线挂机成功结算次数。通过 `advanceTasks(daily, 'battle', mainRolls)` 累计，任务文案改为「主线挂机结算」，由 `tasks.ts` 统一定义。

### 3.6 结算流程（`src/core/systems/idle.ts`）

1. **解析目标。** 主线跟随模式取 `campaign.clearedStage`，指定模式只接受有效的已通关关卡。副本目标必须属于该通道并已记录通关。关闭、失效或首胜前尚无目标的通道不计收益，计量水位仍向前推进；失效时返回状态供界面提示。时钟回退时跳过该通道，水位保持原值。
2. **计量预算。** 用服务端时刻和现有租约，将距 `measuredAt` 的时间切成在线段和离线段。只有 `onlineMs > 0` 时才重置连续离线起点。将离线曲线在本次离线段的累计有效秒数差乘 1,000 转成毫秒，再加在线毫秒乘以在线倍率。更新受封顶约束的 `effectiveMs`、连续离线时长、水位及 `pendingOfflineMs`。心跳只执行计量，计量结束后才续租。
3. **结算入库。** 用 `rollMs = IDLE.SECONDS_PER_ROLL * 1000` 换算可结算次数，每通道取完整次数与单次限额中的较小值。主线掷经验书与银两，两个副本各掷目标关的材料产量。通过 `applyRewardBundle()` 入库，同一事务扣除 `rolls * rollMs`，并推进私有随机计数器。正数预算即使来自较早的心跳也可领取；无完整次数时不发奖、不耗随机。
4. **生成回执。** 有产出的通道返回 `ChannelSettlement`，从该通道的 `pendingOfflineMs` 读取实际离线秒数并清除已报告时长。无产出的通道保留待报告时长。离线弹窗取本次有产出通道的最长实际离线时长判断阈值，在线计量不计入该时长。

**目标变更**先按原目标结清完整次数。启用中的通道换目标时保留不足一次的余数，水位不得回退。主线跟随模式因首胜而前推时也按此处理。关闭通道时结清后清除剩余预算和离线累计；重新打开从开启时刻起算。

**分批等价**适用于固定目标、等量预算且未触发预算封顶的情形。每条通道用自己的持久化随机序列逐次掷奖，领取次数与顺序不会改变该通道的掉落。挂机只兑现已解锁掉落，`campaign.clearedStage`、`campaign.creditedStages` 和副本通关记录均由手动挑战路径管理。

**`OfflineSettlementResult`** 含有产出的通道明细、总次数及本次覆盖的最长实际离线秒数。在线领取与服务端入口补结算使用同一份通道明细。

### 3.7 服务端接线（`server/src/game/service.ts`）

- 载入和普通动作通过 `prepare()` 预结算。`idle.tick` 和 `idle.claimOffline` 自行调用结算入口返回明细。`idle.setChannel` 在动作内校验并比对目标，只有实际变更时才结清对应通道。心跳仅计量。主线首胜跟随模式复用原目标的预结算结果。
- `offlineForClient()` 以本次有产出的通道所报告的最大实际离线时长判断阈值。先心跳后领取也能拿到完整离线报告。
- **心跳保持轻量**（铁律 #33）：仍不回传存档主体、只载入已装备遗物、不写遗物行。心跳现在要计量**三条**通道 —— 计量是纯数值运算，成本与单条同量级。
- **战斗回放不进幂等日志**。`StoredOutcome.result` 只存胜负、通关状态和奖励等轻量结果。完整 `BattleResult` 通过响应的 `replay?: BattleResult` 一次性回传。
  - 理由：`BattleResult.log` 上限 1500 条（铁律 #20），单条约 120 KB；存进 24 小时幂等日志 = 每天几十 MB。
  - 副作用：24 小时内重放同一 actionId 时拿不到回放数据 → 客户端按「已结算」处理，不再重播演出（结果与奖励仍一致）。

### 3.8 表现层

#### 3.8.1 关卡详情弹窗（D6）

- 新增 `src/presentation/components/StageDetailModal.vue`：内容 = 现 `StageDetailView.vue` 的全部区块（概要 / 战力门槛 / 敌人 / 掉落预览 / 战斗预览 / 设为挂机目标），改为 `props: { stageId: number }` + `emit('close')`。
- `src/presentation/views/StageDetailView.vue` 改为**薄壳**：读 `route.params.id` → 渲染同一个弹窗组件（深链可用，E2E / 截图工具不破）。
- 推征页「详情 ›」与关卡网格点击 → **就地开弹窗**（不切路由，不改 URL）。
- 弹窗内按钮语义调整：
  - 「设为挂机目标」→ **仅对已通关关卡可用**（未通关按钮禁用 + 文案「通关后才能挂机」）。
  - 当前可推进的关卡显示「挑战此关」，已通关关卡显示「再次挑战」。奖励预览分开展示「基础掉落」与未领取的「首通追加」，说明基础掉落也是挂机产出。更后面的关卡显示挑战条件。

#### 3.8.2 推征页（`ExpeditionView.vue`）

自上而下：

1. **主线面板**保留当前章节、关卡名、战力对比和观战。初次进入时显示「挑战第 1 关」，普通关胜利结算后可直接「挑战下一关」。回放沿用已有的跳过演出设置。
2. **三通道挂机面板**用三张卡分别显示通道名称、当前目标、可结算次数和每次产出。可结算次数使用 core 的统一换算口径。
   - 面板只提供一个「全部领取」，调用 `idle.tick`，分别展示各通道实发奖励。
   - 主线的「更换目标」打开已通关关卡选择弹窗。技能和强化的设置入口跳到对应副本 tab。
   - 未启用或未通关时显示具体条件和「去挑战」入口。主线首胜后默认跟随最新通关关卡并开始计量。
3. **副本入口卡**（D7）：「技能副本」「强化副本」两张卡 → `/dungeon?kind=skill` / `/dungeon?kind=enhance`。
4. **本章关卡网格**（保留）：点击 → 开关卡详情弹窗。
5. **编队概览**（保留）。

#### 3.8.3 副本页（`DungeonView.vue`）

- 保留种类 tab（技能 / 强化）。
- **关卡列表**：按「难度段（简易 / 普通 / 困难）× 变体」展示 24 关，每行显示
  关卡名 / 难度 / **通关状态** / 战力门槛 vs 当前战力 / 每胜产量。
- 「**挑战**」与「**再次挑战**」均调用 `dungeon.challenge`。每次手动胜利展示本场材料产量，首胜额外标记已通关和开放挂机设置。
- 「**设为挂机通道**」按钮 → `idle.setChannel`（仅已通关可设；已设则显示「已挂机」）。
- 未解锁的关卡显示解锁原因（`dungeonUnlocked()` 的口径）与直达养成入口（铁律 #27）。
- 现有「设为挂机去向」按钮改造为「设为挂机通道」（同一通道重复设置 = 无操作，不报错）。

#### 3.8.4 离线结算弹窗（`App.vue`）

- `store.offlineReport` 使用新的 `OfflineSettlementResult`，按通道展示目标、结算次数及掉落明细。
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
| `tools/balance/newplayer.ts` | 首日模拟分别统计手动挑战与三通道结算，纳入主线首胜前的起步时间 |
| `tools/balance/recalibrate.ts` | 40 天曲线由手动挑战驱动，对照不同上线和挑战频率，按需重新标定主线锚点 |
| `tools/balance/report.ts` | 按资源拆分主线基础掉落、首通奖励、手动副本和挂机副本的投放与回收 |
| `tools/validate-config.ts` | 校验新的通道目标 / **副本 24 关配置（齐全、敌人存在、段间单调、产量登记）** / 掉落口径 |
| `tools/perf/long-hang.ts` | 长挂压测改为三通道 |

**M5 对照口径**

- 一次纯离线完整额度为每通道 1,560 次。三个目标均已开启时共 4,680 次。次数用于校验预算，资源数量按各通道的实际掉落表核算。
- 在相同时间、关卡与单次产量下，某一种材料的挂机投放保持同一口径。并行增加的是其他通道的投放；手动复战频率另外影响经验书、银两和材料的总产量。
- 首日和 40 日报告分别统计手动与挂机投放，按资源对照玩家消耗、成长阶梯和逐章回收比。遗物投放由独立入口核算。首轮使用现有数量配置，确认具体资源超出目标后优先调整该资源或对应通道。

### 3.10 状态、并发、失败与恢复语义

| 维度 | 语义 |
|---|---|
| **权威** | 服务端唯一写入口。客户端改 `save.idle.*` 会被下一次回包覆盖（铁律 #28） |
| **幂等** | 成功动作结果保留 24 小时可重放；已执行 actionId 在账号存续期间永久防重。`campaign.challenge` / `dungeon.challenge` 走同一套（铁律 #11） |
| **并发** | 同账号动作进 Promise 串行队列（`server/src/game/lock.ts`）；存档与幂等日志同事务落库 |
| **时钟回退** | `ctx.now < ch.measuredAt` → 该通道本次不计量、不产出（沿用现有 `settleIdleLedger` 的 `if (ctx.now < from) return null` 口径） |
| **余数保留** | 不足一次的毫秒余数留在 `effectiveMs` 中。固定目标、等量预算且未触发封顶时，同一通道的分批掉落与一次领取一致 |
| **空预算** | 未攒够完整次数时无产出，随机序列保持原值。已有完整预算时可在同一时刻结算 |
| **通道关闭** | 先结清完整次数，再清除预算和离线累计。重新启用从服务端开启时刻计量 |
| **失效目标** | 配置无效或失去通关凭证时，该通道停止计量与产出。副本目标清空，界面按服务端状态提示重新挑战或选择目标 |
| **导入** | 只接受 v11，按 §3.3 初始化账本和私有随机状态 |
| **离线只读** | 服务端不可达 → 客户端进入只读模式，操作一律拒绝并提示（铁律 #28） |
| **仓库容量** | 遗物仓库容量与自动分解由独立获取入口继续遵循。三条挂机通道都只发基础资源或材料 |
| **断线** | 由下一次加载或动作按离线曲线补算。下次有产出的结算回执带上心跳期间计量的离线时长 |

---

## 4. 后续实施阶段

先用主线首关、一个简易技能副本和一个简易强化副本验证三路完整链路，再铺开 24 关。后续实施阶段以对应里程碑的测试和构建检查为验收。

### M1 · Core 数据模型、v11 新档与副本关卡配置

**落点**：`src/core/model/types.ts`、`src/core/save/schema.ts`、`src/core/save/import-validation.ts`、`src/core/config/economy.ts`、`src/core/config/dungeons.ts`

1. 新增 `IdleChannelKind` / `IdleChannelTarget` / `IdleChannelState`；改写 `SaveData.idle`；新增 `SaveData.dungeons`。
2. `SAVE_VERSION` 设为 11，按 §3.3 初始化三个账本与私有随机状态。
3. `normalizeSave()` 改写 `idle` 归一化：逐通道兜底（`target` 形状非法 → 该通道 `target = null`；数值非法 → 0 / `lastTickAt`）；`dungeons.cleared` 只保留 `true` 值的合法 key。
4. `import-validation.ts` 校验 v11 的三通道结构，按 §3.3 重置导入账本与私有随机状态。
5. `economy.ts`：新增 `IDLE.SECONDS_PER_ROLL = 6` 与 `DUNGEON` 锚点块（锚点值先留占位，由 M5 标定产出）；删除 `BATTLE.SECONDS_PER_BATTLE`，全量替换引用点。
6. 删除 `IdleTarget`（`core/model/types.ts`）与 `normalizeIdleTarget()`。
7. **副本关卡配置**先建立 `DungeonStageDef` 和两个简易样例，M5 完成 `core/config/dungeons.ts` 的 24 关定义表。
   每关含 id / 变体 / 难度 / 名称 / 敌人组合 / `enemyScale` / `powerRequired` / `drop`；
   `enemyScale` 与 `powerRequired` 由锚点表算出（**配置里只放锚点，不放手填值**）。
   另提供 `dungeonStageById()` / `dungeonStagesOf(kind)` / `dungeonStageId(variant, difficulty)` 三个索引函数
   （表现层与动作层都从这里取，**禁止自行拼 id**）。

**验收**覆盖 v11 新建、导入重置、异常字段处理、公开投影及两个副本样例的敌人索引与产量。

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
5. `tasks.ts` 将每日和每周任务文案改为主线挂机结算次数，保留现有目标数。

**验收**：
- `tests/unit/idle.test.ts` 覆盖三个通道独立计量、当前离线曲线、余数、空预算和发奖扣账。
- `tests/unit/idle-authority.test.ts` 重写：分批领取 == 一次领取、时钟回退不重发、通道关闭不追溯、重复领取不重复发。
- `tests/unit/idle-target.test.ts` 重写为 `idle-channel.test.ts`：主线只能选已通关关卡（未通关被拒）、副本未通关不能设为通道、切换通道立即生效且不追溯。
- `tests/unit/challenge.test.ts` 覆盖主线首胜三项发奖、复战基础掉落、重复请求、跳关校验、副本首胜及复战各发一份、战败不发奖。

### M3 · 服务端接线

**落点**：`server/src/game/service.ts`、`server/src/game/*.ts`（必要时）

1. `prepare()` 改调 `settleIdleChannels`。
2. `offlineForClient()` 使用三通道已报告的最大实际离线时长，验证先心跳后领取仍能生成正确回执。
3. 响应装配：`replay` 字段透传（**不写入幂等日志**）。
4. `StoredOutcome.result` 保持轻量（不含 battle）。

**验收**：`tests/unit/server/idle-authority.test.ts` 重写（服务端载入与动作使用同一账本、余数写回）；`tests/unit/server/action.test.ts` 补「挑战类动作的幂等重放不重复发奖」。

### M4 · 表现层

**落点**：`src/presentation/components/StageDetailModal.vue`（新）、`src/presentation/views/StageDetailView.vue`、`src/presentation/views/ExpeditionView.vue`、`src/presentation/views/DungeonView.vue`、`src/presentation/App.vue`、`src/presentation/stores/game.ts`

1. `StageDetailModal.vue` 抽离自现 `StageDetailView.vue`；`StageDetailView.vue` 变薄壳（深链保活）。
2. 推征页接入首胜引导、结算后挑战下一关、三通道一键领取、副本直达和关卡详情弹窗。
3. 副本页接入由配置驱动的关卡列表、通关状态、挑战和挂机设置，完整 24 关在 M5 标定后验收。
4. `App.vue` 离线结算弹窗改三通道分段。
5. `stores/game.ts`：`setIdleTarget` → `setIdleChannel`；新增 `challengeStage` / `challengeDungeon`；`offlineReport` 类型更新。

**验收**先走通首关与两个副本样例的挑战、结算、全领和深链。全量 E2E 用例见 §5.2。

### M5 · 数值工具适配、副本标定与基线重跑

**落点**包括副本关卡配置、`tools/balance/*.ts`、`tools/validate-config.ts` 和 `tools/perf/long-hang.ts`。

1. `dungeon-loop.ts` 改为三通道并行模型（见 3.9）。
2. 补齐 24 个副本关卡，新增 `tools/balance/recalibrate-dungeon.ts` 标定全部关卡的
   `SCALE_ANCHORS` / `POWER_ANCHORS` / `DESIGN_LEVELS`（见 3.2.1 ④），
   并把结果写回 `core/config/economy.ts` 的 `DUNGEON` 常量块（标定值禁止手填）。
3. `newplayer.ts` / `recalibrate.ts` 适配手动挑战驱动。
4. `report.ts` / `validate-config.ts` / `long-hang.ts` 适配
   （`validate-config.ts` 新增：24 关配置齐全、敌人存在、段间单调、产量登记）。
5. **重跑基线**：`npm run balance` / `balance:newplayer` / `balance:recalibrate` /
   `balance:recalibrate:dungeon` / `balance:report` / `balance:rates`。
6. 若关卡曲线因「手动推进」而失配 → 用 `npm run balance:recalibrate` **重新标定**锚点（禁止手填，铁律 #41）。
7. 输出一张**副本 vs 主线门槛对照表**（副本关卡门槛 vs 同档主线门槛），供策划核对两条线的相对难度。

**验收**包括首日和 40 日报告、手动与挂机按资源拆分的投放、逐章回收比与成长阶梯，以及同难度五行副本用多种阵容测试的可达性。锚点重标定时附调整前后对照表。

### M6 · 文档与收尾

1. `artifacts/plan.md` §5.7 重写（离线曲线 → 三通道账本 + 副本独立关卡）、§4 核心循环图更新、§12 实施修正补记。
2. `AGENTS.md`：新增 / 修订铁律（三通道独立账本、挂机不跑战斗、首通只在手动挑战发放、战斗回放不进幂等日志、副本锚点必须标定）。
3. 截图工具 `tools/capture/screenshot.ts`：新增 `--dungeon-challenge` 场景；`--stage` 场景改走弹窗。
4. `npm run check` + 全量 E2E 全绿。

---

## 5. 后续实施的测试与验收标准

### 5.1 新增 / 重写的单测

| 文件 | 覆盖 |
|---|---|
| v11 存档与公开投影相关单测 | 新建账本、导入重置、异常字段处理、公开快照及导出省略随机状态 |
| `tests/unit/dungeon-stages.test.ts`（新） | 副本 24 关配置齐全、关卡 id 唯一、段间缩放 / 门槛单调、每关产量与变体材料一致、挑战一次即通关 |
| `tests/unit/idle.test.ts`（重写） | 曲线、通道独立、余数、空预算、扣账 |
| `tests/unit/idle-authority.test.ts`（重写） | 分批与一次领取逐通道一致、时钟回退、目标切换、关闭再开启、心跳后离线报告 |
| `tests/unit/idle-channel.test.ts`（重写自 `idle-target`） | 通道目标校验（已通关主线关卡 / 已通关副本关卡）、切换即时生效 |
| `tests/unit/challenge.test.ts`（新） | 主线首胜三项奖励（含未掷出经验书时的保底）、复战基础掉落、跳关拒绝、副本首胜及复战材料、战败结果 |
| `tests/unit/dungeons.test.ts`（扩） | `runDungeonLevel` 口径、`dungeonUnlocked` 不变 |
| `tests/unit/server/action.test.ts`（扩） | 挑战类动作幂等重放不重复发奖 |
| `tests/unit/server/idle-authority.test.ts`（重写） | 服务端与动作同账本 |
| `tests/unit/dungeon-loop.test.ts`（重写） | 三通道并行模型 |

### 5.2 E2E

| 文件 | 覆盖 |
|---|---|
| `tests/e2e/battle.spec.ts` | 关卡详情弹窗与深链、基础掉落与首通追加预览、首胜与复战结算 |
| `tests/e2e/dungeon.spec.ts` | 副本首胜与复战材料到账、首胜后设置通道、未通关不能挂 |
| `tests/e2e/relic.spec.ts` | 新档从独立入口取得首件遗物，解锁初阶强化副本，再领强化石 |
| `tests/e2e/growth.spec.ts` | 主线首胜 → 挂机获取经验书 → 喂经验书 → 消耗银两突破；Lv59 前置用 v11 `save.import` 建立 |
| `tests/e2e/smoke.spec.ts` | 首屏导航、三通道卡片、面板只有一个「全部领取」入口 |

> ⚠ E2E 必须走真实「上线 → 心跳 → 领奖」序列（铁律：不得直接改 `save.idle.measuredAt` / `activeUntil`）。

### 5.3 验收口径

1. `npm run check` 全绿（配置校验 / 禁用词扫描 / 全量单测 / 类型检查 / 构建）。
2. 全量 E2E 全绿。
3. 执行 `npm run balance` / `balance:newplayer` / `balance:recalibrate` / `balance:recalibrate:dungeon` / `balance:report`，对照 §3.9 与 M5 的数值口径验收。
4. 人工验收清单：
   - 挂机结算通过配置掷奖，战斗执行只由挑战动作触发。
   - 点击「全部领取」同时结算三路，结算明细与背包增加量一致。
   - 主线通道只能选已通关关卡；未通关的「设为挂机目标」按钮禁用。
   - 主线首次手动胜利三种奖励到账，复战和挂机只走基础掉落。两个副本每次手动胜利各发一份材料。战败不发挑战奖励，重放同一请求不重复入账。
   - 副本页展示 24 个独立关卡，各有通关状态 / 门槛 / 产量；未通关不能挂机。
   - 关卡详情为弹窗（URL 不变），深链 `/stage/:id` 仍可用。
   - 推征页可直达技能副本和强化副本。用弱首抽阵容验证编队至首胜、首胜至首次领取，以及首件遗物至强化副本的起步流程。

---

## 6. 风险与未决事项

### 6.1 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **主线手动推进的操作量** | 310 关至少需要 310 次成功挑战 | 实测首章和一个中期章节的连续操作耗时、挑战数与重试，再修正 M5 会话模型 |
| R2 | **并行挂机叠加手动投放** | 材料、银两和经验书的产出与消耗可能失衡 | 按资源拆分手动和挂机来源，先检查超标通道与资源，再调整投放 |
| R3 | **战斗回放体积**（3.7） | 若把 `BattleResult` 存进幂等日志，SQLite 日志表暴涨 | 已用 `replay` 非持久化字段规避；需在 M3 实测回包大小 |
| R4 | **大改动面**：core 存档 + 动作 + 服务端 + 表现层 + 工具 + 测试同时改 | 回归面大 | 按 M1→M6 顺序推进，每步 `npm run check`；core 先于表现层 |
| R5 | **首件遗物依赖独立入口** | 新档缺少第一件遗物时，初阶强化副本无法开启 | 完整养成链路验收必须覆盖首件遗物 → 初阶强化副本 → 强化石 |
| R6 | **`dungeon-loop.ts` 的理性玩家模型重写**（F4） | 数值工具可能与真实游戏对不上 | 工具口径与 core 动作层共用同一套函数（铁律 #4）；M5 必须用新模型重跑全部基线 |
| R7 | **首胜前无法挂机** | 弱首抽阵容可能迟迟拿不到第一笔主线产出 | 用初始经验书与银两验证弱阵容首胜，并测试界面的养成引导与再次挑战 |
| R8 | **副本 24 关的配置与标定是新工作量**（D9 / D10） | 24 关 × (敌人组合 + 锚点 + 门槛 + 产量) 全部要配；标定工具是新建的 | 标定工具与主线同款（复用 F15 的二分与参考队伍）；24 关配置集中在 `core/config/dungeons.ts` 一份，不散落 |
| R9 | **同难度的副本实际胜率不一致** | 不同五行的队伍可能在同一养成阶段拿不到所需材料 | 对照主线与副本门槛，多阵容验证同难度五行关卡的可达性 |

### 6.2 后续设计与标定事项

| # | 未决 | 默认处理 |
|---|---|---|
| U1 | **手动挑战速率**（每会话尝试次数） | 以 20 次为中档，加入低频和高频模拟，再用首章与中期实测校正 |
| U2 | **副本关卡的「通关」定义** | 打赢该关**一场**真实战斗即通关（D9：`(变体 × 难度) = 1 关`） |
| U3 | **独立遗物入口的玩法与投放** | 另行设计，须满足 §1.3 的首件遗物可达性要求 |
| U4 | **主线通道默认跟随最新通关关卡时，玩家能否改挂旧关** | 能（可挂任意已通关关卡，含 BOSS）。`stageId = null` 表示「跟随最新」 |
| U5 | **挂机通道开关** | 技能和强化可关，主线首胜后保持开启 |
| U6 | **经济是否需要同步收紧** | 首轮按 §3.4 的现有数量与曲线模拟。M5 如发现投放失衡，优先调整对应资源或通道 |
| U7 | **副本 24 关的设计等级阶梯**（`DUNGEON.DESIGN_LEVELS`） | 默认：难度段 = 主线第 1 / 4 / 8 章的目标等级（Lv24 / Lv96 / Lv192）；段内 8 关按变体顺序在「段起点 ~ 段终点」等比铺开；强化副本 tier2 / tier3 按解锁线向上取整到最近的 24 级档。M5 标定时按实测调整 |
| U8 | **副本关卡的敌人组合** | 复用现有 30 只敌人的子集，不新增敌人（见 3.2.1 ③）；元素主题仍只体现在产出材料上。若实测某关难度失真 → 回标定工具，不改敌人表 |

---

## 7. 后续实施的受影响文件（预估）

**core**：`core/model/types.ts`、`core/save/schema.ts`、`core/save/import-validation.ts`、`core/save/serialize.ts`（投影确认）、`core/config/economy.ts`（新增 `IDLE.SECONDS_PER_ROLL` 与 `DUNGEON` 锚点块）、`core/config/dungeons.ts`（**新增 24 关定义表**）、`core/config/tasks.ts`、`core/systems/idle.ts`、`core/systems/actions.ts`、`core/systems/action-protocol.ts`、`core/systems/dungeons.ts`（重写）、`core/systems/tasks.ts`（若有）

**server**：`server/src/game/service.ts`

**presentation**：`presentation/components/StageDetailModal.vue`（新）、`presentation/views/StageDetailView.vue`、`presentation/views/ExpeditionView.vue`、`presentation/views/DungeonView.vue`、`presentation/App.vue`、`presentation/stores/game.ts`、`presentation/router.ts`（仅在需要时）

**tools**：`tools/balance/{dungeon-loop,newplayer,recalibrate,report}.ts`、`tools/balance/recalibrate-dungeon.ts`（**新增**）、`tools/validate-config.ts`、`tools/perf/long-hang.ts`、`tools/capture/screenshot.ts`

**tests**：`tests/unit/{idle,idle-authority,idle-target→idle-channel,dungeon-loop,dungeons,dungeon-stages,challenge,server/action,server/idle-authority}.test.ts`、`tests/e2e/{battle,dungeon,relic,growth,smoke}.spec.ts`

**docs**：`artifacts/plan.md`、`AGENTS.md`

---

## 8. 实施守则（继承项目铁律）

- **`src/core/` 零 DOM / 零平台 API**；时间经 `ctx.now`、随机经 `ctx.rng` 注入。
- **所有改存档的动作**走 `core/systems/actions.ts` 纯函数，服务端执行；客户端只发意图。
- **数值常量只进 `core/config/economy.ts`**；本次新增 `IDLE.SECONDS_PER_ROLL` 与 `DUNGEON` 锚点块，删除 `BATTLE.SECONDS_PER_BATTLE`（不做别名）。
- **难度锚点只由标定工具产出**（主线 `balance:recalibrate` / 副本 `balance:recalibrate:dungeon`），禁止手填（铁律 #41）。
- **关卡 id 只有一个出处**：副本关卡 id 由 `core/config/dungeons.ts` 的索引函数产出，表现层与动作层不得自行拼接（铁律 #3 / #8）。
- **收益入库只认 `rewards`**（铁律 #26）。奖励预览与实际结算共用配置，结算回执从实发奖励生成。
- **表现层不得自推导战斗事实 / 掉落口径 / 通道状态**：一律取 core 与服务端回包。
- **心跳保持轻量**（铁律 #33）。
- **战斗回放是时间的纯函数**（铁律 #20）：本次不改变 `battle-timeline.ts`，只改「回放数据从哪来」。
- **禁用词表只改 `src/content/compliance/forbidden-words.md`**。
