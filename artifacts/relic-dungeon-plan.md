# 遗物副本设计（存档 v12 · 遗物来源从「银两祈愿」改为「遗物副本」）

> **本文件 = 已批准的设计稿 + 实施落地记录**。
> 设计部分（§1~§6）是 2026-11-25 用户拍板后的原文；§9「实施落地记录」
> 记录实际实现与原文的**差异点**（以实现为准，原文保留以说明「为什么这样定」）。
> 铁律口径见 `AGENTS.md` #59 / #64 / #65；总纲见 [`plan.md`](plan.md)。

## Summary

把遗物的获取途径从「花 5000 银两祈愿」整体换成**专属的遗物副本**：12 个遗物套装两两配对成 6 个副本变体，每个变体 3 档难度 = 18 个独立关卡；遗物副本同时是**第 4 条挂机通道**（与主线 / 技能副本 / 强化副本并列），但挂机产出受**每日额度**约束；祈愿入口与动作彻底下线。

**用户已拍板的三条决定**（2026-11-25）：

1. 遗物副本**支持挂机**（新增第 4 条挂机通道）；
2. 副本规模为 **6 副本 × 3 难度 = 18 关**（与现有副本完全同构）；
3. 「花银两祈愿遗物」**彻底下线**（删动作、删界面、改铁律）。

**关键设计决策**：

- **遗物副本的掉落是零成本的**（不消耗银两 / 结晶），而遗物自动分解会折算成**银两**（`core/systems/inventory.ts:78-83`）。若不加约束，挂机可无限产遗物 → 仓库溢出 → 自动分解 → **银两无限通胀**。因此**每日额度是这套设计的必需件，不是可选项**。
- 难度差异体现在**每场产出件数**（easy 1 / normal 1~2 / hard 2~3），**不**体现在稀有度权重：每个副本覆盖的 2 个套装共 10 件，其稀有度是**定义固定的**（每套 1 SSR + 1 SR + 2 R + 1 N），难度无法改变。若让难度改稀有度，easy / normal 会因"打不过就不如 hard"而变成死内容。
- **保底**（每副本累计 10 次未出 SSR 则下次必出 SSR）是必需的：否则集齐一套 5 件的期望场次高达 ~100 场，遗物线会卡死在"永远差一点"。
  > **实施口径修正**：保底最终按**「件」**计（不是按「场」）——
  > 一件遗物 = 一次抽签 ⇒ 「连续 10 **件**未出 SSR ⇒ 第 11 件必出 SSR」，
  > 且计数**逐件**累加 / 归零（一次掉 3 件就可能把计数推满 3）。见 §9.2。
- **遗物本体不是瓶颈，强化石才是**：强化 Lv200 × 216 个装备位 = 8.6 万个强化石，只能从强化副本来。所以遗物产出可以相对宽松。

---

## 1. 背景：现在为什么拿不到遗物

挂机改版 v11（提交 `e132959`）把遗物**移出了掉落表**，遗物改由独立入口 `relic.acquire`（祈愿）产出。该入口在 core 动作层、动作协议、服务端、store 四层都已实现，**但表现层没有按钮**——2026-11-24 已修复界面入口（背包 → 遗物 → 遗物祈愿面板）。

本次改造把这个入口**整体换成副本**，理由：

- 祈愿是**纯消耗**（5000 银两换 1 件），没有战斗、没有目标感，玩家只是反复点按钮；
- 祈愿产出**完全随机**（SSR 3%），且**与玩家想要的套装无关**——凑齐一套 5 件的期望场次/花费极高；
- 遗物是最大的乘区来源（zone 'relic'），值得一个**有场景、有门槛、有目标**的获取场景。

## 2. 范围与非目标

### 在范围内

- 新增 6 个「遗物」副本变体 × 3 难度 = 18 个独立关卡（锚点表 24 → 42，整表重跑标定）；
- 遗物作为**第 4 条挂机通道**（`IdleChannelKind` 扩到 4），带每日额度；
- 掉落模型：稀有度权重 + 保底 + 每日额度；
- 祈愿动作 / 界面 / 配置 / 铁律全部下线；
- 存档 `v11 → v12` 迁移。

### 不在范围内（明确不做）

- **不做**遗物副本次序关卡体（每副本每难度 1 关，不做多波次）——沿用现有「(变体 × 难度) = 1 关」口径；
- **不做**新的遗物套装 / 遗物定义（仍是 12 套 × 5 件 = 60 件）；
- **不做**遗物强化曲线 / 分解价值的改动（`RELIC` 配置不动）；
- **不做**每日签到 / 任务 / 竞技场等其它来源的遗物投放（遗物只从副本来，铁律 #59 改写后仍然成立）；
- **不做**副本扫荡券 / 门票等新货币（每日额度已足够约束产出）。

## 3. 现状与受影响面（实现前必读）

### 3.1 副本体系现状

| 事实 | 出处 |
|---|---|
| 副本 = `(变体 × 难度) = 1 关`，共 8 变体 × 3 难度 = 24 关 | `src/core/config/dungeons.ts:312-334` |
| 变体顺序 `DUNGEON_VARIANT_ORDER` 是锚点表的下标基准 | `dungeons.ts:229-238` |
| 锚点下标公式：`难度段序 × 变体数 + 变体内下标`（难度段优先） | `dungeons.ts:319` |
| `DUNGEON.SCALE_ANCHORS` / `POWER_ANCHORS` / `DESIGN_LEVELS` 均为长度 24 的位置数组 | `src/core/config/economy.ts:882-918` |
| `DungeonStageDef.drop` 是必填 `{ itemId: ItemId; min; max }` | `dungeons.ts:225` |
| `DungeonVariant.itemId` 是必填 `ItemId` | `dungeons.ts:58` |
| 副本挑战只发 `rewards.items`（1 个键），无遗物 / 银两 / 结晶 | `src/core/systems/actions.ts:944-952` |
| 解锁判定按 `variant.kind` 二分：`enhance` 看遗物等级，`skill` 看五行英灵 | `src/core/systems/dungeons.ts:60-102` |

### 3.2 遗物体系现状

| 事实 | 出处 |
|---|---|
| 12 套 × 5 件 = 60 件；每套 1 SSR + 1 SR + 2 R + 1 N | `src/core/config/relics.ts:41-246` |
| 套装效果 2 / 4 / **6** 件阶梯 | `src/core/config/relics.ts` 各 `bonuses` |
| 套装件数按**实例**计数 ⇒ 同 defId 的多件可分别装备 ⇒ **6 件档可达** | `src/core/systems/relic.ts:175-193` + `src/core/systems/loadout.ts:45-58` |
| `rewards.relics?: string[]`（遗物 defId 列表）类型已存在 | `src/core/model/types.ts:517` |
| `applyRewardBundle` 已支持 `rewards.relics` 入库（`save.relics.push(generateRelic(...))`） | `src/core/systems/actions.ts:524-532` |
| ⚠ 但该分支**提前 `return`**（跳过 `rewards.heroes` 分支）且遗物等级**硬编码 1** | `actions.ts:528, 532` |
| 仓库上限 3000，溢出自动分解**折算银两** | `src/core/systems/inventory.ts:58-89` |

