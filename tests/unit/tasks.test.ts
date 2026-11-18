/**
 * 每日任务与周目标（roadmap P2-1）。
 *
 * 守的是**服务端权威**的任务链路：
 *
 * - 计数来自真实动作（召唤 / 推征 / 遗物强化 / 签到），不是客户端上报；
 * - 周期滚动按北京时间（每日 0 点 / 每周一 0 点），跨周期不重复领；
 * - 领取**先校验后修改**：没完成 / 重复领取 → 失败且存档一字节未变；
 * - 奖励只经 `rewards` 入库，且**不含**圣杯结晶与抽卡券（不冲击抽卡间隔）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeTestRelic } from './helpers.ts'
import type { SaveData } from '../../src/core/model/types.ts'
import { applyAction, type ActionContext } from '../../src/core/systems/actions.ts'
import { createNewSave } from '../../src/core/save/schema.ts'
import { Rng } from '../../src/core/rng.ts'
import { advanceTasks, counterKey, rollTasks, taskViews } from '../../src/core/systems/tasks.ts'
import { DAILY_TASKS, TASKS, WEEKLY_TASKS } from '../../src/core/config/tasks.ts'
import { dayIndex, weekIndex } from '../../src/core/time.ts'
import { GAME_ERROR_CODES } from '../../src/core/config/game-errors.ts'

const NOW = 1_700_000_000_000
const SEED = 20241118
const DAY_MS = 86_400_000

function makeCtx(save: SaveData, now = NOW) {
  const rng = Rng.fromSnapshot(save.rng.seed || SEED, save.rng.counter)
  const ctx: ActionContext = { now, rng, randomSeed: () => 987654321 }
  return { ctx, rng }
}

function makeSave(): SaveData {
  return createNewSave(NOW, SEED)
}

/** 让某个任务立刻达成（直接写计数，不走动作） */
function completeTask(save: SaveData, taskId: string): void {
  const task = TASKS.find((t) => t.id === taskId)
  if (!task) throw new Error(`未知任务：${taskId}`)
  const key = counterKey(task.metric, task.period)
  save.daily.taskProgress[key] = task.target
  save.daily.taskDay = dayIndex(NOW)
  save.daily.taskWeek = weekIndex(NOW)
}

describe('任务计数：按周期分桶', () => {
  it('一次行为同时推进每日与每周两个口径', () => {
    const save = makeSave()
    const next = advanceTasks(save.daily, 'pull', 1, NOW)
    expect(next.taskProgress[counterKey('pull', 'daily')]).toBe(1)
    expect(next.taskProgress[counterKey('pull', 'weekly')]).toBe(1)
  })

  it('跨日：每日口径归零，周口径保留', () => {
    const save = makeSave()
    save.daily.taskProgress[counterKey('pull', 'daily')] = 3
    save.daily.taskProgress[counterKey('pull', 'weekly')] = 5
    save.daily.taskDay = dayIndex(NOW)
    save.daily.taskWeek = weekIndex(NOW)

    const next = rollTasks(save.daily, NOW + DAY_MS)
    expect(next.taskProgress[counterKey('pull', 'daily')]).toBeUndefined()
    expect(next.taskProgress[counterKey('pull', 'weekly')]).toBe(5)
  })

  it('跨周：周口径归零，每日口径保留（周期归属独立判断）', () => {
    const save = makeSave()
    save.daily.taskProgress[counterKey('pull', 'daily')] = 3
    save.daily.taskProgress[counterKey('pull', 'weekly')] = 5
    save.daily.taskClaimed = ['d_pull', 'w_pull']
    // 日口径是今天、周口径是上周：两套周期归属**各自独立**判断
    save.daily.taskDay = dayIndex(NOW)
    save.daily.taskWeek = weekIndex(NOW) - 1

    const next = rollTasks(save.daily, NOW)
    expect(next.taskProgress[counterKey('pull', 'weekly')]).toBeUndefined()
    expect(next.taskProgress[counterKey('pull', 'daily')]).toBe(3)
    expect(next.taskClaimed).toEqual(['d_pull'])
  })

  it('过了一周：两个口径都归零（跨周的那一天同时也是新的一天）', () => {
    const save = makeSave()
    save.daily.taskProgress[counterKey('pull', 'daily')] = 3
    save.daily.taskProgress[counterKey('pull', 'weekly')] = 5
    save.daily.taskClaimed = ['d_pull', 'w_pull']
    save.daily.taskDay = dayIndex(NOW)
    save.daily.taskWeek = weekIndex(NOW)

    const next = rollTasks(save.daily, NOW + 7 * DAY_MS)
    expect(next.taskProgress[counterKey('pull', 'daily')]).toBeUndefined()
    expect(next.taskProgress[counterKey('pull', 'weekly')]).toBeUndefined()
    expect(next.taskClaimed).toEqual([])
  })

  it('跨日又跨周：两个口径都归零，领取记录也清空', () => {
    const save = makeSave()
    save.daily.taskProgress[counterKey('pull', 'daily')] = 3
    save.daily.taskProgress[counterKey('pull', 'weekly')] = 5
    save.daily.taskClaimed = ['d_pull', 'w_pull']
    save.daily.taskDay = dayIndex(NOW)
    save.daily.taskWeek = weekIndex(NOW)

    const next = rollTasks(save.daily, NOW + 8 * DAY_MS)
    expect(next.taskProgress[counterKey('pull', 'daily')]).toBeUndefined()
    expect(next.taskProgress[counterKey('pull', 'weekly')]).toBeUndefined()
    expect(next.taskClaimed).toEqual([])
  })

  it('滚动是纯函数：不修改入参', () => {
    const save = makeSave()
    save.daily.taskProgress[counterKey('pull', 'daily')] = 3
    const before = JSON.stringify(save.daily)
    rollTasks(save.daily, NOW + DAY_MS)
    expect(JSON.stringify(save.daily)).toBe(before)
  })
})

