<script setup lang="ts">
/**
 * 登录 / 注册页（首屏）。
 *
 * - 强制登录才能进游戏：未登录时路由守卫会把玩家送到本页
 * - 用户名与口令在**本地先校验**（规则与后端共用 core/config/account.ts），
 *   校验不通过不发请求，避免无谓的往返与限流计数
 * - 口令只做「非空」级别的本地提示，强度规则与服务端一致
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAccountStore } from '../stores/account'
import {
  ACCOUNT,
  validatePassword,
  validateUsername,
} from '../../core/config/account.ts'

const account = useAccountStore()
const router = useRouter()
const route = useRoute()

type Mode = 'login' | 'register'
const mode = ref<Mode>('login')

const username = ref('')
const password = ref('')
const localError = ref<string | null>(null)

const busy = computed(() => account.busy)
const errorText = computed(() => localError.value ?? account.error)

/**
 * **服务地址就地修改**（登录前就能改）。
 *
 * ⚠ 为什么必须在登录页：设置页在路由守卫后面 ⇒ 连不上后端时玩家
 *   **进不去设置页**，也就改不了地址 ⇒ 死路（错误提示让玩家「检查后端地址」，
 *   却不给地方改）。
 */
const addrEditing = ref(false)
const apiBaseInput = ref(account.apiBaseOverride || account.apiBase)

function toggleAddrEditing(): void {
  addrEditing.value = !addrEditing.value
  if (addrEditing.value) apiBaseInput.value = account.apiBaseOverride || account.apiBase
}

/** 保存服务地址（空串 = 清除覆盖） */
function saveApiBase(): void {
  account.saveApiBase(apiBaseInput.value)
  addrEditing.value = false
  apiBaseInput.value = account.apiBaseOverride || account.apiBase
  localError.value = null
  account.error = null
}

function switchMode(next: Mode) {
  mode.value = next
  localError.value = null
  account.error = null
}

/** 登录后回到哪里：只接受站内绝对路径，避免被拼成外站地址 */
function resolveRedirect(): string {
  const raw = route.query.redirect
  const target = Array.isArray(raw) ? raw[0] : raw
  if (typeof target !== 'string') return '/'
  if (!target.startsWith('/') || target.startsWith('//')) return '/'
  return target
}

async function submit() {
  localError.value = null
  account.error = null

  const nameError = validateUsername(username.value.trim())
  if (nameError) {
    localError.value = nameError
    return
  }
  const passError = validatePassword(password.value)
  if (passError) {
    localError.value = passError
    return
  }

  const ok =
    mode.value === 'login'
      ? await account.login(username.value.trim(), password.value)
      : await account.register(username.value.trim(), password.value)
  if (!ok) return

  // 换路由会触发守卫：守卫负责载入该账号的存档
  await router.replace(resolveRedirect())
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-title">超级圣杯战争</div>
      <p class="login-sub tiny muted">登录后进度随账号保存，可在其他设备继续</p>

      <div class="mode">
        <button :class="{ on: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button :class="{ on: mode === 'register' }" @click="switchMode('register')">注册</button>
      </div>

      <label class="field">
        <span>用户名</span>
        <input
          v-model="username"
          type="text"
          autocomplete="username"
          placeholder="3-16 位字母、数字或下划线"
          :disabled="busy"
        />
      </label>

      <label class="field">
        <span>口令</span>
        <input
          v-model="password"
          type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          placeholder="至少 8 位"
          :disabled="busy"
          @keyup.enter="submit"
        />
      </label>

      <p class="tiny muted rule">
        用户名 {{ ACCOUNT.USERNAME_MIN }}-{{ ACCOUNT.USERNAME_MAX }} 位，仅限字母、数字与下划线；
        口令 {{ ACCOUNT.PASSWORD_MIN }}-{{ ACCOUNT.PASSWORD_MAX }} 位。账号不区分大小写。
      </p>

      <div v-if="errorText" class="err tiny">{{ errorText }}</div>

      <button class="btn btn-primary btn-block" :disabled="busy" @click="submit">
        {{ busy ? '处理中…' : mode === 'login' ? '登录' : '注册并进入' }}
      </button>

      <div class="login-foot">
        <button class="link tiny" @click="router.push('/compliance')">合规与概率公示</button>
        <button class="link tiny addr addr-edit-toggle" @click="toggleAddrEditing">
          服务地址 {{ account.apiBaseLabel }}{{ addrEditing ? '（收起）' : '（修改）' }}
        </button>
      </div>

      <div v-if="addrEditing" class="addr-edit">
        <input v-model="apiBaseInput" class="addr-input" placeholder="留空 = 同源；或填后端地址（不带 /api）" />
        <button class="btn btn-sm btn-block" style="margin-top: 6px" @click="saveApiBase">
          保存服务地址
        </button>
        <p class="tiny muted" style="margin: 6px 0 0; line-height: 1.6">
          连不上后端时改这里。留空 = 同源（开发服与正式服的 <code>/api</code> 都会自动转发）；
          独立部署的后端填完整 origin，例如 <code>http://192.168.1.10:8787</code>（不要带 <code>/api</code>）。
        </p>
      </div>
    </div>

    <p class="tiny muted age">本游戏适合 16 周岁及以上人群游玩，请合理安排游戏时间。</p>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px 18px;
  background: radial-gradient(120% 60% at 50% 0%, #241f18 0%, var(--c-bg) 58%);
}

.login-card {
  width: 100%;
  max-width: 360px;
  background: var(--c-panel);
  border: 1px solid var(--c-line);
  border-radius: 12px;
  padding: 20px 16px 16px;
}

.login-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--c-gold-2);
  text-align: center;
}

.login-sub {
  text-align: center;
  margin: 6px 0 16px;
}

.mode {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
}

.mode button {
  flex: 1;
  min-height: 34px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-dim);
  font-size: 13px;
}

.mode button.on {
  border-color: var(--c-gold);
  background: #2a2419;
  color: var(--c-gold-2);
}

.field {
  display: block;
  margin-bottom: 10px;
}

.field span {
  display: block;
  font-size: 12px;
  color: var(--c-text-dim);
  margin-bottom: 4px;
}

.field input {
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text);
  font-size: 14px;
  outline: none;
}

.field input:focus {
  border-color: var(--c-line-2);
}

.rule {
  margin: 2px 0 10px;
  line-height: 1.7;
}

.err {
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid #7a352c;
  background: rgba(122, 53, 44, 0.22);
  color: #e9a79c;
}

.login-foot {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.link {
  color: var(--c-text-dim);
  text-decoration: underline;
}

/* 服务地址：默认只显示一行，改的时候才展开输入框 */
.addr,
.addr-edit-toggle {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 10px;
  opacity: 0.7;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 62%;
}

.addr-edit {
  margin-top: 8px;
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

.age {
  text-align: center;
  max-width: 320px;
}
</style>