### 3.3 挂机体系现状（加第 4 条通道的连带面）

| 事实 | 出处 | 风险 |
|---|---|---|
| `IdleChannelKind = 'main' \| 'skill' \| 'enhance'` | `src/core/model/types.ts:594` | 需加 `'relic'` |
| `IdleChannelTarget` 是三成员联合类型 | `types.ts:622-625` | 需加 `{ kind: 'relic'; dungeonStageId: string }` |
| `save.idle.channels` 是**字面量三键**类型 | `types.ts:763-767` | 需改四键 |
| `normalizeSave` 的通道段**硬编码三通道**（不是循环 `IDLE_CHANNEL_KINDS`） | `src/core/save/schema.ts:591-599` | ⚠ 漏改 ⇒ 该通道账本每次载入被**静默重置** |
| `createNewSave` 的通道段硬编码三通道 | `schema.ts:379-389` | 需改四键 |
| `createChannelRng` / `normalizeChannelRng` **循环 `IDLE_CHANNEL_KINDS`** | `schema.ts:41-48, 57+` | ✅ 自动跟上第 4 条序列 |
| `resolveChannelTarget` 里 `if (kind !== 'enhance') return null` | `src/core/systems/idle.ts:138` | ⚠ `kind='relic'` 命中 ⇒ **目标被静默清空**且不报错 |
| `rollChannelRewards` 只二分 main / dungeon | `idle.ts:222-225` | 需加 relic 分支（产实例而非堆叠物） |
| `settleIdleChannels` 里目标失效会 `ch.target = null` | `idle.ts:414-417` | ⚠ 额度用满**不能**走这条路，否则玩家每天要重设目标 |
| `actionIdleSetChannel` 校验 `variant.kind !== kind` | `actions.ts:799-802` | 需认识 `'relic'` |
| 表现层：推征页三条通道卡、通道名映射、store 硬编码数组 | `ExpeditionView.vue:92-127`、`App.vue:109`、`stores/game.ts:634` | 需改四处 |

### 3.4 祈愿现状（待下线）

| 位置 | 内容 |
|---|---|
| `src/core/config/economy.ts:406-431` | `RELIC_ACQUIRE`（`SILVER_COST: 5_000` + `RARITY_WEIGHTS`） |
| `src/core/systems/actions.ts:972-1004` | `actionRelicAcquire`（扣费 → 抽签 → 入库） |
| `src/core/systems/actions.ts:1006-1022` | `rollRelicDefId`（本次已改为读 core 唯一概率表） |
| `src/core/systems/relic.ts` | `relicAcquireRarityRates()` / `RELIC_RARITY_ORDER` |
| `src/core/systems/action-protocol.ts:221-222` | `case 'relic.acquire'` |
| `src/presentation/components/RelicWarehouse.vue` | 「遗物祈愿」面板（2026-11-24 刚加） |
| `tools/balance/newplayer.ts:665-673` | 模拟里每 chunk 祈愿 1 件并自动装备 |
| `AGENTS.md:948` | 铁律 #59「遗物只有一个获取入口，掉落表里不得再有遗物」 |

### 3.5 加 6 个变体必炸的 5 个点

1. **锚点表整体错位**：变体数 8 → 14，每难度段 8 → 14 关，锚点表 24 → **42**，且**旧下标全部平移**（`normal/skillGold` 由 8 变 14）。必须**三张表整表重跑**（`npm run balance:recalibrate:dungeon`），旧值一个都不能留。
2. **`DUNGEON_PLACE_NAMES` 只有 8 个地名**（`dungeons.ts:269-273`），`slot ≥ 8` 时关卡名会变成字面量 `undefined`——**TypeScript 不会报错**（类型是 `readonly string[]` 而非元组）。必须扩到 14。
3. **`DUNGEON_ENEMY_SETS` 是 `Record<DungeonVariantId, readonly string[]>`**（`dungeons.ts:257-266`），新变体漏登记会**编译失败**——这是好护栏，照着补 6 条即可。
4. **`DUNGEON.DESIGN_LEVELS` 不由标定脚本写回**（`recalibrate-dungeon.ts:133` 只读不写），42 个设计等级要**手工**补 18 个新值（外生常数，不能用模拟涌现值，否则形成坏不动点）。
5. **长度断言要跟着改**：`tools/validate-config.ts:824-831, 871-880`（关卡数 / 三表长度）+ `tests/unit/dungeons.test.ts:83-85, 94, 114-116, 169`（24 → 42）。

### 3.6 「遗物只从副本来」会失效的测试

| 文件 | 断言 | 处理 |
|---|---|---|
| `tests/unit/drop-table.test.ts:170-258` | 祈愿整组（扣费 / 余额不足 / uid / 分布 / 公示表） | **删除**，替换为遗物副本掉落组 |
| `tests/e2e/relic.spec.ts:141-166` / `168-184` / `196-229` | 祈愿 3 例（含「祈愿按钮在界面上」） | **改写**为「遗物副本入口在界面上」 |
| `tests/e2e/dungeon.spec.ts:294-296` | 用 `relic.acquire` 拿第一件遗物以解锁强化副本 | 改为**打遗物副本**拿第一件 |
| `tests/unit/dungeons.test.ts` + `tests/e2e/dungeon.spec.ts:82-117` | 变体 8 / 关卡 24 / skill 15 / enhance 9 | 改为 14 / 42 / skill 15 / enhance 9 / relic 18 |
| `tests/unit/idle.test.ts:149-155` | 通道明细 3 条 | 改为 4 条 |
| `tests/unit/idle-pending.test.ts:114` | 心跳回执 `{main,skill,enhance}` 精确相等 | 加 `relic` 键 |
| `tests/unit/idle-authority.test.ts:286-289` | 三通道计数器各自前进 | 扩到四通道 |
| `tests/e2e/authority.spec.ts:146-153` | 篡改三条通道目标 | 加 `relic` |
| `tests/e2e/idle.spec.ts:41` | 通道种类联合类型写死 | 加 `'relic'` |
| `tests/e2e/dungeon.spec.ts:170-176` | 副本奖励只有材料、`rewards.relics` 须为 undefined | **改写**：遗物副本必须发遗物、材料副本必须不发 |
| `tools/capture/screenshot.ts:1094-1140` | 截图按「15 / 9 关」断言 | 数字走 core 自动跟随，但注释里的「合计 24 关」要改 |

