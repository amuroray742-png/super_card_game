/**
 * 副本关卡表（挂机改版 v11 + 遗物副本 v12：**42 个独立关卡**）。
 *
 * ## 与旧版的差别
 *
 * 旧版副本没有自己的关卡实体——「难度 = 取材主线某章」，副本其实是拿主线波次换皮。
 * 新版副本是 `(变体 × 难度) = 1 关`，共 `5 技能变体 × 3 难度 + 3 强化变体 × 3 难度
 * + 6 遗物变体 × 3 难度 = 42 关`，每关有自己的敌人组合、缩放锚点、战力门槛与产量，
 * **打赢一次即通关**。
 *
 * ## 三种副本，三种产出形状
 *
 * - **技能副本**：产出对应五行的技能材料（堆叠物）；
 * - **强化副本**：产出对应档位的强化石（堆叠物）；
 * - **遗物副本**：产出**遗物实例**（`relicPool` + `rewards.relics`）——
 *   遗物是**实物**，不是堆叠物 ⇒ 关卡定义里 `drop` 为 `null`。
 *
 * ## 守什么
 *
 * 1. **42 关齐全**：id 唯一且符合 `dgn_<变体>_<难度>`；
 * 2. **同一变体三难度共用同一批敌人**——难度差异只来自缩放 / 门槛 / 产量，
 *    不靠改敌人表救难度（设计稿 §3.2.1 ③ / U8）；
 * 3. **敌人真实存在**（配错 id ⇒ 战斗直接开不起来）；
 * 4. **段间单调**：easy < normal < hard（缩放与门槛严格递增）；
 * 5. **锚点表与关卡表逐位对齐**（缩放 / 门槛都取自标定锚点，不许手填，铁律 #41）；
 * 6. **解锁判定**：技能副本要「该五行有可升技能的英灵」，
 *    强化副本要「仓库最高遗物等级 ≥ 解锁线」，未解锁要给原因与引导路由；
 * 7. **副本与主线分开记账**（副本不写 `campaign`），胜利只发所选材料。
 * 8. **遗物副本**：12 个套装被 6 个副本**恰好覆盖一次**；候选池 = 2 套 × 5 件；
 *    第一个副本在**主线第 1 关**即可进入（首件遗物的可达性是硬卡）。
 */
import { describe, expect, it } from 'vitest'
import {
  DUNGEON_INDEX,
  DUNGEON_STAGES,
  DUNGEON_STAGE_INDEX,
  DUNGEON_VARIANTS,
  DUNGEON_VARIANT_ORDER,
  dungeonStageById,
  dungeonStageId,
  dungeonStagesOf,
  dungeonStagesOfVariant,
  findRelicDungeonVariant,
  relicPoolOf,
} from '../../src/core/config/dungeons.ts'
import { RELIC_SETS as RELIC_SET_LIST } from '../../src/core/config/relics.ts'
import {
  dungeonStageUnlocked,
  dungeonUnlocked,
  runDungeonLevel,
  suggestLowerDifficulty,
  variantById,
} from '../../src/core/systems/dungeons.ts'
import { DUNGEON, DUNGEON_DIFFICULTIES, DUNGEON_DIFFICULTY_ORDER, RELIC, RELIC_DROP } from '../../src/core/config/economy.ts'
import { getEnemy } from '../../src/core/config/enemies.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { buildPveContext } from '../../src/core/systems/derive.ts'
import { applyAction } from '../../src/core/systems/actions.ts'
import { Rng } from '../../src/core/rng.ts'
import { makeTestRelic } from './helpers.ts'
import type { ActionContext } from '../../src/core/systems/actions.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000

function actionCtx(now = NOW, seed = 4242): ActionContext {
  return { now, rng: new Rng(seed), randomSeed: () => seed }
}

