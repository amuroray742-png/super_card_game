<script setup lang="ts">
/**
 * 设置：账号、战斗速度、音效、演出、存档导出导入、重置进度与关于。
 * 存档读写一律经 src/platform/storage.ts，表现层不直接访问 localStorage；
 * 后端通信一律经 src/platform/account.ts。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { useAccountStore } from '../stores/account'
import { storage } from '../../platform/storage.ts'
import {
  readApiBaseOverride,
  resolveApiBase,
  writeApiBaseOverride,
} from '../../platform/account.ts'
import { BATTLE } from '../../core/config/economy.ts'
import pkg from '../../../package.json'

const store = useGameStore()
const account = useAccountStore()
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

// ─────────────────────────── 账号 ───────────────────────────

/** 当前后端地址（localStorage 覆盖优先，其次环境变量，最后默认值） */
const apiBase = computed(() => resolveApiBase())
/** 可编辑的服务地址（静态托管时指向自建后端） */
const apiBaseInput = ref(readApiBaseOverride() || apiBase.value)

function saveApiBase() {
  writeApiBaseOverride(apiBaseInput.value)
  store.notify('服务地址已保存', 'ok')
}

/** 退出登录：先把还没推上云端的存档刷掉，再吊销会话 */
async function doLogout() {
  await store.flushPush()
  await account.logout()
  await router.replace('/login')
}

const deleteOpen = ref(false)

/** 注销账号：服务端级联删除账号 / 会话 / 云存档 */
async function doDeleteAccount() {
  const ok = await account.deleteAccount()
  deleteOpen.value = false
  if (!ok) return
  store.notify('账号已注销，云端数据已删除', 'warn')
  await router.replace('/login')
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

    <!-- 账号 -->
    <section class="panel">
      <div class="panel-title"><span>账号</span></div>
      <div class="row-between tiny" style="margin-bottom: 6px">
        <span class="muted">当前账号</span>
        <b>{{ account.user?.username ?? '未登录' }}</b>
      </div>
      <div class="row-between tiny" style="margin-bottom: 6px">
        <span class="muted">服务地址</span>
        <b class="addr">{{ apiBase }}</b>
      </div>
      <input v-model="apiBaseInput" class="addr-input" placeholder="http://127.0.0.1:8787" />
      <button class="btn btn-sm btn-block" style="margin-top: 6px" @click="saveApiBase">
        保存服务地址
      </button>
      <p class="tiny muted" style="margin: 8px 0 0; line-height: 1.7">
        进度随账号保存在云端，登录后可在其他设备继续；本机也会保留一份副本。
      </p>
      <button class="btn btn-sm btn-block" style="margin-top: 10px" @click="doLogout">退出登录</button>
      <button class="btn btn-sm btn-danger btn-block" style="margin-top: 6px" @click="deleteOpen = true">
        注销账号
      </button>
    </section>

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
      <div class="tiny muted" style="margin-top: -4px">
        开启后观战与战斗预览直接出战后结算，不播放战斗演出。
      </div>
    </section>

    <!-- 存档 -->
    <section class="panel">
      <div class="panel-title"><span>存档</span></div>
      <p class="tiny muted" style="margin: 0 0 8px">
        存档串可用于备份当前进度：导出后在其他设备粘贴导入即可。
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
        清空本机与云端的进度并回到初始状态，该操作不可撤销。
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
    <!-- 注销账号二次确认 -->
    <div v-if="deleteOpen" class="mask" @click.self="deleteOpen = false">
      <div class="dialog">
        <div class="panel-title">注销账号</div>
        <p class="tiny muted" style="margin: 0 0 10px; line-height: 1.8">
          注销后会删除账号 {{ account.user?.username }} 的云端存档与登录状态，本机副本也会被清除。
          该操作不可撤销，如需保留进度请先导出存档。
        </p>
        <div class="row" style="gap: 8px">
          <button class="btn btn-sm" style="flex: 1" @click="deleteOpen = false">取消</button>
          <button class="btn btn-sm btn-danger" style="flex: 1" @click="doDeleteAccount">确认注销</button>
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

.addr {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.addr-input {
  width: 100%;
  min-height: 32px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-dim);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  outline: none;
}

.addr-input:focus {
  border-color: var(--c-line-2);
}
</style>
