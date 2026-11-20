/**
 * 三队天梯 · PVE 长线挑战（roadmap P2-2）单元测试。
 *
 * 覆盖 roadmap 点名的四项：
 *   ① 首次参与 ② 结算 ③ 下赛季重置 ④ 积分与奖励隔离
 * 外加回流奖励、编队校验、周轮换与存档往返。
 */
import { describe, expect, it } from 'vitest'
import { applyAction } from '../../src/core/systems/actions.ts'
import type { GameAction, GameActionType } from '../../src/core/systems/actions.ts'
import {
  buildLadderSquads,
  detectReturnDays,
  ladderPointsFor,
  ladderTierIndex,
  ladderTierName,
  resolveLadderRewards,
  resolveReturnReward,
  rollLadderPeriods,
  validateSquad,
  LADDER_REWARD_ALLOWED_KEYS,
} from '../../src/core/systems/ladder.ts'
import { LADDER, LADDER_SEASON_REWARDS } from '../../src/core/config/economy.ts'
import { LADDER_TIERS } from '../../src/core/config/ladder.ts'
import { createNewSave, normalizeSave } from '../../src/core/save/schema.ts'
import { createHeroState } from '../../src/core/systems/growth.ts'
import { Rng } from '../../src/core/rng.ts'
import { arenaWeekIndex } from '../../src/core/time.ts'
import { GAME_ERROR_CODES } from '../../src/core/config/game-errors.ts'
import type { SaveData } from '../../src/core/model/types.ts'

const BASE_TIME = Date.parse('2026-11-18T15:59:59Z')
/** 测试用满编队伍（6 人） */
const FULL_TEAM = ['xiangyu', 'hanxin', 'zhugeliang', 'huatuo', 'bianque', 'nangdengel']
const WEEK_MS = 7 * 86_400_000

/** 造一份有 6 名英灵、已编队的存档（养成水平足以打过第 0 层梯队） */
function ladderSave(now = BASE_TIME): SaveData {
  const save = createNewSave(now, 19)
  const ids = ['xiangyu', 'hanxin', 'zhugeliang', 'huatuo', 'bianque', 'nangdengel']
  for (const id of ids) {
    save.heroes[id] = { ...createHeroState(id, 0), level: 40, star: 3, skillLevels: [8, 8, 8] }
  }
  save.team.slots = [...ids]
  return save
}

function ctxOf(now: number, seed = 7) {
  return { now, rng: new Rng(seed), randomSeed: () => seed }
}

/** 编成三队（同一批英灵复用，模拟「省钱打法」） */
function fillSquads(save: SaveData, ids: string[]): (string | null)[][] {
  const row: (string | null)[] = [...ids, null, null, null, null, null, null].slice(0, LADDER.SQUAD_SIZE)
  return [row, [...row], [...row]]
}

function apply<T extends GameActionType>(
  save: SaveData,
  action: Extract<GameAction, { type: T }>,
  now = BASE_TIME,
) {
  return applyAction(save, action, ctxOf(now))
}

