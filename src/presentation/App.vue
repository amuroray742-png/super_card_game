<script setup lang="ts">
/**
 * 应用外壳：顶部资源条 + 内容区 + 底部标签栏 + 全局提示 + 离线结算弹窗。
 *
 * 启动顺序由**路由守卫**兜住（见 router.ts）：
 *   恢复会话 → 载入该账号的存档 → 首启引导劫持。
 * 本组件只负责渲染，未登录时（登录页 / 公开合规页）走裸布局，不显示资源条与标签栏。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { IDLE } from '../core/config/economy.ts'
import { STAGE_INDEX } from '../core/config/stages.ts'
import { resourceIconPath } from '../core/config/art.ts'
import {
  RESOURCE_DEFS,
  TOP_BAR_RESOURCE_KEYS,
  resourceDesc,
  type TopBarResourceKey,
} from '../core/config/resources.ts'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from './stores/game'
import { useAccountStore } from './stores/account'
import type { IdleChannelKind } from '../core/model/types.ts'
import { formatNumber } from './utils/format'
import { rewardLines } from './utils/reward-text'
import { richParts } from '../content/compliance/index.ts'
import ChallengeReplay from './components/ChallengeReplay.vue'

const store = useGameStore()
const account = useAccountStore()
const route = useRoute()
const router = useRouter()
const booted = ref(false)

const TABS = [
  { key: 'expedition', label: '推征', icon: '⚔', to: '/expedition' },
  { key: 'temple', label: '圣殿', icon: '◈', to: '/temple' },
  { key: 'formation', label: '阵位', icon: '❖', to: '/formation' },
  // ⚠ **实施修正（资源/背包版本 v10）**：「铸造」升级为「背包」。
  //   路径与路由名 `forge` 全部保留（E2E / 截图工具 / 任务跳转都不用改），
  //   列数仍是 5 → 360px 窄机型零回归。
  { key: 'forge', label: '背包', icon: '⚒', to: '/forge' },
  { key: 'legacy', label: '传承', icon: '✧', to: '/legacy' },
]

const activeTab = computed(() => (route.meta.tab as string) ?? '')

/** 未登录 → 裸布局（无资源条、无标签栏） */
const bare = computed(() => !account.isAuthenticated)

const bareTitle = computed(() => (route.name === 'login' ? '登录' : '合规与概率公示'))

/**
 * 顶部资源条（图标 + 数量）。
 *
 * ⚠ **名称不出现**在顶栏里：名称与作用描述统一放在
 *   `core/config/resources.ts` 的登记表，点击图标才在弹窗里给（铁律 #8）。
 *   资源清单与顶栏展示因此不会各写一套。
 */
const resources = computed(() =>
  TOP_BAR_RESOURCE_KEYS.map((key) => ({
    key,
    name: RESOURCE_DEFS[key].name,
    value: store.save.player[key],
  })),
)

/** 当前打开的资源说明弹窗（null = 未打开） */
const activeResource = ref<TopBarResourceKey | null>(null)

/** 弹窗内容：登记表里的名称与描述 + 当前数量 */
const activeDef = computed(() =>
  activeResource.value ? RESOURCE_DEFS[activeResource.value] : null,
)
const activeValue = computed(() =>
  activeResource.value ? store.save.player[activeResource.value] : 0,
)
const activeDesc = computed(() =>
  activeResource.value ? resourceDesc(activeResource.value) : '',
)

/**
 * 资源说明拆成粗体 / 普通片段。
 *
 * ⚠ 资源描述里也用了 `**…**` 强调（与合规页同一套写法），
 *   而本弹窗是**纯文本插值** → 不解析的话星号会原样印在玩家眼前。
 *   统一走合规页那份 `richParts`（唯一口径，不用 v-html）。
 */
const activeDescParts = computed(() => richParts(activeDesc.value))

/**
 * 点「前往召唤」。
 *
 * 抽卡是核心循环，入口必须在任意页面一键可达（铁律 #10）——
 * 顶栏图标点击改为弹窗后，这个入口收进弹窗里，不能整条丢掉。
 */
function goGacha() {
  activeResource.value = null
  router.push('/gacha')
}

