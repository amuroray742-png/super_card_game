/**
 * 章节与关卡（§5.8 / §6.4）。
 *
 * 310 关 = 10 章 × 31 关（第 31 关为章 BOSS）。
 * 关卡难度由 `STAGE.SCALE_ANCHORS`（逐章锚点，真实难度）与
 * `STAGE.POWER_ANCHORS`（逐章锚点，战力门槛）两条曲线决定，详见 economy.ts。
 * 章主题通过**环境氛围**表达，不指向任何真实历史人物或族群。
 */
import type { ChapterDef, StageDef } from '../model/types.ts'
import { STAGE } from './economy.ts'
import { getEnemy } from './enemies.ts'
import { computePower } from '../systems/stats.ts'

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

/**
 * 敌人属性缩放倍率（**真实难度曲线**）。
 *
 * 每章首关用该章锚点，章内 30 个普通关等比铺开到 `IN_CHAPTER_SPAN`，
 * 章末 BOSS 再乘 `BOSS_MULTIPLIER`。
 * 全曲线严格递增（章内递增 + 章边界由锚点比 ≥ 章内总跨度 保证）。
 *
 * ⚠ 锚点表可注入（`scaleAnchors`）：`tools/balance/recalibrate.ts` 的标定迭代
 *   需要用**上一轮算出来的锚点**再跑一遍推进模拟（锚点与推进互相依赖），
 *   而配置里的锚点是 `as const` 的标定值，不能就地改。
 *   公式本身只有这一份（铁律 #4）——注入的锚点与配置锚点走的是同一个函数。
 */
export function stageEnemyScaleFor(
  chapter: number,
  index: number,
  isBoss: boolean,
  scaleAnchors: readonly number[] = STAGE.SCALE_ANCHORS,
): number {
  const step = Math.pow(STAGE.IN_CHAPTER_SPAN, 1 / STAGE.STAGES_PER_CHAPTER)
  const base = scaleAnchors[chapter - 1] * Math.pow(step, index - 1)
  return isBoss ? base * STAGE.BOSS_MULTIPLIER : base
}

export function stageEnemyScale(chapter: number, index: number, isBoss: boolean): number {
  return stageEnemyScaleFor(chapter, index, isBoss)
}

/**
 * 关卡战力需求（§5.8）—— **软提示 + 挂机放行线**，单调递增，章边界连续。
 *
 * 章内按等比曲线从「上一章 BOSS 门槛 × CHAPTER_GATE_GAP」升到本章 BOSS 门槛，
 * 于是每章首关严格高于上一章 BOSS（章边界不倒挂）。
 *
 * ⚠ 门槛不是难度本身，而是「玩家推进到这里需要多少战力」的标定值；
 *   它必须**不晚于**该关真正打得赢的时刻，否则挂机会把玩家推进到打不过的关卡。
 *   详见 economy.ts 的 STAGE.POWER_ANCHORS 注释。
 */
export function stagePowerRequiredFor(
  chapter: number,
  index: number,
  isBoss: boolean,
  powerAnchors: readonly number[] = STAGE.POWER_ANCHORS,
): number {
  const lo =
    chapter === 1
      ? STAGE.FIRST_STAGE_POWER
      : powerAnchors[chapter - 2] * STAGE.CHAPTER_GATE_GAP
  const hi = powerAnchors[chapter - 1]
  // ⚠ 锚点异常时（hi ≤ lo，含 0）不能让门槛算出 NaN / 递减曲线：
  //   NaN 会让挂机的放行判断 `power >= next.powerRequired` 恒为 false
  //   → 玩家被**静默**卡在第 1 关（打了一整天，零推进）。
  //   这里兜底成「不低于上一章门槛」，宁可略紧也不产生坏值。
  const safeHi = Number.isFinite(hi) && hi > lo ? hi : lo
  // index 1..30 为普通关（等比铺开），章末 BOSS 直接取本章 BOSS 锚点
  const t = isBoss ? 1 : (index - 1) / STAGE.STAGES_PER_CHAPTER
  return Math.round(lo * Math.pow(safeHi / lo, t))
}

export function stagePowerRequired(chapter: number, index: number, isBoss: boolean): number {
  return stagePowerRequiredFor(chapter, index, isBoss)
}

/**
 * 关卡的**真实难度** = 敌方基础战力 × 属性缩放倍率。
 *
 * ⚠ 难度**不是**缩放本身：敌方**基础属性**本身跨章增长约 **1.25×/章**
 *   （§6.5 的「已知限制」：BOSS 基础战力 897 → 6,382），
 *   所以章边界处新一章首关的**缩放**必然低于上一章 BOSS 的缩放
 *   （否则难度增速会跑赢玩家养成），但**难度**仍然递增。
 *   「难度不倒挂」必须按这个口径核对——
 *   按缩放核对会把「基础属性增长」误判成「难度倒挂」（§6.5 实施修正）。
 *
 * ⚠ 这是**唯一**一份难度口径：配置校验（tools/validate-config.ts）与
 *   守护单测（tests/unit/save-config.test.ts）都必须走它（铁律 #4）。
 */