## 4. 目标设计

### 4.1 套装配对表（6 个遗物副本）

按**定位互补**配对，让每个副本里的 2 个套装覆盖不同属性维度，玩家按需求选副本：

| # | 副本 id | 副本名 | 套装 A | 套装 B | 覆盖维度 | 候选遗物 |
|---|---|---|---|---|---|---|
| 1 | `relicZhanTan` | 锋锐遗窟 | 战神（攻/暴/暴伤） | 探破（暴/暴伤） | 纯输出 | 10 |
| 2 | `relicJiYing` | 疾影遗窟 | 冰界（速/暴） | 青冥（速/暴） | 速度 | 10 |
| 3 | `relicJianBi` | 坚壁遗窟 | 疆土（防/血） | 玄武（防/血） | 生存 | 10 |
| 4 | `relicShengXi` | 生息遗窟 | 回春（治疗/血） | 生命（血/抗性） | 续航 | 10 |
| 5 | `relicLingDong` | 灵动遗窟 | 机括（攻/异常） | 灵气（速/攻） | 攻速 | 10 |
| 6 | `relicJunHeng` | 均衡遗窟 | 尚战（全属性） | 六合（全属性+速） | 通用 | 10 |

> 副本 1 必须**最早就可达**（见 4.6）：它是「首件遗物」的来源，而初阶强化副本要求持有 Lv1 遗物才解锁 ⇒ 遗物副本必须先于强化副本可达，否则整条强化链锁死（这正是 2026-11-24 那次故障的成因）。

### 4.2 副本结构

- `DungeonKind` 扩为 `'skill' | 'enhance' | 'relic'`；
- `DungeonVariantId` 增加 6 个上表 id；`DUNGEON_VARIANT_ORDER` 追加在**技能 5 个之后、强化 3 个之前**还是**末尾**？→ **放末尾**（追加），理由：现有 24 个锚点下标**在 easy/normal 段不变**（`slot < 8` 不动），只有 `normal` / `hard` 段平移，重跑标定时差异最小、diff 最易读；
- 每副本每难度 1 关 → **新增 18 关，总计 42 关**；
- `DungeonStageDef` 增加遗物产出字段（见 4.3），材料字段保持不变；
- 敌人组合复用现有 30 只敌人库（铁律：不新增敌人），新增 6 组：

| 副本 | 敌人组合（3 难度共用） | 地点名（easy / normal / hard） |
|---|---|---|
| 锋锐 | `illusion` + `void_echo` | 断兵坑 / 锋刃祭坛 / 万刃刑场 |
| 疾影 | `dream_weaver` + `illusion` | 掠影径 / 疾风回廊 / 无踪之座 |
| 坚壁 | `ice_guard` + `dust_shade` | 残垣垒 / 铁壁回廊 / 不破之壁 |
| 生息 | `thorn_beast` + `wanderer` | 苗圃窟 / 涌泉之庭 / 长生之坛 |
| 灵动 | `spark_wisp` + `frost_wraith` | 齿轮窖 / 轮转工坊 / 万机之心 |
| 均衡 | `star_shard` + `void_mirror` | 观测台 / 均衡之庭 / 万象中枢 |

### 4.3 掉落模型

**产出单位 = 遗物实例**（走 `rewards.relics`，最终由 `applyRewardBundle` 入 `save.relics`）。

每次胜利：

1. **数量**：按难度取 `easy 1 / normal 1~2 / hard 2~3` 件；
2. **稀有度**：抽 `N` 档概率 → 再在该副本 10 件候选里、该稀有度的候选里**等概率**抽 1 件具体遗物；
3. **保底**：该副本累计挑战次数达阈值且本场未出 SSR ⇒ 本场必出 SSR。

**稀有度权重表**（唯一出处 `economy.ts` 的 `RELIC_DROP.RATES`，公示 = 实际）：

| 难度 | N | R | SR | SSR |
|---|---|---|---|---|
| 简易 easy | 45 | 35 | 15 | 5 |
| 普通 normal | 45 | 35 | 15 | 5 |
| 困难 hard | 45 | 35 | 15 | 5 |

> 三档**权重相同**：难度差异只体现在「件数」与「门槛」。理由见 Summary——每件遗物的稀有度由套装定义固定，难度无法改变；若让难度改稀有度，easy/normal 会因「打不过就不如 hard」变成死内容。玩家在每个副本内面对的是**同一张概率表**，公示只需 3 档（实际 1 档）。

**为什么权重比原祈愿的 SSR 3% 高到 5%**：祈愿要花 5000 银两（≈一件遗物的强化成本），副本产出零成本；同时引入保底（见下）把长尾拉回来。但**遗物本体不是瓶颈**（强化石才是），所以宽松一点是安全的。

**保底**（`RELIC_DROP.PITY_SSR`）：

- 每个遗物副本各自计数：`累计挑战次数` 与 `连续未出 SSR 次数`；
- 连续未出 SSR 达 **10** 次 ⇒ 下一次胜利**必出 SSR**（该副本内随机 2 件 SSR 之一）；
- 保底计数**随存档落盘**（新增 `save.relicPity`），跨设备一致（铁律 #11 / #24）；
- 保底触发后计数器归零。

### 4.4 挂机第 4 通道 + 每日额度

**通道**：`IdleChannelKind` 增加 `'relic'`；遗物通道的目标是一个**已通关**的遗物副本关卡（与技能 / 强化通道同规则：未通关不能挂）。

**掷奖**：遗物通道每次掷奖产出**遗物实例**（与手动挑战同一套掉落函数，同一份概率表、同一个保底计数）。

**每日额度**（防通胀的核心闸门）：

- `RELIC_DROP.DAILY_CAP`（初值 **15 件/天**）：遗物通道**每天最多产出** 15 件；
- 额度记在 `save.relicDaily = { date: string; count: number }`，`date` 由 `ctx.now` 推导（core 不读时钟，铁律 #1）；
- 跨日自动重置（`date !== today` ⇒ `count = 0`）；
- **手动挑战不受每日额度限制**（主动行为，逐场结算，耗时换产出）→ 给「肝但自由」的出口；
- 额度用满时的语义**必须是「暂停产出」，不是「目标失效」**：`settleIdleChannels` 里目标失效会 `ch.target = null`（`idle.ts:414-417`）——若把「额度用满」误判成目标失效，玩家**每天都要重设一次通道目标**。因此：
  - 遗物通道的**待结算次数** = `min(rollsFromEffectiveMs(effectiveMs), 剩余额度)`；
  - 剩余额度为 0 时，待结算次数 = 0 ⇒ 界面写「0 次」，**不骗人**（铁律 #62：按钮写的次数 ≤ 实发次数）；
  - 结算时只掷 `min(次数, 剩余额度)` 奖，**未掷出的预算不扣**（`effectiveMs` 只扣实际掷掉的次数）⇒ 额度恢复后继续，不会「白烧预算」。

