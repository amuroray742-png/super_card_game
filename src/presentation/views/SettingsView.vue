<script setup lang="ts">
/**
 * 设置：战斗速度、音效、演出、存档导出导入、重置进度与关于。
 * 存档读写一律经 src/platform/storage.ts，表现层不直接访问 localStorage。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { storage } from '../../platform/storage.ts'
import { BATTLE } from '../../core/config/economy.ts'
import pkg from '../../../package.json'

const store = useGameStore()
const router = useRouter()

const VERSION = pkg.version

const settings = computed(() => store.save.settings)

/** 战斗速度：写入存档并同步回放倍速 */
function setSpeed(v: number) {
  store.save.settings.speed = v
  store.battleSpeed = v
  store.persist()
}

function toggleSfx() {
  store.save.settings.sfx = !store.save.settings.sfx
  store.persist()
}

function toggleSkipAnim() {
  store.save.settings.skipAnim = !store.save.settings.skipAnim
  store.persist()
}

// ─────────────────────────── 存档导出 / 导入 ───────────────────────────

const exportText = ref('')
const importText = ref('')
const busy = ref(false)

async function doExport() {
  busy.value = true
  try {
    exportText.value = await store.exportSaveText()
    store.notify('存档已生成，可复制保存', 'ok')
  } catch {
    store.notify('导出失败', 'warn')
  } finally {
    busy.value = false
  }
}

async function copyExport() {
  if (!exportText.value) return
  try {
    await navigator.clipboard.writeText(exportText.value)
    store.notify('已复制到剪贴板', 'ok')
  } catch {
    store.notify('复制失败，请手动选择文本', 'warn')
  }
}

async function doImport() {
  const text = importText.value.trim()
  if (!text) {
    store.notify('请先粘贴存档内容', 'warn')
    return
  }
  busy.value = true
  try {
    const ok = await store.importSaveText(text)
    if (ok) importText.value = ''
  } finally {
    busy.value = false
  }
}

// ─────────────────────────── 重置 ───────────────────────────

const resetOpen = ref(false)

async function doReset() {
  await store.reset()
  resetOpen.value = false
}
</script>

<template>
  <div class="page">
    <div class="page-title">设置</div>

    <!-- 战斗 -->
    <section class="panel">
      <div class="panel-title"><span>战斗</span></div>
      <div class="row-between tiny" style="margin-bottom: 6px">
        <span class="muted">战斗速度</span>
        <b>×{{ settings.speed }}</b>
      </div>
      <div class="chips">
        <button
          v-for="v in BATTLE.SPEED_OPTIONS"
          :key="v"
          class="chip"
          :class="{ on: settings.speed === v }"
          @click="setSpeed(v)"
        >
          ×{{ v }}
        </button>
      </div>

      <div class="row-between setting-row">
        <span>音效</span>
        <button class="switch" :class="{ on: settings.sfx }" @click="toggleSfx">
          {{ settings.sfx ? '开' : '关' }}
        </button>
      </div>
      <div class="row-between setting-row">
        <span>跳过演出</span>
        <button class="switch" :class="{ on: settings.skipAnim }" @click="toggleSkipAnim">
          {{ settings.skipAnim ? '开' : '关' }}
        </button>
      </div>
    </section>

    <!-- 存档 -->
    <section class="panel">
      <div class="panel-title"><span>存档</span></div>
      <p class="tiny muted" style="margin: 0 0 8px">
        进度仅保存在本机浏览器中。导出后可在其他设备导入同一份进度。
      </p>
      <div class="row" style="gap: 6px">
        <button class="btn btn-sm" style="flex: 1" :disabled="busy" @click="doExport">导出存档</button>
        <button class="btn btn-sm" style="flex: 1" :disabled="busy || !exportText" @click="copyExport">
          复制存档串
        </button>
      </div>
      <textarea
        v-if="exportText"
        v-model="exportText"
        class="save-area"
        readonly
        rows="3"
      ></textarea>

      <div class="row-between" style="margin: 12px 0 6px">
        <span class="tiny muted">导入存档</span>
      </div>
      <textarea v-model="importText" class="save-area" rows="3" placeholder="粘贴存档串"></textarea>
      <button class="btn btn-sm btn-block" style="margin-top: 6px" :disabled="busy" @click="doImport">
        导入并覆盖当前进度
      </button>
    </section>

    <!-- 重置 -->
    <section class="panel">
      <div class="panel-title"><span>重置进度</span></div>
      <p class="tiny muted" style="margin: 0 0 8px">
        清空本机存档并回到初始状态，该操作不可撤销。
      </p>
      <button class="btn btn-sm btn-danger btn-block" @click="resetOpen = true">重置全部进度</button>
    </section>

    <!-- 关于 -->
    <section class="panel">
      <div class="panel-title"><span>关于</span></div>
      <div class="row-between tiny">
        <span class="muted">游戏名称</span>
        <b>超级圣杯战争</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">版本</span>
        <b>v{{ VERSION }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">已召唤</span>
        <b>{{ store.save.stats.totalPulls }} 次</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">累计挂机</span>
        <b>{{ Math.floor(store.save.idle.totalIdleSeconds / 60) }} 分钟</b>
      </div>
      <button class="btn btn-sm btn-ghost btn-block" style="margin-top: 10px" @click="router.push('/compliance')">
        查看合规与概率公示
      </button>
      <button class="btn btn-sm btn-ghost btn-block" style="margin-top: 6px" @click="router.push('/guide')">
        查看新手引导
      </button>
    </section>

    <!-- 重置二次确认 -->
    <div v-if="resetOpen" class="mask" @click.self="resetOpen = false">
      <div class="dialog">
        <div class="panel-title">重置确认</div>
        <p class="tiny muted" style="margin: 0 0 10px; line-height: 1.8">
          重置后会清空英灵、遗物、关卡进度与召唤记录，并回到初始资源。
          若需要保留进度，请先导出存档。
        </p>
        <div class="row" style="gap: 8px">
          <button class="btn btn-sm" style="flex: 1" @click="resetOpen = false">取消</button>
          <button class="btn btn-sm btn-danger" style="flex: 1" @click="doReset">确认重置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  gap: 6px;
}

.chip {
  flex: 1;
  min-height: 40px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  font-size: 13px;
  color: var(--c-text-dim);
}

.chip.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.setting-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--c-line);
}

.setting-row:last-child {
  border-bottom: none;
}

.switch {
  min-width: 52px;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--c-line-2);
  background: var(--c-bg-2);
  font-size: 12px;
  color: var(--c-text-dim);
}

.switch.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.save-area {
  width: 100%;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-dim);
  font-size: 11px;
  font-family: inherit;
  resize: vertical;
  outline: none;
}

.save-area:focus {
  border-color: var(--c-line-2);
}
</style>
