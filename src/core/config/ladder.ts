/**
 * PVE 长线挑战 · 三队天梯（§9.1 / roadmap P2-2）—— **梯队数据表**。
 *
 * ── 玩法 ──────────────────────────────────────────────────────────────
 * 玩家用自己收集的英灵组成 **3 队**（每队最多 6 人），依次挑战 **3 个敌方梯队**。
 * 一轮 = 3 场战斗；每周一轮（北京时区周一零点切换）。
 *
 * ── 合规红线（硬要求）────────────────────────────────────────────────
 * 敌方梯队**全部是灵体 / 妖异 / 器械造物**（`config/enemies.ts` 的敌人库），
 * **不是历史人物**。梯队名为「演武场投影」式的架空设定，
 * UI 必须标注为**架空演武**，不得暗示历史上真实发生过敌对关系。
 *
 * 原案（§9.1）写的是「敌方梯队由历史人物组成的虚构阵营呈现」，
 * 与本项目的敌人合规红线冲突 → **以合规红线为准**：改用灵体投影。
 *
 * ── 数据驱动 ──────────────────────────────────────────────────────────
 * 梯队组成只在本文件里；战斗代码遍历本表，不硬编码敌人 id。
 */
import { LADDER } from './economy.ts'

/** 一个敌方梯队 */
export interface LadderSquadDef {
  /** 梯队 id（唯一） */
  id: string
  /** 梯队名（架空演武口径） */
  name: string
  /** 敌人 id 列表（取自 `config/enemies.ts`，长度 = LADDER.SQUAD_SIZE） */
  enemyIds: string[]
}

/** 一个梯队层（与 `TIERS` 的段位一一对应） */
export interface LadderTierDef {
  /** 层号（0 起，与 `TIERS` 下标对应） */
  index: number
  /** 层名（与段位同名，便于展示） */
  name: string
  /** 3 个敌方梯队：依次对应玩家的第 1 / 2 / 3 队 */
  squads: LadderSquadDef[]
}

/**
 * 梯队层表。
 *
 * 层的顺序与强度对应主线的推进节奏（层 0 ≈ 第 1 章，层 7 ≈ 第 8~10 章），
 * 但**独立于主线进度**：段位只由天梯积分决定。
 */