**挂机时的产出量级核算**：挂机每通道每天有效时长封顶 3 小时（`IDLE.CAP_HOURS`），掷奖间隔 6 秒 ⇒ 每天最多 1800 次掷奖。遗物通道被每日额度 15 件封顶 ⇒ 挂机每天最多 15 件遗物（其余掷奖不产遗物）。集齐 60 件（12 套 × 5 件）纯挂机需 4 天，配合手动挑战与强化石节奏合理。

**为什么必须有额度（通胀论证）**：遗物是**零成本**产出 ⇒ 仓库（上限 3000）迟早溢出 ⇒ `enforceInventoryCap` 把最没用的件**自动分解并折算银两**（`inventory.ts:78-83`）⇒ 银两无限进账 ⇒ 经济通胀。没有额度，遗物副本挂机就是一个印钞机。

### 4.5 祈愿下线

**core / 服务端**：

- 删除 `RELIC_ACQUIRE`（`economy.ts:406-431`）与 `actionRelicAcquire`、`rollRelicDefId`、动作注册（`actions.ts:2065`）、`ActionResultMap['relic.acquire']`、`GameAction` 里的 `'relic.acquire'` 分支；
- 删除 `action-protocol.ts:221-222` 的 `case 'relic.acquire'`；
- `core/systems/relic.ts` 的 `relicAcquireRarityRates()` 改为 `relicDropRates(difficulty)`（读 `RELIC_DROP.RATES`），档序常量改为 `['N','R','SR','SSR']` 保留；
- `tools/balance/newplayer.ts:665-673` 的「每 chunk 祈愿 1 件」改为「打遗物副本拿 1 件」。

**表现层**：

- 删除 `RelicWarehouse.vue` 的「遗物祈愿」面板；
- 仓库空态文案改回指向遗物副本，并给**直达按钮**（`/dungeon?kind=relic`）；
- 背包的遗物分类加「去遗物副本」入口。

**铁律**：AGENTS.md #59 改写为「遗物只从遗物副本获得（掉落表里不得再有遗物，祈愿已下线）」，并补一条「遗物副本的每日额度是防通胀闸门，不可省」。

**银两回收阀**：祈愿下线后银两少了一个出口。遗物强化（500 银两/级 × 200 级 × 最多 216 个装备位 ≈ 2160 万）仍是长期黑洞，境界突破 / 技能升级也在吃银两，前期银两偏多是正常现象（没东西可花）。**数值结论：不需要额外的银两回收阀**，但要在 `npm run balance:report` 的回收比口径里把祈愿这一项**删掉**（否则报表按银两收入 ÷ 5000 折算遗物供给，会得出错误的供给数字）。

### 4.6 解锁线

遗物副本按**主线进度**逐个解锁（不能挂在遗物上——会与强化副本形成循环依赖）：

| 副本 | 解锁条件 | 设计意图 |
|---|---|---|
| 锋锐（战神+探破） | 主线通关第 **1** 关 | 首件遗物极早可达 ⇒ 初阶强化副本可解锁 |
| 疾影（冰界+青冥） | 主线通关第 **5** 关 | 玩家拿到第一套 2 件效果 |
| 坚壁（疆土+玄武） | 主线通关第 **15** 关 | 推图中期，出口支撑 |
| 生息（回春+生命） | 主线通关第 **30** 关 | 第 2 章末 |
| 灵动（机括+灵气） | 主线通关第 **50** 关 | 第 5 章前后 |
| 均衡（尚战+六合） | 主线通关第 **70** 关 | 后期通用套装 |

> ⚠ 「主线通关第 1 关」意味着**新号打完第 1 关就能进第一个遗物副本**。该副本 easy 档的 `DESIGN_LEVELS` 必须定在**玩家第一关时的养成水平**（Lv1~2），否则新号进去必输 ⇒ 首件遗物拿不到 ⇒ 整条链又锁死。**这条是本次改造的最大卡点，验收时必须实测新号进第一个遗物副本能打赢。**

### 4.7 存档 v11 → v12

**新增字段**：

| 字段 | 类型 | 用途 |
|---|---|---|
| `save.idle.channels.relic` | `IdleChannelState` | 第 4 条挂机通道账本 |
| `save.rng.channels.relic` | `ChannelRngState` | 第 4 条通道的独立随机序列（`createChannelRng` 循环 `IDLE_CHANNEL_KINDS`，自动生成） |
| `save.relicPity` | `Record<string, number>` | 每个遗物副本的**连续未出 SSR 件数**（key = 副本关卡 id）→ **实施口径**：单一计数器，按「件」计（见 §9.2） |
| `save.relicDaily` | `{ date: string; count: number }` | 当日遗物产出计数（每日额度） |

**迁移链**（照抄 v10→v11 的惯例，`schema.ts:257-296`）：

1. `MIGRATIONS` 增加 `11: (save) => { … }`，`SAVE_VERSION` 改 **12**；
2. `createNewSave` 增加 relic 通道 + 空 `relicPity` + 今日 `relicDaily`；
3. `normalizeSave` **必须补齐** relic 通道（⚠ 这里是硬编码三通道的坑，`schema.ts:591-599`）；
4. `import-validation.ts`：`validateRawChannelTargets` 循环 `IDLE_CHANNEL_KINDS`，自动覆盖 relic；`validateRawDungeonCleared` 自动覆盖新关卡 id；**新增 relic 通道目标必须是合法遗物副本关卡**。

**兼容性注意**：`import-validation.ts:101` 要求导入存档 `version === SAVE_VERSION` ⇒ 升到 12 后 **v11 导出档会被拒**（`IMPORT_INVALID`）。这是既有行为（导入只接受当前版本），不是本次引入的问题，但要在迁移说明与 UI 提示里写明。

### 4.8 表现层改动

| 位置 | 改动 |
|---|---|
| `DungeonView.vue` | 第三个 tab「遗物副本」；`kind` 解析加 `'relic'`；`focusVariant` 支持 `?relic=` 深链；**通道推断不能再用 `startsWith('skill') ? … : 'enhance'`**（`DungeonView.vue:183`），必须查 `DUNGEON_INDEX.get(variantId).kind`；遗物副本卡片显示套装名 + 已收集进度 + 保底进度 |
| `ExpeditionView.vue` | 第 4 条通道卡（遗物）；副本入口卡加第三个 |
| `App.vue:109` | 通道名映射加 `relic → 遗物副本` |
| `stores/game.ts:634` | 硬编码 `['main','skill','enhance']` 改为遍历 `IDLE_CHANNEL_KINDS` |
| `RelicWarehouse.vue` | 删祈愿面板；空态 + 「去遗物副本」直达按钮；**新增「本副本已收集 N/5 件 + 保底进度」区块**（铁律 #27：养成规则要在玩家眼前） |
| `BackpackView.vue` | 遗物分类加「去遗物副本」入口 |

