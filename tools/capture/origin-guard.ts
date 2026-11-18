/**
 * origin 守卫（自动化脚本的硬约束）。
 *
 * ## 为什么要有这个模块
 *
 * 历史上写过若干一次性 Playwright 截图脚本，其中一个打开了
 * `http://localhost:5173/#/gacha` 并**真的点了一次十连**——那是玩家正在游玩的
 * dev server origin，于是脚本把玩家的存档抽走了（3000 结晶清零、10 位英灵入库）。
 *
 * 根因不是游戏逻辑，而是**工具和玩家共用同一个 origin**：
 * localStorage 按 origin 隔离，`localhost:5173` 的存档对所有访问该 origin 的
 * 上下文都是同一份。
 *
 * 所以任何自动化（截图 / 抓取 / 验证）都必须：
 * 1. 先过本守卫：禁止访问玩家可能正在使用的 origin；
 * 2. 用**全新隔离的 browser context**（空 localStorage），需要存档就在隔离环境里造。
 *
 * 守卫单独成文件（而不是内联在某个截图脚本里），是为了让**每个**自动化脚本
 * 都复用同一份判定——内联一次就等于「下一次写脚本的人可以再犯一次」。
 */

/**
 * 禁止访问的 host。
 *
 * `localhost` / `127.0.0.1` 都是玩家可能正在使用的开发服务器地址；
 * 端口单独判定（见 `FORBIDDEN_PORTS`），因为隔离预览服务也跑在 127.0.0.1 上。
 */
export const FORBIDDEN_HOSTS = new Set(['localhost', '127.0.0.1'])

/**
 * 禁止访问的端口。
 *
 * `5173` 是 vite dev server 的默认端口——玩家最可能正在这里游玩。
 * 隔离预览服务请用别的端口（例如 4188）。
 */
export const FORBIDDEN_PORTS = new Set(['5173'])

/** 隔离预览服务默认端口（与 dev server 刻意不同） */
export const ISOLATED_PREVIEW_URL = 'http://127.0.0.1:4188'

/**
 * origin 守卫：命中玩家可能正在使用的 origin 直接拒绝执行。
 *
 * @param url 目标地址
 * @throws Error 命中禁止组合时抛错，并给出可用的替代地址
 */
export function assertSafeOrigin(url: string): void {
  const u = new URL(url)
  if (FORBIDDEN_HOSTS.has(u.hostname) && FORBIDDEN_PORTS.has(u.port)) {
    throw new Error(
      [
        `拒绝访问 ${u.origin}：这是玩家可能正在游玩的开发服务器 origin。`,
        '自动化访问会与玩家共用同一份 localStorage，直接改动玩家的真实存档。',
        '请改用隔离的预览服务，例如：',
        '  npm run build && npm run preview -- --port 4188 --host 127.0.0.1',
        `  npx tsx tools/capture/screenshot.ts --url ${ISOLATED_PREVIEW_URL} ...`,
      ].join('\n'),
    )
  }
}