/**
 * 造一份有队伍、有遗物、战力足够的存档。
 *
 * ⚠ 技能等级刻意留低（1）：满级技能会让「可升技能的英灵」判定为假，
 *   技能副本就会一直锁着（解锁判定读的是「还有没有技能能升」）。
 */
function strongSave(): SaveData {
  const save = createNewSave(NOW, 7)
  for (const id of ['xiangyu', 'hanxin']) {
    save.heroes[id] = { ...createHeroState(id, NOW), level: 240, star: 6, skillLevels: [1, 1, 1] }
  }
  save.team.slots[0] = 'xiangyu'
  save.team.slots[1] = 'hanxin'
  const rng = new Rng(99)
  save.relics = [
    makeTestRelic('set_zhanshen_1', rng, 1),
    makeTestRelic('set_zhanshen_2', rng, 1),
  ]
  return save
}

describe('副本关卡表（42 关）', () => {
  it('42 关 = 14 变体 × 3 难度，id 唯一且符合 `dgn_<变体>_<难度>`', () => {
    // ⚠ 铁律 #8：关卡 id 的**唯一出处**是 `dungeonStageId`，
    //   表现层与动作层都从这里取，禁止自行拼接（拼错了战斗直接开不起来）。
    expect(DUNGEON_VARIANT_ORDER).toHaveLength(14)
    expect(DUNGEON_DIFFICULTY_ORDER).toHaveLength(3)
    expect(DUNGEON_STAGES).toHaveLength(42)

    const ids = new Set<string>()
    for (const stage of DUNGEON_STAGES) {
      expect(ids.has(stage.id), `关卡 id 重复：${stage.id}`).toBe(false)
      ids.add(stage.id)
      expect(stage.id).toBe(dungeonStageId(stage.variantId, stage.difficulty))
      expect(stage.id).toMatch(/^dgn_[A-Za-z0-9]+_(easy|normal|hard)$/)
    }
    expect(ids.size).toBe(42)
  })

  it('难度段顺序固定为 [简易 × 14, 普通 × 14, 困难 × 14]', () => {
    // ⚠ 锚点表（SCALE_ANCHORS / POWER_ANCHORS）与关卡表**逐位对齐**，
    //   顺序变了 ⇒ 难度锚点会张冠李戴（铁律 #4 / #41）。
    const easy = DUNGEON_STAGES.filter((s) => s.difficulty === 'easy')
    const normal = DUNGEON_STAGES.filter((s) => s.difficulty === 'normal')
    const hard = DUNGEON_STAGES.filter((s) => s.difficulty === 'hard')
    expect(easy).toHaveLength(14)
    expect(normal).toHaveLength(14)
    expect(hard).toHaveLength(14)
    expect(DUNGEON_STAGES.slice(0, 14).every((s) => s.difficulty === 'easy')).toBe(true)
    expect(DUNGEON_STAGES.slice(14, 28).every((s) => s.difficulty === 'normal')).toBe(true)
    expect(DUNGEON_STAGES.slice(28).every((s) => s.difficulty === 'hard')).toBe(true)
  })

  it('缩放与门槛取自标定锚点表（不许手填）', () => {
    // ⚠ 铁律 #41：锚点是**标定值**，改了英灵 / 成长数值后必须重跑标定。
    //   这里锁住「关卡表与锚点表逐位对齐」，防止有人手填出一个与现实脱节的门槛。
    expect(DUNGEON.SCALE_ANCHORS).toHaveLength(42)
    expect(DUNGEON.POWER_ANCHORS).toHaveLength(42)
    expect(DUNGEON.DESIGN_LEVELS).toHaveLength(42)
    DUNGEON_STAGES.forEach((stage, index) => {
      expect(stage.enemyScale, `${stage.id} 的缩放没有对齐锚点表`).toBe(
        DUNGEON.SCALE_ANCHORS[index],
      )
      expect(stage.powerRequired, `${stage.id} 的门槛没有对齐锚点表`).toBe(
        DUNGEON.POWER_ANCHORS[index],
      )
    })
  })

  it('同一变体的三个难度**共用同一批敌人**', () => {
    // ⚠ 设计稿 §3.2.1 ③ / U8：难度问题一律回标定工具，
    //   不靠改敌人表救难度——否则"难度"其实是敌人配置，标定结论全部失效。
    for (const variantId of DUNGEON_VARIANT_ORDER) {
      const stages = dungeonStagesOfVariant(variantId)
      expect(stages, `${variantId} 应该有 3 个难度段`).toHaveLength(3)
      const enemySets = new Set(stages.map((s) => s.enemyIds.join(',')))
      expect(enemySets.size, `${variantId} 的三个难度用了不同的敌人`).toBe(1)
      expect(stages[0].enemyIds.length).toBeGreaterThan(0)
    }
  })

  it('每个 `enemyIds` 里的敌人都真实存在', () => {
    // ⚠ 「配置齐全 ≠ 功能可用」（铁律 #22）：
    //   敌人 id 写错 ⇒ 战斗开不起来 ⇒ 整条副本链路空转。
    for (const stage of DUNGEON_STAGES) {
      for (const id of stage.enemyIds) {
        expect(() => getEnemy(id), `${stage.id} 引用了不存在的敌人 ${id}`).not.toThrow()
        expect(getEnemy(id).id).toBe(id)
      }
    }
  })

  it('段间单调：easy < normal < hard（缩放、门槛严格递增）', () => {
    // ⚠ 难度曲线必须单调——否则玩家会撞上"简单比困难还难"的关卡。
    // ⚠ **产量**只在**材料副本**上有（遗物副本 `drop` 为 `null`，
    //   件数由 `RELIC_DROP.COUNT` 决定，不在这张表里）。
    for (const variantId of DUNGEON_VARIANT_ORDER) {
      const [easy, normal, hard] = dungeonStagesOfVariant(variantId)
      expect(easy.difficulty).toBe('easy')
      expect(normal.difficulty).toBe('normal')
      expect(hard.difficulty).toBe('hard')
      expect(normal.enemyScale).toBeGreaterThan(easy.enemyScale)
      expect(hard.enemyScale).toBeGreaterThan(normal.enemyScale)
      expect(normal.powerRequired).toBeGreaterThan(easy.powerRequired)
      expect(hard.powerRequired).toBeGreaterThan(normal.powerRequired)
      if (!easy.drop || !normal.drop || !hard.drop) continue
      expect(normal.drop.min).toBeGreaterThan(easy.drop.min)
      expect(hard.drop.min).toBeGreaterThan(normal.drop.min)
    }
  })
})

