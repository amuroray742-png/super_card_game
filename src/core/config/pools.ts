/**
 * 卡池配置（§7.1）。
 *
 * 概率全部引用 economy.BASE_RATES —— 公示与抽卡执行共用同一数据源（合规硬要求）。
 */
import type { PoolDef, Rarity } from '../model/types.ts'
import { BASE_RATES } from './economy.ts'
import { HEROES } from './heroes/index.ts'

const RATES = { ...BASE_RATES }

/** 常驻池：全部英灵 */
export const POOL_STANDARD: PoolDef = {
  id: 'standard',
  name: '万灵殿',
  desc: '收录全部英灵的常驻卡池。保底计数与诸池共享继承。',
  heroIds: HEROES.map((h) => h.id),
  rates: RATES,
}

/** 纪元池 · 诸子百家：SR 及以上中国史英灵 */
export const POOL_CHINA: PoolDef = {
  id: 'china',
  name: '纪元池 · 诸子百家',
  desc: '收录 SR 及以上的中国史英灵。保底计数与万灵殿共享继承。',
  heroIds: [],
  selection: { rarity: ['SSR', 'SR'], region: ['中国'] },
  rates: RATES,
}

/** 纪元池 · 寰宇纪年：SR 及以上全球英灵 */
export const POOL_WORLD: PoolDef = {
  id: 'world',
  name: '纪元池 · 寰宇纪年',
  desc: '收录 SR 及以上的全球英灵。保底计数与万灵殿共享继承。',
  heroIds: [],
  selection: { rarity: ['SSR', 'SR'], region: ['中国', '马其顿', '罗马', '迦太基', '古希腊', '法国', '英国', '英格兰', '美国', '意大利', '波兰', '蒙古', '法兰西', '中世纪', '近代', '文艺复兴'] },
  rates: RATES,
}

/** 新手池：首次可见，10 连保底 1 位指定 SSR */
export const POOL_NEWBIE: PoolDef = {
  id: 'newbie',
  name: '初临之赐',
  desc: '仅在首次抽卡时可见。首次十连享 1 位传说英灵保底。',
  heroIds: [],
  selection: { rarity: ['SSR', 'SR', 'R', 'N'] },
  rates: RATES,
  guaranteedHeroId: 'xiangyu',
  newbieOnly: true,
}

export const POOLS: readonly PoolDef[] = [POOL_STANDARD, POOL_CHINA, POOL_WORLD, POOL_NEWBIE]

export const POOL_INDEX = new Map(POOLS.map((p) => [p.id, p]))

export function getPool(id: string): PoolDef {
  const pool = POOL_INDEX.get(id)
  if (!pool) throw new Error(`未知卡池：${id}`)
  return pool
}

/**
 * 解析卡池实际可抽取的英灵 id 列表。
 * 显式 heroIds 优先；否则按 selection 规则动态选取（数据驱动，零硬编码）。
 */
export function resolvePoolHeroIds(pool: PoolDef): string[] {
  if (pool.heroIds.length > 0) return pool.heroIds
  const sel = pool.selection
  if (!sel) return []
  return HEROES.filter((h) => {
    if (sel.rarity && !sel.rarity.includes(h.rarity)) return false
    if (sel.region && !sel.region.includes(h.region)) return false
    return true
  }).map((h) => h.id)
}

/** 按稀有度把英灵 id 分组 */
export function groupByRarity(heroIds: string[]): Record<Rarity, string[]> {
  const groups: Record<Rarity, string[]> = { SSR: [], SR: [], R: [], N: [] }
  for (const id of heroIds) {
    const hero = HEROES.find((h) => h.id === id)
    if (!hero) continue
    groups[hero.rarity].push(id)
  }
  return groups
}
