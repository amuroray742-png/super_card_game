<script setup lang="ts">
/**
 * 关卡详情**深链薄壳**（挂机改版 v11 · D6）。
 *
 * ⚠ 关卡详情已经改成**弹窗**（`StageDetailModal.vue`），推征页就地打开、URL 不变。
 *   但 `/stage/:id` 这条**深链必须保留**——
 *   E2E（`tests/e2e/battle.spec.ts`）与截图工具（`tools/capture/screenshot.ts --stage`）
 *   都依赖它。深链落地后渲染**同一个弹窗组件**，内容完全一致。
 *
 * ⚠ **挑战之后不踢走玩家**：刚打完一场就把人带回上一页，
 *   战斗演出（页面级 `ChallengeReplay`）就白播了 ⇒ 这里改成「关掉弹窗、留在本页」。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import StageDetailModal from '../components/StageDetailModal.vue'

const route = useRoute()
const router = useRouter()
const store = useGameStore()

const stageId = computed(() => Number(route.params.id ?? 0))

/** 弹窗是否已被关掉（深链页没有「上一页」时用得上） */
const closed = ref(false)

function onClose() {
  // 刚打完一场 → 先留在本页把演出播完
  if (store.challengeReplay) {
    closed.value = true
    return
  }
  router.back()
}
</script>

<template>
  <div class="page">
    <StageDetailModal v-if="!closed" :stage-id="stageId" @close="onClose" />
  </div>
</template>