describe('副本索引函数', () => {
  it('`dungeonStageById` 与 `DUNGEON_STAGE_INDEX` 一致', () => {
    expect(DUNGEON_STAGE_INDEX.size).toBe(42)
    for (const stage of DUNGEON_STAGES) {
      expect(dungeonStageById(stage.id)).toEqual(stage)
    }
    expect(dungeonStageById('dgn_not_exists_easy')).toBeNull()
  })

  it('`dungeonStagesOf` 按种类切分（15 技能 + 9 强化 + 18 遗物）', () => {
    expect(dungeonStagesOf('skill')).toHaveLength(15)
    expect(dungeonStagesOf('enhance')).toHaveLength(9)
    expect(dungeonStagesOf('relic')).toHaveLength(18)
    for (const stage of dungeonStagesOf('skill')) {
      expect(DUNGEON_INDEX.get(stage.variantId)?.kind).toBe('skill')
    }
  })

  it('`dungeonStagesOfVariant` 按变体切分（每变体 3 关）', () => {
    for (const variantId of DUNGEON_VARIANT_ORDER) {
      const stages = dungeonStagesOfVariant(variantId)
      expect(stages).toHaveLength(3)
      expect(stages.every((s) => s.variantId === variantId)).toBe(true)
    }
  })

  it('变体索引与清单一致，`variantById` 找不到返回 null', () => {
    expect(DUNGEON_INDEX.size).toBe(DUNGEON_VARIANTS.length)
    for (const variant of DUNGEON_VARIANTS) {
      expect(DUNGEON_INDEX.get(variant.id)).toEqual(variant)
      expect(variantById(variant.id)).toEqual(variant)
    }
    expect(variantById('not_a_variant' as never)).toBeNull()
  })

  it('降难度建议：已经最低档就返回 null', () => {
    expect(suggestLowerDifficulty('easy')).toBeNull()
    expect(suggestLowerDifficulty('normal')).toBe('easy')
    expect(suggestLowerDifficulty('hard')).toBe('normal')
  })
})