export function stageDifficulty(stage: StageDef): number {
  const powers = stage.enemyIds.map((id) => computePower(getEnemy(id).baseStats))
  const base = powers.reduce((a, b) => a + b, 0) / Math.max(1, powers.length)
  return base * stage.enemyScale
}

// ─────────────────────────── 难度曲线不变量 ───────────────────────────

export interface StageMonotonicityIssue {
  /** 前一关 id */
  prevId: number
  /** 违反不变量的关卡 id */
  stageId: number
  /** 人类可读的说明 */
  reason: string
}

/**
 * 难度曲线的**不变量核对**（唯一一份口径）。
 *
 * 返回违反不变量的关卡对；空数组 = 全部通过。
 * 配置校验（`tools/validate-config.ts`）与守护单测
 * （`tests/unit/save-config.test.ts`）都必须走它（铁律 #4）。
 *
 * 三条不变量：
 *  ① **战力门槛全局严格递增**——门槛是挂机放行线，倒挂会让玩家推进到打不过的关卡。
 *  ② **章内敌方缩放严格递增**——章末 BOSS 尖峰。
 *  ③ **章首难度（基础属性 × 缩放）跨章严格递增**——章与章之间不倒挂。
 *
 * ⚠ **章内相邻关的「难度绝对值」允许波动**：关卡的敌人配置在 1~2 只之间轮换
 *   （`enemyPool` 按 index 取 1 或 2 只），基础属性不同 ⇒
 *   「基础属性 × 缩放」会跟着配比振荡。章内难度只看**缩放**（②）。
 * ⚠ **章末 BOSS → 下一章首关的难度允许回落**：BOSS 的基础属性是普通敌的 3.6~6.9 倍，
 *   跨章回落是设计上的「喘息」（下一章再重新爬坡）。
 *   章与章之间的不倒挂由 ③ 的「章首 vs 章首」守住。
 */
export function stageMonotonicityIssues(
  stages: readonly StageDef[] = STAGES,
): StageMonotonicityIssue[] {
  const issues: StageMonotonicityIssue[] = []
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1]
    const cur = stages[i]
    if (cur.powerRequired <= prev.powerRequired) {
      issues.push({
        prevId: prev.id,
        stageId: cur.id,
        reason: `门槛 ${cur.powerRequired} 未高于关卡 ${prev.id} 的 ${prev.powerRequired}（放行线倒挂）`,
      })
    }
    if (prev.chapter === cur.chapter && cur.enemyScale <= prev.enemyScale) {
      issues.push({
        prevId: prev.id,
        stageId: cur.id,
        reason: `章内缩放 ${cur.enemyScale} 未高于关卡 ${prev.id} 的 ${prev.enemyScale}（章内难度倒挂）`,
      })
    }
  }

  // ③ 章首 vs 章首：**不是**「上一章末关 vs 本章首关」——
  //   章末 BOSS 的基础属性是普通敌的 3.6~6.9 倍，拿它比会把设计上的
  //   「喘息」误判成倒挂。跨章递增比的是**两章的首关**。
  const firstOf = (chapter: number): StageDef | undefined =>
    stages.find((s) => s.chapter === chapter && s.index === 1)
  const chapters = [...new Set(stages.map((s) => s.chapter))].sort((a, b) => a - b)
  for (let i = 1; i < chapters.length; i++) {
    const prevFirst = firstOf(chapters[i - 1])
    const curFirst = firstOf(chapters[i])
    if (!prevFirst || !curFirst) continue
    if (curFirst.enemyScale <= prevFirst.enemyScale) {
      issues.push({
        prevId: prevFirst.id,
        stageId: curFirst.id,
        reason:
          `第 ${curFirst.chapter} 章首关缩放 ${curFirst.enemyScale} 未高于 ` +
          `第 ${prevFirst.chapter} 章首关的 ${prevFirst.enemyScale}（跨章倒挂）`,
      })
    }
    if (stageDifficulty(curFirst) <= stageDifficulty(prevFirst)) {
      issues.push({
        prevId: prevFirst.id,
        stageId: curFirst.id,
        reason:
          `第 ${curFirst.chapter} 章首关难度 ${stageDifficulty(curFirst).toFixed(0)} 未高于 ` +
          `第 ${prevFirst.chapter} 章首关的 ${stageDifficulty(prevFirst).toFixed(0)}（跨章难度倒挂）`,
      })
    }
  }
  return issues
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
