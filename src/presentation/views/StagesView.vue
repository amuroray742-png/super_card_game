<script setup lang="ts">
/**
 * 关卡一览（L2 二级页）：本章关卡网格 + 挂机目标 + 当前羁绊。
 *
 * ## 为什么把它从推征页挪出来
 *
 * 推征页 L1 现在是**一屏**（AGENTS.md 铁律 #68）：31 格关卡网格要占 354px，
 * 塞进去就把「挑战此关」和「全部领取」挤出了首屏。
 * 网格属于**低频信息**（玩家推进时基本不看，偶尔回看进度）⇒ 下沉到二级页。
 *
 * ## 两个模式
 *
 * - **浏览模式**（`/stages`）：看本章网格，点格子开关卡详情弹窗（URL 不变）。
 * - **选关模式**（`/stages?pick=main`）：从推征页的「主线通道 ›」进来，
 *   点**已通关**的格子直接设为挂机目标，成功后回推征页。
 *
 * ⚠ 二级页**不加深路由**：关卡详情仍是**弹窗**（`StageDetailModal`），
 *   `/stage/:id` 深链保留但不再从本页进入 ⇒ 页面深度 ≤ 3 级。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { CHAPTERS, STAGES } from '../../core/config/stages.ts'
import { mainIdleTargetName } from '../utils/idle-target'
import StageDetailModal from '../components/StageDetailModal.vue'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

/** 选关模式：从推征页「更换主线挂机目标」进来 */
const pickMode = computed(() => route.query.pick === 'main')

/** 关卡详情弹窗（就地打开，URL 不变） */
const detailStageId = ref<number | null>(null)

/** 玩家手动切过的章节（`null` = 跟随「下一关所在章」） */
const pickedChapter = ref<number | null>(null)

/** 当前章节（默认 = 下一关所在章） */
const currentChapter = computed(() => pickedChapter.value ?? store.nextChallengeStage.chapter)

/** 本章关卡列表 */
const chapterStages = computed(() => STAGES.filter((s) => s.chapter === currentChapter.value))

/** 本章章名（走 core 配置表，表现层不写中文名） */
const chapterName = computed(() => CHAPTERS.find((c) => c.id === currentChapter.value)?.name ?? '')

/** 本章已通关关卡数 */
const clearedInChapter = computed(() => chapterStages.value.filter((s) => s.id <= store.clearedStage).length)

/** 主线挂机目标名（与推征页同一份口径） */
const idleTargetName = computed(() => mainIdleTargetName(store.save, store.clearedStage))

/** 当前生效的羁绊（羁绊影响战力 ⇒ 推征时必须看得见） */
const activeBonds = computed(() => store.bondStates.filter((b) => b.active))

/** 该关是否已通关（**挂机与挑战的资格都看它**） */
function isCleared(id: number): boolean {
  return id <= store.clearedStage
}

/** 点格子：选关模式下直接设为挂机目标，否则开详情弹窗 */
async function onStageClick(stageId: number) {
  if (!pickMode.value) {
    detailStageId.value = stageId
    return
  }
  // ⚠ 选关模式下只允许选**已通关**的关卡（挂机只挂已通关内容，永不卡关）
  if (!isCleared(stageId)) {
    store.notify('挂机只挂已通关的关卡，先手动挑战通关', 'warn')
    return
  }
  const res = await store.setIdleChannel({ channel: 'main', stageId })
  if (!res) return
  store.notify('挂机目标已更新', 'ok')
  void router.replace('/expedition')
}

/** 进入「选关模式」（改挂机目标） */
function enterPickMode(): void {
  void router.replace({ path: '/stages', query: { pick: 'main' } })
}
</script>

<template>
  <div class="page">
    <div class="page-title">{{ pickMode ? '选择挂机目标' : '关卡一览' }}</div>

    <!-- 章节切换（章名 / 关卡数走 core 配置表） -->
    <div class="chip-row" style="margin-bottom: 10px">
      <button
        v-for="c in CHAPTERS"
        :key="c.id"
        class="chip"
        :class="{ on: c.id === currentChapter }"
        :data-testid="`stage-chapter-${c.id}`"
        @click="pickedChapter = c.id"
      >
        {{ c.id }}
      </button>
    </div>

    <div class="row-between tiny muted" style="margin-bottom: 8px">
      <span>第 {{ currentChapter }} 章 · {{ chapterName }}</span>
      <span>已通关 {{ clearedInChapter }}/{{ chapterStages.length }}</span>
    </div>

    <!-- 本章关卡网格 -->
    <div class="stage-grid">
      <button
        v-for="s in chapterStages"
        :key="s.id"
        class="stage-cell"
        :class="{
          done: isCleared(s.id),
          now: s.id === store.nextChallengeStage.id,
          boss: s.isBoss,
        }"
        :data-testid="`stage-cell-${s.id}`"
        @click="onStageClick(s.id)"
      >
        <span class="s-idx">{{ s.index }}</span>
        <span v-if="s.isBoss" class="s-boss">BOSS</span>
        <span v-if="pickMode && isCleared(s.id)" class="s-pick">挂</span>
      </button>
    </div>

    <p v-if="pickMode" class="tiny muted" style="margin: 8px 0 0">
      点已通关的关卡即可设为挂机目标；未通关的关卡要先手动挑战通关（挂机只挂已通关内容，永不卡关）。
    </p>

    <!-- 挂机目标 -->
    <div class="row-between panel" style="margin-top: 12px; padding: 10px">
      <span class="tiny">
        <span class="muted">挂机目标</span>
        <b style="margin-left: 6px">{{ idleTargetName ?? '未设置' }}</b>
      </span>
      <button class="btn btn-sm btn-ghost" data-testid="stage-pick-idle" @click="enterPickMode">更改 ›</button>
    </div>

    <!-- 当前生效的羁绊（羁绊影响战力 ⇒ 规则必须在玩家眼前） -->
    <div v-if="activeBonds.length" class="tiny muted" style="margin-top: 8px">
      当前羁绊：
      <span v-for="b in activeBonds" :key="b.bond.id" class="tag tag-sr" style="margin-right: 4px">
        {{ b.bond.name }}
      </span>
    </div>

    <!-- 关卡详情弹窗（不跳页、不加页面深度） -->
    <StageDetailModal v-if="detailStageId !== null" :stage-id="detailStageId" @close="detailStageId = null" />
  </div>
</template>

<style scoped>
/** 选关模式的可挂徽标 */
.s-pick {
  position: absolute;
  top: 1px;
  right: 2px;
  font-size: 9px;
  color: var(--c-gold-2);
}
</style>