// ⚠ 结算明细的名称一律取登记表（铁律 #8：禁止就地写中文名）。
//   旧实现在这里硬编码「银两 / 经验 / 术式结晶 / 强化石 / 英灵印记」，
//   与背包 / 登记表对不上——现已改为通用聚合（`rewardLines`）。
//
// ⚠ **挂机改版 v11**：离线结算是**分通道段**——每条通道各自报告
//   目标、结算次数与掉落明细（`ChannelSettlement`）。
// ⚠ **存档 v12 增加遗物通道**：通道名映射漏一条 = 结算面板把遗物产出写成别的通道
//   （四选一的写法曾让第四种通道默默落到「强化副本」上）。
const CHANNEL_LABELS: Record<IdleChannelKind, string> = {
  main: '主线',
  skill: '技能副本',
  enhance: '强化副本',
  relic: '遗物副本',
}

const offlineChannels = computed(() =>
  (store.offlineReport?.channels ?? []).map((ch) => ({
    ...ch,
    label: CHANNEL_LABELS[ch.channel],
    lines: rewardLines(ch.rewards),
  })),
)

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
function stopHeartbeat() {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}
function syncHeartbeat() {
  stopHeartbeat()
  if (!booted.value || document.visibilityState !== 'visible' || !store.loaded || store.offline || account.offline || !account.isAuthenticated) return
  void store.heartbeat()
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void store.heartbeat()
  }, IDLE.HEARTBEAT_INTERVAL_MS)
}
watch(() => [store.loaded, store.offline, account.offline, account.user?.id], syncHeartbeat)
// 切页时关掉资源弹窗：否则返回上一页时弹窗还挂着
watch(() => route.path, () => {
  activeResource.value = null
})

onMounted(() => {
  booted.value = true
  syncHeartbeat()
  document.addEventListener('visibilitychange', flushOnHide)
  window.addEventListener('online', recoverOnOnline)
  window.addEventListener('pagehide', flushOnHide)
})

onUnmounted(() => {
  stopHeartbeat()
  document.removeEventListener('visibilitychange', flushOnHide)
  window.removeEventListener('online', recoverOnOnline)
  window.removeEventListener('pagehide', flushOnHide)
})

/**
 * 页面隐藏 / 关闭前把本地缓存刷一下。
 *
 * 服务端权威后，进度在**每次动作**时就已落库（服务端），
 * 这里只是把最新镜像写进本地缓存，断网时也能看到最近进度。
 */
function recoverOnOnline() {
  if (store.offline || account.offline) void store.reconnect()
}

function flushOnHide() {
  syncHeartbeat()
  if (document.visibilityState === 'hidden') void store.persist()
}

/** 返回：引导页是首启落地页，没有可靠的前进历史，直接回推征页 */
function goBack() {
  if (route.path === '/guide') {
    router.replace('/expedition')
    return
  }
  router.back()
}

/** 裸布局的返回：登录页没有前进历史，回落到登录页本身 */
function goBackBare() {
  if (route.path === '/login') {
    router.replace('/login')
    return
  }
  router.back()
}
</script>

