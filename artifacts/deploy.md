# 试玩部署手册（roadmap P1-3）

> 本文件是**部署与运维的唯一入口**。部署形态、备份恢复、回滚、兼容性实测都在这里。
> 设计背景见 [plan.md §12.8](plan.md#128-厂商中立部署件与运维roadmap-p1-3)。

---

## 1. 交付形态

**单实例 + SQLite 持久化卷 + nginx 反向代理**。

```
浏览器 ──HTTPS──▶ nginx（web 容器）
                     │  /            → SPA 静态资源（dist/）
                     │  /api/        → 反代到 api:8787
                     ▼
                  Fastify（api 容器）
                     │
                     ▼
                  SQLite（命名卷 sgw-data:/data/app.db）
```

| 组件 | 容器 | 说明 |
|---|---|---|
| `api` | `node:24-alpine` | Fastify + `node:sqlite`（Node 24 内置，**零原生依赖**） |
| `web` | `nginx:1.27-alpine` | 托管 SPA + 反代 `/api` |

### 为什么是厂商中立

- **不依赖任何云厂商的语法**：只用 Docker + nginx 标准模块 + 一份 `.env`。
  单机 VPS、容器平台、内网服务器都能跑，换托管只需换 `.env` 里的地址。
- **前端用相对 API 地址 `/api`**：同一份构建产物在任何域名下都指向同源，
  由 nginx 反代到 api 容器 → **换域名不必重新构建镜像**。
- **不引入新运行时依赖**：数据库用 Node 24 内置的 `node:sqlite`，不需要编译工具链。

### 为什么是单实例

- 存档写入口在服务端、按账号串行（铁律 #11），SQLite 又不支持多进程并发写；
- 试玩阶段的并发量远低于单实例上限；
- **备份 = 复制一个文件**，恢复演练成本极低（见 §6）。

扩容边界见 §9。

---

## 2. 文件清单

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 三阶段构建：`web-build`（前端）→ `api`（运行时）→ `web`（nginx） |
| `docker-compose.yml` | 编排两个服务 + 命名卷 `sgw-data` |
| `deploy/nginx.conf` | 静态托管 + `/api` 反代 + 缓存策略 + HTTPS 模板（注释形式） |
| `.dockerignore` | 排除 `node_modules/dist/.git/server/data/tools/artgen/out/.env` |
| `tools/db-backup.mjs` | 整库一致性快照（`VACUUM INTO`） |
| `tools/db-restore.mjs` | 整库恢复（先校验 → 备份旧库 → 覆盖 → 清 WAL 伴生文件 → 自检） |
| `.env.example` | 环境变量清单（**唯一**出处） |
| `.github/workflows/ci.yml` | CI：`check` / `e2e` / `docker` 三个 job |

---

## 3. 首次部署

```bash
# 1. 准备环境变量
cp .env.example .env
#    至少要改：
#      SGW_JWT_SECRET        —— 32+ 位随机串；不设 compose 会直接拒绝启动
#      VITE_CONTACT_EMAIL   —— 客服邮箱（合规页展示；不配会显示「尚未配置」）
#    生成密钥：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. 起服务（首次会构建镜像）
docker compose up -d --build

# 3. 自检
curl -s http://<host>/api/health        # {"ok":true}
docker compose logs -f api
```

**未设置 `SGW_JWT_SECRET` 时 compose 直接拒绝启动**（`${SGW_JWT_SECRET:?...}` 语法），
不会悄悄用开发密钥上线（那会导致重启后所有会话失效）。

### 端口

| 变量 | 默认 | 说明 |
|---|---|---|
| `SGW_HTTP_PORT` | `80` | web 容器的宿主机端口（映射到容器 80） |
| — | `8787` | api 容器内端口（**不直接暴露**到宿主机，只走 nginx） |

---

## 4. 环境变量

服务端读取（`server/src/config.ts`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SGW_HOST` | `127.0.0.1` | 容器内设为 `0.0.0.0` |
| `SGW_PORT` | `8787` | 容器内设为 `8787` |
| `SGW_DB_PATH` | `server/data/app.db` | 容器内 `/data/app.db` |
| `SGW_JWT_SECRET` | 开发默认值 | **生产必填**；`NODE_ENV=production` 且为默认值时服务端拒绝启动 |
| `SGW_ACCESS_TOKEN_TTL` | `900`（秒） | access token 有效期 |
| `SGW_REFRESH_TOKEN_TTL` | `2592000`（秒，30 天） | refresh token 有效期 |
| `SGW_CORS_ORIGINS` | 本地开发地址列表 | **同源部署不需要**，留空即可 |
| `NODE_ENV` | — | `production` 时收紧密钥校验 |

构建期（前端）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `VITE_API_BASE` | `http://127.0.0.1:8787` | **部署时设为 `/api`**（同源相对地址） |
| `VITE_CONTACT_EMAIL` | 空 | 客服邮箱；未配置时合规页显式提示「尚未配置」 |

> `.env` 由 Node 24 原生 `--env-file-if-exists` 加载（见 `package.json` 的
> `server:dev` / `server:start`），**不引入 dotenv**。容器内不走 `.env`，
> 由 compose 的 `environment` 注入。

---

## 5. 数据持久化

- 库文件：命名卷 `sgw-data` → 容器内 `/data/app.db`（WAL 模式，伴生 `-wal` / `-shm`）。
- **备份也落在同一卷内**：`/data/backups/app-<时间戳>.db`
  （`SGW_BACKUP_DIR` 可改；未设置时默认 `<库所在目录>/backups`）。
- 换机器迁移：整个 `sgw-data` 卷拷过去即可（含库与备份）。
- ⚠ 卷丢失 = 全部玩家进度丢失 → **必须做异地备份**（见 §6）。

---

## 6. 备份与恢复（已实测）

### 6.1 备份

```bash
docker compose exec api node tools/db-backup.mjs
# 或本地：npm run db:backup
```

用 SQLite 的 `VACUUM INTO` 而不是直接复制文件：
库开着 WAL，直接复制会**漏掉还在 WAL 里没落盘的事务**，复制过程中有写入还会得到撕裂的文件；
`VACUUM INTO` 走 SQLite 自己的备份流程，产出**一致性单文件快照**（无 WAL 伴随文件）。

输出会打印各表行数，便于肉眼核对：

```
[backup] 已备份到：/data/backups/app-20261118-183412.db
[backup] 体积：60.0 KB
[backup]   users: 1 行
[backup]   sessions: 1 行
[backup]   saves: 1 行
[backup]   action_log: 9 行
[backup]   user_flags: 0 行
[backup]   relic_instances: 3 行
```

默认保留最近 7 份（`--keep N` 可调），旧的按时间序清理。

### 6.2 恢复

```bash
docker compose exec api node tools/db-restore.mjs --list       # 先看有哪些备份
docker compose stop api                                          # ⚠ 必须先停服
docker compose run --rm --no-deps api node tools/db-restore.mjs \
  --from /data/backups/app-20261118-183412.db
docker compose start api
```

恢复脚本按顺序做四件事：

1. **校验备份**：必须含 `users` / `saves` 表且能打开 → 坏文件不会被盖上去；
2. **旧库另存**为 `<库>.before-restore` → 恢复步骤本身出错也能回退；
3. **覆盖 + 删除 `-wal` / `-shm`** → WAL 里可能还留着恢复前的事务帧，
   只覆盖 `.db` 而留着旧 WAL，SQLite 启动时会把旧 WAL 重放回新库；
4. **自检**：重新打开库，打印行数。

> ⚠ 恢复必须在**停服**状态下做。运行中的进程持有 WAL 与文件句柄，
> 覆盖库文件会让它继续往旧 WAL 里写，恢复出来的数据与运行态不一致。

### 6.3 演练记录（2026-11-18，本机实测）

演练脚本：注册账号 A → 建档 → 十连 → 编队 6 人 → 等待挂机账本积累 → 推征（产出遗物）
→ 备份 → **备份之后**再注册账号 B → 停服 → 恢复 → 重启 → 校验。

| 步骤 | 结果 |
|---|---|
| 备份时库里有什么 | `users 1` · `sessions 1` · `saves 1` · `action_log 9` · `relic_instances 3` |
| 恢复 | 成功；`-wal` / `-shm` 已清理；旧库留成 `.before-restore` |
| 恢复后登录 A | `200` —— 恢复点之前的数据完好 |
| 恢复后登录 B | `401` —— 恢复点之后的账号被回滚 |
| 恢复后仓库遗物数 | `3`（与备份时一致） |

结论：**恢复点之后的数据被回滚，恢复点之前的数据完好**。

### 6.4 备份策略建议

| 频率 | 做法 |
|---|---|
| 每小时 | 容器内 `db-backup.mjs`（cron / 平台定时任务） |
| 每天 | 把 `/data/backups` 里的最新一份**同步到异地**（对象存储 / 另一台机器） |
| 保留 | 卷内 7 份 + 异地 30 天 |

---

## 7. 回滚

| 场景 | 操作 |
|---|---|
| **代码回滚** | `docker compose down && docker compose up -d --build`（拉旧镜像 tag 重跑） |
| **数据回滚** | §6.2 的恢复流程 |
| **只回滚数据、代码不动** | 停服 → 恢复 → 起服（同一个流程） |

代码回滚**不影响数据**（数据在卷里，镜像不携带任何数据），
数据回滚**不影响代码**。两者可独立执行，也可先回数据再回代码。

---

## 8. HTTPS

TLS 终止在反向代理这一层，证书与续期交给任意 ACME 客户端（certbot / acme.sh / 云厂商证书服务）。

`deploy/nginx.conf` 里已备好模板（以注释形式给出），启用步骤：

1. 签发证书，把 `fullchain.pem` / `privkey.pem` 挂进 web 容器；
2. 把配置里的 80 端口段改成 ACME 校验 + `301` 到 HTTPS；
3. 打开 443 段（`ssl_protocols TLSv1.2 TLSv1.3`）；
4. 其余 `location` 与现在一致。

> 前端 API 地址是相对路径 `/api` → **开 HTTPS 后仍然同源，不需要 CORS**。

---

## 9. 扩容边界

当前形态（单实例 + SQLite）的硬边界：

| 指标 | 现状 | 说明 |
|---|---|---|
| 并发连接 | 无硬限制，但 SQLite 写是串行的 | 试玩规模（数百人）绰绰有余 |
| 写吞吐 | 单进程串行写 | 动作写库是瓶颈，但每个动作都是毫秒级 |
| 多实例 | **不支持** | SQLite 不支持多进程并发写；多实例会互相覆盖 |

**要横向扩容，必须先做两件事**（按顺序）：

1. **把 SQLite 换成真正的数据库**（PostgreSQL / MySQL）：
   `server/src/db.ts` 是唯一的数据访问层，替换面可控；
   `repo.ts` 里的读写函数签名不用改。
2. **把按账号串行锁换成分布式锁**（`server/src/game/lock.ts`）：
   当前是进程内 Promise 队列，多实例下会失效 → 幂等日志与扣费会重复。

在这两件事做完之前，**不要加 api 副本数**。

---

## 10. 浏览器兼容实测

### 10.1 工具

```bash
npm run build
npm run preview -- --port 4188 --host 127.0.0.1     # 隔离预览服务
node --no-warnings server/src/index.ts --host 127.0.0.1 --port 8791 --db <临时库>
npx tsx tools/capture/screenshot.ts --compat --api http://127.0.0.1:8791 \
  --url http://127.0.0.1:4188 --route /temple
```

- 工具复用截图工具的 **origin 守卫 + 隔离 context**，只访问 `127.0.0.1:4188`；
- 每个配置**单独注册一个账号**（refresh token 一次性轮换，不能复用），
  并先 `save.create` + 十连 → 测到的是**有进度的真实首屏**，不是空壳；
- 报告落 `artifacts/baselines/browser-compat.json`。

### 10.2 实测结果（2026-11-18，本机实测）

| 配置 | 阶段 | FCP | LCP | 传输 | 渲染 | 脚本错误 |
|---|---|---|---|---|---|---|
| 低端 Android（4× CPU 降速 + 4G 限速） | 登录页 | 1,140 ms | 1,140 ms | 95.2 KB | 正常 | 0 |
| 低端 Android（4× CPU 降速 + 4G 限速） | 登录后首页 | 1,632 ms | 1,632 ms | 95.4 KB | 正常 | 0 |
| 微信内置浏览器（Android X5/Chromium + 4G） | 登录页 | 1,092 ms | 1,092 ms | 95.2 KB | 正常 | 0 |
| 微信内置浏览器（Android X5/Chromium + 4G） | 登录后首页 | 1,500 ms | 1,500 ms | 95.4 KB | 正常 | 0 |
| Safari 引擎（WebKit） | 登录页 | 112 ms | 112 ms | 95.2 KB | 正常 | 0 |
| Safari 引擎（WebKit） | 登录后首页 | 162 ms | 216 ms | 535.2 KB | 正常 | 0 |

**读法**：

- **传输体积是未压缩值**（vite preview 不开 gzip）。nginx 上线后 JS 部分
  从 91.8 KB 压到约 **55 KB**（`index.js` gzip 55.09 kB）。
- **WebKit 未限速**（Playwright 只对 Chromium 提供 CDP 限速），
  所以它那一列只证明**引擎兼容性**，不代表弱网表现。
- Safari 首页传输 535 KB 是因为加载了英灵立绘（`public/heroes/*.svg`），
  这些图走 nginx 的 30 天缓存。

### 10.3 真机补测清单（工具覆盖不到的部分）

| 项 | 怎么看 |
|---|---|
| 微信 iOS（WKWebView） | 用微信打开链接 → 确认能登录、能抽卡、分享不崩 |
| 微信 Android（X5） | 同上 |
| 低端安卓真机（2 GB 内存） | 首屏是否卡顿、滚动是否掉帧 |
| 4G / 弱网 | 弱网下登录是否给得出明确提示（不是白屏） |
| iOS Safari 地址栏折叠 | 布局是否被视口高度变化裁掉 |

---

## 11. 上线前人工验证清单

已有 E2E 覆盖（`npm run test:e2e` 会跑）：

| 验证项 | 用例 |
|---|---|
| 注册 | `tests/e2e/login.spec.ts` 「注册后自动进入游戏并出现首启引导」 |
| 跨设备同步 | `tests/e2e/login.spec.ts` 「另一台设备用同一账号登录能看到同样的云端进度」 |
| 断网重连 | `tests/e2e/authority.spec.ts` 「服务端不可达 → 能看进度，不能操作」（含重连后重新拉权威档） |
| 注销 | `tests/e2e/login.spec.ts` 「设置页可以注销账号，注销后回到登录页」 |

**仍需人工确认**（无法自动化）：

- [ ] `SGW_JWT_SECRET` 已是 32+ 位随机串，且不在版本库里
- [ ] `VITE_CONTACT_EMAIL` 已填真实客服邮箱（合规页页脚展示它）
- [ ] 概率公示的**生效日期**与实际发版一致（`src/content/compliance/index.ts` 的 `RATES_PUBLICATION`）
- [ ] 用户协议与隐私披露已由法务/运营过目
- [ ] HTTPS 证书已签发并配置自动续期
- [ ] 备份定时任务已配置，且**异地**副本已验证过一次恢复
- [ ] 客服邮箱能收到玩家来信（运营流程）

---

## 12. 已知限制

1. **镜像未在本机构建验证**：开发机没有 Docker，Dockerfile / compose / nginx.conf
   只做了静态审查，**实际构建由 CI 的 `docker` job 兜底**（buildx 构建 api / web 两个 target）。
2. **WebKit 未限速**：Playwright 不给 WebKit 提供 CDP 限速，Safari 那列只反映引擎兼容性。
3. **真机未实测**：微信内置浏览器与低端安卓真机需要人工补测（清单见 §10.3）。
4. **单实例**：不支持多副本，扩容路径见 §9。
5. **账号找回未实现自助流程**：当前版本只能通过客服邮箱人工核实处理
   （合规页已如实说明，不要在对外材料里写成「自助找回」）。
