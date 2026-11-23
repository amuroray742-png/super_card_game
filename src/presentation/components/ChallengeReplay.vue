<script setup lang="ts">
/**
 * **手动挑战的战斗回放 + 战后结算**（挂机改版 v11）。
 *
 * ## 为什么要有这个组件
 *
 * 挂机改版后，战斗只在**手动挑战**时发生（挂机不跑战斗，铁律 #52）。
 * 服务端执行完把 `BattleResult` **一次性**回传（不进幂等日志，设计稿 §3.7），
 * 表现层必须把它**演出来**——否则玩家点完「挑战」只看到一条 toast，
 * 「回放沿用已有的跳过演出设置」（设计稿 §3.8.2）就是空话。
 *
 * ## 规则一律取 core
 *
 * - 战斗事实（胜负 / 回合 / 名册 / 战报）→ core 产出的 `BattleResult`；
 * - 实发奖励 → core 产出的 `RewardBundle`（**不是**掉落表预览）；
 * - 关卡名 → core 配置表（`STAGES` / `dungeonStageById`），表现层不自拼（铁律 #8）。
 *
 * ⚠ 回放可能**没有**（`battle === null`）：24 小时内重放同一 `actionId` 时，
 *   服务端不再回传回放 ⇒ 只出结算，不重播演出（结果与奖励仍一致）。
 *
 * ⚠ 回放挂在 store 上（换页不丢，换账号会清），直到玩家点「收起」或下一场挑战覆盖它。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useGameStore } from '../stores/game'
import { STAGES } from '../../core/config/stages.ts'
import { dungeonStageById } from '../../core/config/dungeons.ts'
import { resourceIconPath } from '../../core/config/art.ts'
import { formatNumber } from '../utils/format'
import { rewardLines } from '../utils/reward-text'
import BattleCanvas from './BattleCanvas.vue'
import BattleResultPanel from './BattleResultPanel.vue'

const store = useGameStore()

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

/** 换一场战斗 → 结算重新隐藏（新一轮演出重新播） */
watch(
  () => replay.value,
  () => {
    finished.value = false
    void scrollIntoView()
  },
)

/** 面板出现时滚到视野内（挑战可能在页面下方点，演出要在看得见的地方播） */
async function scrollIntoView(): Promise<void> {
  await nextTick()
  const el = document.querySelector<HTMLElement>('[data-testid="challenge-replay"]')
  try {
    el?.scrollIntoView({ block: 'start' })
  } catch {
    // 滚动失败不影响功能（面板已经渲染出来了）
  }
}

/** 回放倍速：写回存档设置（与设置页同一口径） */
function onSpeedChange(v: number) {
  void store.updateSettings({ speed: v })
}

/** 关掉面板 */
function close() {
  store.clearChallengeReplay()
}
</script>

<template>
  <section v-if="replay" class="panel" data-testid="challenge-replay">
    <div class="panel-title">
      <span>战斗回放</span>
      <div class="row" style="gap: 6px">
        <span class="tag" :class="replay.win ? 'tag-sr' : ''">{{ replay.win ? '胜利' : '失败' }}</span>
        <span v-if="replay.firstClear" class="tag tag-sr">首通</span>
        <button class="btn btn-sm btn-ghost" data-testid="challenge-replay-close" @click="close">收起</button>
      </div>
    </div>

    <div class="tiny muted" style="margin-bottom: 8px">{{ title }}</div>

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
    <p v-if="!replay.battle" class="tiny muted" style="margin: 8px 0 0">
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
  </section>
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
