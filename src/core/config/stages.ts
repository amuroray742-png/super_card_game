/**
 * 章节与关卡（§5.8 / §6.4）。
 *
 * 310 关 = 10 章 × 31 关（第 31 关为章 BOSS）。
 * 关卡门槛 E(c,i) = BASE × CHAPTER_GROWTH^(章序-1) × IN_CHAPTER_GROWTH^(关序-1)，章末 BOSS 再 × BOSS_MULTIPLIER。
 * 章主题通过**环境氛围**表达，不指向任何真实历史人物或族群。
 */
import type { ChapterDef, StageDef } from '../model/types.ts'
import { STAGE } from './economy.ts'

interface ChapterSpec {
  id: number
  name: string
  theme: string
  intro: string
  bossEnemyId: string
  /** 本章普通敌人 id 池 */
  enemyPool: string[]
  /** 本章关卡名素材 */
  stageWords: string[]
}

const CHAPTER_SPECS: ChapterSpec[] = [
  {
    id: 1,
    name: '荒原之息',
    theme: '枯草漫延的旷野上，风里残留着无名的低语',
    intro: '风从没有尽头的地方来，带着早已散去的意志。',
    bossEnemyId: 'boss_wasteland',
    enemyPool: ['wanderer', 'dust_shade'],
    stageWords: ['残阳', '枯井', '断碑', '风信', '荒垒', '沙痕', '白骨野', '旅人', '空帐', '长风'],
  },
  {
    id: 2,
    name: '沙海回响',
    theme: '流沙起伏如潮，蜃景在热浪里不断重塑',
    intro: '沙丘移动，掩埋着名字，也掩埋着回声。',
    bossEnemyId: 'boss_mirage',
    enemyPool: ['sand_mirage', 'burrower'],
    stageWords: ['流沙', '蜃楼', '盐壳', '陷坑', '驼铃', '砾原', '风蚀柱', '枯井', '沙脊', '迷城'],
  },
  {
    id: 3,
    name: '潮汐遗构',
    theme: '被海水反复冲刷的旧日造物，仍在运转',
    intro: '潮水退去，机关依旧在空转。',
    bossEnemyId: 'boss_tide',
    enemyPool: ['tide_construct', 'brine_wisp'],
    stageWords: ['浅滩', '遗构', '盐沼', '潮门', '沉钟', '碎珊瑚', '灯浮', '咸雾', '旧港', '退潮线'],
  },
  {
    id: 4,
    name: '雷壑',
    theme: '裂谷之上雷云常年不散，电流在岩壁间游走',
    intro: '天光被雷声盖过，只剩轮廓。',
    bossEnemyId: 'boss_storm',
    enemyPool: ['spark_wisp', 'storm_golem'],
    stageWords: ['裂谷', '雷髓', '悬台', '电痕', '断桥', '风穴', '雷池', '碎岩', '啸谷', '晦日'],
  },
  {
    id: 5,
    name: '幽林',
    theme: '枝叶交错成穹顶，林中兽影与孢雾同行',
    intro: '林深处传来咀嚼与生长的声音。',
    bossEnemyId: 'boss_grove',
    enemyPool: ['thorn_beast', 'spore_drake'],
    stageWords: ['根道', '孢雾', '古藤', '兽径', '苔阶', '林隙', '枯木', '菌坛', '鹿径', '深荫'],
  },
  {
    id: 6,
    name: '熔火地脉',
    theme: '地脉开裂，熔流在岩层间缓慢移动',
    intro: '空气本身在燃烧。',
    bossEnemyId: 'boss_magma',
    enemyPool: ['magma_hound', 'forge_sprite'],
    stageWords: ['熔道', '炉腔', '烬原', '熔池', '赤脊', '铸坑', '炉心', '火喉', '黑曜', '炽流'],
  },
  {
    id: 7,
    name: '霜寂山原',
    theme: '寒风抹平一切痕迹，连脚印也留不久',
    intro: '雪线之上，声音传不远。',
    bossEnemyId: 'boss_frost',
    enemyPool: ['frost_wraith', 'ice_guard'],
    stageWords: ['霜原', '冻湖', '雪谷', '冰隙', '寒阶', '冰柱', '白垩', '风口', '冻河', '寂岭'],
  },
  {
    id: 8,
    name: '织梦之境',
    theme: '光与影在此折叠成布，织出未曾存在的景象',
    intro: '看见的未必真实，真实的未必被看见。',
    bossEnemyId: 'boss_dream',
    enemyPool: ['dream_weaver', 'illusion'],
    stageWords: ['织台', '幻廊', '镜沼', '丝渊', '倒影', '悬丝', '梦匣', '重影', '眠阶', '絮海'],
  },
  {
    id: 9,
    name: '沉渊',
    theme: '光线在此止步，只有回声证明曾有东西坠落',
    intro: '往下看，比黑暗更黑。',
    bossEnemyId: 'boss_abyss',
    enemyPool: ['abyss_lurker', 'void_echo'],
    stageWords: ['渊口', '空腔', '坠道', '回声井', '断层', '幽渊', '沉环', '无光带', '深喉', '渊底'],
  },
  {
    id: 10,
    name: '星陨',
    theme: '坠落的星辉凝成残片，仍在夜里缓慢燃烧',
    intro: '最后一颗星落下的地方，一切尚未结束。',
    bossEnemyId: 'boss_star',
    enemyPool: ['star_shard', 'void_mirror'],
    stageWords: ['星痕', '坠坑', '辉核', '天穹残片', '陨环', '静轨', '碎星', '夜幕', '长昼', '终焉'],
  },
]