describe('任务计数：由真实动作累计', () => {
  let save: SaveData

  beforeEach(() => {
    save = makeSave()
  })

  it('召唤 → 召唤计数 +1', () => {
    const { ctx } = makeCtx(save)
    const res = applyAction(save, { type: 'gacha.pull', poolId: 'standard', count: 1 }, ctx)
    expect(res.ok).toBe(true)
    expect(save.daily.taskProgress[counterKey('pull', 'daily')]).toBe(1)
    expect(save.daily.taskProgress[counterKey('pull', 'weekly')]).toBe(1)
  })

  it('十连 → 召唤计数 +10', () => {
    const { ctx } = makeCtx(save)
    applyAction(save, { type: 'gacha.pull', poolId: 'standard', count: 10 }, ctx)
    expect(save.daily.taskProgress[counterKey('pull', 'daily')]).toBe(10)
  })

  it('签到 → 签到计数 +1', () => {
    const { ctx } = makeCtx(save)
    const res = applyAction(save, { type: 'daily.signIn' }, ctx)
    expect(res.ok).toBe(true)
    expect(save.daily.taskProgress[counterKey('signIn', 'daily')]).toBe(1)
  })

  it('遗物强化 → 强化件数 +1', () => {
    const { ctx, rng } = makeCtx(save)
    const relic = makeTestRelic('set_jiangtun_1', rng)
    save.relics.push(relic)
    const res = applyAction(save, { type: 'relic.upgrade', uid: relic.uid }, ctx)
    expect(res.ok).toBe(true)
    expect(save.daily.taskProgress[counterKey('relicUpgrade', 'daily')]).toBe(1)
  })

  it('失败的召唤不消耗计数（失败即原子）', () => {
    const { ctx } = makeCtx(save)
    save.player.crystals = 0
    save.player.tickets = 0
    const res = applyAction(save, { type: 'gacha.pull', poolId: 'standard', count: 1 }, ctx)
    expect(res.ok).toBe(false)
    expect(save.daily.taskProgress[counterKey('pull', 'daily')]).toBeUndefined()
  })
})

