<script setup lang="ts">
/**
 * **遗物详情抽屉**（底部升起的半屏面板）。
 *
 * ## 为什么用抽屉而不是页内面板
 *
 * 旧版把遗物详情放在**仓库网格下面** ⇒ 360×640 上要点一件遗物，
 * 得先滚过 60 件（20 行 ≈ 1760px）才摸得到「强化 +1」按钮。
 * 抽屉把它变成「点一下就升起来」，**操作就在手指底下**，
 * 且**不加页面深度**（铁律 #68 / #69）。
 *
 * ⚠ 遮罩只盖内容区（顶栏与底栏留着）⇒ 玩家随时看得见资源、随时能离开。
 * ⚠ 内容由 `RelicDetailContent` 提供 —— 与 `/relic/:uid` 详情页**同一份 UI**，
 *   避免两处各写一套（历史上两套内容都不一样）。
 */
import { computed } from 'vue'
import RelicDetailContent from './RelicDetailContent.vue'
import type { RelicInstance } from '../../core/model/types.ts'

const props = defineProps<{
  /** 当前打开的遗物 uid（`null` = 抽屉关闭） */
  uid: string | null
  /** 兜底实例（这件遗物已经不在当前页 / 镜像里了） */
  prefetched?: RelicInstance | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

/** 抽屉是否打开 */
const open = computed(() => props.uid !== null)
</script>

<template>
  <div v-if="open && uid" class="sheet-mask" @click.self="emit('close')">
    <div class="sheet" data-testid="relic-detail-sheet">
      <div class="panel-title">
        <span>遗物</span>
        <button class="btn btn-sm btn-ghost" data-testid="relic-detail-close" @click="emit('close')">
          关闭
        </button>
      </div>
      <RelicDetailContent :uid="uid" :prefetched="prefetched" @removed="emit('close')" />
    </div>
  </div>
</template>
