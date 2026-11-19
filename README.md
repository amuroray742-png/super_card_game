# super_card_game · 超级圣杯战争

全球历史名人抽卡 × 数值挂机 H5 游戏。Vue 3 + TypeScript + Vite 前端 + Node(Fastify) 后端，
账号认证与云存档为真实实现，登录后进度随账号跨设备同步。

## 核心循环

召唤（抽卡） → 编队（6 阵位 + 遗物 + 羁绊） → 推征（挂机刷关） → 养成（升级 / 境界突破 / 升星 / 技能 / 遗物强化） → 圣杯重启（永久加成）。

- **72 位英灵**：公有领域历史人物（SSR 12 / SR 24 / R 24 / N 12），每人 3 技能 + ≥5 被动 + 传记。
- **72 张 AI 卡面**：3:4 完整卡面，半写实厚涂 CG 风格，发布为宽 528 px 的 WebP（全量约 3.9 MB），画面内无文字。
- **竞技场**提供段位天梯和归一化镜像试炼。服务端用玩家自己的阵容快照生成对手并结算，竞技数值隔离由单测守护。真人匹配属于 Phase 11 扩展范围。
- **抽卡演出**：蓄力 → 逐张翻牌 → SR 光效 → SSR 全屏爆点（光爆 + 放射光束 + 粒子 + 震屏），
  可随时跳过；音效为 WebAudio 合成，无配音素材。

## 账号与云存档

- **强制登录才能进游戏**。未登录可访问登录页与公开合规页。
- **后端**在 `server/`，使用 Node 24、Fastify 5 与内置 `node:sqlite`。接口覆盖账号认证、权威存档、游戏动作和健康检查。
- **安全**：口令 scrypt 加盐哈希；access token 为 HS256 JWT（15 分钟），refresh token 只存 sha256 且刷新即轮换；
  用户不存在与口令错误返回同一错误码（防账号枚举）；同一「用户名 + IP」失败 5 次后限流。
- **同步**通过 `GET /api/save` 拉取权威进度，游戏动作经 `POST /api/action` 提交。服务端按账号串行执行，将动作结果与幂等记录一并落库。成功业务动作可在 24 小时内重放结果，超期仍防止重复执行。
- **本地缓存**按账号存放在 `sgw.save.<账号 id>`。断网时可查看缓存，待重新拉取权威存档后恢复操作。跨设备使用同一账号登录即可同步进度。
- **注销**以服务端确认删除为准，成功后清理本机的会话和该账号缓存。云存档回包、本地缓存和导出串省略服务端随机状态。
- **旧档迁移**仅对尚无云档且未迁移的账号开放。同一浏览器的 `sgw.save.main` 只在服务端确认迁移成功后标记为已迁移。设置页的导出用于备份，已有云档的账号无法通过导入覆盖进度。

## 挂机结算

服务端按自身时钟计量挂机时间。可见页面通过心跳续约，租约有效期间按基础速率的 3 倍计量。离线前 1 小时按基础速率计量，接下来 2 小时逐步衰减，累计最多计 3 小时。在线推征和离线补结算共用同一时间账本，实际收益取决于回放的战斗与掉落。挑战战败后按实际尝试结算，回到已通关关卡刷取，累计胜场后再试原目标。

遗物强化分两段：Lv1→60 为标准段，每级价格恒定（银两 500 · 强化石 2）、主词条每级 +3%；Lv60 起进入淬炼段，每级价格按指数上升（银两 ×1.10 · 强化石 ×1.06）、主词条每级 +0.6%，强化上限 200 级。

## 后端运行

```bash
npm run server:dev      # 起后端（默认 127.0.0.1:8787，DB 落在 server/data/app.db）
npm run server:start    # 启动后端（部署入口）
```

后端优先读取命令行参数，其次是环境变量和默认值。配置项见 `.env.example`。
部署时设置 `NODE_ENV=production`，并为 `SGW_JWT_SECRET` 配置独立密钥。
前端默认连 `http://127.0.0.1:8787`，可用 `VITE_API_BASE` 或设置页里的「服务地址」覆盖。

## 目录

```
src/core/          纯逻辑层（禁 DOM / 平台 API，时间与随机均注入）
src/platform/      平台适配（storage / account / payment / share / ads）
src/presentation/  Vue 视图层
src/content/       传记文本、合规文案、美术资源
server/            真实后端（Fastify + node:sqlite），负责认证与权威存档
tools/             数值模拟、配置校验、禁用词扫描、卡面流水线、界面截图
tests/unit/        Vitest 单测        tests/e2e/  Playwright 端到端
artifacts/         设计基线、美术规范和验收记录
```

## 常用命令

```bash
npm install
npm run dev:all           # 前端 + 后端一起起（推荐，见下方说明）
npm run dev              # 只起前端开发服务器
npm run check            # 配置校验 + 禁用词扫描 + 单测 + 构建（提交前跑这个）
npm test                 # Vitest 单测
npm run build            # 类型检查 + 生产构建
npx playwright install chromium  # 首次运行端到端测试前安装浏览器
npm run test:e2e         # Playwright 端到端（自动起真实后端 + 静态预览）
npm run balance          # 数值模拟：难度曲线 vs 养成曲线
npm run balance:battle   # 实战战斗模拟：逐章 BOSS 通关率 + 实战卡关点
npm run balance:report   # 投放回收表
npm run validate:config  # 配置完整性校验
npm run scan:forbidden   # 禁用词扫描
npm run art:transcode    # 卡面 JPEG → WebP 转码
npm run art:capture      # 界面截图（只允许指向隔离 origin）
```

> **登录系统引入真实后端后，开发需要两个进程**：只跑 `npm run dev`（前端）的话，
> 登录页会提示「无法连接服务器」。用 `npm run dev:all` 一次拉起前后端，
> 任一进程退出另一个会一并停止。单独起后端用 `npm run server:dev`。

## 协作约定

[`AGENTS.md`](AGENTS.md) 是本仓库的工程铁律（架构分层、存档写入、数值调参流程、合规红线、IP 边界），
设计基线见 [`artifacts/plan.md`](artifacts/plan.md) 与 [`artifacts/art-style.md`](artifacts/art-style.md)。
修改数值只改 `src/core/config/economy.ts` 与对应配置表，改完按序跑 `balance` / `balance:battle` / `balance:report` / `validate:config` / `test`。
其中 `balance:battle` 会**真实跑战斗**，用于复核「满养成可通关末关」——`balance` 只比战力数字，看不出 BOSS 机制空转之类的实战问题。

设计、规范和已验证提交的检查结果见 [artifacts 目录索引](artifacts/README.md)。

## 合规

敌人与 BOSS 全部为非历史人物（灵体、妖异、幻想体、器械造物）；概率公示同时展示基础概率与含保底综合概率（两位小数）；
首次十连保底 1 位传说英灵，保底计数跨池继承。重复获得按稀有度转化为印记、碎片或银两。竞技场发放勋章与有限抽卡券。
禁用词表是单一数据源，见 `src/content/compliance/forbidden-words.md`。