describe('任务领取：先校验后修改', () => {
  let save: SaveData

  beforeEach(() => {
    save = makeSave()
  })

  it('没完成 → 拒绝，存档不变', () => {
    const { ctx } = makeCtx(save)
    const before = JSON.stringify(save)
    const res = applyAction(save, { type: 'daily.claimTask', taskId: 'd_pull' }, ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe(GAME_ERROR_CODES.TASK_NOT_COMPLETED)
    expect(JSON.stringify(save)).toBe(before)
  })

  it('完成后 → 发奖并标记已领取', () => {
    const { ctx } = makeCtx(save)
    completeTask(save, 'd_pull')
    const before = save.player.relicStones
    const res = applyAction(save, { type: 'daily.claimTask', taskId: 'd_pull' }, ctx)
    expect(res.ok).toBe(true)
    expect(save.player.relicStones).toBe(before + 6)
    expect(save.daily.taskClaimed).toContain('d_pull')
  })

  it('重复领取 → 拒绝，资源不再增加', () => {
    const { ctx } = makeCtx(save)
    completeTask(save, 'd_pull')
    applyAction(save, { type: 'daily.claimTask', taskId: 'd_pull' }, ctx)
    const afterFirst = save.player.relicStones
    const res = applyAction(save, { type: 'daily.claimTask', taskId: 'd_pull' }, ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe(GAME_ERROR_CODES.TASK_ALREADY_CLAIMED)
    expect(save.player.relicStones).toBe(afterFirst)
  })

  it('不存在的任务 → 拒绝', () => {
    const { ctx } = makeCtx(save)
    const res = applyAction(save, { type: 'daily.claimTask', taskId: 'not_a_task' }, ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe(GAME_ERROR_CODES.TASK_NOT_FOUND)
  })

  it('跨日后同一个每日任务可以再领（新的周期）', () => {
    const { ctx } = makeCtx(save)
    completeTask(save, 'd_pull')
    applyAction(save, { type: 'daily.claimTask', taskId: 'd_pull' }, ctx)
    const stones = save.player.relicStones

    // 第二天：进度与领取记录都归位
    const { ctx: ctx2 } = makeCtx(save, NOW + DAY_MS)
    const views = taskViews(save.daily, NOW + DAY_MS, 'daily')
    const pull = views.find((v) => v.def.id === 'd_pull')!
    expect(pull.claimed).toBe(false)
    expect(pull.progress).toBe(0)

    // 第二天再抽一次 → 可以重新领
    applyAction(save, { type: 'gacha.pull', poolId: 'standard', count: 1 }, ctx2)
    const res = applyAction(save, { type: 'daily.claimTask', taskId: 'd_pull' }, ctx2)
    expect(res.ok).toBe(true)
    expect(save.player.relicStones).toBe(stones + 6)
  })

  it('周目标跨周归零后可以重新累计', () => {
    const { ctx } = makeCtx(save)
    completeTask(save, 'w_pull')
    applyAction(save, { type: 'daily.claimTask', taskId: 'w_pull' }, ctx)
    const { ctx: ctx2 } = makeCtx(save, NOW + 7 * DAY_MS)
    const views = taskViews(save.daily, NOW + 7 * DAY_MS, 'weekly')
    const pull = views.find((v) => v.def.id === 'w_pull')!
    expect(pull.claimed).toBe(false)
    expect(pull.progress).toBe(0)
  })
})

describe('任务奖励口径', () => {
  it('任务奖励不含圣杯结晶 / 抽卡券 / 银两 / 印记', () => {
    for (const task of TASKS) {
      const reward = task.rewards as Record<string, unknown>
      for (const key of Object.keys(reward)) {
        expect(['skillStones', 'relicStones']).toContain(key)
      }
    }
  })

  it('任务表覆盖四条玩法来源（推征 / 召唤 / 遗物 / 签到）', () => {
    const metrics = new Set(DAILY_TASKS.map((t) => t.metric))
    expect(metrics).toEqual(new Set(['battle', 'pull', 'relicUpgrade', 'signIn']))
    expect(WEEKLY_TASKS.length).toBeGreaterThan(0)
  })

  it('每条任务都有引导入口（除签到外）', () => {
    for (const task of TASKS) {
      if (task.id === 'd_signin') {
        expect(task.route).toBe('')
        continue
      }
      expect(task.route.length).toBeGreaterThan(0)
      // 路由名（vue-router 的 name），不是路径
      expect(task.route).toMatch(/^[a-z][a-z_]*$/)
    }
  })
})