export const LADDER_TIERS: readonly LadderTierDef[] = [
  {
    index: 0,
    name: '残魂列阵',
    squads: [
      { id: 't0_a', name: '残魂列阵 · 前哨', enemyIds: ['wanderer', 'wanderer', 'wanderer', 'dust_shade', 'dust_shade', 'dust_shade'] },
      { id: 't0_b', name: '残魂列阵 · 回廊', enemyIds: ['wanderer', 'wanderer', 'dust_shade', 'dust_shade', 'sand_mirage', 'sand_mirage'] },
      { id: 't0_c', name: '残魂列阵 · 沙线', enemyIds: ['dust_shade', 'dust_shade', 'sand_mirage', 'sand_mirage', 'burrower', 'burrower'] },
    ],
  },
  {
    index: 1,
    name: '蜃影回廊',
    squads: [
      { id: 't1_a', name: '蜃影回廊 · 外环', enemyIds: ['sand_mirage', 'sand_mirage', 'sand_mirage', 'burrower', 'burrower', 'burrower'] },
      { id: 't1_b', name: '蜃影回廊 · 内环', enemyIds: ['sand_mirage', 'sand_mirage', 'burrower', 'burrower', 'tide_construct', 'tide_construct'] },
      { id: 't1_c', name: '蜃影回廊 · 潮线', enemyIds: ['burrower', 'burrower', 'burrower', 'tide_construct', 'tide_construct', 'tide_construct'] },
    ],
  },
  {
    index: 2,
    name: '潮汐遗构',
    squads: [
      { id: 't2_a', name: '潮汐遗构 · 浅滩', enemyIds: ['tide_construct', 'tide_construct', 'tide_construct', 'brine_wisp', 'brine_wisp', 'brine_wisp'] },
      { id: 't2_b', name: '潮汐遗构 · 盐沼', enemyIds: ['tide_construct', 'tide_construct', 'brine_wisp', 'brine_wisp', 'spark_wisp', 'spark_wisp'] },
      { id: 't2_c', name: '潮汐遗构 · 沉钟', enemyIds: ['brine_wisp', 'brine_wisp', 'brine_wisp', 'spark_wisp', 'spark_wisp', 'spark_wisp'] },
    ],
  },
  {
    index: 3,
    name: '雷髓裂谷',
    squads: [
      { id: 't3_a', name: '雷髓裂谷 · 崖底', enemyIds: ['spark_wisp', 'spark_wisp', 'spark_wisp', 'storm_golem', 'storm_golem', 'storm_golem'] },
      { id: 't3_b', name: '雷髓裂谷 · 雷池', enemyIds: ['spark_wisp', 'spark_wisp', 'storm_golem', 'storm_golem', 'thorn_beast', 'thorn_beast'] },
      { id: 't3_c', name: '雷髓裂谷 · 晦日', enemyIds: ['storm_golem', 'storm_golem', 'storm_golem', 'thorn_beast', 'thorn_beast', 'thorn_beast'] },
    ],
  },
  {
    index: 4,
    name: '幽林菌穹',
    squads: [
      { id: 't4_a', name: '幽林菌穹 · 根道', enemyIds: ['thorn_beast', 'thorn_beast', 'thorn_beast', 'spore_drake', 'spore_drake', 'spore_drake'] },
      { id: 't4_b', name: '幽林菌穹 · 菌坛', enemyIds: ['thorn_beast', 'thorn_beast', 'spore_drake', 'spore_drake', 'magma_hound', 'magma_hound'] },
      { id: 't4_c', name: '幽林菌穹 · 鹿径', enemyIds: ['spore_drake', 'spore_drake', 'spore_drake', 'magma_hound', 'magma_hound', 'magma_hound'] },
    ],
  },
  {
    index: 5,
    name: '熔心地脉',
    squads: [
      { id: 't5_a', name: '熔心地脉 · 熔道', enemyIds: ['magma_hound', 'magma_hound', 'magma_hound', 'forge_sprite', 'forge_sprite', 'forge_sprite'] },
      { id: 't5_b', name: '熔心地脉 · 铸坑', enemyIds: ['magma_hound', 'magma_hound', 'forge_sprite', 'forge_sprite', 'frost_wraith', 'frost_wraith'] },
      { id: 't5_c', name: '熔心地脉 · 喉口', enemyIds: ['forge_sprite', 'forge_sprite', 'forge_sprite', 'frost_wraith', 'frost_wraith', 'frost_wraith'] },
    ],
  },
  {
    index: 6,
    name: '霜寂雪原',
    squads: [
      { id: 't6_a', name: '霜寂雪原 · 霜原', enemyIds: ['frost_wraith', 'frost_wraith', 'frost_wraith', 'ice_guard', 'ice_guard', 'ice_guard'] },
      { id: 't6_b', name: '霜寂雪原 · 冻湖', enemyIds: ['frost_wraith', 'frost_wraith', 'ice_guard', 'ice_guard', 'dream_weaver', 'dream_weaver'] },
      { id: 't6_c', name: '霜寂雪原 · 白垩', enemyIds: ['ice_guard', 'ice_guard', 'ice_guard', 'dream_weaver', 'dream_weaver', 'dream_weaver'] },
    ],
  },
  {
    index: 7,
    name: '织梦沉渊',
    squads: [
      { id: 't7_a', name: '织梦沉渊 · 织台', enemyIds: ['dream_weaver', 'dream_weaver', 'dream_weaver', 'illusion', 'illusion', 'illusion'] },
      { id: 't7_b', name: '织梦沉渊 · 幻廊', enemyIds: ['dream_weaver', 'dream_weaver', 'illusion', 'illusion', 'abyss_lurker', 'abyss_lurker'] },
      { id: 't7_c', name: '织梦沉渊 · 渊底', enemyIds: ['illusion', 'illusion', 'abyss_lurker', 'abyss_lurker', 'star_shard', 'star_shard'] },
    ],
  },
]

/** 梯队层表索引 */
export const LADDER_TIER_INDEX = new Map(LADDER_TIERS.map((t) => [t.index, t]))

/**
 * 空的三队阵容（3 队 × 6 槽）。
 *
 * 放在**配置层**而不是战斗逻辑层：存档 schema 也要用它建初始结构，
 * 而 `core/save/schema.ts` 不该为了一个空数组把整条战斗链拖进来。
 */
export function emptyLadderSquads(): (string | null)[][] {
  return Array.from({ length: LADDER.SQUAD_COUNT }, () =>
    Array.from({ length: LADDER.SQUAD_SIZE }, () => null as string | null))
}
