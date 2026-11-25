/**
 * 旧档迁移 v11 → v12（**遗物副本**：遗物的唯一来源从「银两祈愿」改为「遗物副本」）。
 *
 * ## 这次改了什么
 *
 * - 遗物**祈愿**（`relic.acquire`，花 5000 银两换一件）**下线**；
 * - 遗物改由**遗物副本**产出 ⇒ 挂机多出**第四条通道** `idle.channels.relic`；
 * - 新增**保底计数**（`save.relicPity`，按关卡记）与**每日产出计数**（`save.relicDaily`）。
 *
 * ## 守什么
 *
 * 1. 迁移后版本号 = `SAVE_VERSION`（12）；
 * 2. **新增的遗物通道是「关闭」状态**（`target === null`、预算为 0）——
 *    旧档没有遗物副本目标可继承，擅自继承一个就是凭空捏造；
 * 3. `relicPity` 清空、`relicDaily` 归零（旧档的遗物来自祈愿，没有副本保底概念）；
 * 4. ⚠ **其余三条通道的账本原样保留**——它们的语义没变，
 *    迁移时顺手清掉就是**静默丢进度**（玩家会发现「挂机进度回到原点」）。
 *
 * ⚠ 同 AGENTS.md 铁律 #22：迁移链上多写一条不该有的赋值，玩家就会**静默丢资产**，
 *   而单测与配置校验都看不出来。
 */
import { describe, expect, it } from 'vitest'
import { createNewSave, migrate, normalizeSave, SAVE_VERSION } from '../../src/core/save/schema.ts'
import { dungeonStageId } from '../../src/core/config/dungeons.ts'
import { RELIC_DROP } from '../../src/core/config/economy.ts'
import { relicDailyKey } from '../../src/core/systems/relic.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const NOW = 1_700_000_000_000

const SKILL_EARTH_EASY = dungeonStageId('skillEarth', 'easy')
const ENHANCE_T1_EASY = dungeonStageId('enhanceTier1', 'easy')
const RELIC_EASY = dungeonStageId('relicZhanTan', 'easy')

/**
 * 造一份 **v11 形态**的存档（只有三条挂机通道，账本上有真实数据）。
 *
 * ⚠ 不用 `createNewSave` 再改版本号——那样造出来的还是 v12 结构，
 *   迁移链 v11 → v12 的行为会被绕过。
 */
function legacyV11Save(): SaveData {
  const save = createNewSave(NOW, 7)
  save.version = 11
  // ⚠ v11 只有三条通道；遗物通道是 v12 才有的 ⇒ 这里必须把它删掉，
  //   否则测的是「v12 档再迁移一次」，不是真正的 v11 档。
  delete (save.idle.channels as Record<string, unknown>).relic
  delete (save as unknown as Record<string, unknown>).relicPity
  delete (save as unknown as Record<string, unknown>).relicDaily

  // 三条通道的真实账本（迁移后必须原样保留）
  save.idle.channels.main.target = { kind: 'main', stageId: null }
  save.idle.channels.main.effectiveMs = 120_000
  save.idle.channels.main.measuredAt = NOW - 60_000
  save.idle.channels.main.offlineElapsedMs = 30_000
  save.idle.channels.main.pendingOfflineMs = 15_000

  save.idle.channels.skill.target = { kind: 'skill', dungeonStageId: SKILL_EARTH_EASY }
  save.idle.channels.skill.effectiveMs = 60_000
  save.idle.channels.skill.measuredAt = NOW - 30_000

  save.idle.channels.enhance.target = { kind: 'enhance', dungeonStageId: ENHANCE_T1_EASY }
  save.idle.channels.enhance.effectiveMs = 6_000

  save.dungeons.cleared[SKILL_EARTH_EASY] = true
  save.dungeons.cleared[ENHANCE_T1_EASY] = true
  save.campaign.clearedStage = 5
  save.idle.totalIdleSeconds = 1234
  return save
}

