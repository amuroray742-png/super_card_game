<script setup lang="ts">
/**
 * **手动挑战的战斗回放 + 战后结算**（挂机改版 v11 · 推征页一屏化 v13）。
 *
 * ## 为什么是全屏覆盖层
 *
 * 旧实现把回放**内联插在页面顶部**（`ExpeditionView.vue` 的第一个子节点）：
 * 打完一场想点「下一关」要往上滚 ≈600px（AGENTS.md 铁律 #68 的 P2）。
 *
 * 现在它是**从底部升起的全屏覆盖层**：
 * - 盖住顶栏与底栏（战斗期间玩家不需要看资源与导航）；
 * - 底下页面的位置**一个字都不动** ⇒ 关掉后主卡仍在原位；
 * - 打开期间**锁住内容区滚动**（`utils/scroll-lock.ts`）——
 *   否则玩家在演出途中滑了页面，关掉后才发现已经跑位。
 *
 * ## 组件是全局唯一的
 *
 * 实例挂在 `App.vue`（不再由各个页面各挂一个）：
 * 副本页、关卡深链页、推征页打出来的战斗都走**同一层**，
 * 不会出现「回放盖在页面上、下面还留着半个面板」。
 *
 * ## 规则一律取 core
 *
 * - 战斗事实（胜负 / 回合 / 名册 / 战报）→ core 产出的 `BattleResult`；
 * - 实发奖励 → core 产出的 `RewardBundle`（**不是**掉落表预览）；
 * - 关卡名 → core 配置表（`STAGES` / `dungeonStageById`），表现层不自拼（铁律 #8）。
 *
 * ⚠ 回放可能**没有**（`battle === null`）：24 小时内重放同一 `actionId` 时，
 *   服务端不再回传回放 ⇒ 只出结算，不重播演出（结果与奖励仍一致）。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useGameStore } from '../stores/game'
import { STAGES } from '../../core/config/stages.ts'
import { dungeonStageById } from '../../core/config/dungeons.ts'
import { resourceIconPath } from '../../core/config/art.ts'
import { formatNumber } from '../utils/format'
import { rewardLines } from '../utils/reward-text'
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock'
import BattleCanvas from './BattleCanvas.vue'
import BattleResultPanel from './BattleResultPanel.vue'

const store = useGameStore()
const route = useRoute()

/** 最近一次挑战的回放状态（战斗事实由 core 给出） */
const replay = computed(() => store.challengeReplay)

/** 演出是否播完（播完才出战后结算） */
const finished = ref(false)

/** 关卡名（core 配置表的唯一出处） */
const title = computed(() => {
  const r = replay.value
  if (!r) return ''
  if (r.kind === 'campaign') {
    const id = typeof r.stageId === 'number' ? r.stageId : Number(r.stageId)
    return STAGES.find((s) => s.id === id)?.name ?? `第 ${r.stageId} 关`
  }
  return dungeonStageById(String(r.stageId))?.name ?? String(r.stageId)
})

/** 战场氛围用的章节（副本没有章节概念，取第 1 章的配色） */
const chapter = computed(() => {
  const r = replay.value
  if (!r || r.kind !== 'campaign') return 1
  const id = typeof r.stageId === 'number' ? r.stageId : Number(r.stageId)
  return STAGES.find((s) => s.id === id)?.chapter ?? 1
})

/** 实发奖励行（名称取登记表，铁律 #8） */
const rewardRows = computed(() => rewardLines(replay.value?.rewards))

/** 底部「返回」按钮的文案（推征页说「返回推征」，其它页说「返回」） */
const backLabel = computed(() => (route.path === '/expedition' ? '返回推征' : '返回'))

/**
 * **能不能接着打下一关**（胜利 + 是主线战斗 + 后面还有关）。
 *
 * ⚠ `store.nextChallengeStage` 在全部通关后会停在最后一关 ⇒ 用
 *   「下一关 id > 已通关 id」判定，避免把「再打一遍最后一关」说成「下一关」。
 */
const nextStage = computed(() => store.nextChallengeStage)
const canChallengeNext = computed(
  () =>
    replay.value?.kind === 'campaign' &&
    replay.value.win === true &&
    nextStage.value.id > store.clearedStage,
)

/** 战败后可以「再战一次」（同一关重来） */
const canRetry = computed(() => replay.value?.kind === 'campaign' && replay.value.win === false)

/** 本场战斗的主线关卡 id（再战一次要用） */
const campaignStageId = computed(() => {
  const r = replay.value
  if (!r || r.kind !== 'campaign') return null
  return typeof r.stageId === 'number' ? r.stageId : Number(r.stageId)
})

/** 换一场战斗 → 结算重新隐藏（新一轮演出重新播） */
watch(
  () => replay.value,
  () => {
    finished.value = false
    syncScrollLock(replay.value !== null)
  },
)

