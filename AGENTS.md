# 超级圣杯战争 — 项目约定

本文件供后续 AI 协作者与开发者共同遵守。**设计基线见 [`artifacts/plan.md`](artifacts/plan.md)**（19 章，与本文件同源，随实现同步更新）。

## 架构铁律

1. **`src/core/` 是纯逻辑层**：禁止 import 任何 DOM / 平台 API（`window`、`localStorage`、`document`）。
   - 时间经 `core/time.ts` 注入，随机经 `core/rng.ts` 注入。
   - 违反此规则 → 数值脚本无法在 Node 下运行，`npm run balance` 直接失效。
2. **属性解析单一入口**：所有战斗必须经 `resolveStats(hero, ctx)` 取属性。
   战斗系统内部**不得**直接读 `hero.level` / `relic.level` / `player.permBoost`。
   `ctx.mode === 'arena'` 走归一化分支，PvP 数值隔离依赖此约束。
3. **数据驱动**：新增英灵 / 关卡 / 遗物只加配置，不改逻辑代码。系统逻辑必须遍历配置表，禁止硬编码角色 id。
4. **单一数据源**：概率公示、抽卡执行、掉落预览必须调用同一函数，禁止复制定义（合规硬要求）。
5. **配置与代码分离**：所有数值常数集中在 `src/core/config/economy.ts`。禁止在业务代码里就地写数字。
   > **显式例外**：账号 / 会话类阈值（用户名规则、口令强度、令牌有效期、限流阈值）
   > 放 `src/core/config/account.ts`，前后端与服务端共用同一份。
   > 这类阈值不属于经济数值调参范畴（不进 `npm run balance` 的曲线）。
6. **平台解耦**：`src/presentation/` 不直接访问 `localStorage`，一律经 `src/platform/`。
7. **养成即配置**：竞技场中养成投入只允许通过「战术铭文槽位数量」与「系数封顶表」体现，禁止直接数值加成路径。
8. **存档结构也必须有唯一约定**：装备槽位 key 格式、掉落表 id、卡池 id 等由 `core/systems/loadout.ts`
   与 `core/config/` 定义，表现层不得自行拼接（否则 core 与 UI 会各写一套 key 规则）。
9. **禁用词表是单一数据源**：只改 `src/content/compliance/forbidden-words.md`，扫描器只解析该文件，
   不得在扫描器代码里硬编码词条。
10. **核心循环入口必须可达**：抽卡 / 编队 / 推征等主循环页面必须在导航或主界面上有显式入口，
    禁止只写路由而只留一句「可前往 XX」的纯文案（历史教训：召唤页曾完全无法从游戏内进入）。
    同时，任何**扣费动作必须先做余额校验**：余额不足直接拒绝并提示，不得出现负数资源
    （历史教训：抽卡可把圣杯结晶扣成负数，抽卡总闸门失效）。
11. **存档写入单一入口 + 并发保护**：改存档一律经 `presentation/stores/game.ts` 的 `persist()`，
    禁止绕过它直接写存储。`persist()` 是**先读后写 + 外部优先**：写入前比对存储里的 `savedAt`，
    若存储版本比本进程已知的更新（说明另一个标签页 / 上下文在我们之后改过存档），
    **不得覆盖**，改为采纳外部版本并提示玩家，本次改动整体作废
    （存档是原子的，不会出现「扣了费却没出货」的中间态）。
    「重置进度」与「导入存档」是玩家主动覆盖，允许强行写入。
    由 `tests/unit/save-conflict.test.ts` + `tests/unit/store-save.test.ts` 守护。
    > 历史教训：原 `persist()` 无脑覆写，握着过期存档的一方一写就把另一方进度整份抹掉且无提示。
12. **注入时钟必须会走动**：表现层 store 注入 `systemClock`，**禁止**用 `ManualClock`
    （它只属于测试代码）。历史教训：store 曾注入 `ManualClock` 且只在 `load()` 时 `set` 一次，
    导致整局游戏的 `history.at` / `obtainedAt` / `lastTickAt` 全等于「页面加载那一刻」，
    抽卡记录时间戳全部相同，离线结算也算不准，排查异常时时间线完全对不上。
13. **自动化脚本不得碰玩家的 origin**：localStorage 按 **origin** 隔离，访问玩家正在游玩的
    origin（`localhost:5173`）等于共用玩家存档。截图 / 验证 / 抓取类脚本一律用
    `tools/capture/screenshot.ts`（内置 origin 守卫 + 全新隔离 context），
    目标地址只允许 `127.0.0.1:<隔离端口>`（如 4188）。禁止自写一次性脚本直连 `localhost:5173`。
