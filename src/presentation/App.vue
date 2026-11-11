<script setup lang="ts">
/**
 * 应用外壳：顶部资源条 + 内容区 + 底部标签栏 + 全局提示 + 离线结算弹窗。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from './stores/game'
import { formatNumber } from './utils/format'

const store = useGameStore()
const route = useRoute()
const router = useRouter()
const booted = ref(false)

const TABS = [
  { key: 'expedition', label: '推征', icon: '⚔', to: '/expedition' },
  { key: 'temple', label: '圣殿', icon: '◈', to: '/temple' },
  { key: 'formation', label: '阵位', icon: '❖', to: '/formation' },
  { key: 'forge', label: '铸造', icon: '⚒', to: '/forge' },
  { key: 'legacy', label: '传承', icon: '✧', to: '/legacy' },
]

const activeTab = computed(() => (route.meta.tab as string) ?? '')

const resources = computed(() => {
  const p = store.save.player
  return [
    { label: '银两', value: p.silver },
    // 圣杯结晶可点击直达召唤页——抽卡是核心循环，必须在任意页面一键可达
    { label: '圣杯结晶', value: p.crystals, to: '/gacha' },
    { label: '抽卡券', value: p.tickets, to: '/gacha' },
    { label: '术式结晶', value: p.skillStones },
    { label: '强化石', value: p.relicStones },
    { label: '英灵印记', value: p.emblems },
  ]
})

const offlineRewards = computed(() => {
  const r = store.offlineReport?.rewards
  if (!r) return []
  return [
    { label: '银两', value: r.silver ?? 0 },
    { label: '经验', value: r.exp ?? 0 },
    { label: '术式结晶', value: r.skillStones ?? 0 },
    { label: '强化石', value: r.relicStones ?? 0 },
    { label: '英灵印记', value: r.emblems ?? 0 },
  ].filter((x) => x.value > 0)
})

onMounted(async () => {
  await store.load()
  booted.value = true
  // 离线结算：离开超过 1 分钟才结算
  const elapsed = (Date.now() - store.save.lastTickAt) / 1000
  if (elapsed > 60) void store.claimOffline()
  // 新手引导：首次进入（无英灵）且从主入口落地时，直接进入引导页。
  // 引导是「怎么抽卡」的第一次教学，必须自动出现，不能只置一个无人读取的标记；
  // 深链（/gacha、/compliance 等）不劫持，避免玩家被弹离想去的地方。
  const isRootEntry = route.path === '/' || route.path === '/expedition'
  if (isRootEntry && Object.keys(store.save.heroes).length === 0) {
    store.guideStep = 0
    router.replace('/guide')
  }
})

/** 返回：引导页是首启落地页，没有可靠的前进历史，直接回推征页 */
function goBack() {
  if (route.path === '/guide') {
    router.replace('/expedition')
    return
  }
  router.back()
}
</script>

<template>
  <div class="shell">
    <!-- 顶部资源条 -->
    <header class="top">
      <button class="top-back" v-if="route.meta.tab === undefined" @click="goBack">‹</button>
      <div class="res-bar">
        <template v-for="r in resources" :key="r.label">
          <button v-if="r.to" class="res-item res-link" @click="router.push(r.to)">
            {{ r.label }}<b>{{ formatNumber(r.value) }}</b>
          </button>
          <span v-else class="res-item">
            {{ r.label }}<b>{{ formatNumber(r.value) }}</b>
          </span>
        </template>
      </div>
      <button class="top-extra" @click="router.push('/settings')">⋯</button>
    </header>

    <!-- 内容 -->
    <main class="body" v-if="booted">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
    <div v-else class="empty">载入中…</div>

    <!-- 底部标签栏 -->
    <nav class="tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab"
        :class="{ on: activeTab === t.key }"
        @click="router.push(t.to)"
      >
        <i>{{ t.icon }}</i>
        <span>{{ t.label }}</span>
      </button>
    </nav>

    <!-- 全局提示 -->
    <transition name="fade">
      <div v-if="store.toast" class="toast" :class="store.toast.kind">{{ store.toast.text }}</div>
    </transition>

    <!-- 离线结算 -->
    <div v-if="store.offlineReport" class="mask" @click.self="store.offlineReport = null">
      <div class="dialog">
        <div class="panel-title">离线推征结算</div>
        <p class="muted tiny" style="margin: 0 0 10px">
          离线时长 {{ Math.round(store.offlineReport.elapsedSeconds / 60) }} 分钟，
          共进行 {{ store.offlineReport.battles }} 场推征
        </p>
        <div v-for="r in offlineRewards" :key="r.label" class="row-between" style="padding: 4px 0">
          <span class="muted">{{ r.label }}</span>
          <b>+{{ formatNumber(r.value) }}</b>
        </div>
        <button class="btn btn-primary btn-block" style="margin-top: 12px" @click="store.offlineReport = null">
          收下
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: radial-gradient(120% 60% at 50% 0%, #241f18 0%, var(--c-bg) 58%);
}

.top {
  height: var(--top-h);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid var(--c-line);
  background: rgba(20, 18, 15, 0.92);
  backdrop-filter: blur(8px);
}

.top-back,
.top-extra {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--c-line);
  color: var(--c-text-dim);
  font-size: 16px;
  line-height: 1;
}

.body {
  flex: 1 1 auto;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.tabs {
  flex: 0 0 auto;
  height: var(--tab-h);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border-top: 1px solid var(--c-line);
  background: rgba(20, 18, 15, 0.96);
  backdrop-filter: blur(8px);
}

.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--c-text-mute);
  font-size: 11px;
}

.tab i {
  font-style: normal;
  font-size: 17px;
  line-height: 1;
}

.tab.on {
  color: var(--c-gold-2);
}

.tab.on i {
  text-shadow: 0 0 10px rgba(232, 200, 122, 0.5);
}

.toast {
  position: fixed;
  left: 50%;
  bottom: calc(var(--tab-h) + 18px);
  transform: translateX(-50%);
  z-index: 200;
  padding: 8px 16px;
  border-radius: 8px;
  background: rgba(35, 32, 25, 0.96);
  border: 1px solid var(--c-line-2);
  font-size: 13px;
  white-space: nowrap;
  pointer-events: none;
}

.toast.ok { border-color: #3d6b52; color: #a9e6c4; }
.toast.warn { border-color: #7a4a30; color: #efc3a0; }

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
