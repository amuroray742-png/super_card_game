<script setup lang="ts">
/**
 * 段位天梯：展示全部段位门槛与玩家当前竞技数据。
 * 段位门槛取 core/config/economy.ts 的 TIERS，判定用 core 的 tierForPoints。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { TIERS } from '../../core/config/economy.ts'
import { tierForPoints } from '../../core/systems/arena.ts'
import { formatNumber } from '../utils/format'

const store = useGameStore()
const router = useRouter()

const arena = computed(() => store.save.arena)
const points = computed(() => arena.value.tierPoints)
const currentTier = computed(() => tierForPoints(points.value))

/** 下一段位及其所需分数 */
const nextTier = computed(() => TIERS.find((t) => t.min > points.value) ?? null)
const toNext = computed(() => (nextTier.value ? nextTier.value.min - points.value : 0))

/** 当前段位在阶梯中的位置 */
const currentIndex = computed(() => TIERS.findIndex((t) => t.name === currentTier.value))

function tierProgress(min: number): number {
  const upper = TIERS.find((t) => t.min > min)?.min ?? min
  if (upper === min) return 100
  return Math.max(0, Math.min(100, ((points.value - min) / (upper - min)) * 100))
}
</script>

<template>
  <div class="page">
    <div class="page-title">段位天梯</div>

    <!-- 当前段位 -->
    <section class="panel">
      <div class="row-between">
        <div>
          <div class="tiny muted">当前段位</div>
          <div class="tier-name">{{ currentTier }}</div>
        </div>
        <div class="points-box">
          <div class="tiny muted">段位分</div>
          <div class="points">{{ formatNumber(points) }}</div>
        </div>
      </div>
      <div v-if="nextTier" class="bar" style="margin: 12px 0 6px">
        <i :style="{ width: `${Math.min(100, (points / nextTier.min) * 100)}%` }"></i>
      </div>
      <div class="tiny muted">
        {{ nextTier ? `距 ${nextTier.name} 还差 ${formatNumber(toNext)} 分` : '已达最高段位' }}
      </div>
    </section>

    <!-- 段位阶梯 -->
    <section class="panel">
      <div class="panel-title"><span>段位门槛</span></div>
      <div
        v-for="(t, i) in TIERS"
        :key="t.name"
        class="tier-row"
        :class="{ on: t.name === currentTier, passed: i < currentIndex }"
      >
        <div class="row-between">
          <b>{{ t.name }}</b>
          <span class="tiny muted">{{ formatNumber(t.min) }} 分</span>
        </div>
        <div class="bar" style="margin-top: 5px">
          <i :style="{ width: `${tierProgress(t.min)}%` }"></i>
        </div>
      </div>
    </section>

    <!-- 竞技数据 -->
    <section class="panel">
      <div class="panel-title"><span>竞技数据</span></div>
      <div class="row-between tiny">
        <span class="muted">段位分</span>
        <b>{{ formatNumber(arena.tierPoints) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">对战分</span>
        <b>{{ formatNumber(arena.pvpPoints) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">勋章</span>
        <b>{{ formatNumber(arena.medals) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">竞技等级</span>
        <b>{{ arena.arenaLevel }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">战术铭文</span>
        <b>{{ arena.runes.length }} / 3</b>
      </div>
      <p class="tiny muted" style="margin: 8px 0 0">
        竞技等级决定可用的战术铭文槽位数量，不直接提供属性加成。
      </p>
    </section>

    <button class="btn btn-block btn-ghost" @click="router.push('/arena')">返回竞技场</button>
  </div>
</template>

<style scoped>
.tier-name {
  font-size: 26px;
  font-weight: 700;
  color: var(--c-gold-2);
  margin-top: 2px;
}

.points-box {
  text-align: right;
}

.points {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.tier-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
}

.tier-row:last-child {
  border-bottom: none;
}

.tier-row.on {
  color: var(--c-gold-2);
}

.tier-row.passed {
  color: var(--c-text-dim);
}
</style>