<template>
  <div class="shell">
    <!-- 未登录：裸布局（登录页 / 公开合规页） -->
    <template v-if="bare">
      <main class="body bare-body">
        <div class="bare-top">
          <button v-if="route.path !== '/login'" class="bare-back" @click="goBackBare">‹</button>
          <span class="tiny muted">{{ bareTitle }}</span>
        </div>
        <router-view v-if="booted" />
      </main>
    </template>

    <template v-else>
      <!-- 顶部资源条 -->
      <header class="top">
        <button class="top-back" v-if="route.meta.tab === undefined" @click="goBack">‹</button>
        <div class="res-bar">
          <!--
            图标 + 数量，**不显示文字名称**（名称与作用描述在点击后的弹窗里给）。
            名称仍通过 alt / aria-label / title 暴露给读屏与桌面 hover。
          -->
          <button
            v-for="r in resources"
            :key="r.key"
            class="res-item"
            :data-res="r.key"
            :aria-label="`${r.name} ${formatNumber(r.value)}`"
            :title="r.name"
            @click="activeResource = r.key"
          >
            <img class="res-icon" :src="resourceIconPath(r.key)" :alt="r.name" width="22" height="22" />
            <b>{{ formatNumber(r.value) }}</b>
          </button>
        </div>
        <button class="top-extra" @click="router.push('/settings')">⋯</button>
      </header>

      <!-- 资源说明（点击顶栏图标） -->
      <div v-if="activeResource && activeDef" class="mask" @click.self="activeResource = null">
        <div class="dialog" data-testid="resource-dialog">
          <div class="panel-title">
            <span>{{ activeDef.name }}</span>
            <button class="btn btn-sm btn-ghost" @click="activeResource = null">关闭</button>
          </div>
          <div class="res-info">
            <img class="res-info-icon" :src="resourceIconPath(activeResource)" :alt="activeDef.name" />
            <b>{{ formatNumber(activeValue) }}</b>
          </div>
          <p class="tiny muted" style="margin: 8px 0 0; line-height: 1.8">
            <template v-for="(part, i) in activeDescParts" :key="i">
              <b v-if="part.bold">{{ part.text }}</b>
              <template v-else>{{ part.text }}</template>
            </template>
          </p>
          <button
            v-if="activeDef.gachaEntry"
            class="btn btn-primary btn-block"
            style="margin-top: 12px"
            @click="goGacha"
          >
            前往召唤
          </button>
        </div>
      </div>

      <!-- 内容 -->
      <main class="body" v-if="booted">
        <!-- 离线模式：服务端不可达，只能看不能改 -->
        <div v-if="store.offline" class="offline-bar">
          离线模式 · 连不上服务器，现在只能查看进度，操作需恢复连接
          <button data-testid="reconnect" class="btn btn-sm" :disabled="store.reconnecting" @click="store.reconnect()">
            {{ store.reconnecting ? '恢复中…' : '恢复连接' }}
          </button>
        </div>
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </main>
      <div v-else class="empty">载入中…</div>

      <!--
        战斗回放：**全局唯一**的全屏覆盖层。
        ⚠ 以前是各页面各挂一份（推征 / 副本 / 关卡深链），现在统一挂在这里 ——
          战斗在哪个页面发起都走同一层，且底下页面的位置一个字都不动
          （AGENTS.md 铁律 #68 的 P2）。
      -->
      <ChallengeReplay />

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
    </template>

    <!-- 全局提示 -->
    <transition name="fade">
      <div v-if="store.toast" class="toast" :class="store.toast.kind">{{ store.toast.text }}</div>
    </transition>

    <!-- 离线结算（未登录时不显示：弹窗属于游戏内结算，登录页不该出现） -->
    <div v-if="!bare && store.offlineReport" class="mask" @click.self="store.offlineReport = null">
      <div class="dialog" data-testid="offline-settlement">
        <div class="panel-title">离线挂机结算</div>
        <!--
          ⚠ 通道数**按实际结算段数推导**，不写死「三条 / 四条」：
          只有挂上目标且真的结算了的通道才会出现在 `offlineReport.channels` 里，
          写死一个数就是「过期即说谎」——v12 加了遗物通道后这里就漏改过一次。
        -->
        <p class="muted tiny" style="margin: 0 0 10px">
          {{ offlineChannels.length }} 条通道各自结算，共 {{ store.offlineReport.rolls }} 次。
        </p>
        <div v-for="ch in offlineChannels" :key="ch.channel" class="offline-chan">
          <div class="row-between tiny">
            <b>{{ ch.label }}</b>
            <span class="muted">{{ ch.rolls }} 次 · {{ ch.targetName }}</span>
          </div>
          <div v-for="r in ch.lines" :key="r.key" class="row-between tiny" style="padding: 3px 0 0 8px">
            <span class="muted">{{ r.label }}</span>
            <b>+{{ formatNumber(r.value) }}</b>
          </div>
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
  /* ⚠ 用 min-height 而不是 height：资源条换行后顶栏要能长高，
   *   固定高度会把第二行裁掉（铁律 #27：资源必须看得见）。 */
  min-height: var(--top-h);
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

/* 离线模式提示条（服务端不可达 → 只能看，不能操作） */
.offline-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  padding: 6px 12px;
  font-size: 12px;
  color: #ffd9a0;
  background: rgba(120, 72, 20, 0.92);
  border-bottom: 1px solid rgba(255, 200, 120, 0.35);
  text-align: center;
}

/* 未登录时的裸布局（登录页 / 公开合规页） */
.bare-body {
  padding-bottom: 20px;
}

.bare-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 4px;
}

.bare-back {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--c-line);
  color: var(--c-text-dim);
  font-size: 16px;
  line-height: 1;
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
