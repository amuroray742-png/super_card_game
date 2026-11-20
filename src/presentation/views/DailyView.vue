<script setup lang="ts">
/**
 * 每日：7 天签到、每日任务、周目标与竞技产出提示。
 *
 * ## 分工
 *
 * - **条目 / 目标 / 奖励**：来自 `core/config/tasks.ts`（唯一出处）；
 * - **进度与领取状态**：来自服务端存档（`store.save.daily`），
 *   界面用 core 的纯函数 `taskViews` 按当前周期换算（跨日 / 跨周自动归位）；
 * - **领取**：走服务端动作 `daily.claimTask`（判定与发奖都在服务端）。
 *
 * 界面**不自己算**「算不算完成」：那套判定在 core 里，服务端用的是同一份。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { DAILY } from '../../core/config/economy.ts'
import { taskViews, type TaskView } from '../../core/systems/tasks.ts'
import { ITEM_DEFS } from '../../core/config/items.ts'
import { dayIndex } from '../../core/time.ts'
import { formatNumber } from '../utils/format'
import { rewardLines } from '../utils/reward-text'

const store = useGameStore()
const router = useRouter()

const daily = computed(() => store.save.daily)

/**
 * 签到奖励条目（配置表各条字段不完全相同，统一成同一形状便于展示）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：抽卡券 / 术式结晶 / 遗物强化石退役，
 *   改为 `items`（通用经验书）。
 */
interface SignInReward {
  crystals?: number
  silver?: number
  items?: Record<string, number>
}

/** 签到奖励表（数值全部来自 core 配置） */
const REWARDS: SignInReward[] = DAILY.SIGN_IN_REWARDS.map((r) => ({ ...r }))

/** 今天的自然日编号（与服务端同一口径：北京时间） */
const today = computed(() => dayIndex(store.now()))

/** 今天是否已签到 */
const signedToday = computed(() => daily.value.lastSignInDay === today.value)

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

/**
 * 签到奖励文案。
 *
 * ⚠ 名称一律取登记表（铁律 #8：禁止就地写中文名）。
 *   签到奖励结构 = `{ crystals, silver, items }`（抽卡券 / 术式结晶 / 强化石已退役）。
 */
function rewardText(reward: SignInReward): string {
  return rewardLines(reward).map((l) => `${l.label} ${formatNumber(l.value)}`).join(' · ')
}

/**
 * 任务奖励文案（只可能是通用经验书，见 config/tasks.ts 的 TaskReward）。
 */
function taskRewardText(view: TaskView): string {
  const books = view.def.rewards.expBooks
  if (!books) return ''
  const parts: string[] = []
  if (books.small) parts.push(`${ITEM_DEFS.expBookSmall.name} ${books.small}`)
  if (books.large) parts.push(`${ITEM_DEFS.expBookLarge.name} ${books.large}`)
  return parts.join(' · ')
}

/** 每日任务（北京时间 0 点重置） */
const dailyTasks = computed(() => taskViews(daily.value, store.now(), 'daily'))

/** 周目标（北京时间周一 0 点重置） */
const weeklyTasks = computed(() => taskViews(daily.value, store.now(), 'weekly'))

/** 签到：奖励发放与连续天数推进由服务端负责（数值取自 core 配置） */
async function signIn() {
  const reward = await store.signInDaily()
  if (reward) {
    const parts = rewardLines(reward).map((l) => `${l.label} ${formatNumber(l.value)}`)
    store.notify(parts.length ? `签到成功：${parts.join(' · ')}` : '签到成功', 'ok')
  }
}

/** 领取任务奖励（服务端判定与发奖） */
async function claim(view: TaskView) {
  const reward = await store.claimTask(view.def.id)
  if (!reward) return
  const parts = rewardLines(reward).map((l) => `${l.label} ${formatNumber(l.value)}`)
  store.notify(parts.length ? `已领取：${parts.join(' · ')}` : '任务奖励已领取', 'ok')
}

/** 前往对应玩法（铁律 #10：任务要能真的把人带到玩法上） */
function go(view: TaskView) {
  if (view.def.route) router.push({ name: view.def.route })
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
        <span class="tiny muted">每日 0 点重置</span>
      </div>
      <div
        v-for="view in dailyTasks"
        :key="view.def.id"
        class="task-card"
        :data-testid="`task-${view.def.id}`"
        :class="{ done: view.completed, claimed: view.claimed }"
      >
        <div class="task-head">
          <span class="task-title">{{ view.def.title }}</span>
          <button
            v-if="view.def.route"
            class="btn btn-ghost btn-sm"
            :data-testid="`task-go-${view.def.id}`"
            @click="go(view)"
          >
            前往
          </button>
        </div>
        <div class="tiny muted task-progress">
          进度 {{ view.progress }} / {{ view.def.target }} · 奖励 {{ taskRewardText(view) }}
        </div>
        <button
          class="btn btn-primary btn-sm btn-block"
          :data-testid="`task-claim-${view.def.id}`"
          :disabled="!view.completed || view.claimed"
          @click="claim(view)"
        >
          {{ view.claimed ? '已领取' : view.completed ? '领取奖励' : '未完成' }}
        </button>
      </div>
    </section>

    <!-- 周目标 -->
    <section class="panel">
      <div class="panel-title">
        <span>周目标</span>
        <span class="tiny muted">每周一 0 点重置</span>
      </div>
      <div
        v-for="view in weeklyTasks"
        :key="view.def.id"
        class="task-card"
        :data-testid="`task-${view.def.id}`"
        :class="{ done: view.completed, claimed: view.claimed }"
      >
        <div class="task-head">
          <span class="task-title">{{ view.def.title }}</span>
          <button
            v-if="view.def.route"
            class="btn btn-ghost btn-sm"
            :data-testid="`task-go-${view.def.id}`"
            @click="go(view)"
          >
            前往
          </button>
        </div>
        <div class="tiny muted task-progress">
          进度 {{ view.progress }} / {{ view.def.target }} · 奖励 {{ taskRewardText(view) }}
        </div>
        <button
          class="btn btn-primary btn-sm btn-block"
          :data-testid="`task-claim-${view.def.id}`"
          :disabled="!view.completed || view.claimed"
          @click="claim(view)"
        >
          {{ view.claimed ? '已领取' : view.completed ? '领取奖励' : '未完成' }}
        </button>
      </div>
      <p class="tiny muted" style="margin: 8px 0 0">
        任务奖励只有通用经验书（辅助养成），不含圣杯结晶，不影响召唤节奏与竞技产出。
      </p>
    </section>

    <!-- 竞技产出提示 -->
    <section class="panel notice">
      <div class="panel-title"><span>竞技产出提示</span></div>
      <p class="tiny" style="margin: 0; line-height: 1.8; color: var(--c-text-dim)">
        ⚠ 竞技勋章与竞技材料<b>已停止新增</b>，旧余额只作记录保留。
        竞技只承接段位分与称号，不产出银两、经验、强化石与圣杯结晶。
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

.task-card {
  padding: 8px;
  margin-bottom: 8px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
}

.task-card.done {
  border-color: #3d6b52;
}

.task-card.claimed {
  opacity: 0.72;
}

.task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-title {
  font-size: 13px;
  color: var(--c-text);
}

.task-progress {
  margin: 4px 0 6px;
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