14. **表现层不得直连后端接口**：所有认证 / 云存档请求一律经 `src/platform/account.ts`，
    `src/presentation/` 里禁止出现 `fetch('http…')` 这类直连（否则会出现两套令牌与错误处理）。
    令牌轮换、401 自动续期、会话落盘统一由 `presentation/stores/account.ts` 负责。
    服务端同样遵守「单一数据源」：账号阈值与错误码表复用 `src/core/config/account.ts`，
    不在 `server/` 里另立一份。
15. **账号与登录是核心循环的一部分，不是可选项**：首屏即登录页，
    未登录只放行 `/login` 与公开合规页（路由守卫 `presentation/router.ts`）。
    存档归属由账号决定：本地槽位 `sgw.save.<账号 id>`，云端每账号一份。
    存量单槽位 `sgw.save.main` 只迁给**第一个**登录的账号（`sgw.legacyMigrated` 标记）。
    新增页面若需要玩家身份相关的数据，走 store，不得各自去读会话。
    > 历史教训：登录系统缺失时，「跨设备同步」这类产品承诺无从兑现；
    > 而把云存档接上后发现 `@fastify/cors` v11 默认方法表**不含 PUT**，
    > 浏览器预检会静默拦掉云存档推送——这类问题只有端到端跑真实链路才会暴露。
16. **站位与参战名册由 core 独家产出，表现层不得自行推导**：
    - `HeroRuntime.slot` 是**真实编队槽位号**（0-2 前排 / 3-5 后排），
      **不是「队伍里的第几个」**——队伍会跳过空槽位，用紧凑序号会让后排的人被当成前排。
    - 参战单位的 id / side / slot / 初始血量一律取 `BattleResult.roster`（core 产出）。
      表现层**禁止**自行拼接单位 id：战斗日志里敌方 id 是 `def.id#0`，
      若表现层用 `def.id` 就查不到单位，血条永远不变（同类错误见铁律 #8）。
    - 目标选择的**并列判定按槽位序**（slot 小 = 前排先挨打），禁止用 `id.localeCompare`——
      英灵 id 是拼音字母序，与编队无关，会出现「怪开局固定打字母序最小的人」的反直觉结果。
    > 历史教训：观战界面出现「后排贴敌、前排缩在角落」，且一整场只有蔡文姬挨打，
    > 排查后确认是渲染按插入序号排位 + 目标选择按 id 字典序并列，两处都错。
17. **Canvas 高分屏必须先拿 ctx 再设尺寸**：`el.width` / `el.height` 赋值会**重置 2D 上下文变换矩阵**，
    因此 `setTransform(dpr, …)` 必须在尺寸赋值**之后**且 `ctx` 已获取时执行；
    `onMounted` 里的顺序必须是「取 ctx → resize → draw」。
    窗口 resize 同样要重绘（改尺寸会清空画布）。
    > 历史教训：原实现 `onMounted` 先调 `resize()`（此时 `ctx.value` 仍为 null，变换没设上）
    > 才赋值 ctx → 高分屏上整个战斗场景被画进 2x 缓冲的左上角，整场战斗缩成一半挤在角落。
18. **BOSS 机制必须真的触发，且要能被打死**：
    - `BossMechanic` 的每个字段都必须被战斗代码读取——
      召唤机制的 `enemyId`（**敌人 id**，不是显示名）/ `count` / `everyTurns` 缺一不可，
      禁止从战场上「反推」模板（如取已死敌人的名字）。
    - 召唤物是模板怪的**削弱版**：攻防血一起按 `BATTLE.SUMMON_STAT_RATIO` 折算，
      并受 `BATTLE.MAX_LIVE_SUMMONS` 存活上限约束。
    - **BOSS 锁定**：只要 BOSS 存活，我方单体攻击锁定 BOSS。
      否则援军（血量必然低于 BOSS）会一直抢走「集火最低血」的注意力 → BOSS 永远不死 → 召唤型 BOSS 变成活门。
    > 历史教训：召唤机制配置齐全（`enemyId` / `count` 都在）却**从未触发**——
    > 模板查找拿显示名去查以敌人 id 为 key 的索引，永远查不到。
    > 而 `npm run balance` 只比战力数字，**看不出机制空转**，只有真跑战斗才能发现。