describe('三队天梯 · 首次参与与结算', () => {
  it('未编队时拒绝挑战，且存档一字节未变', () => {
    const save = ladderSave()
    const before = JSON.stringify(save)
    const res = apply(save, { type: 'arena.ladderChallenge' })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.code).toBe(GAME_ERROR_CODES.LADDER_NO_SQUAD)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('编队后能挑战：段位分增加、周结算标记写入、三队都有战报', () => {
    const save = ladderSave()
    const squads = fillSquads(save, ['xiangyu', 'hanxin', 'zhugeliang', 'huatuo', 'bianque', 'nangdengel'])
    const saved = apply(save, { type: 'arena.ladderSaveSquads', squads })
    expect(saved.ok).toBe(true)
    expect(save.arena.ladder.squads).toEqual(squads)

    const res = apply(save, { type: 'arena.ladderChallenge' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result.squads).toHaveLength(3)
    expect(res.result.squads.every((s) => s.result.roster.length > 0)).toBe(true)
    expect(save.arena.tierPoints).toBe(res.result.points)
    expect(save.arena.ladder.lastSettledWeek).toBe(arenaWeekIndex(BASE_TIME))
    expect(save.arena.ladder.seasonPoints).toBe(res.result.points)
  })

  it('每周只能挑战一次，重复挑战被拒且存档不变', () => {
    const save = ladderSave()
    apply(save, { type: 'arena.ladderSaveSquads', squads: fillSquads(save, FULL_TEAM) })
    expect(apply(save, { type: 'arena.ladderChallenge' }).ok).toBe(true)
    const before = JSON.stringify(save)
    const again = apply(save, { type: 'arena.ladderChallenge' })
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.code).toBe(GAME_ERROR_CODES.LADDER_ALREADY_SETTLED)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('跨周后可以再挑战一轮', () => {
    const save = ladderSave()
    apply(save, { type: 'arena.ladderSaveSquads', squads: fillSquads(save, FULL_TEAM) })
    apply(save, { type: 'arena.ladderChallenge' })
    const nextWeek = BASE_TIME + WEEK_MS
    const res = apply(save, { type: 'arena.ladderChallenge' }, nextWeek)
    expect(res.ok).toBe(true)
    expect(save.arena.ladder.lastSettledWeek).toBe(arenaWeekIndex(nextWeek))
  })
})

describe('三队天梯 · 积分与奖励隔离', () => {
  it('天梯产出只有竞技专属资源，绝不回流 PVE 经济', () => {
    const save = ladderSave()
    // ⚠ 资源/背包版本 v10：钱包只剩**银两 + 圣杯结晶**，
    //   术式结晶 / 遗物强化石 / 抽卡券 / 玩家经验池已退役 → 改成盯背包道具表。
    const before = {
      silver: save.player.silver,
      crystals: save.player.crystals,
      items: JSON.stringify(save.items),
    }
    apply(save, { type: 'arena.ladderSaveSquads', squads: fillSquads(save, FULL_TEAM) })
    const res = apply(save, { type: 'arena.ladderChallenge' })
    expect(res.ok).toBe(true)
    expect(save.player.silver).toBe(before.silver)
    expect(save.player.crystals).toBe(before.crystals)
    expect(JSON.stringify(save.items)).toBe(before.items)
    // 只进竞技专属池
    expect(save.arena.medals).toBeGreaterThanOrEqual(0)
    expect(save.arena.arenaMaterials).toBeGreaterThanOrEqual(0)
  })

  it('天梯产出白名单里没有任何 PVE 资源', () => {
    for (const key of ['silver', 'crystals', 'items'] as const) {
      expect(LADDER_REWARD_ALLOWED_KEYS).not.toContain(key as never)
    }
  })

  it('天梯段位分与对战分互不影响', () => {
    const save = ladderSave()
    apply(save, { type: 'arena.ladderSaveSquads', squads: fillSquads(save, FULL_TEAM) })
    apply(save, { type: 'arena.ladderChallenge' })
    const tierPoints = save.arena.tierPoints
    expect(save.arena.pvpPoints).toBe(0)

    // 镜像试炼只写对战分
    apply(save, { type: 'arena.settle' })
    expect(save.arena.tierPoints).toBe(tierPoints)
    expect(save.arena.pvpPoints).toBeGreaterThan(0)
  })

  it('竞技勋章与竞技材料有周上限，天梯与镜像试炼共用同一份预算', () => {
    const { reward, weeklyMedals, weeklyMaterials } = resolveLadderRewards(3, 999, 999)
    expect(reward.medals).toBe(0)
    expect(reward.arenaMaterials).toBe(0)
    expect(weeklyMedals).toBe(999)
    expect(weeklyMaterials).toBe(999)
  })
})

describe('三队天梯 · 赛季重置', () => {
  it('跨过赛季长度后自动结算：段位分按比例保留、发放赛季奖励、赛季号 +1', () => {
    const save = ladderSave()
    apply(save, { type: 'arena.ladderSaveSquads', squads: fillSquads(save, FULL_TEAM) })
    // 先打一轮，攒下赛季积分与段位分
    apply(save, { type: 'arena.ladderChallenge' })
    const pointsBefore = save.arena.tierPoints
    const seasonPointsBefore = save.arena.ladder.seasonPoints
    const medalsBefore = save.arena.medals
    const materialsBefore = save.arena.arenaMaterials
    expect(save.arena.ladder.season).toBe(1)

    // 跨过整个赛季长度 → 下一次动作触发赛季结算
    const nextSeason = BASE_TIME + LADDER.SEASON_WEEKS * WEEK_MS + 1000
    const rolled = rollLadderPeriods(save, nextSeason)
    expect(rolled.settlements).toHaveLength(1)
    expect(rolled.settlements[0].season).toBe(1)

    // 赛季奖励按**赛季内累计积分**分档
    const spec = LADDER_SEASON_REWARDS.find((r) => seasonPointsBefore >= r.minPoints)!
    expect(save.arena.ladder.season).toBe(2)
    expect(save.arena.ladder.seasonPoints).toBe(0)
    // 段位分按保留比例下调
    expect(save.arena.tierPoints).toBe(Math.floor(pointsBefore * LADDER.SEASON_CARRY_PCT))
    expect(save.arena.tierPoints).toBeLessThan(pointsBefore)
    // 赛季奖励**只发称号**（勋章 / 竞技材料已停发，设计稿 §3）
    expect(save.arena.medals).toBe(medalsBefore)
    expect(save.arena.arenaMaterials).toBe(materialsBefore)
    // 称号入列
    expect(save.arena.ladder.seasonTitles.length).toBe(1)
  })

  it('赛季结算不发放任何 PVE 资源', () => {
    const save = ladderSave()
    apply(save, { type: 'arena.ladderSaveSquads', squads: fillSquads(save, FULL_TEAM) })
    const before = {
      silver: save.player.silver,
      crystals: save.player.crystals,
      items: JSON.stringify(save.items),
    }
    rollLadderPeriods(save, BASE_TIME + LADDER.SEASON_WEEKS * WEEK_MS + 1000)
    expect(save.player.silver).toBe(before.silver)
    expect(save.player.crystals).toBe(before.crystals)
    expect(JSON.stringify(save.items)).toBe(before.items)
  })

  it('连续跨多个赛季会逐个结算', () => {
    const save = ladderSave()
    // 先开赛季（首次参与从当前周起算）
    rollLadderPeriods(save, BASE_TIME)
    expect(save.arena.ladder.season).toBe(1)
    const rolled = rollLadderPeriods(save, BASE_TIME + LADDER.SEASON_WEEKS * 3 * WEEK_MS + 1000)
    expect(rolled.settlements).toHaveLength(3)
    expect(save.arena.ladder.season).toBe(4)
  })
})

describe('三队天梯 · 回流奖励', () => {
  it('离线满 3 天判为回流，领取后给通用经验书（不含结晶、券与竞技产出）', () => {
    const save = ladderSave()
    // 先活跃一次，确立 lastActiveAt
    rollLadderPeriods(save, BASE_TIME)
    expect(save.arena.ladder.returnPending).toBe(false)

    const back = BASE_TIME + 5 * 86_400_000
    const rolled = rollLadderPeriods(save, back)
    expect(rolled.returnDays).toBe(5)
    expect(save.arena.ladder.returnPending).toBe(true)

    const before = {
      books: save.items.expBookSmall,
      crystals: save.player.crystals,
      medals: save.arena.medals,
    }
    const res = apply(save, { type: 'arena.ladderClaimReturn' }, back)
    expect(res.ok).toBe(true)
    // ⚠ 资源/背包版本 v10：回流改发**通用经验书**（设计稿 §3）
    expect(save.items.expBookSmall).toBeGreaterThan(before.books)
    // 不冲击抽卡间隔，也不发竞技产出
    expect(save.player.crystals).toBe(before.crystals)
    expect(save.arena.medals).toBe(before.medals)
    expect(save.arena.ladder.returnPending).toBe(false)
  })

  it('没有回流奖励时领取被拒，且存档不变', () => {
    const save = ladderSave()
    const before = JSON.stringify(save)
    const res = apply(save, { type: 'arena.ladderClaimReturn' })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.code).toBe(GAME_ERROR_CODES.RETURN_NOT_AVAILABLE)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('冷却期内不再判为回流', () => {
    const save = ladderSave()
    rollLadderPeriods(save, BASE_TIME)
    const back = BASE_TIME + 5 * 86_400_000
    rollLadderPeriods(save, back)
    apply(save, { type: 'arena.ladderClaimReturn' }, back)
    // 领取后 lastReturnAt 更新；再离线 5 天（未过冷却）→ 不再是回流
    const again = back + 5 * 86_400_000
    rollLadderPeriods(save, again)
    expect(save.arena.ladder.returnPending).toBe(false)
    expect(detectReturnDays(save, again)).toBe(0)
  })

  it('回流奖励分档：离线越久给得越多', () => {
    expect(resolveReturnReward(2)).toBeNull()
    // ⚠ 回流改发通用经验书（`items`），不再是术式结晶 / 强化石
    expect(resolveReturnReward(3)?.items.expBookSmall).toBeGreaterThan(0)
    expect(resolveReturnReward(7)!.items.expBookSmall).toBeGreaterThan(
      resolveReturnReward(3)!.items.expBookSmall,
    )
    expect(resolveReturnReward(14)!.items.expBookSmall).toBeGreaterThan(
      resolveReturnReward(7)!.items.expBookSmall,
    )
  })
})

describe('三队天梯 · 编队校验与存档', () => {
  it('未拥有的英灵被拒，存档不变', () => {
    const save = ladderSave()
    const squads = fillSquads(save, FULL_TEAM)
    squads[0][1] = 'caesar' // 未拥有
    const before = JSON.stringify(save)
    const res = apply(save, { type: 'arena.ladderSaveSquads', squads })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.code).toBe(GAME_ERROR_CODES.LADDER_INVALID_LINEUP)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('同一队内重复上阵被拒', () => {
    const save = ladderSave()
    const squads = fillSquads(save, FULL_TEAM)
    squads[0][1] = 'xiangyu'
    const res = apply(save, { type: 'arena.ladderSaveSquads', squads })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.code).toBe(GAME_ERROR_CODES.LADDER_INVALID_LINEUP)
  })

  it('跨队复用同一名英灵是允许的', () => {
    const save = ladderSave()
    const squads = fillSquads(save, FULL_TEAM)
    expect(validateSquad(save, squads[0])).toBeNull()
    expect(apply(save, { type: 'arena.ladderSaveSquads', squads }).ok).toBe(true)
  })

  it('阵容形状固定为 3 队 × 6 槽', () => {
    const save = ladderSave()
    expect(save.arena.ladder.squads).toHaveLength(3)
    for (const row of save.arena.ladder.squads) expect(row).toHaveLength(6)
  })

  it('存档往返后天梯状态完整（normalizeSave 逐字段兜底）', () => {
    const save = ladderSave()
    apply(save, { type: 'arena.ladderSaveSquads', squads: fillSquads(save, FULL_TEAM) })
    apply(save, { type: 'arena.ladderChallenge' })
    const round = normalizeSave(JSON.parse(JSON.stringify(save)))
    expect(round.arena.ladder.squads).toEqual(save.arena.ladder.squads)
    expect(round.arena.ladder.lastSettledWeek).toBe(save.arena.ladder.lastSettledWeek)
    expect(round.arena.ladder.seasonPoints).toBe(save.arena.ladder.seasonPoints)
    expect(round.arena.tierPoints).toBe(save.arena.tierPoints)
  })

  it('旧档（无 ladder 字段）补齐为初始状态', () => {
    const raw = JSON.parse(JSON.stringify(ladderSave())) as Record<string, unknown>
    delete (raw.arena as Record<string, unknown>).ladder
    const normalized = normalizeSave(raw)
    expect(normalized.arena.ladder.squads).toHaveLength(3)
    expect(normalized.arena.ladder.lastSettledWeek).toBeNull()
    expect(normalized.arena.ladder.season).toBe(0)
  })
})

describe('三队天梯 · 配置自洽', () => {
  it('梯队表与段位表一一对应', () => {
    expect(LADDER_TIERS).toHaveLength(8)
    expect(LADDER.SCALE_ANCHORS).toHaveLength(LADDER_TIERS.length)
  })

  it('每个梯队都是 6 名灵体，且全部取自敌人库（合规：非历史人物）', () => {
    for (const tier of LADDER_TIERS) {
      expect(tier.squads).toHaveLength(LADDER.SQUAD_COUNT)
      for (const squad of tier.squads) {
        expect(squad.enemyIds).toHaveLength(LADDER.SQUAD_SIZE)
        for (const id of squad.enemyIds) expect(id).toMatch(/^(wanderer|dust_shade|sand_mirage|burrower|tide_construct|brine_wisp|spark_wisp|storm_golem|thorn_beast|spore_drake|magma_hound|forge_sprite|frost_wraith|ice_guard|dream_weaver|illusion|abyss_lurker|void_echo|star_shard|void_mirror)$/)
      }
    }
  })

  it('段位分随胜场数递增，全胜有登顶奖励', () => {
    expect(ladderPointsFor(0)).toBe(0)
    expect(ladderPointsFor(1)).toBeLessThan(ladderPointsFor(2))
    expect(ladderPointsFor(3)).toBeGreaterThan(ladderPointsFor(2))
    expect(ladderPointsFor(3)).toBe(3 * LADDER.POINTS_PER_SQUAD + LADDER.POINTS_CLEAR_BONUS)
  })

  it('段位名随段位分单调递增', () => {
    expect(ladderTierIndex(0)).toBe(0)
    expect(ladderTierName(0)).toBe('黑铁')
    expect(ladderTierIndex(999999)).toBe(7)
    expect(ladderTierName(999999)).toBe('王者')
  })

  it('三支队伍都能从存档里构造出运行时对象', () => {
    const save = ladderSave()
    apply(save, { type: 'arena.ladderSaveSquads', squads: fillSquads(save, ['xiangyu', 'hanxin']) })
    const squads = buildLadderSquads(save)
    expect(squads).toHaveLength(3)
    expect(squads[0].map((h) => h.def.id)).toEqual(['xiangyu', 'hanxin'])
    // 槽位号是真实槽位（0-2 前排 / 3-5 后排）
    expect(squads[0][0].slot).toBe(0)
    expect(squads[0][1].slot).toBe(1)
  })
})