/**
 * **换页 = 离开演出**。
 *
 * ⚠ 覆盖层是**全局**的（`App.vue` 唯一挂载）⇒ 不主动收起的话，它会一直盖在屏幕上：
 *   玩家点底部标签栏换了页面，却发现自己还在演出层里 ⇒ 直接挡住新页面。
 *
 * ⚠ 只认**路径**变化（`route.path`）：同页的 query 变化（`/stages?pick=main`）
 *   不是「离开演出」，不收。
 */
watch(
  () => route.path,
  () => {
    if (replay.value) close()
  },
)

/**
 * **滚动锁的幂等开关**。
 *
 * ⚠ 必须幂等：「挑战下一关」会让 `replay` 再次变化 ⇒ 若每次变化都
 *   `lockBodyScroll()`，锁的层数会一路涨 ⇒ 关闭覆盖层后页面仍然滚不动。
 */
let locked = false
function syncScrollLock(shouldLock: boolean): void {
  if (shouldLock === locked) return
  locked = shouldLock
  if (shouldLock) lockBodyScroll()
  else unlockBodyScroll()
}

// 组件被卸载（登出 / 换账号）时兜底解锁，别把页面永久锁死
onUnmounted(() => {
  if (!locked) return
  locked = false
  unlockBodyScroll()
})

/** 回放倍速：写回存档设置（与设置页同一口径） */
function onSpeedChange(v: number) {
  void store.updateSettings({ speed: v })
}

/** 关掉覆盖层（回到原页面，位置不变） */
function close() {
  store.clearChallengeReplay()
}

/**
 * **挑战下一关**（胜利后接着推进）。
 *
 * ⚠ 先关再打：`clearChallengeReplay()` 把旧的回放摘掉，
 *   紧接着的 `challengeStage()` 会写入新的回放 ⇒ 覆盖层原地换一场，
 *   玩家不用回页面再点一次。
 */
async function challengeNext() {
  const stage = nextStage.value
  close()
  await store.challengeStage(stage.id)
}

/** **再战一次**（同一关重来） */
async function retry() {
  const id = campaignStageId.value
  if (id === null) return
  close()
  await store.challengeStage(id)
}
</script>

<template>
  <div v-if="replay" class="overlay" data-testid="challenge-replay">
    <!-- 头部：关卡名 + 胜负 + 收起 -->
    <div class="overlay-head">
      <div class="row" style="gap: 6px; min-width: 0">
        <b class="tiny">{{ title }}</b>
        <span class="tag" :class="replay.win ? 'tag-sr' : ''">{{ replay.win ? '胜利' : '失败' }}</span>
        <span v-if="replay.firstClear" class="tag tag-sr">首通</span>
      </div>
      <button class="btn btn-sm btn-ghost" data-testid="challenge-replay-close" @click="close">收起</button>
    </div>

    <!-- 主体：演出 + 结算 + 奖励 -->
    <div class="overlay-body">
      <!-- 战斗演出（画面是时间的纯函数，倍速 / 跳过都由 BattleCanvas 负责） -->
      <BattleCanvas
        v-if="replay.battle"
        :battle="replay.battle"
        :speed="store.battleSpeed"
        :chapter="chapter"
        :skip-anim="store.save.settings.skipAnim"
        @finished="finished = true"
        @speed-change="onSpeedChange"
      />

      <!-- 战后结算 -->
      <BattleResultPanel v-if="finished && replay.battle" class="result-wrap" :battle="replay.battle" />

      <!--
        ⚠ 回放缺席时（服务端这次没回传）也要把**结算事实**讲清楚：
        玩家看到的仍是同一场战斗的结果与奖励，只是没有演出可播。
      -->
      <p v-if="!replay.battle" class="tiny muted" style="margin: 0 0 8px">
        本场回放数据已过保留期，不再重播演出；战斗结果与奖励不受影响。
      </p>

      <!-- 实发奖励（服务端回包里的那一份，不是掉落表预览） -->
      <div class="rewards">
        <div class="tiny muted" style="margin-bottom: 4px">本次获得</div>
        <div v-if="rewardRows.length === 0" class="tiny muted">无产出</div>
        <div v-for="row in rewardRows" :key="row.key" class="row-between tiny">
          <span class="muted res-label">
            <img
              v-if="row.iconKey"
              class="res-icon"
              :src="resourceIconPath(row.iconKey)"
              :alt="row.label"
              width="16"
              height="16"
            />{{ row.label }}
          </span>
          <b>{{ formatNumber(row.value) }}</b>
        </div>
      </div>
    </div>

    <!-- 底部：回原位 / 接着推进 -->
    <div class="overlay-foot">
      <button class="btn" style="flex: 1" data-testid="challenge-replay-return" @click="close">
        {{ backLabel }}
      </button>
      <button
        v-if="canChallengeNext"
        class="btn btn-primary"
        style="flex: 1"
        data-testid="challenge-next-stage"
        @click="challengeNext"
      >
        挑战下一关
      </button>
      <button
        v-else-if="canRetry"
        class="btn btn-primary"
        style="flex: 1"
        data-testid="challenge-retry"
        @click="retry"
      >
        再战一次
      </button>
    </div>
  </div>
</template>

<style scoped>
.result-wrap {
  margin-top: 10px;
}

.rewards {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--c-line);
}
</style>