/** 每章总关卡数（30 普通 + 1 BOSS） */
export const STAGES_PER_CHAPTER = STAGE.STAGES_PER_CHAPTER + 1

/** 关卡战力需求（§5.8）—— 单调递增，章边界连续 */
export function stagePowerRequired(chapter: number, index: number, isBoss: boolean): number {
  const base =
    STAGE.BASE_POWER *
    Math.pow(STAGE.CHAPTER_GROWTH, chapter - 1) *
    Math.pow(STAGE.IN_CHAPTER_GROWTH, index - 1)
  return Math.round(isBoss ? base * STAGE.BOSS_MULTIPLIER : base)
}

/**
 * 敌人属性缩放倍率。
 * 与关卡战力需求同曲线，使"战力门槛"与"敌人实际强度"同步增长。
 */
export function stageEnemyScale(chapter: number, index: number, isBoss: boolean): number {
  const scale =
    Math.pow(STAGE.CHAPTER_GROWTH, chapter - 1) *
    Math.pow(STAGE.IN_CHAPTER_GROWTH, index - 1)
  return isBoss ? scale * STAGE.BOSS_MULTIPLIER : scale
}

function buildStages(): StageDef[] {
  const stages: StageDef[] = []
  for (const spec of CHAPTER_SPECS) {
    for (let index = 1; index <= STAGES_PER_CHAPTER; index++) {
      const isBoss = index === STAGES_PER_CHAPTER
      const globalId = (spec.id - 1) * STAGES_PER_CHAPTER + index
      const word = spec.stageWords[(index - 1) % spec.stageWords.length]
      const cycle = Math.floor((index - 1) / spec.stageWords.length)

      const enemyIds = isBoss
        ? [spec.bossEnemyId]
        : [spec.enemyPool[index % spec.enemyPool.length], spec.enemyPool[(index + 1) % spec.enemyPool.length]].slice(
            0,
            index % 3 === 0 ? 2 : 1,
          )

      const scale = stageEnemyScale(spec.id, index, isBoss)

      stages.push({
        id: globalId,
        chapter: spec.id,
        index,
        isBoss,
        name: `${spec.name}·${word}${cycle > 0 ? ` ${cycle + 1}` : ''}`,
        enemyIds,
        enemyScale: scale,
        powerRequired: stagePowerRequired(spec.id, index, isBoss),
        expReward: Math.round(60 * scale),
        silverReward: Math.round(40 * scale),
        dropTableId: isBoss ? `boss_${spec.id}` : `stage_${spec.id}`,
      })
    }
  }
  return stages
}

export const CHAPTERS: readonly ChapterDef[] = CHAPTER_SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  theme: spec.theme,
  intro: spec.intro,
  stageCount: STAGES_PER_CHAPTER,
  bossEnemyId: spec.bossEnemyId,
}))

export const STAGES: readonly StageDef[] = buildStages()

export const STAGE_INDEX = new Map(STAGES.map((s) => [s.id, s]))

export function getStage(id: number): StageDef {
  const stage = STAGE_INDEX.get(id)
  if (!stage) throw new Error(`未知关卡：${id}`)
  return stage
}

export function getChapter(id: number): ChapterDef {
  const chapter = CHAPTERS.find((c) => c.id === id)
  if (!chapter) throw new Error(`未知章节：${id}`)
  return chapter
}

/** 关卡总 */
export const TOTAL_STAGES = STAGES.length
