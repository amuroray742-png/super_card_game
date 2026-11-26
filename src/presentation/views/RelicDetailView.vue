<script setup lang="ts">
/**
 * 遗物详情页（`/relic/:uid`，图鉴页进入）。
 *
 * ⚠ **内容由 `RelicDetailContent` 提供** —— 与仓库里的**底部抽屉同一份 UI**。
 *   改版前这里是一套独立实现（有分解没装备），仓库里又是另一套（有装备没分解），
 *   同一件遗物在两个入口看到的信息不一样；现在合成一份（铁律 #4 的精神）。
 *
 * ## 数据来源
 *
 * ⚠ 仓库里的遗物**不在客户端镜像里**（分包后镜像只带已装备遗物），
 *   所以详情页要向服务端要单件（`GET /api/relics/:uid`）；
 *   已装备的那件本地就有，直接用（省一次请求）。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import RelicDetailContent from '../components/RelicDetailContent.vue'
import type { RelicInstance } from '../../core/model/types.ts'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

const uid = computed(() => String(route.params.uid ?? ''))

/** 当前遗物（服务端取的那件；拿不到就是 null） */
const relic = ref<RelicInstance | null>(null)
const loading = ref(true)

watch(
  uid,
  async (id) => {
    loading.value = true
    const local = store.relicsByUid.get(id) ?? null
    relic.value = local
    if (!local) {
      const fetched = await store.fetchRelic(id)
      relic.value = fetched ?? null
    }
    loading.value = false
  },
  { immediate: true },
)

/** 动作执行完 → 重新取一次单件（强化后等级会变） */
async function refresh() {
  const fetched = await store.fetchRelic(uid.value)
  if (fetched) relic.value = fetched
}
</script>

<template>
  <div class="page">
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!relic" class="empty">
      未找到该遗物<br />
      <span class="tiny">它可能已被分解</span>
    </div>

    <template v-else>
      <div class="page-title">遗物</div>
      <section class="panel">
        <RelicDetailContent
          :uid="uid"
          :prefetched="relic"
          @changed="refresh"
          @removed="router.back()"
        />
      </section>
      <button class="btn btn-block btn-ghost" @click="router.back()">返回</button>
    </template>
  </div>
</template>