## 5. 数值口径与标定

### 5.1 必须落在 `src/core/config/economy.ts` 的新配置

```ts
export const RELIC_DROP = {
  /** 每个难度档的稀有度权重（唯一出处，公示 = 实际） */
  RATES: { easy: {N:45,R:35,SR:15,SSR:5}, normal: {...}, hard: {...} },
  /** 每场产出件数区间（按难度） */
  COUNT: { easy: {min:1,max:1}, normal: {min:1,max:2}, hard: {min:2,max:3} },
  /** 保底：连续未出 SSR 达此次数，下一次必出 SSR */
  PITY_SSR: 10,
  /** 遗物挂机通道每日产出上限（防通胀闸门） */
  DAILY_CAP: 15,
}
```

> `RARITY_WEIGHTS` 的三档相同 ⇒ 实际只需一份表 + 三档共用，但**结构上仍按难度取**，以便将来按难度分化而不必改调用方。

### 5.2 锚点重跑标定（铁律 #41：锚点禁止手填）

1. 手工补 `DUNGEON.DESIGN_LEVELS` 的 18 个新值（外生设计阶梯，**不用模拟涌现值**）：

```
easy   段（14 个）：1, 2, 2, 4, 6, 10, 72, 144,  ← 现有 8 个不动
                    + 2, 4, 6, 8, 10, 12          ← 遗物 1~6 号
normal 段（14 个）：73, 76, 79, 82, 85, 89, 92, 168, ← 现有 8 个不动
                    + 70, 76, 79, 82, 85, 89
hard   段（14 个）：169, 172, 175, 178, 182, 185, 189, 192, ← 现有 8 个不动
                    + 165, 169, 172, 175, 178, 182
```

> 遗物副本的 3 难度设计等级**刻意贴近**同段技能副本（它们是"刷遗物"的主战场），
> 但**第 1 号副本的 easy 档必须 ≤ 2**（新号可达，见 4.6）。

2. 跑 `npm run balance:recalibrate:dungeon` → 自动产出 42 个 `SCALE_ANCHORS` / `POWER_ANCHORS` 并写回 `economy.ts`；
3. 跑 `npm run validate:config` → 锚点长度 / 单调性 / 段间递增全部自动核对；
4. 跑 `npm run balance:report` 与 `npm run balance:newplayer` → 核对遗物供给（**祈愿那一项要删**，改为「遗物副本产量 ÷ 每日额度 × 天数」）与逐章回收比。

> ⚠ 标定脚本 `recalibrate-dungeon.ts:199, 206` 的格式化按**每行 8 个**换行 ⇒ 42 个值会排成 8/8/8/8/8/2，**不再对齐 14 变体的段界**。建议把格式化改成「按 `DUNGEON_VARIANT_ORDER.length` 每行一个难度段」，否则锚点表会被误读（这是历史上「主线锚点被副本标定冲掉」那类事故的同类风险）。

### 5.3 存量工具适配

| 工具 | 改动 |
|---|---|
| `tools/balance/newplayer.ts:665-673` | 祈愿 → 打遗物副本 |
| `tools/balance/dungeon-loop.ts` | `ChannelPlan` 三元组 → 四元组；`decideChannels` 决策遗物通道；`dungeonExpectedYield` 需支持遗物（实例不是堆叠物，产出按「件数 × 期望稀有度价值」折算） |
| `tools/balance/report.ts:134-145, 280-313, 403-416` | 删「遗物祈愿」供给口径，改「遗物副本」；遗物本体供给 = 每日额度 × 天数 + 手动挑战 |
| `tools/validate-config.ts` | 新增：遗物副本变体必须**没有** `itemId`、必须有 `relicSetIds`；`DUNGEON_DROPS` 不得含遗物；遗物副本的 `relicPool` 必须是其 2 个套装的 10 件；`RELIC_DROP.DAILY_CAP > 0` |
| `tools/capture/screenshot.ts` | 遗物副本场景（点一次挑战 → 看到掉落的遗物 + 套装进度） |

## 6. 实施步骤（分阶段，每阶段可独立验证）

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| **P0 配置层** | `economy.ts` 加 `RELIC_DROP`；`dungeons.ts` 加 `kind: 'relic'`、6 个变体、18 个关卡、敌人组、地名扩到 14、`DungeonStageDef` 加遗物产出字段 | `vue-tsc` 0 错；`validate-config` 报「锚点长度 24 ≠ 42」（**预期**，P1 修） |
| **P1 标定** | 补 18 个 `DESIGN_LEVELS` → 跑 `recalibrate:dungeon` → 42 锚点写回；顺手把脚本的换行宽度改成按变体数 | `validate:config` 全绿；`tests/unit/dungeons.test.ts` 的长度断言改成 42 后全绿 |
| **P2 core 掉落** | `relic.ts` 出 `relicDropRates(difficulty)` + `rollRelicDrop(pool, rarity, rng)` + 保底函数；`actions.ts` 的 `actionDungeonChallenge` 分支发 `rewards.relics`；修 `applyRewardBundle` 的 relics 分支（去掉提前 return、等级用 `RELIC.MIN_LEVEL`） | 新增单测：掉落稀有度分布符合公示、保底第 11 次必出 SSR、扣费/产出各一条路径 |
| **P3 挂机第 4 通道** | `IdleChannelKind` + `IdleChannelTarget` + `types.ts` 四键 + `schema.ts`（`createNewSave` / `normalizeSave`）+ `idle.ts`（`resolveChannelTarget` / `rollChannelRewards` / 额度）+ 每日额度与跨日重置 + `actionIdleSetChannel` | 单测：第 4 通道能设目标、能产出、额度用满时**目标不被清空**、跨日重置；`idle-pending` 心跳回执含 `relic` |
| **P4 存档迁移** | `SAVE_VERSION` 12 + `MIGRATIONS[11]` + `normalizeSave` 补齐 + `import-validation` 校验 | 迁移单测：v11 档升到 v12 后 relic 通道账本存在且计数为 0、导入校验拒绝非法 relic 目标 |
| **P5 表现层** | 副本页第三个 tab + 遗物卡片（套装进度 / 保底进度 / 每日额度）；推征页第 4 条通道；背包空态与入口；`RelicWarehouse` 删祈愿、加套装进度 | 截图验收（360px）：遗物副本页、通道卡、空态引导 |
| **P6 祈愿下线** | 删动作 / 协议 / 配置 / 界面 / 模拟口径；改铁律 #59；改 `tools/balance/report.ts` 供给口径 | `grep -rn "relic.acquire"` 只剩历史文档；相关单测/E2E 已改写 |
| **P7 文档回写** | `artifacts/relic-dungeon-plan.md`（本设计正式稿）+ `artifacts/plan.md`（§5.4 / §12.7.9 / §12.x 改版全貌）+ `artifacts/idle-redesign-plan.md`（§1.3 / §3.1 / U3 结案）+ `AGENTS.md`（铁律 #59 改写 + 新增「每日额度不可省」「遗物副本是遗物唯一来源」两条） | 文档与实现逐条对齐；`npm run check` 全绿 |

