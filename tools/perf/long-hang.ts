/**
 * 长挂 / 大档压测（roadmap P1-1 验收）。
 *
 * ## 要回答的问题
 *
 * roadmap P1-1 要求：「用高养成档复现 12 小时离线、分批结算及大量遗物，
 * 记录计算耗时、SQLite 写入量、回包大小与移动端渲染」，
 * 以及「按设计基线完成 2 小时长挂和内存验收」。
 *
 * 这个脚本把前三项**量化**出来（渲染由截图工具另行验收）：
 *   ① 12 小时离线：一次补算要多久、落多少行、仓库攒多少件；
 *   ② 分批结算：分几次吃完预算、每次耗时；
 *   ③ 2 小时长挂：1,440 次心跳累计耗时、落库量、内存增长；
 *   ④ 长挂后的第一次普通动作（在线倍率攒下的预算一次性吃掉的耗时）。
 *
 * ## 关键设计
 *
 * - **跑真实服务端代码**（`buildApp` + 真 SQLite 文件），不是模拟：
 *   写入量要按真实事务算，内存要按真实进程算。
 * - **游戏时钟可控**（改 `Date.now`），但**计时用真实时钟**（`performance.now`）——
 *   否则测出来的全是「虚拟时间」，毫无意义。
 * - **不留垃圾**：数据库文件落在临时目录，跑完删掉。
 *
 * 用法：
 * ```bash
 * npx tsx tools/perf/long-hang.ts
 * npx tsx tools/perf/long-hang.ts --relics 2000 --hours 12 --hang-hours 2
 * ```
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type AppBundle } from '../../server/src/app.ts'
import { GameService } from '../../server/src/game/service.ts'
import { UserLock } from '../../server/src/game/lock.ts'
import { countRelics, readRelics, readSave, writeSave } from '../../server/src/game/repo.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { preferredSlotForRole } from '../../src/core/systems/team.ts'
import { generateRelic, makeRelicUid } from '../../src/core/systems/relic.ts'
import {
  readSaveBody,
  restoreSave,
  serializePublicSave,
} from '../../src/core/save/serialize.ts'
import { IDLE, RELIC } from '../../src/core/config/economy.ts'
import { Rng } from '../../src/core/rng.ts'
import type { SaveData } from '../../src/core/model/types.ts'
import '../../src/core/config/relics.ts'
import '../../src/core/config/enemies.ts'

// ─────────────────────────── 参数 ───────────────────────────

const args = process.argv.slice(2)
function numArg(flag: string, fallback: number): number {
  const i = args.indexOf(flag)
  if (i < 0) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}

/** 离线时长（小时） */
const OFFLINE_HOURS = numArg('--hours', 12)
/** 长挂时长（小时） */
const HANG_HOURS = numArg('--hang-hours', 2)
/** 预置遗物件数（模拟已有仓库） */
const PRE_RELICS = numArg('--relics', 500)
/** 分批结算的批次数 */
const CHUNKS = numArg('--chunks', 4)

// ─────────────────────────── 可控时钟 ───────────────────────────

const realNow = Date.now
let fakeNow = realNow()
Date.now = () => fakeNow

/** 游戏时间前进若干毫秒（只动虚拟时钟，不动真实计时） */
function advance(ms: number): void {
  fakeNow += ms
}

/** 真实耗时（毫秒） */
function elapsedSince(start: number): number {
  return Math.round(performance.now() - start)
}

// ─────────────────────────── 造档 ───────────────────────────

/** 造一支满养成队伍（6 名 SSR，按定位排前后排） */
function buildMaxTeam(save: SaveData): void {
  const roster = HEROES.filter((h) => h.rarity === 'SSR').slice(0, 6)
  const front = roster.filter((h) => preferredSlotForRole(h.role) === 'front')
  const back = roster.filter((h) => preferredSlotForRole(h.role) === 'back')
  const frontLine = [...front, ...back].slice(0, 3)
  const backLine = [...back, ...front].filter((h) => !frontLine.includes(h)).slice(0, 3)
  const ordered = [...frontLine, ...backLine]

  const rng = new Rng(20261110)
  let seq = 0
  ordered.forEach((def, slot) => {
    save.heroes[def.id] = {
      ...createHeroState(def.id, fakeNow),
      level: 240,
      star: 6,
      skillLevels: [20, 20, 20],
      coreAwakened: true,
    }
    save.team.slots[slot] = def.id
    const setId = def.relicAffinity[0]
    for (let i = 0; i < 6; i++) {
      seq += 1
      const relic = generateRelic(`${setId}_${(i % 5) + 1}`, rng, 60, makeRelicUid(seq))
      save.relics.push(relic)
      save.equipped[`${def.id}#${i}`] = { heroId: def.id, relicId: relic.uid }
    }
  })
  save.relicSeq = seq
}

