/**
 * 一键拉起前后端开发服务。
 *
 * 登录系统引入真实后端后，只跑 `npm run dev`（前端）的话，登录页会报
 * 「无法连接服务器」——这是最容易踩的一个坑。这里把后端与前端一起拉起，
 * 任一进程退出就一并收摊。
 *
 *   npm run dev:all
 *
 * 不用 `concurrently` 之类的额外依赖：一个 Node 脚本足够，且跨平台。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'

const children = new Set()
let shuttingDown = false

/** 结束子进程（Windows 下要连同它拉起的孙进程一起收） */
function killTree(child) {
  try {
    if (IS_WINDOWS) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    // 进程已经没了，忽略
  }
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) killTree(child)
  setTimeout(() => process.exit(code), 300)
}

function start(name, command) {
  // 命令整体交给 shell（不拆成 args），避免 Node 的 shell+args 弃用警告，
  // 同时让 package.json 的 scripts 保持唯一口径。
  const child = spawn(command, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  })
  children.add(child)
  child.on('exit', (code) => {
    children.delete(child)
    if (!shuttingDown) {
      console.error(`[dev-all] ${name} 已退出（code=${code}），另一个进程也一并停止`)
      shutdown(code ?? 0)
    }
  })
  return child
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('[dev-all] 后端 → http://127.0.0.1:8787')
console.log('[dev-all] 前端 → http://localhost:5173')
console.log('[dev-all] Ctrl+C 一起停止')

start('后端', 'npm run server:dev')
start('前端', 'npm run dev')