## 7. 测试与验收标准

### 7.1 单测（新增）

| 文件 | 用例 |
|---|---|
| `tests/unit/relic-drop.test.ts`（新） | ① 稀有度分布符合 `RELIC_DROP.RATES`（大样本 + 4σ 容差）；② 掉落池恰好是该副本 2 套的 10 件；③ 保底：连续 10 次未出 SSR ⇒ 第 11 次必出 SSR；④ 每场件数在难度区间内；⑤ 产出的 `rewards.relics` 能被 `applyRewardBundle` 入库且 uid 唯一 |
| `tests/unit/dungeons.test.ts`（改） | 变体 14 / 关卡 42 / skill 15 / enhance 9 / **relic 18**；锚点三表长度 42 且逐位对齐；段间单调递增 |
| `tests/unit/idle.test.ts`（改） | 4 条通道各自计量；**遗物通道产出 `rewards.relics`**；**额度用满 → 待结算次数 0 且目标不被清空**；跨日重置 |
| `tests/unit/idle-pending.test.ts`（改） | 心跳回执 `{main,skill,enhance,relic}` |
| `tests/unit/idle-authority.test.ts`（改） | 四条通道的随机序列各自独立前进 |
| `tests/unit/drop-table.test.ts`（改） | 删祈愿组；新增「遗物只从遗物副本来」（掉落表无遗物、主线与副本通道不产遗物、遗物副本产遗物） |
| `tests/unit/save-migration.test.ts`（改/新） | v11 → v12 迁移补齐 relic 通道 / relicPity / relicDaily |

### 7.2 E2E（新增 / 改写）

| 用例 | 内容 |
|---|---|
| **新**「遗物副本：打赢 → 仓库真的多一件」 | 手动挑战遗物副本 → `rewards.relics` 非空 → 权威存档 `save.relics` 变长 → 仓库分页 `total` +1 |
| **新**「遗物副本：掉落必在本副本的 2 个套装内」 | 连续挑战若干次，校验每件 `defId` 的 `setId` ∈ 该副本的 2 套 |
| **新**「遗物通道挂机：真的产出遗物」 | 设遗物通道 → 领挂机 → `rewards.relics` 非空 → 仓库 +N |
| **新**「每日额度：到上限后不再产出、且通道目标不被清空」 | 额度用满 → 再领 → 0 件；**再打开页面，通道目标仍在**（这是 `idle.ts:414-417` 的坑，必须有回归） |
| **新**「新号可达性」 | 新号（仅第一关通关）→ 能进锋锐遗窟 easy → 打赢 → 拿到**第一件**遗物 → 能进初阶强化副本（**闭合铁律 #59 的首件遗物可达性**） |
| **改写**`relic.spec.ts` 的祈愿 3 例 | → 副本入口可达 + 副本掉落 |
| **改写**`dungeon.spec.ts` | 副本奖励口径（材料副本不发遗物 / 遗物副本发遗物）+ 关卡数量 |

### 7.3 验收命令

```powershell
npm run check                    # 配置校验 + 禁用词 + 单测 + 构建，全绿
npx playwright test              # E2E 全绿（预期 102 + 新增 ≈ 108）
npm run balance:recalibrate:dungeon --dry   # 42 关锚点判定通过
npm run balance:report           # 逐章回收比全过（遗物供给口径已改）
npm run balance:newplayer        # 新号首日曲线：遗物件数 / 强化石 / 银两不再失衡
npx tsx tools/capture/screenshot.ts --relic --api http://127.0.0.1:8791 --url http://127.0.0.1:4188 --out artifacts/art-preview/relic.png --viewport 360x800
npx tsx tools/capture/screenshot.ts --dungeon-challenge --api http://127.0.0.1:8791 --url http://127.0.0.1:4188 --out artifacts/art-preview/dungeon.png --viewport 360x800
```

## 8. 风险与未决

### 8.1 风险

| 风险 | 后果 | 缓解 |
|---|---|---|
| **新号打不进第一个遗物副本** | 首件遗物拿不到 ⇒ 强化副本锁死 ⇒ **重演 2026-11-24 的故障** | 4.6 的可达性设计等级 + 「新号可达性」E2E 硬卡 |
| 锚点表重跑时旧值残留 / 下标平移 | 难度错位且 `balance` 看不出来 | 整表重写（不是追加）；`validate-config` 的长度 + 单调性校验；重跑后 diff 人工过一遍 |
| `DUNGEON_PLACE_NAMES` 漏扩 | 关卡名出现字面量 `undefined` | 扩到 14；并**把类型改成元组** `readonly [string, …, string]` 让编译期拦 |
| 每日额度被当成「目标失效」 | 玩家每天要重设通道目标 | 4.4 的语义拆分；E2E 专测「额度用满后目标仍在」 |
| 祈愿下线后 `RELIC_ACQUIRE` 残留死配置 | `validate-config` 的死配置检查报错 / 两处口径 | P6 一次性清干净；`grep -rn "relic.acquire\|RELIC_ACQUIRE"` 归零 |
| 遗物产出过快 → 强化石跟不上 → 遗物线失去长期目标 | 养成深度塌陷 | 已识别：强化石（8.6 万个）才是真瓶颈；`balance:report` 盯遗物件数 vs 强化石件的回收比 |
| 遗物副本刷屏（4 个 tab + 4 条通道） | 界面变复杂、导航挤 | 副本页第三个 tab；推征页第 4 张通道卡做成紧凑卡；底部导航保持 5 项（铁律 #10 不扩导航） |

### 8.2 未决（可在实施中定，或由用户拍板）

1. **遗物副本次序解锁的具体主线关卡**（4.6 给的是初值 1 / 5 / 15 / 30 / 50 / 70）——需用 `balance:newplayer` 跑一遍首日曲线，确认玩家在第 1 天能进几个副本、拿到几件遗物。
2. **每日额度 15 件**是否合适——取决于「集齐 60 件要几天」的目标（当前设计约 4 天纯挂机）。
3. **遗物副本的 BOSS 形态**：现有副本每关只是「2 只敌人 + 缩放」，遗物副本是否需要像主线 BOSS 那样带机制（护盾 / 召唤 / 狂暴）？本设计**沿用现有普通副本形态**（无机制），若要加机制属内容批次。
4. **`RELIC_DROP.RATES` 三档相同**是否长期成立——若将来想让难度影响稀有度，改配置即可（结构已按难度取）。