19. **BOSS 的护盾 / 狂暴机制必须有确定语义，且必须真能打死**：
    - **护盾阶段（`shieldPhase`）只挂一次**：`BattleUnit.shieldPhaseUsed` 标记是否已进过护盾阶段，
      盾被打掉后**不再补盾**。否则 BOSS 实际无敌，难度对缩放极度敏感
      （实测第 10 章 BOSS 在缩放 733~1500 之间通关率从 83% 直接掉到 0%，
      纯数值调参根本调不出合理曲线）。
      盾值取配置的 `threshold`，**禁止硬编码**。
    - **狂暴（`enrage`）必须真的生效**：`hp ≤ threshold × maxHp` 时挂 `atk` 增益
      （回合数 = `BATTLE.MAX_ROUNDS`），在回合末结算里与 `applyRegen` 同层调用。
      历史上 `enrage` 配在 `boss_storm` / `boss_abyss` 身上，战斗代码**从未读取**，
      机制完全空转——`npm run balance` 同样看不出来。
    > 教训：难度调参之前，先确认 BOSS 机制本身语义正确。
    > 机制空转 / 语义错误时，任何缩放曲线都是在给 bug 打补丁。

## 数值调参的既定流程

数值改动**只改** `src/core/config/economy.ts`（以及对应的配置表），然后按序执行：

```bash
npm run balance          # 难度曲线 vs 养成曲线：检查 310 关单调递增、满养成可通关
npm run balance:battle   # 实战战斗模拟：逐章 BOSS 通关率（召唤开/关对照）+ 实战卡关点
npm run balance:report   # 投放回收表：五类资源回收率必须全部 ≥ 1
npm run validate:config  # 配置自洽性
npm test                 # 单测（含十项 PvP 隔离断言）
```

任何调参都要同时满足三个不变量：**关卡门槛单调递增**、**满养成可通关末关且有 1.5× 以上余量**、
**竞技归一化后战力差 < 15%**。

> ⚠ `npm run balance` 比的是**战力数字**（`computePower` vs `powerRequired`），**不跑战斗**。
> 「满养成可通关末关」这条不变量必须用 `npm run balance:battle`（真实跑战斗）复核。
> 两者曾严重脱节（模型 310 关 / 实战 246 关，第 7~10 章 BOSS 通关率 0%），
> 已由「关卡难度曲线重标定」提交修好（模型 310 / 实战 310，各章 BOSS 100%），
> 详见 `artifacts/plan.md` §6.5。

> ⚠ **难度曲线是标定值，不是拍脑袋的常数**：`STAGE.SCALE_ANCHORS`（敌方缩放）与
> `STAGE.POWER_ANCHORS`（战力门槛）是**逐章锚点**，由真实战斗模拟标定得出。
> 改动英灵 / 成长 / 掉落数值后必须重跑 `npm run balance:battle` 重新标定，
> 否则门槛会与真实难度重新脱节（详见 plan.md §6.5「已知限制」）。

> ⚠ **门槛是挂机放行线，不是装饰**：`powerRequired` 决定挂机自动推进时**要不要放行到下一关**。
> 放行必须**不晚于**该关真正打得赢的时刻，否则挂机会推进到打不过的关卡 → 打输 →
> 结算中断 → 玩家零收益卡死。**宁可略紧不可略松。**

## 命名的 IP 边界

本作不使用 Fate 系列名词。历史上曾使用 `noblePhantasm`（宝具的直译），已整体更名为
`coreAwakened` / `ultimate`。新增命名时不要引入 `noble / phantasm / 命令 / 职阶 / 令咒 / 从者 / 御主 / 魔术`。

## PvP 数值隔离（最重要的一条）

| 养成来源 | 竞技模式 | 封顶 |
|---|---|---|
| 等级 / 遗物强化等级 / 遗物随机词条 / 印记 / 永久加成 | **完全无效** | 0 |
| 星级被动 | 效果系数打折 | ×0.6 |
| 技能等级 / 终极技 | 效果强度 | +30% |
| 遗物套装效果 | 固定标准强度 | ×0.7 |
| 羁绊 | 系数打折 | ×0.6 |

`core/systems/arena.ts` **禁止**出现 `permBoost`。由 `tests/unit/arena-isolation.test.ts` 守护。

## 合规红线

- 敌人 / BOSS **全部为非历史人物**（灵体、妖异、幻想体、器械造物），不得指向任何真实历史人物或族群。
- 传记只述史实、不评功过；禁用贬义定性词。
- UI 禁用绝对化用语（"必出""100%""最高品质"等），见 `src/content/compliance/forbidden-words.md`。
- 概率公示必须同时展示「基础概率」与「含保底综合概率」，精确到小数点后两位。
- PvP 产出不得回流 PVE 经济（银两 / 经验 / 强化石 / 圣杯结晶均为 0）。

## 目录约定

```
src/core/       纯逻辑，可在 Node 下运行，被单元测试全覆盖
src/platform/   平台适配（storage / account / payment / share / ads），首发为 mock
src/presentation/ Vue 视图层
src/content/    传记文本、合规文案、美术资源
server/         真实后端（Fastify + node:sqlite）：认证 + 云存档
tools/          数值模拟、配置校验、禁用词扫描、占位图生成
tools/capture/  界面截图（内置 origin 守卫，禁止对玩家正在使用的 origin 动手）
tests/unit/     Vitest 单测（core/systems 目标 100% 覆盖）
tests/e2e/      Playwright 端到端（起真实后端 + 静态预览）
```