/** 预置一堆仓库遗物（模拟长挂后的存量） */
function addStockRelics(save: SaveData, count: number): void {
  const rng = new Rng(99887766)
  let seq = save.relicSeq ?? 0
  for (let i = 0; i < count; i++) {
    seq += 1
    save.relics.push(generateRelic('set_zhanshen_1', rng, 1, makeRelicUid(seq)))
  }
  save.relicSeq = seq
}

// ─────────────────────────── 度量 ───────────────────────────

/** 累计改动的行数（SQLite total_changes） */
function totalChanges(db: { prepare: (sql: string) => { get: () => unknown } }): number {
  return (db.prepare('SELECT total_changes() AS n').get() as unknown as { n: number }).n
}

/**
 * 堆内存（MB）。
 *
 * ⚠ 先尽力跑一次 GC 再读——否则读到的是「还没来得及回收的垃圾」，
 *   长挂看起来像内存泄漏，其实只是 V8 懒得回收。
 *   想看准数请用 `node --expose-gc --import tsx tools/perf/long-hang.ts`。
 */
function heapMb(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc) {
    gc()
    gc()
  }
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10
}

/** 人读体积 */
function kb(bytes: number): string {
  return `${Math.round((bytes / 1024) * 10) / 10} KB`
}

function line(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(22, '·')} ${value}`)
}

/** 读服务端完整存档（主体 + 遗物表） */
function readFull(db: Parameters<typeof readRelics>[0], userId: number): SaveData {
  const row = readSave(db, userId)!
  const { body, legacyRelics } = readSaveBody(row.payload)
  const relics = legacyRelics ?? readRelics(db, userId)
  return restoreSave(body, relics)
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sgw-perf-'))
  const dbPath = join(dir, 'perf.db')
  let bundle: AppBundle | undefined
  try {
    bundle = buildApp({
      dbPath,
      jwtSecret: 'perf-secret',
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 3600,
      corsOrigins: [],
    })
    const service = new GameService(bundle.db, new UserLock())

    // 注册 + 造档（用户名规则：3-16 位，字母数字下划线）
    const reg = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: `perf_${String(fakeNow % 1_000_000).padStart(6, '0')}`,
        password: 'correct-horse-1',
      },
    })
    const userId = reg.json().user?.id as number
    if (!userId) throw new Error(`注册失败：${reg.body}`)

    const save = createNewSave(fakeNow, 20240607)
    buildMaxTeam(save)
    addStockRelics(save, PRE_RELICS)
    // ⚠ **挂机改版 v11**：主线通道**跟随最新通关关卡**（`stageId = null`）。
    //   主线推进改走**手动挑战**，挂机不再自己往前推 ⇒ 这里必须先把主线**打通关**，
    //   否则主线通道解析不出目标（`clearedStage = 0` ⇒ 无目标 ⇒ 离线补算产出恒为 0），
    //   压测就测不到「一次吃完预算」的真实路径了。
    save.campaign.clearedStage = 4
    // 整包落库（与存量大档同一条路径：服务端读取时会自动拆表）
    writeSave(bundle.db, userId, JSON.stringify(save), save.savedAt, fakeNow)

    console.log('══ 长挂 / 大档压测 ══')
    line('离线时长', `${OFFLINE_HOURS} 小时`)
    line('长挂时长', `${HANG_HOURS} 小时`)
    line('预置遗物', `${PRE_RELICS} 件`)
    line('库存上限', `${RELIC.INVENTORY_CAP} 件`)
    console.log('')

    // ── ① 离线补算（一次吃完预算）──
    const changesBefore = totalChanges(bundle.db)
    advance(OFFLINE_HOURS * 3600 * 1000)
    const t0 = performance.now()
    const loaded = await service.load(userId)
    const settleMs = elapsedSince(t0)
    const changesAfterOffline = totalChanges(bundle.db) - changesBefore
    const relicCount = countRelics(bundle.db, userId)
    const stored = readSave(bundle.db, userId)!
    const bodyBytes = stored.payload.length
    const fullSave = readFull(bundle.db, userId)
    const clientBytes = serializePublicSave(fullSave).length

    console.log('① 离线补算（一次吃完预算）')
    line('补算耗时', `${settleMs} ms`)
    line('结算次数', loaded?.offline?.rolls ?? 0)
    line('落库行数', changesAfterOffline)
    line('仓库遗物', `${relicCount} 件`)
    line('存档主体', kb(bodyBytes))
    line('客户端回包', kb(clientBytes))
    console.log('')

    // ── ② 分批结算 ──
    console.log('② 分批结算')
    let chunkTotal = 0
    for (let i = 0; i < CHUNKS; i++) {
      const c0 = performance.now()
      const res = await service.execute(userId, {
        actionId: `chunk-${i}`,
        // ⚠ 挂机改版 v11：次数**不再由客户端传**（旧版是 `battles`），
        //   服务端按各通道的 `effectiveMs` 决定掷几次。
        action: { type: 'idle.tick' },
      })
      const ms = elapsedSince(c0)
      chunkTotal += ms
      const rolls = (res.result as { rolls?: number } | undefined)?.rolls ?? 0
      line(`第 ${i + 1} 批`, `${ms} ms · ${rolls} 次`)
    }
    line('分批合计', `${chunkTotal} ms`)
    console.log('')

    // ── ③ 长挂：心跳循环 ──
    console.log(`③ 长挂 ${HANG_HOURS} 小时（心跳 ${IDLE.HEARTBEAT_INTERVAL_MS / 1000} 秒一次）`)
    const beats = Math.round((HANG_HOURS * 3600 * 1000) / IDLE.HEARTBEAT_INTERVAL_MS)
    const heap0 = heapMb()
    const changesBeforeHang = totalChanges(bundle.db)
    const tHang = performance.now()
    for (let i = 0; i < beats; i++) {
      advance(IDLE.HEARTBEAT_INTERVAL_MS)
      await service.execute(userId, { actionId: `hb-${i}`, action: { type: 'idle.heartbeat' } })
    }
    const hangMs = elapsedSince(tHang)
    const changesHang = totalChanges(bundle.db) - changesBeforeHang
    const heap1 = heapMb()
    const dbBytes = statSync(dbPath).size
    const storedAfterHang = readSave(bundle.db, userId)!

    line('心跳次数', `${beats} 次`)
    line('累计耗时', `${hangMs} ms（均 ${Math.round(hangMs / beats)} ms/次）`)
    line('落库行数', changesHang)
    line('存档主体', kb(storedAfterHang.payload.length))
    line('数据库文件', kb(dbBytes))
    line('堆内存', `${heap0} MB → ${heap1} MB`)
    console.log('')

    // ── ④ 长挂后的第一次普通动作（账本一次性结算的风险点）──
    console.log('④ 长挂后的第一次普通动作（在线倍率攒下的预算一次性吃掉）')
    advance(IDLE.HEARTBEAT_INTERVAL_MS)
    const tFlush = performance.now()
    await service.execute(userId, { actionId: 'flush-1', action: { type: 'settings.update', speed: 2 } })
    const flushMs = elapsedSince(tFlush)
    line('耗时', `${flushMs} ms`)
    line('仓库遗物', `${countRelics(bundle.db, userId)} 件`)
    console.log('')

    // ── 结论 ──
    console.log('══ 验收口径 ══')
    const ok = (label: string, pass: boolean, detail: string) =>
      line(label, pass ? `PASS ${detail}` : `WARN ${detail}`)
    ok('离线补算耗时', settleMs < 5_000, `${settleMs} ms（阈值 5000 ms）`)
    ok('长挂心跳均耗时', hangMs / beats < 50, `${Math.round(hangMs / beats)} ms/次（阈值 50 ms）`)
    ok('长挂后首次动作', flushMs < 5_000, `${flushMs} ms（阈值 5000 ms）`)
    ok('存档主体与遗物数无关', bodyBytes < 200_000, `${kb(bodyBytes)}（阈值 200 KB）`)
  } finally {
    await bundle?.close()
    rmSync(dir, { recursive: true, force: true })
    Date.now = realNow
  }
}

void main()