### 8.3 本次改造的用户约束（实施时必须遵守）

- 不得修改 `src/core/config/economy.ts` 之外的数值来源（铁律 #5：数值只在这一个文件）；
- 锚点**禁止手填**（铁律 #41），必须由 `npm run balance:recalibrate:dungeon` 产出；
- 新增遗物 / 副本 / 通道**只加配置，不改逻辑**（铁律 #3）；
- 概率公示与实际抽签必须同源（铁律 #4）；
- 表现层不得自行推导战斗事实与配置（铁律 #8 / #16）；
- 所有"会改存档"的动作必须经 `POST /api/action`（铁律 #11）；
- 截图 / 验证脚本一律走 `tools/capture/screenshot.ts`，目标地址只允许 `127.0.0.1:<隔离端口>`（铁律 #13）；
- 改实现必须同步回写 `AGENTS.md` 与 `artifacts/plan.md`（项目约定）。

---

## 9. 实施落地记录（2026-11-25）

本节记录**实际实现**与上文设计稿的差异点，以及实测结果。**以本节为准**（设计稿保留原文以说明「为什么这样定」）。

### 9.1 落地的文件清单

| 层 | 文件 | 改动 |
|---|---|---|
| 配置 | `src/core/config/economy.ts` | 新增 `RELIC_DROP`（`RATES` / `COUNT` / `PITY_SSR` / `DAILY_CAP` / `UNLOCK_STAGE`）；**删除** `RELIC_ACQUIRE`；`DUNGEON` 三张锚点表扩到 **42** |
| 配置 | `src/core/config/dungeons.ts` | `DungeonKind` 加 `'relic'`；`DungeonVariantId` 加 6 个；`DungeonVariant.itemId` 改可空 + 加 `relicSetIds` / `shortName`；`DungeonStageDef.drop` 改可空 + 加 `relicPool`；地名扩 14（**类型改成 14 元组**）；新增 `findRelicDungeonVariant` / `relicPoolOf` |
| 系统 | `src/core/systems/relic.ts` | `relicAcquireRarityRates()` → `relicDropRates(difficulty)`；新增 `rollRelicDrop()` / `relicDailyKey()` / `relicQuotaLeft()` / `recordRelicOutput()` |
| 系统 | `src/core/systems/actions.ts` | 遗物副本分支发 `rewards.relics`（保底写 `save.relicPity`）；**删除** `actionRelicAcquire` / `rollRelicDefId` / 动作注册 / `ActionResultMap['relic.acquire']` |
| 系统 | `src/core/systems/idle.ts` | 第 4 条通道：目标解析 / 掷奖 / **每日额度** / 保底落盘；`idlePendingRolls(save, now)` 签名加 `now` |
| 系统 | `src/core/systems/dungeons.ts` | `dungeonUnlocked` 加遗物分支（按主线通关关卡解锁） |
| 协议 | `src/core/systems/action-protocol.ts` | `case 'relic.acquire'` **保留但返回 `null`** ⇒ 老客户端 / 老脚本会被**显式拒绝**，而不是「静默成功但什么都不给」 |
| 模型 | `src/core/model/types.ts` | `IdleChannelKind` 四项；`IdleChannelTarget` 加 `{kind:'relic'}`；`idle.channels` 四键；新增 `relicPity` / `relicDaily` |
| 存档 | `src/core/save/schema.ts` | `SAVE_VERSION` 11 → **12**；`MIGRATIONS[11]`；`createNewSave` / `normalizeSave` 补齐；新增 `normalizeRelicPity` |
| 存档 | `src/core/save/import-validation.ts` | 副本目标**种类**必须与通道一致；`relicPity` 原始值校验；导入后**不继承** `relicPity` / `relicDaily` |
| 表现 | `DungeonView.vue` / `ExpeditionView.vue` / `RelicWarehouse.vue` / `BackpackView.vue` / `HeroDetailView.vue` / `stores/game.ts` / `App.vue` | 副本页第三个 tab、第 4 条挂机通道、仓库套装进度 / 保底 / 额度、祈愿面板下线 |
| 工具 | `tools/balance/*` / `tools/validate-config.ts` / `tools/capture/*` | 祈愿口径改遗物副本；新增遗物副本校验；截图场景改遗物副本 |
| 测试 | `tests/unit/*` / `tests/e2e/*` | 祈愿用例改写为遗物副本用例；新增「新号可达性」等硬卡 |

### 9.2 与设计稿的差异（及原因）

1. **保底按「件」计，不按「场」**（设计稿写的是「累计挑战次数」）：
   - 一件遗物 = 一次抽签 ⇒ 「连续 10 **件**未出 SSR ⇒ 第 11 件必出 SSR」；
   - 计数**逐件**累加 / 归零（一次掉 3 件就可能把计数推满 3）。
   - ⚠ 设计稿的「一次掉落只 +1」写法会让**多件掉落时保底推进变慢**，
     且与「第 11 件必出」这句话自相矛盾。
2. **`save.relicPity` 是单一计数器**（`Record<string, number>`），不是 `{attempts, sinceSsr}`：
   - 「累计挑战次数」没有用途（掉落件数才是玩家真正消耗的东西）。
3. **额度按「件」计**（设计稿已写明），实现上因此**不能**一次掷完：
   - hard 档一次掷奖可能出 2~3 件 ⇒ 结算必须**逐次掷、逐件扣**，
     最后一次用剩余额度裁剪（`rollRelicDrop(..., maxCount)`）。
   - 未掷出的预算**不扣**（`effectiveMs` 只扣实际掷掉的次数）⇒ 额度恢复后继续领。
4. **`idlePendingRolls` 签名加了 `now`**：
   - 遗物通道的待结算次数要按额度裁剪，而额度依赖「今天是哪天」⇒ 必须有当前时刻。
   - ⚠ core 不能读 `Date.now()`（铁律 #1），所以 `now` 只能由调用方注入。
5. **导入路径仍只接受当前版本**（v12）：
   - `import-validation.ts` 的 `raw.version === SAVE_VERSION` 是既有行为，**不是本次引入**；
     但升到 12 后**v11 导出档会被拒**（`IMPORT_INVALID`）。
     服务端权威档走迁移链自动升级，不受影响。
6. **遗物副本变体追加在变体顺序末尾**（设计稿已定）：
   - 现有 8 个变体在 easy 段的下标不变，只有 normal / hard 段平移。

### 9.3 实测结果