describe('副本解锁判定', () => {
  it('技能副本：该五行有可升技能的英灵即可进入', () => {
    const save = strongSave()
    const variant = DUNGEON_INDEX.get('skillEarth')!
    expect(dungeonUnlocked(save, variant).unlocked).toBe(true)
  })

  it('技能副本：没有该五行英灵 → 锁定并给出原因与引导路由', () => {
    // ⚠ 铁律 #27：未解锁时必须写清"为什么"与"去哪儿"，
    //   否则玩家只会看到一把锁，以为功能坏了。
    const save = strongSave()
    const variant = DUNGEON_INDEX.get('skillWater')!
    const res = dungeonUnlocked(save, variant)
    expect(res.unlocked).toBe(false)
    expect(res.reason).toContain('水')
    expect(res.hintRoute).toBe('hero')
  })

  it('强化副本：仓库最高遗物等级 ≥ 解锁线才解锁（初阶 1 / 中阶 60 / 高阶 130）', () => {
    const save = createNewSave(NOW, 7)
    const tier1 = DUNGEON_INDEX.get('enhanceTier1')!
    const tier2 = DUNGEON_INDEX.get('enhanceTier2')!
    const tier3 = DUNGEON_INDEX.get('enhanceTier3')!

    // 新档仓库是空的 ⇒ 三档全锁（但初阶只要求 Lv1，
    //   也就是"只要有第一件遗物就能进"——遗物祈愿入口就是为了这条）
    expect(dungeonUnlocked(save, tier1).unlocked).toBe(false)
    expect(dungeonUnlocked(save, tier2).unlocked).toBe(false)
    expect(dungeonUnlocked(save, tier3).unlocked).toBe(false)
    expect(dungeonUnlocked(save, tier3).reason).toContain('Lv130')

    const rng = new Rng(5)
    save.relics = [makeTestRelic('set_zhanshen_1', rng, RELIC.STONE_TIERS[1].unlockRelicLevel)]
    expect(dungeonUnlocked(save, tier1).unlocked).toBe(true)
    expect(dungeonUnlocked(save, tier2).unlocked).toBe(true)
    expect(dungeonUnlocked(save, tier3).unlocked).toBe(false)
  })

  /**
   * 客户端镜像里 `save.relics` **只有已装备件**（存档分包）→
   * 仓库里那件 Lv60 的客户端看不见 → 解锁线必须由服务端统计后传入。
   *
   * ⚠ 历史教训：不传 facts 时客户端会把「明明有 Lv60」判成「未解锁」，
   *   玩家在副本页看到「需要持有 Lv60 遗物（当前最高 Lv0）」却根本进不去。
   */
  it('强化副本：解锁线取服务端统计的仓库最高等级（不依赖已装备件）', () => {
    const save = createNewSave(NOW, 7)
    // 客户端镜像：仓库里的 Lv60 那件**没有**出现在 relics 里
    expect(save.relics).toHaveLength(0)
    const tier2 = DUNGEON_INDEX.get('enhanceTier2')!

    // 没有 facts → 只能看到 0 → 判定为未解锁（这正是客户端的老毛病）
    expect(dungeonUnlocked(save, tier2).unlocked).toBe(false)

    // 传入服务端统计 → 解锁
    const res = dungeonUnlocked(save, tier2, { maxRelicLevel: 60 })
    expect(res.unlocked).toBe(true)
  })

  it('强化副本：服务端统计低于解锁线时仍锁定，并写清当前最高等级', () => {
    const save = createNewSave(NOW, 7)
    const tier2 = DUNGEON_INDEX.get('enhanceTier2')!
    const res = dungeonUnlocked(save, tier2, { maxRelicLevel: 12 })
    expect(res.unlocked).toBe(false)
    expect(res.reason).toContain('Lv60')
    expect(res.reason).toContain('Lv12')
  })

  it('关卡级判定与变体级判定口径一致（同一把钥匙）', () => {
    // ⚠ 两处各写一套判定 ⇒ 玩家会看到"界面说能进，点了说不能"。
    const save = strongSave()
    for (const stage of DUNGEON_STAGES) {
      const variant = variantById(stage.variantId)!
      const byVariant = dungeonUnlocked(save, variant)
      const byStage = dungeonStageUnlocked(save, stage)
      expect(byStage.unlocked, `${stage.id} 的关卡判定与变体判定不一致`).toBe(
        byVariant.unlocked,
      )
      expect(byStage.reason).toBe(byVariant.reason)
      expect(byStage.hintRoute).toBe(byVariant.hintRoute)
    }
  })
})

