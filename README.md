# super_card_game · 超级圣杯战争

全球历史名人抽卡 × 数值挂机 H5 游戏。Vue 3 + TypeScript + Vite，纯前端实现，存档落在浏览器 localStorage。

## 核心循环

召唤（抽卡） → 编队（6 阵位 + 遗物 + 羁绊） → 推征（挂机刷关） → 养成（升级 / 升星 / 技能 / 遗物强化） → 圣杯重启（永久加成）。

- **72 位英灵**：公有领域历史人物（SSR 12 / SR 24 / R 24 / N 12），每人 3 技能 + ≥5 被动 + 传记。
- **72 张 AI 卡面**：3:4 完整卡面，半写实厚涂 CG 风格，WebP 发布（528×710，全量约 3.9MB）；画面内无任何文字。
- **竞技场**：首发为 PVE 天梯段位，养成投入经归一化后战力差 < 15%（PvP 数值隔离由单测守护）。

## 目录

```
src/core/          纯逻辑层（禁 DOM / 平台 API，时间与随机均注入）
src/platform/      平台适配（storage / payment / share / ads）
src/presentation/  Vue 视图层
src/content/       传记文本、合规文案、美术资源
tools/             数值模拟、配置校验、禁用词扫描、卡面流水线、界面截图
tests/unit/        Vitest 单测        tests/e2e/  Playwright 端到端
artifacts/         设计基线（plan.md 19 章）与美术规范（art-style.md）
```

## 常用命令

```bash
npm install
npm run dev              # 开发服务器
npm run check            # 配置校验 + 禁用词扫描 + 单测 + 构建（提交前跑这个）
npm test                 # Vitest 单测
npm run build            # 类型检查 + 生产构建
npm run test:e2e         # Playwright 端到端
npm run balance          # 数值模拟：难度曲线 vs 养成曲线
npm run balance:report   # 投放回收表
npm run validate:config  # 配置完整性校验
npm run scan:forbidden   # 禁用词扫描
npm run art:transcode    # 卡面 JPEG → WebP 转码
npm run art:capture      # 界面截图（只允许指向隔离 origin）
```

## 协作约定

[`AGENTS.md`](AGENTS.md) 是本仓库的工程铁律（架构分层、存档写入、数值调参流程、合规红线、IP 边界），
设计基线见 [`artifacts/plan.md`](artifacts/plan.md) 与 [`artifacts/art-style.md`](artifacts/art-style.md)。
修改数值只改 `src/core/config/economy.ts` 与对应配置表，改完按序跑 `balance` / `balance:report` / `validate:config` / `test`。

## 合规

敌人与 BOSS 全部为非历史人物（灵体、妖异、幻想体、器械造物）；概率公示同时展示基础概率与含保底综合概率（两位小数）；
首次十连保底 1 位传说英灵且保底跨池继承；重复获得只转化为印记与碎片，不直接提升强度；竞技场产出不回流 PVE 经济。
禁用词表是单一数据源，见 `src/content/compliance/forbidden-words.md`。
