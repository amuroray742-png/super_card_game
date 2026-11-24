# syntax=docker/dockerfile:1
#
# 厂商中立的试玩部署件（roadmap P1-3「试玩部署」）。
#
# 三个阶段：
#   web-build —— 构建前端静态资源（dist/）
#   api       —— 服务端运行时（Fastify + node:sqlite），零原生依赖
#   web       —— nginx：托管 SPA + 反向代理 /api
#
# 为什么拆成两个容器：
#   静态站点与 API 的伸缩特性、发布节奏、回滚粒度都不同；
#   而且**厂商中立**——任何支持 Docker 与反向代理的托管都能跑
#   （单机 VPS / 容器平台 / 内网服务器都不需要改配置）。
#
# ⚠ 镜像源保持 node:24（与本地一致）：
#   服务端用 Node 24 内置的 `node:sqlite`，不需要编译原生模块，
#   换镜像源就可能退回 better-sqlite3 而要求编译链。

# ── 阶段 1：前端构建 ──────────────────────────────────────────
FROM node:24-alpine AS web-build
WORKDIR /app

# 先只拷依赖清单 → 依赖层可被缓存（改业务代码不会重装依赖）
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 前端默认走**同源** `/api`（base 留空 = 同源）：同一份构建在任何域名下都指向同源，
# 由 nginx 反向代理到 api 容器 —— 换域名 / 换托管不必重新构建（厂商中立的关键）。
#
# ⚠ base 只放「**后端 origin**」，**绝不能写 `/api`**：
#   客户端的请求路径本身以 `/api/` 开头（`/api/auth/register` …），
#   base 只负责前缀 ⇒ 写 `/api` 会拼成 `/api/api/auth/register` ⇒ 404，
#   生产环境会**所有接口都挂**（且只在真部署时才暴露）。
#   只有「前端与后端不同源」（静态托管 + 独立 API 域名）才需要填绝对地址，
#   例如 `https://api.example.com`。
ARG VITE_API_BASE=""
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

# ── 阶段 2：服务端运行时 ──────────────────────────────────────
FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 服务端直接 import core（src/core）→ core 必须一起进镜像；
# core 的英雄配置还会 import src/content/bios → content 一并带上。
COPY server ./server
COPY src/core ./src/core
COPY src/content ./src/content

# 备份 / 恢复脚本要进镜像：运维要在 api 容器里直接跑，
# 否则得把文件从容器里拷出来（跨机器更麻烦）。
COPY tools/db-backup.mjs tools/db-restore.mjs ./tools/

# 存档与数据库目录（compose 里把卷挂到这里）
RUN mkdir -p /data
ENV SGW_HOST=0.0.0.0 \
    SGW_PORT=8787 \
    SGW_DB_PATH=/data/app.db

EXPOSE 8787

# 健康检查：compose 用它决定何时把流量切进来
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接用 Node 24 的原生 TypeScript 执行（无构建步骤）
CMD ["node", "--no-warnings", "server/src/index.ts"]

# ── 阶段 3：静态站点 + 反向代理 ───────────────────────────────
FROM nginx:1.27-alpine AS web
COPY --from=web-build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