describe('v11 → v12 迁移', () => {
  it('存档版本升到 12', () => {
    expect(SAVE_VERSION).toBe(12)
    expect(migrate(legacyV11Save()).version).toBe(12)
  })

  it('新增的遗物通道存在，但**关闭**（target 为 null、预算为 0）', () => {
    // ⚠ 旧档没有遗物副本目标可继承 ⇒ 迁移出来的通道必须是「关着的」。
    //   擅自继承一个目标 = 凭空捏造玩家的挂机意图。
    const save = migrate(legacyV11Save())
    const channel = save.idle.channels.relic
    expect(channel).toBeTruthy()
    expect(channel.target).toBeNull()
    expect(channel.effectiveMs).toBe(0)
    expect(channel.offlineElapsedMs).toBe(0)
    expect(channel.pendingOfflineMs).toBe(0)
  })

  it('保底计数清空、每日计数归零', () => {
    // ⚠ 旧档的遗物来自**祈愿**，没有副本保底的概念 ⇒ 继承一个数值就是错的。
    const save = migrate(legacyV11Save())
    expect(save.relicPity).toEqual({})
    expect(save.relicDaily.count).toBe(0)
    expect(save.relicDaily.date).toBe('')
  })

  it('⚠ 其余三条通道的账本**原样保留**（不静默丢进度）', () => {
    // ⚠ 这是本次迁移最容易踩的坑：新增通道时顺手把老通道重置了，
    //   玩家会发现「挂机进度回到原点」却没有任何提示。
    const before = legacyV11Save()
    const save = migrate(before)

    expect(save.idle.channels.main.target).toEqual({ kind: 'main', stageId: null })
    expect(save.idle.channels.main.effectiveMs).toBe(before.idle.channels.main.effectiveMs)
    expect(save.idle.channels.main.measuredAt).toBe(before.idle.channels.main.measuredAt)
    expect(save.idle.channels.main.offlineElapsedMs).toBe(before.idle.channels.main.offlineElapsedMs)
    expect(save.idle.channels.main.pendingOfflineMs).toBe(before.idle.channels.main.pendingOfflineMs)

    expect(save.idle.channels.skill.target).toEqual({ kind: 'skill', dungeonStageId: SKILL_EARTH_EASY })
    expect(save.idle.channels.skill.effectiveMs).toBe(before.idle.channels.skill.effectiveMs)
    expect(save.idle.channels.skill.measuredAt).toBe(before.idle.channels.skill.measuredAt)

    expect(save.idle.channels.enhance.target).toEqual({ kind: 'enhance', dungeonStageId: ENHANCE_T1_EASY })
    expect(save.idle.channels.enhance.effectiveMs).toBe(before.idle.channels.enhance.effectiveMs)

    // 主线进度与副本通关记录也不受影响
    expect(save.campaign.clearedStage).toBe(5)
    expect(save.dungeons.cleared[SKILL_EARTH_EASY]).toBe(true)
    expect(save.dungeons.cleared[ENHANCE_T1_EASY]).toBe(true)
    expect(save.idle.totalIdleSeconds).toBe(1234)
  })

  it('迁移是幂等的（重复载入不会重置任何账本）', () => {
    const once = migrate(legacyV11Save())
    const twice = migrate(structuredClone(once))
    expect(twice.idle.channels.main.effectiveMs).toBe(once.idle.channels.main.effectiveMs)
    expect(twice.idle.channels.skill.effectiveMs).toBe(once.idle.channels.skill.effectiveMs)
    expect(twice.idle.channels.enhance.effectiveMs).toBe(once.idle.channels.enhance.effectiveMs)
    expect(twice.idle.channels.relic.target).toBeNull()
    expect(twice.relicPity).toEqual({})
    expect(twice.relicDaily.count).toBe(0)
  })
})

describe('normalizeSave：遗物保底计数的归一化', () => {
  /** 造一份畸形存档（保底计数的 key / 值都不合法） */
  function malformedSave(pity: unknown): SaveData {
    const save = createNewSave(NOW, 7)
    ;(save as unknown as Record<string, unknown>).relicPity = pity
    return save
  }

  it('非法 key 被丢弃（保底计数只对真实副本关卡有意义）', () => {
    // ⚠ 非法 key 会让 `relicPity` 变成一个能塞任意字符串的黑洞
    //   （存档体积无上限增长），且保底对不存在的关卡毫无意义。
    const save = normalizeSave(malformedSave({ dgn_not_exists_easy: 3, '任意字符串': 5 }))
    expect(save.relicPity).toEqual({})
  })

  it('负数被夹成 0，非数字被丢弃', () => {
    const save = normalizeSave(
      malformedSave({ [RELIC_EASY]: -5, [dungeonStageId('relicJiYing', 'easy')]: 'x' }),
    )
    expect(save.relicPity[RELIC_EASY]).toBe(0)
    expect(save.relicPity[dungeonStageId('relicJiYing', 'easy')]).toBeUndefined()
  })

  it('合法值**原样保留**（保底必须跨会话累计）', () => {
    // ⚠ 每次载入都归零 ⇒ 玩家刷新页面就能重抽（铁律 #24 的同款坑）。
    const save = normalizeSave(malformedSave({ [RELIC_EASY]: 7 }))
    expect(save.relicPity[RELIC_EASY]).toBe(7)
  })

  it('每日计数归一化：负数夹成 0，日期非字符串则置空', () => {
    const save = createNewSave(NOW, 7)
    ;(save as unknown as Record<string, unknown>).relicDaily = { date: 123, count: -9 }
    const normalized = normalizeSave(save)
    expect(normalized.relicDaily.date).toBe('')
    expect(normalized.relicDaily.count).toBe(0)
  })

  it('跨日判定用 UTC 日期键（客户端与服务端时区不同也要一致）', () => {
    // ⚠ 额度是服务端权威的，但展示要与判定同源 ⇒ 日期键必须是 UTC。
    const save = createNewSave(NOW, 7)
    save.relicDaily = { date: relicDailyKey(NOW), count: RELIC_DROP.DAILY_CAP }
    const normalized = normalizeSave(save)
    expect(normalized.relicDaily.date).toBe(relicDailyKey(NOW))
    expect(normalized.relicDaily.count).toBe(RELIC_DROP.DAILY_CAP)
  })
})
