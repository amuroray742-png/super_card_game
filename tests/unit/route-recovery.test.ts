/**
 * 路由动态导入失败的兜底策略（presentation/utils/route-recovery.ts）。
 *
 * ⚠ 本文件不需要浏览器：兜底策略模块零 DOM 依赖，可直接在 Node 下测。
 *
 * 背景：懒加载组件拉不到时，Vue Router 会中止导航，而玩家只看到「页面打不开」
 * （初始导航失败 = 整页白屏；后续导航失败 = URL 变了画面没变）。
 * 这个模块负责判定「是不是动态导入失败」并给出**有上限**的恢复动作。
 */
import { describe, expect, it } from 'vitest'
import {
  isChunkLoadError,
  planRouteRecovery,
  ROUTE_FALLBACK,
} from '../../src/presentation/utils/route-recovery.ts'

/** Chrome 的典型报错（动态 import 的组件拉取失败） */
function chromeChunkError(url = 'http://localhost:5173/src/presentation/views/BackpackView.vue') {
  return new TypeError(`Failed to fetch dynamically imported module: ${url}`)
}

describe('动态导入失败的识别', () => {
  it('认得出 Chrome 的动态导入报错', () => {
    expect(isChunkLoadError(chromeChunkError())).toBe(true)
  })

  it('认得出 Firefox / Safari / Rollup 的措辞', () => {
    const samples = [
      new TypeError('error loading dynamically imported module: https://x/y.js'),
      new Error('Importing a module script failed.'),
      new Error('Loading module script failed.'),
      new Error('Failed to load module script.'),
      new Error('Failed to fetch module script.'),
    ]
    for (const e of samples) expect(isChunkLoadError(e)).toBe(true)
  })

  it('嵌套在 cause 里的动态导入报错也算数', () => {
    const wrapped = Object.assign(new Error('wrapped'), {
      cause: new TypeError('Failed to fetch dynamically imported module: /a.js'),
    })
    expect(isChunkLoadError(wrapped)).toBe(true)
  })

  it('业务错误不误判成动态导入失败', () => {
    expect(isChunkLoadError(new Error('存档读取失败'))).toBe(false)
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
    expect(isChunkLoadError('')).toBe(false)
  })
})

describe('兜底动作的分配', () => {
  it('第一次失败 → 重载，并记住要去哪（不能只回原地）', () => {
    const action = planRouteRecovery(chromeChunkError(), 0, '/forge')
    expect(action.kind).toBe('reload')
    if (action.kind !== 'reload') throw new Error('unreachable')
    expect(action.target).toBe('/forge')
  })

  it('没给目标路由时退回兜底路由', () => {
    const action = planRouteRecovery(chromeChunkError(), 0)
    expect(action.kind).toBe('reload')
    if (action.kind !== 'reload') throw new Error('unreachable')
    expect(action.target).toBe(ROUTE_FALLBACK)
  })

  it('第二次失败 → 回退首页并给出提示', () => {
    const action = planRouteRecovery(chromeChunkError(), 1)
    expect(action.kind).toBe('redirect')
    if (action.kind !== 'redirect') throw new Error('unreachable')
    expect(action.to).toBe(ROUTE_FALLBACK)
    expect(action.message.length).toBeGreaterThan(0)
  })

  it('第三次失败 → 只提示，不再重载（防死循环）', () => {
    const action = planRouteRecovery(chromeChunkError(), 2)
    expect(action.kind).toBe('notify')
    const again = planRouteRecovery(chromeChunkError(), 9)
    expect(again.kind).toBe('notify')
  })

  it('与动态导入无关的错误不插手', () => {
    expect(planRouteRecovery(new Error('存档读取失败'), 0).kind).toBe('ignore')
    expect(planRouteRecovery(new Error('存档读取失败'), 1).kind).toBe('ignore')
  })
})
