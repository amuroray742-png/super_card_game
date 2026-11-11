<script setup lang="ts">
/**
 * 传承：圣杯重启（永久加成）与兑换码。
 * 重启条件与收益全部取自 core 的 previewRebirth，组件只做展示与确认。
 */
import { computed, ref } from 'vue'
import { useGameStore } from '../stores/game'
import { REBIRTH, REDEEM_CODES } from '../../core/config/economy.ts'
import { formatRate } from '../utils/format'

const store = useGameStore()

const preview = computed(() => store.rebirthPreview)

/** 重启二次确认 */
const confirmOpen = ref(false)

/** 兑换码 */
const codeInput = ref('')

async function doRebirth() {
  const result = await store.doRebirth()
  confirmOpen.value = false
  if (result) store.notify(`圣杯重启完成 · 永久加成 ${formatRate(result.nextPermBoost)}`, 'ok')
}

/** 兑换码：store 目前没有 redeem 动作，先按配置表发放并记录 */
async function redeem() {
  const code = codeInput.value.trim().toUpperCase()
  if (!code) return
  // 兑换码校验与发放由 store 负责（兑换表取自 core 配置）
  if (await store.redeemCode(code)) {
    codeInput.value = ''
  }
}
</script>

<template>
  <div class="page">
    <div class="page-title">传承</div>

    <!-- 重启概览 -->
    <section class="panel">
      <div class="panel-title">
        <span>圣杯重启</span>
        <span class="tag" :class="preview.eligible ? 'tag-sr' : ''">
          {{ preview.eligible ? '条件达成' : '条件未达成' }}
        </span>
      </div>

      <div class="boost-box">
        <div class="row-between tiny">
          <span class="muted">当前永久加成</span>
          <b>{{ formatRate(preview.currentPermBoost) }}</b>
        </div>
        <div class="row-between tiny">
          <span class="muted">重启后加成</span>
          <b class="gold">{{ formatRate(preview.nextPermBoost) }}</b>
        </div>
        <div class="row-between tiny">
          <span class="muted">本次获得</span>
          <b>{{ formatRate(preview.gainedPermBoost) }}</b>
        </div>
        <div class="row-between tiny">
          <span class="muted">距上限还差</span>
          <b>{{ formatRate(preview.permBoostCapRemaining) }}</b>
        </div>
        <div class="bar" style="margin-top: 8px">
          <i :style="{ width: `${Math.min(100, (preview.nextPermBoost / REBIRTH.PERM_BOOST_CAP) * 100)}%` }"></i>
        </div>
        <div class="tiny muted" style="margin-top: 5px">
          永久加成上限 {{ formatRate(REBIRTH.PERM_BOOST_CAP) }} · 已重启 {{ store.save.player.rebirthCount }} 次
        </div>
      </div>

      <div class="row-between tiny" style="margin-top: 10px">
        <span class="muted">将被重置的英灵</span>
        <b>{{ preview.resetHeroes }} 名</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">将被保留的英灵</span>
        <b>{{ preview.keptHeroes }} 名</b>
      </div>

      <p v-if="!preview.eligible" class="reason">{{ preview.reason }}</p>

      <button
        class="btn btn-primary btn-block"
        style="margin-top: 10px"
        :disabled="!preview.eligible"
        @click="confirmOpen = true"
      >
        执行重启
      </button>
      <p class="tiny muted" style="margin: 8px 0 0">
        重启条件：任一英灵达到 {{ REBIRTH.MIN_LEVEL }} 级，且通关第 {{ REBIRTH.MIN_CHAPTER }} 章。
      </p>
    </section>

    <!-- 重启说明 -->
    <section class="panel">
      <div class="panel-title"><span>重启效果</span></div>
      <div class="row-between tiny">
        <span class="muted">重置</span>
        <span>等级 · 经验 · 星级 · 技能等级 · 遗物强化等级</span>
      </div>
      <div class="row-between tiny" style="margin-top: 4px">
        <span class="muted">保留</span>
        <span>英灵本体 · 英灵印记 · 同名碎片 · 图鉴 · 段位</span>
      </div>
      <div class="row-between tiny" style="margin-top: 4px">
        <span class="muted">累计</span>
        <span>每轮 {{ formatRate(REBIRTH.PERM_BOOST_PER_ROUND) }} 永久加成</span>
      </div>
    </section>

    <!-- 兑换码 -->
    <section class="panel">
      <div class="panel-title"><span>兑换码</span></div>
      <div class="row" style="gap: 6px">
        <input v-model="codeInput" class="code-input" placeholder="输入兑换码" />
        <button class="btn btn-sm" @click="redeem">兑换</button>
      </div>
      <div v-if="store.save.codes.length" class="code-list">
        <div v-for="c in store.save.codes" :key="c" class="row-between tiny">
          <span class="muted">{{ c }}</span>
          <span>{{ REDEEM_CODES[c]?.note ?? '已使用' }}</span>
        </div>
      </div>
      <div v-else class="tiny muted" style="margin-top: 8px">尚未使用过兑换码。</div>
    </section>

    <!-- 重启二次确认 -->
    <div v-if="confirmOpen" class="mask" @click.self="confirmOpen = false">
      <div class="dialog">
        <div class="panel-title">重启确认</div>
        <p class="tiny muted" style="margin: 0 0 10px; line-height: 1.8">
          执行后，{{ preview.resetHeroes }} 名英灵的<b>等级、经验、星级、技能等级</b>与
          <b>全部遗物的强化等级</b>都会重置为初始值，永久加成提升至
          {{ formatRate(preview.nextPermBoost) }}。英灵本体、印记、碎片与图鉴会保留。
        </p>
        <div class="row" style="gap: 8px">
          <button class="btn btn-sm" style="flex: 1" @click="confirmOpen = false">取消</button>
          <button class="btn btn-sm btn-primary" style="flex: 1" @click="doRebirth">确认重启</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.boost-box {
  margin-top: 4px;
  padding: 10px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gold {
  color: var(--c-gold-2);
}

.reason {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #2a2419;
  border: 1px solid var(--c-line-2);
  font-size: 12px;
  color: #e0a06a;
}

.code-input {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  outline: none;
}

.code-input:focus {
  border-color: var(--c-line-2);
}

.code-list {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--c-line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