describe('遗物副本关卡表（遗物的唯一来源）', () => {
  it('遗物副本关卡：`drop` 为 null，候选池 = 2 套 × 5 件 = 10 件', () => {
    // ⚠ 遗物是**实例**（实物），不是堆叠物 ⇒ 关卡定义里 `drop` 必须是 `null`，
    //   产出走 `relicPool` + `rewards.relics`（铁律 #22：一关只产一种东西）。
    const stages = dungeonStagesOf('relic')
    expect(stages).toHaveLength(18)
    for (const stage of stages) {
      expect(stage.drop, `${stage.id} 不该有堆叠物掉落`).toBeNull()
      expect(stage.relicPool, `${stage.id} 缺候选遗物池`).toBeTruthy()
      expect(stage.relicPool!.length, `${stage.id} 的候选池件数不对`).toBe(10)
      // 候选池内容必须**等于** `relicPoolOf(variant)`（唯一出处，铁律 #8）
      const variant = DUNGEON_INDEX.get(stage.variantId)!
      expect([...stage.relicPool!]).toEqual([...relicPoolOf(variant)!])
    }
  })

  it('材料副本关卡：`drop` 有值，候选池为 null（两种产出形状互斥）', () => {
    for (const stage of DUNGEON_STAGES) {
      const variant = DUNGEON_INDEX.get(stage.variantId)!
      if (variant.kind === 'relic') continue
      expect(stage.drop, `${stage.id} 缺材料掉落`).toBeTruthy()
      expect(stage.relicPool, `${stage.id} 不该有遗物池`).toBeNull()
    }
  })

  it('12 个套装被 6 个遗物副本**恰好覆盖一次**', () => {
    // ⚠ 套装是遗物产出的「维度」：漏一个 ⇒ 那套永远拿不到；
    //   覆盖两次 ⇒ 两个副本产出完全重叠（一边变成死内容）。
    const covered = new Map<string, string[]>()
    for (const variant of DUNGEON_VARIANTS.filter((v) => v.kind === 'relic')) {
      expect(variant.relicSetIds, `${variant.id} 应当覆盖 2 个套装`).toHaveLength(2)
      for (const setId of variant.relicSetIds ?? []) {
        covered.set(setId, [...(covered.get(setId) ?? []), variant.id])
      }
    }
    // 套装总数取配置表（不在测试里另写一份清单）
    expect(RELIC_SET_LIST).toHaveLength(12)
    for (const set of RELIC_SET_LIST) {
      const owners = covered.get(set.id) ?? []
      expect(owners, `套装 ${set.id} 没有被遗物副本覆盖`).toHaveLength(1)
    }
    // 反向：每个套装都能唯一定位到它的副本（表现层「缺哪套 → 去哪个副本」的桥）
    for (const set of RELIC_SET_LIST) {
      const variant = findRelicDungeonVariant(set.id)
      expect(variant, `套装 ${set.id} 找不到对应的遗物副本`).toBeTruthy()
      expect(variant!.kind).toBe('relic')
      expect(variant!.relicSetIds).toContain(set.id)
    }
  })

  it('⚠ 新号可达性：第一个遗物副本在**主线第 1 关**即可进入', () => {
    // ⚠ **硬卡**：历史上「首件遗物拿不到」把整条强化链锁死
    //   （初阶强化副本要求「持有 Lv1 遗物」⇒ 循环依赖）。
    //   遗物副本必须**按主线进度**解锁，且第一个副本的解锁线 = 1。
    const stage = dungeonStageById(dungeonStageId('relicZhanTan', 'easy'))!
    expect(RELIC_DROP.UNLOCK_STAGE.relicZhanTan).toBe(1)

    const save = createNewSave(NOW, 7)
    // 主线第 1 关还没通关 ⇒ 锁着
    const locked = dungeonStageUnlocked(save, stage)
    expect(locked.unlocked).toBe(false)
    expect(locked.hintRoute).toBe('expedition')

    // ⚠ 主线通关第 1 关 ⇒ 立刻可进（首件遗物必须可达）
    save.campaign.clearedStage = 1
    const unlocked = dungeonStageUnlocked(save, stage)
    expect(unlocked.unlocked, '主线第 1 关后遗物副本仍不可进').toBe(true)
    expect(unlocked.reason).toBe('')
  })

  it('遗物副本按主线进度逐级解锁，且不与「持有遗物」形成循环依赖', () => {
    // ⚠ 遗物副本**不能**挂在遗物上（强化副本要求持有 Lv1 遗物 ⇒ 循环依赖）。
    //   所以判定的唯一依据是**主线通关关卡**。
    const save = createNewSave(NOW, 7)
    for (const variant of DUNGEON_VARIANTS.filter((v) => v.kind === 'relic')) {
      const need = RELIC_DROP.UNLOCK_STAGE[variant.id]
      expect(need, `${variant.id} 缺解锁线`).toBeGreaterThanOrEqual(1)
      // 仓库里**一件遗物都没有**时，也只按主线进度判
      expect(save.relics).toHaveLength(0)
      save.campaign.clearedStage = need - 1
      expect(dungeonUnlocked(save, variant).unlocked, `${variant.id} 提前解锁了`).toBe(false)
      save.campaign.clearedStage = need
      expect(dungeonUnlocked(save, variant).unlocked, `${variant.id} 没解锁`).toBe(true)
    }
  })
})

