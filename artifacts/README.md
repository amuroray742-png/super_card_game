# 项目文档与验收记录

本目录存放设计基线、美术规范与按提交归档的验收记录。

| 文件 | 说明 |
|---|---|
| [plan.md](plan.md) | 《超级圣杯战争》完整设计方案（19 章）及实施修正。工程约束同步记录在 [AGENTS.md](../AGENTS.md)。 |
| [art-style.md](art-style.md) | 英灵卡面的画风、生产和校验规范。 |
| [roadmap.md](roadmap.md) | P1、P2 的执行顺序、交付物与验收条件。 |
| [deploy.md](deploy.md) | 试玩部署手册：托管形态、持久化、备份恢复演练、回滚、HTTPS、兼容性实测、扩容边界。 |
| [phase11-gate.md](phase11-gate.md) | Phase 11 决策闸门（roadmap P2-3）：判据、实测证据、缺口清单与复审触发条件。 |
| [pvp-sampling.md](pvp-sampling.md) | 对局样本采集方案：样本口径、判据阈值、真实样本的采集点 / 开关 / 脱敏 / 留存期。 |
| [baselines/](baselines/) | 实测基线：新号数值基线（`newplayer.json`）、浏览器兼容实测（`browser-compat.json`）、三队天梯标定（`ladder.json`）、竞技对局样本（`pvp-sample.json`）。 |
| [2026-11-18 合并验收记录](acceptance-2026-11-18-886b7c8.md) | `main` 提交 `886b7c8` 的权威链路整改、测试修复与验证结果。 |

`plan.md` 是**不可变快照式基线**：实施过程中发现方案与实现不一致时，先在 `plan.md`
对应章节追加「实施修正」说明（保留原决策意图），再改代码，不要回头静默改写方案决策。
