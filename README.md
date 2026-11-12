# super_card_game · 超级圣杯战争

全球历史名人抽卡 × 数值挂机 H5 游戏。Vue 3 + TypeScript + Vite 前端 + Node(Fastify) 后端，
账号认证与云存档为真实实现，登录后进度随账号跨设备同步。

## 核心循环

召唤（抽卡） → 编队（6 阵位 + 遗物 + 羁绊） → 推征（挂机刷关） → 养成（升级 / 升星 / 技能 / 遗物强化） → 圣杯重启（永久加成）。

- **72 位英灵**：公有领域历史人物（SSR 12 / SR 24 / R 24 / N 12），每人 3 技能 + ≥5 被动 + 传记。
- **72 张 AI 卡面**：3:4 完整卡面，半写实厚涂 CG 风格，WebP 发布（528×710，全量约 3.9MB）；画面内无任何文字。
- **竞技场**：首发为 PVE 天梯段位，养成投入经归一化后战力差 < 15%（PvP 数值隔离由单测守护）。

## 账号与云存档

- **强制登录才能进游戏**：首屏即登录页，路由守卫拦截未登录访问。
- **后端**：`server/`（Node 24 + Fastify 5 + 内置 `node:sqlite`，零原生依赖）。
  接口：注册 / 登录 / 刷新 / 登出 / 当前账号 / 云存档拉取推送 / 注销账号 / 健康检查。
- **安全**：口令 scrypt 加盐哈希；access token 为 HS256 JWT（15 分钟），refresh token 只存 sha256 且刷新即轮换；
  用户不存在与口令错误返回同一错误码（防账号枚举）；同一「用户名 + IP」失败 5 次后限流。
- **同步**：时间戳 `savedAt` 大者胜，不做字段级合并。扣费与不可逆动作立即推云端，其余 1.5s 防抖，
  页面隐藏与登出时 flush。
- **本地副本**：每账号一个本地槽位 `sgw.save.<账号 id>`；首发前的单槽位旧档在首个账号登录时自动迁入。

```bash
npm run server:dev      # 起后端（默认 127.0.0.1:8787，DB 落在 server/data/app.db）
npm run server:start    # 起后端（生产模式）
```

后端配置优先级：命令行参数 > 环境变量 > 默认值，清单见 `.env.example`。
生产环境必须设置 `SGW_JWT_SECRET`（否则启动即退出）。
前端默认连 `http://127.0.0.1:8787`，可用 `VITE_API_BASE` 或设置页里的「服务地址」覆盖。

## 目录

```
src/core/          纯逻辑层（禁 DOM / 平台 API，时间与随机均注入）
src/platform/      平台适配（storage / account / payment / share / ads）
src/presentation/  Vue 视图层
src/content/       传记文本、合规文案、美术资源
server/            真实后端（Fastify + node:sqlite）：认证 + 云存档
tools/             数值模拟、配置校验、禁用词扫描、卡面流水线、界面截图
tests/unit/        Vitest 单测        tests/e2e/  Playwright 端到端
artifacts/         设计基线（plan.md 19 章）与美术规范（art-style.md）
```

## 常用命令

```bash
npm install
npm run dev:all           # 前端 + 后端一起起（推荐，见下方说明）
npm run dev              # 只起前端开发服务器
npm run check            # 配置校验 + 禁用词扫描 + 单测 + 构建（提交前跑这个）
npm test                 # Vitest 单测
npm run build            # 类型检查 + 生产构建
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

## 合规

敌人与 BOSS 全部为非历史人物（灵体、妖异、幻想体、器械造物）；概率公示同时展示基础概率与含保底综合概率（两位小数）；
首次十连保底 1 位传说英灵且保底跨池继承；重复获得只转化为印记与碎片，不直接提升强度；竞技场产出不回流 PVE 经济。
禁用词表是单一数据源，见 `src/content/compliance/forbidden-words.md`。
