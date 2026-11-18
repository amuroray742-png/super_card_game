/**
 * 「store ↔ 真实后端」测试夹具。
 *
 * 服务端权威后，store 的每个动作都走 HTTP。用 Fastify 的 `inject` 把
 * `globalThis.fetch` 转发到**进程内**的后端实例：
 *
 * - 测的是**真实链路**：真实路由 / 真实 core 动作层 / 真实 SQLite；
 * - 但不必起端口（单测里没有端口可争），也不必真的走 socket。
 *
 * ⚠ 别退回「客户端自己算」的老写法来让测试变绿——那等于把
 *   「服务端权威」这条线整个测没了（铁律 #28 / #29）。
 */
import { vi } from 'vitest'
import type { HTTPMethods } from 'fastify'
import { buildApp, type AppBundle } from '../../../server/src/app.ts'

import { serialize } from '../../../src/core/save/serialize.ts'
import type { SaveData } from '../../../src/core/model/types.ts'
import { writeSave } from '../../../server/src/game/repo.ts'

let activeBundle: AppBundle | null = null

/** 测试专用SQLite夹具，绝不经过生产导入/HTTP旁路。 */
export function seedServerSave(userId: number, save: SaveData): void {
  if (!activeBundle) throw new Error('No server harness')
  writeSave(activeBundle.db, userId, serialize(save), save.savedAt, Date.now())
}

export interface ServerHarness {
  bundle: AppBundle
  /** 关闭后端并还原 fetch（可重复调用） */
  close(): Promise<void>
}

/** 起一个进程内后端，并把 globalThis.fetch 转发过去 */
export function startServerHarness(): ServerHarness {
  const bundle = buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    corsOrigins: ['http://127.0.0.1:4173'],
  })

  activeBundle = bundle
  let closed = false

  vi.stubGlobal(
    'fetch',
    (async (input: unknown, init: RequestInit = {}) => {
      const raw =
        typeof input === 'string'
          ? input
          : String((input as { url?: string } | null)?.url ?? input)
      const url = new URL(raw)
      const res = await bundle.app.inject({
        method: (init.method ?? 'GET') as HTTPMethods,
        url: url.pathname + url.search,
        headers: (init.headers ?? {}) as Record<string, string>,
        payload: init.body as string | undefined,
      })
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(res.headers)) {
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
      }
      return new Response(res.body, { status: res.statusCode, headers })
    }) as unknown as typeof fetch,
  )

  return {
    bundle,
    close: async () => {
      if (closed) return
      closed = true
      if (activeBundle === bundle) activeBundle = null
      vi.unstubAllGlobals()
      await bundle.close()
    },
  }
}