| 项 | 结果 |
|---|---|
| 副本锚点标定 | 42 关全部由 `npm run balance:recalibrate:dungeon` 实测产出（40 场/关 × 18 轮二分）；`dgn_relicZhanTan_easy` 稳过上限 2.9 ⇒ 目标缩放 **1.4735** |
| **新号可达性** | **Lv1、零遗物**的 6 人队伍打 `dgn_relicZhanTan_easy`：**通关率 100%**（60 场实测）⇒ 首件遗物拿得到 |
| 副本 vs 主线门槛 | easy 段最低 7400（主线第 1 章 13507 的 0.55×）/ normal 段最低 139264（1.20×）/ hard 段最低 2677223（0.73×） |
| 段内单调 | 难度段之间严格递增；同段内 14 关允许波动（与主线「章内允许波动」同构） |

> ⚠ **为什么「新号可达性」要单独实测**：标定用的 `referenceTeam(level)`
> **带 6 件 Lv1 遗物**，而真实新号**一件遗物都没有**（首件遗物正是从这个副本出的）
> ⇒ 拿标定结果论证新号可达是**偏乐观**的。
> 由 `tests/e2e/relic.spec.ts` 的「新号可达性：Lv1、零遗物的队伍能打赢第一个遗物副本」守护。

### 9.4 仍未做的（属后续批次）

- 遗物副本次序关卡体（每副本每难度仍是 1 关）；
- 遗物副本的 BOSS 形态（沿用普通副本的「2 只敌人 + 缩放」，无护盾 / 召唤 / 狂暴机制）；
- 遗物副本次序解锁线（1/5/15/30/50/70）的首日曲线复核（§8.2 第 1 条）；
- 每日额度 15 件是否需要按实际首日曲线调整（§8.2 第 2 条）；
- 遗物套装 / 遗物定义 / 强化曲线 / 分解价值——**一律不动**（本次改造刻意不碰数值本身）。

### 9.5 收尾验收记录（2026-11-25）

| 项 | 结果 |
|---|---|
| `npm run validate:config` | ✓ 全部检查通过（副本变体 14 · 难度 3） |
| `npm run scan:forbidden` | ✓ 223 文件 / 49,436 行，未命中禁用词 |
| `npx vitest run tests/unit` | ✓ **779 / 779**（基线 743 → +36 条） |
| `npx vue-tsc --noEmit` | ✓ 全项目 0 错误 |
| `npm run check` | ✓ 配置 + 禁用词 + 单测 + 构建，全绿 |
| `npm run balance:recalibrate:dungeon` | ✓ 42 关锚点实测写回（禁止手填，铁律 #41） |
| `npm run balance:recalibrate` | ✓ 40 天基线刷新（`artifacts/baselines/recalibrate.json`）；逐章回收比全 ≥ 1.00×、累计净额全程 ≥ 0；第 2 天起通道显示「遗物 · 锋锐 · 简易 · 断兵坑」 |
| `npx playwright test` | ✓ **109 / 109** |

**截图验收**（`tools/capture/screenshot.ts`，隔离后端 8791 + 隔离预览 4188，视口 360×800）：

| 场景 | 命令 | 关键产出 |
|---|---|---|
| 遗物仓库 | `--relic` | `relic-forge` / `relic-set-progress`（12 套装行）/ `relic-daily-quota`（剩余 15 件）/ `relic-pity`（18 行）/ `relic-dungeon-relic`（点「去遗物副本」真的落到副本页）/ `relic-idle-relic`（推征页第 4 条通道卡） |
| 副本页 | `--dungeon-challenge` | `dungeon`（技能 15 关）/ `dungeon-enhance`（强化 9 关）/ `dungeon-relic`（遗物 18 关）/ `dungeon-result`（挑战结算） |

#### 收尾时抓到的两个真实问题（都不是本次改造引入，但被本次改造暴露）

1. **离线结算弹窗写死了「三条通道各自结算」**（`App.vue`）：
   - 加了遗物通道后它就成了**过期即说谎**的文案——只有挂上目标且真的结算了的通道
     才会出现在结算面板里，写死一个数在「只挂主线」时就已经不对。
   - 修正：按**实际渲染的段数**推导（`{{ offlineChannels.length }} 条通道各自结算`），
     E2E 断言同步改成「文案里的条数 = 弹窗里实际渲染的通道段数」
     （`tests/e2e/authority.spec.ts`）⇒ 以后加减通道都不会再漏改。
2. **`tests/e2e/relic.spec.ts` 的资源对账用了本地缓存当基准**（偶发红）：
   - 现象：期望银两 49,500、实得 49,529 / 49,544（**多 29 / 44**）。
   - 根因：**服务端每个动作入口都会先结算挂机**（`server/src/game/service.ts` 的
     `prepare` → `settleIdleAndApply`）⇒ 快照与「点强化」之间只要跨过
     `IDLE.SECONDS_PER_ROLL`（6 秒）就会**多发一笔挂机收益**；
     而本地缓存只是上一次回包的镜像（测试里直接打 API 的动作根本不刷新它）。
   - ⇒ **不是产品算错，是基准取错了地方**。两处修正：
     1. 基准改用 `idle.tick` 的**服务端权威回包**（顺带把待结算次数归零
        ⇒ 紧接着的动作不会再多结算），见 `authoritativeBefore()`；
     2. **取基准之前先把界面等到就绪**：`networkidle` 满足不代表 Vue 渲染完了，
        `locator.check()` 会一直等列表挂上，那几秒正好跨过掷奖周期
        （批量强化那条就是栽在这里，多出 44 银两）。
   - 已沉淀为 **AGENTS.md 铁律 #66**；修复后两条强化用例连跑 3 轮 **9 / 9 通过**。
3. **`tests/e2e/relic.spec.ts` 的「套装效果区」断言依赖了随机掉落分布**（约 3% 偶发红）：
   - 现象：页面里找不到「还差 N 件」。
   - 根因：遗物副本的候选池只有 **2 个套装**，单个副本连打 6 次完全可能
     **全落在同一个套装**上（(5/10)⁶ ≈ 1.6%，两个套装合计约 3%）；
     而 `HeroDetailView` 的 `setRows` **只统计已装备的套装**，
     那个套装一旦凑满 6 件，它的 2/4/6 三档全部「已生效」
     ⇒ 页面上**再也不会出现「还差 N 件」**。
   - ⇒ 修正：**换副本取样**（锋锐遗窟 3 件 + 疾影遗窟 3 件 ⇒ 每个套装最多 3 件
     ⇒ 「还差 N 件」必然出现）。
     ⚠ 没有把断言放宽成「已生效**或**还差」——放宽等于这条断言随机不执行，等于没守。
   - 同样沉淀为 **AGENTS.md 铁律 #66**（随机分布类断言一律先固定分布）。