describe('副本战斗（runDungeonLevel）', () => {
  it('返回真实战斗结果（名册含我方与关卡定义里的敌人）', () => {
    // ⚠ 铁律 #22：「配置齐全 ≠ 功能可用」。
    //   副本必须真的能打起来，敌人取自关卡定义里的 `enemyIds`。
    const save = strongSave()
    const stage = dungeonStageById(dungeonStageId('skillEarth', 'easy'))!
    const res = runDungeonLevel(save, stage.id, 12345, buildPveContext(save))

    expect(res.stage?.id).toBe(stage.id)
    expect(res.battle).toBeTruthy()
    const roster = res.battle!.roster
    expect(roster.length).toBeGreaterThan(0)
    // 敌方名册的 defId 必须来自关卡定义（战斗日志里的 id 带 `#序号`，这里比 defId）
    const enemyDefIds = new Set(roster.filter((r) => r.side === 'enemy').map((r) => r.defId))
    for (const id of stage.enemyIds) {
      expect(enemyDefIds.has(id), `${stage.id} 的敌人 ${id} 没上战场`).toBe(true)
    }
    expect(roster.some((r) => r.side === 'ally')).toBe(true)
  })

  it('没有编队 → 不打，直接判负（不消耗任何资源）', () => {
    const save = createNewSave(NOW, 7)
    const stage = dungeonStageById(dungeonStageId('skillEarth', 'easy'))!
    const res = runDungeonLevel(save, stage.id, 1, buildPveContext(save))
    expect(res.win).toBe(false)
    expect(res.battle).toBeNull()
    expect(res.stage?.id).toBe(stage.id)
  })

  it('不存在的关卡 id → 直接失败（不崩）', () => {
    const save = strongSave()
    const res = runDungeonLevel(save, 'dgn_not_exists_easy', 1, buildPveContext(save))
    expect(res.win).toBe(false)
    expect(res.battle).toBeNull()
    expect(res.stage).toBeNull()
  })
})

