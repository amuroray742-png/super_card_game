<script setup lang="ts">
/**
 * 文字战报面板（观战 / 关卡预览）。
 *
 * 把 core 产出的战斗事件流渲染成**可滚动的文字战报**，
 * 方便玩家整体回顾一场战斗（此前只有画布底部一行「当前事件」，读不到全局）。
 *
 * ⚠ 战报文字**一律取 core 的 `entry.text`**，表现层不自己拼装文案
 *   （战斗事实由 core 独家产出，AGENTS.md 铁律 #16）。
 * ⚠ 列表范围是**时间的纯函数**：`visibleCount` 由 `projectState(t).eventIndex` 给出，
 *   与画面同源——倍速 / 跳转 / 重播都不会让列表和画面对不上（铁律 #20）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { BattleLogEntry } from '../../core/model/types.ts'

const props = defineProps<{
  /** core 产出的完整战报 */
  log: BattleLogEntry[]
  /** 已经发生的条目数（= projectState(t).eventIndex） */
  visibleCount: number
}>()

/** 已折叠（收起后只留标题条） */
const collapsed = ref(false)
/** 是否贴着底部：玩家手动往上翻时停掉自动跟底，免得被强行拽回去 */
const atBottom = ref(true)
/** 列表 DOM */
const listEl = ref<HTMLElement | null>(null)

/** 已经发生的条目 */
const visibleEntries = computed(() => props.log.slice(0, props.visibleCount))

/** 自动跟底时忽略 scroll 事件（程序化滚动也会派发 scroll） */
let autoScrolling = false

function scrollToLatest(): void {
  autoScrolling = true
  void nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
    atBottom.value = true
    // scroll 事件是异步派发的，下一帧再解除标记
    requestAnimationFrame(() => {
      autoScrolling = false
    })
  })
}

function onScroll(): void {
  if (autoScrolling) return
  const el = listEl.value
  if (!el) return
  // 距底部 24px 以内视为「贴着底部」
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
}

// 新条目到达 → 跟到底部
watch(
  () => props.visibleCount,
  () => {
    if (atBottom.value) scrollToLatest()
  },
)

// 战报换了（新一场战斗）→ 回到顶部并重新跟底
watch(
  () => props.log,
  () => {
    atBottom.value = true
    scrollToLatest()
  },
)
</script>

<template>
  <div class="log-panel" data-testid="battle-log">
    <div class="log-head">
      <button class="log-title" @click="collapsed = !collapsed">
        <span class="caret">{{ collapsed ? '▸' : '▾' }}</span>
        战报
        <span class="tiny muted">{{ visibleCount }} / {{ log.length }}</span>
      </button>
      <button
        v-if="!collapsed && !atBottom"
        class="btn btn-sm btn-ghost"
        data-testid="log-latest"
        @click="scrollToLatest"
      >
        ↓ 最新
      </button>
    </div>

    <!-- v-show 而非 v-if：折叠时保留 DOM，滚动位置不丢 -->
    <div v-show="!collapsed" ref="listEl" class="log-list" data-testid="battle-log-list" @scroll="onScroll">
      <template v-for="(e, i) in visibleEntries" :key="i">
        <!-- 回合分隔 -->
        <div v-if="e.kind === 'round'" class="log-round">第 {{ e.round }} 回合</div>
        <div v-else class="log-line" :class="`k-${e.kind}`">{{ e.text }}</div>
      </template>
      <div v-if="visibleCount === 0" class="log-empty tiny muted">战斗尚未开始…</div>
    </div>
  </div>
</template>

<style scoped>
.log-panel {
  border-top: 1px solid var(--c-line);
  background: var(--c-bg-2);
}

.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
}

.log-title {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--c-gold-2);
  letter-spacing: 0.08em;
  cursor: pointer;
}

.caret {
  font-size: 10px;
  color: var(--c-text-dim);
}

/* 滚动区：固定高度 + 内部滚动，不把页面撑长 */
.log-list {
  max-height: 168px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 10px 8px;
  font-size: 12px;
  line-height: 1.7;
}

/* 回合分隔 */
.log-round {
  margin: 6px 0 3px;
  text-align: center;
  font-size: 11px;
  color: var(--c-text-mute);
  letter-spacing: 0.14em;
  border-top: 1px solid var(--c-line);
  padding-top: 5px;
}

/* 普通条目：左侧色条 */
.log-line {
  padding: 1px 0 1px 8px;
  border-left: 2px solid var(--c-line-2);
  color: var(--c-text-dim);
  overflow-wrap: anywhere;
}

.k-damage {
  border-left-color: var(--c-red);
  color: #e6b6ac;
}

.k-dot {
  border-left-color: #8a4436;
  color: #c99a8f;
}

.k-heal {
  border-left-color: var(--c-green);
  color: #b6dcc6;
}

.k-shield {
  border-left-color: var(--c-blue);
  color: #b2d0dd;
}

.k-buff {
  border-left-color: #4d7a5c;
}

.k-debuff {
  border-left-color: #46607a;
}

.k-control {
  border-left-color: #6b5a8a;
}

.k-skill {
  border-left-color: var(--c-gold);
  color: var(--c-gold-2);
}

.k-summon {
  border-left-color: var(--c-gold);
  color: var(--c-gold-2);
}

.k-death {
  border-left-color: var(--c-red);
  color: var(--c-red);
  font-weight: 700;
}

.k-end {
  border-left-color: var(--c-gold);
  color: var(--c-gold-2);
  font-weight: 700;
}

.log-empty {
  padding: 6px 0 4px;
}
</style>