`server/` 与 `src/core/` 的边界：服务端**只做**认证与云存档，不参与任何战斗与数值计算；
账号阈值与错误码表从 `src/core/config/account.ts` 引入，不在服务端另立一份。

## 常用命令

```bash
npm run dev              # 开发服务器（**只起前端**，登录系统还需要后端）
npm run dev:all          # 前端 + 后端一起起（开发推荐；任一退出另一个一并停）
npm test                 # 单元测试
npm run build            # 类型检查 + 生产构建
npm run check            # 配置校验 + 禁用词扫描 + 单测 + 构建（提交前跑这个）
npm run balance          # 数值模拟：难度曲线 vs 养成曲线
npm run balance:battle   # 实战战斗模拟：逐章 BOSS 通关率 + 实战卡关点
npm run balance:report   # 投放回收表
npm run balance:rates    # 十连综合概率（精确 DP）取数
npm run validate:config  # 配置完整性校验（id 唯一、引用存在、数值区间）
npm run scan:forbidden   # 禁用词扫描（含 server/）
npm run art:placeholder  # 生成占位头像
npm run art:transcode    # 卡面 JPEG → WebP 转码（体积 25.9MB → 3.9MB）
npm run art:capture      # 界面截图（必须指向隔离 origin，见铁律 #13）
npm run test:e2e         # Playwright 端到端（需先 npx playwright install chromium）
npm run server:dev       # 后端开发模式（node --watch，默认 127.0.0.1:8787）
npm run server:start     # 后端生产模式
```

> **后端**：默认 `127.0.0.1:8787`，DB 落在 `server/data/app.db`（已被 .gitignore 忽略）。
> 配置优先级：命令行参数 > 环境变量 > 默认值，完整清单见 `.env.example`。
> **生产环境必须设置 `SGW_JWT_SECRET`**，否则进程启动即退出（重置密钥会让所有会话失效）。
> 前端默认连 `http://127.0.0.1:8787`；可用环境变量 `VITE_API_BASE` 或
> 设置页里的「服务地址」覆盖（写入 `localStorage['sgw.apiBase']`，优先级最高）。
>
> **开发要两个进程**：只跑 `npm run dev`（前端）时，登录页会报「无法连接服务器」——
> 这是登录系统引入真实后端后最容易踩的坑。用 `npm run dev:all` 一次拉起前后端。
>
> **端到端**：`npm run test:e2e` 会自动起两个服务——真实后端（临时 SQLite 库，
> 端口 8790）与静态预览（端口 4173），用例走完整注册 → 登录 → 云存档链路。

> 截图前先起隔离预览服务（**端口不要用 5173**，那是玩家可能在用的 dev server）：
> `npm run build && npm run preview -- --port 4188 --host 127.0.0.1`，
> 再 `npm run art:capture -- --url http://127.0.0.1:4188 --route /gacha --pull --out artifacts/art-preview/gacha.png`。

> **本机坑（Windows + 非 ASCII 项目路径）**：Node 的 `fs.rmSync` 在**含中文的路径**下会静默失效
> （不报错、文件也不删；同目录下 `fs.unlinkSync`、PowerShell 的 `Remove-Item` 都正常，ASCII 路径下 `rmSync` 也正常）。
> vite 清理 `dist` 走的正是 `rmSync`，所以中文路径下每次构建都会把旧哈希产物留在 `dist/` 里
> （实测 586 个 vs 干净构建 209 个），preview 可能命中陈旧产物。
>
> **已修**：`package.json` 的 `prebuild` 钩子调用 `tools/clean-dist.mjs`——
> 先走 `rmSync`（常规路径一步到位），校验发现没清掉时回退到逐项 `unlinkSync` + `rmdirSync`
> （这两个在中文路径下正常），并以「残留文件数」判定成败。连续构建不再累积旧产物。
> 若 `dist` 被别的进程占用（如 `vite preview` 还在跑），脚本会打印警告但不阻断构建，
> 此时手动清一次即可：`Remove-Item -Recurse -Force dist`。
> 该问题只影响本地构建目录，不影响仓库内容与 CI——ASCII 路径下完全正常。

## 提交粒度

每完成一个 Phase 做一次提交，提交信息用 `feat(phase-N): 描述`。数值调参单独提交，便于回滚。
登录与云存档这条工作线的步骤用 `feat(login-A)` … `feat(login-E)` 标记（A 后端骨架 → B 登录前端 →
C 云存档同步 → D 端到端 → E 文档），每步一个可独立跑通的提交。