describe('副本手动挑战（dungeon.challenge）', () => {
  it('胜利只发所选材料，并登记通关；**不写 campaign**', () => {
    // ⚠ 副本是独立关卡：进度与主线分开记账（`clearedStage` 不动）。
    const save = strongSave()
    const clearedBefore = save.campaign.clearedStage
    const stageId = dungeonStageId('skillEarth', 'easy')
    const res = applyAction(save, { type: 'dungeon.challenge', stageId }, actionCtx())

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.stageId).toBe(stageId)
    expect(res.result.win).toBe(true)
    expect(res.result.firstClear).toBe(true)
    // 只发该副本的材料：不发银两、不发经验书
    expect(Object.keys(res.result.rewards.items ?? {})).toEqual(['skillMatEarth'])
    expect(res.result.rewards.silver).toBeUndefined()
    expect(save.items.skillMatEarth).toBeGreaterThan(0)
    // 通关登记
    expect(save.dungeons.cleared[stageId]).toBe(true)
    // 主线记录不受影响
    expect(save.campaign.clearedStage).toBe(clearedBefore)
  })

  it('重复挑战同一关不再算首通', () => {
    const save = strongSave()
    const stageId = dungeonStageId('skillEarth', 'easy')
    applyAction(save, { type: 'dungeon.challenge', stageId }, actionCtx())
    const again = applyAction(save, { type: 'dungeon.challenge', stageId }, actionCtx(NOW, 999))
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.result.firstClear).toBe(false)
  })

  it('未解锁的副本关卡被拒（不消耗任何资源）', () => {
    // ⚠ 水系技能副本：队伍里没有水属性英灵 ⇒ 锁着。
    const save = strongSave()
    const before = JSON.stringify(save.items)
    const res = applyAction(
      save,
      { type: 'dungeon.challenge', stageId: dungeonStageId('skillWater', 'easy') },
      actionCtx(),
    )
    expect(res.ok).toBe(false)
    expect(JSON.stringify(save.items)).toBe(before)
  })

  it('不存在的副本关卡被拒', () => {
    const save = strongSave()
    const res = applyAction(save, { type: 'dungeon.challenge', stageId: 'dgn_nope_easy' }, actionCtx())
    expect(res.ok).toBe(false)
  })
})

describe('副本难度档配置', () => {
  it('三档难度都有名字与产量倍率（副本不借主线波次）', () => {
    // ⚠ 挂机改版 v11：副本不再取材主线波次，
    //   `chapter` 只用于说明"该难度段的设计阶梯对齐主线第几章"。
    expect(DUNGEON_DIFFICULTIES).toHaveLength(3)
    for (const d of DUNGEON_DIFFICULTIES) {
      expect(d.name.length).toBeGreaterThan(0)
      expect(d.dropMul).toBeGreaterThan(0)
    }
    const muls = DUNGEON_DIFFICULTIES.map((d) => d.dropMul)
    expect(muls[0]).toBeLessThan(muls[1])
    expect(muls[1]).toBeLessThan(muls[2])
  })
})
