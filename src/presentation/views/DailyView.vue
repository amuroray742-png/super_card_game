<script setup lang="ts">
/**
 * 每日：7 天签到、每日任务占位与竞技勋章周上限提示。
 * 签到奖励取自 core/config/economy.ts 的 DAILY 配置；跨天判定用 core/time.ts 的 dayIndex。
 */
import { computed } from 'vue'
import { useGameStore } from '../stores/game'
import { ARENA, DAILY } from '../../core/config/economy.ts'
import { dayIndex } from '../../core/time.ts'
import { formatNumber } from '../utils/format'

const store = useGameStore()

const daily = computed(() => store.save.daily)

/** 签到奖励条目（配置表各条字段不完全相同，统一成同一形状便于展示） */
interface SignInReward {
  crystals?: number
  silver?: number
  tickets?: number
  skillStones?: number
  relicStones?: number
}

/** 签到奖励表（数值全部来自 core 配置） */
const REWARDS: SignInReward[] = DAILY.SIGN_IN_REWARDS.map((r) => ({ ...r }))

/** 今天的自然日编号 */
const today = dayIndex(Date.now())

/** 今天是否已签到 */
const signedToday = computed(() => daily.value.lastSignInDay === today)

/** 连续签到天数（断签归零） */
const streak = computed(() => daily.value.signInStreak)

/** 下一个可领取的奖励下标（0..6） */
const nextIndex = computed(() => streak.value % DAILY.SIGN_IN_CYCLE)

/** 本轮已领取的天数 */
const claimedCount = computed(() => Math.min(streak.value, DAILY.SIGN_IN_CYCLE))

function isClaimed(index: number): boolean {
  return index < claimedCount.value
}

function isToday(index: number): boolean {
  return index === nextIndex.value && !signedToday.value
}

function rewardText(reward: SignInReward): string {
  const parts: string[] = []
  if (reward.crystals) parts.push(`圣杯结晶 ${reward.crystals}`)
  if (reward.silver) parts.push(`银两 ${formatNumber(reward.silver)}`)
  if (reward.tickets) parts.push(`抽卡券 ${reward.tickets}`)
  if (reward.skillStones) parts.push(`术式结晶 ${reward.skillStones}`)
  if (reward.relicStones) parts.push(`强化石 ${reward.relicStones}`)
  return parts.join(' · ')
}

/** 签到：奖励发放与连续天数推进由 store 负责（数值取自 core 配置） */
async function signIn() {
  const reward = await store.signInDaily()
  if (reward) {
    const parts: string[] = []
    if (reward.crystals) parts.push(`圣杯结晶 ${reward.crystals}`)
    if (reward.silver) parts.push(`银两 ${formatNumber(reward.silver)}`)
    if (reward.tickets) parts.push(`抽卡券 ${reward.tickets}`)
    if (reward.skillStones) parts.push(`术式结晶 ${reward.skillStones}`)
    if (reward.relicStones) parts.push(`强化石 ${reward.relicStones}`)
    store.notify(parts.length ? `签到成功：${parts.join(' · ')}` : '签到成功', 'ok')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-title">每日</div>

    <!-- 签到 -->
    <section class="panel">
      <div class="panel-title">
        <span>每日签到</span>
        <span class="tiny muted">连续 {{ streak }} 天</span>
      </div>
      <p class="tiny muted" style="margin: 0 0 8px">
        每 {{ DAILY.SIGN_IN_CYCLE }} 天为一轮，断签后从第一天重新开始。
      </p>
      <div class="sign-grid">
        <div
          v-for="(reward, i) in REWARDS"
          :key="i"
          class="sign-cell"
          :class="{ claimed: isClaimed(i), today: isToday(i) }"
        >
          <div class="tiny muted">第 {{ i + 1 }} 天</div>
          <div class="tiny sign-reward">{{ rewardText(reward) }}</div>
          <div class="tiny" :class="isClaimed(i) ? 'ok-text' : isToday(i) ? 'gold-text' : 'muted'">
            {{ isClaimed(i) ? '已领取' : isToday(i) ? '可领取' : '未领取' }}
          </div>
        </div>
      </div>
      <button class="btn btn-primary btn-block" style="margin-top: 10px" :disabled="signedToday" @click="signIn">
        {{ signedToday ? '今日已签到' : '领取今日奖励' }}
      </button>
    </section>

    <!-- 每日任务 -->
    <section class="panel">
      <div class="panel-title">
        <span>每日任务</span>
        <span class="tiny muted">{{ daily.taskClaimed.length }} 项已领取</span>
      </div>
      <div class="task-row">
        <span>推征若干场</span>
        <span class="tiny muted">{{ daily.taskProgress.battle ?? 0 }}</span>
      </div>
      <div class="task-row">
        <span>完成召唤</span>
        <span class="tiny muted">{{ daily.taskProgress.pull ?? 0 }}</span>
      </div>
      <p class="tiny muted" style="margin: 8px 0 0">
        每日任务为占位内容，具体条目与奖励将在后续版本开放。
      </p>
    </section>

    <!-- 竞技周上限提示 -->
    <section class="panel notice">
      <div class="panel-title"><span>竞技产出提示</span></div>
      <p class="tiny" style="margin: 0; line-height: 1.8; color: var(--c-text-dim)">
        竞技勋章每周获取上限为 {{ ARENA.MEDAL_WEEKLY_CAP }} 枚，竞技兑换的抽卡券每周上限为
        {{ ARENA.TICKET_WEEKLY_CAP }} 张。竞技场不产出银两、经验、强化石与圣杯结晶。
      </p>
    </section>
  </div>
</template>

<style scoped>
.sign-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.sign-cell {
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
}

.sign-cell.claimed {
  border-color: #3d6b52;
  background: #1e2a21;
}

.sign-cell.today {
  border-color: var(--c-gold);
  background: #2a2419;
}

.sign-reward {
  margin: 4px 0;
  color: var(--c-text);
  line-height: 1.5;
}

.task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
  font-size: 13px;
}

.task-row:last-of-type {
  border-bottom: none;
}

.ok-text {
  color: var(--c-green);
}

.gold-text {
  color: var(--c-gold-2);
}

.notice {
  border-color: #6b5a2c;
}
</style>
