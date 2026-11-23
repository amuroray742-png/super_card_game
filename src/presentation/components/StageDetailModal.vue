<script setup lang="ts">
/**
 * 关卡详情**弹窗**（挂机改版 v11 · D6）。
 *
 * ## 为什么是弹窗
 *
 * 关卡详情是「看一眼」的动作，不该把玩家从推征页带走——推征页才是主循环。
 * 现在推征页「详情 ›」与关卡网格点击都**就地开这个弹窗**（URL 不变）。
 *
 * ⚠ `/stage/:id` 路由**保留**（E2E `battle.spec.ts` 与截图工具 `screenshot.ts --stage`
 *   依赖该深链）→ `StageDetailView.vue` 变成薄壳，渲染同一个弹窗组件。
 *
 * ## 规则一律取 core
 *
 * 战斗事实 / 掉落口径 / 战力门槛 / 挂机资格全部来自 core，组件不参与判定（铁律 #2 / #4）。
 */
import { computed, ref } from 'vue'
import { useGameStore } from '../stores/game'
import { CHAPTERS, STAGES } from '../../core/config/stages.ts'
import { ENEMY_INDEX, getEnemy } from '../../core/config/enemies.ts'
import { DROP_TABLES } from '../../core/config/economy.ts'
import { resourceIconPath } from '../../core/config/art.ts'
import { runBattle } from '../../core/systems/battle.ts'
import { buildPveContext } from '../../core/systems/derive.ts'
import { formatNumber, formatPower } from '../utils/format'
import { dropTableLines } from '../utils/reward-text'
import BattleCanvas from './BattleCanvas.vue'
import BattleResultPanel from './BattleResultPanel.vue'
import type { BattleResult, EnemyDef } from '../../core/model/types.ts'

const props = defineProps<{ stageId: number }>()
const emit = defineEmits<{ close: [] }>()

const store = useGameStore()

const stage = computed(() => STAGES.find((s) => s.id === props.stageId) ?? null)
const chapter = computed(() => CHAPTERS.find((c) => c.id === stage.value?.chapter) ?? null)

/** 敌人定义（配置保证存在，取用时仍做一次保护） */
const enemies = computed<EnemyDef[]>(() => {
  const ids = stage.value?.enemyIds ?? []
  return ids.map((id) => (ENEMY_INDEX.has(id) ? getEnemy(id) : null)).filter((e): e is EnemyDef => !!e)
})

/** 掉落表预览 */
const drops = computed(() => (stage.value ? DROP_TABLES[stage.value.dropTableId] : null))
/** 掉落预览行（与战后结算共用同一份口径） */
const dropRows = computed(() => dropTableLines(drops.value))

/** 战力门槛对比 */
const powerGap = computed(() => {
  const need = stage.value?.powerRequired ?? 0
  const have = store.teamPower
  return { need, have, enough: have >= need, ratio: have / Math.max(1, need) }
})

/** 该关是否已通关（**挂机与挑战的资格都看它**） */
const isCleared = computed(() => (stage.value?.id ?? 0) <= store.clearedStage)

/** 是否是「下一关」（可推进的关卡） */
const isNext = computed(() => (stage.value?.id ?? 0) === store.clearedStage + 1)

/** 是否已经是主线通道的目标 */
const isIdleTarget = computed(() => {
  const t = store.save.idle.channels.main.target
  if (!t || t.kind !== 'main') return false
  return t.stageId === null || t.stageId === stage.value?.id
})

/** 战斗预览结果 */
const preview = ref<BattleResult | null>(null)
/** 演出是否播完（播完才显示结算） */
const previewFinished = ref(false)

function previewBattle() {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  const list = enemies.value
  if (list.length === 0) return
  preview.value = runBattle({
    allies: store.team,
    enemies: list,
    enemyScale: stage.value?.enemyScale ?? 1,
    ctx: buildPveContext(store.save, store.nextBattleSeed()),
  })
  previewFinished.value = false
}

/** 演出播完（或被跳过）：展示战后结算 */
function onPreviewFinished() {
  previewFinished.value = true
}

/** 回放倍速：写回存档设置（与设置页同一口径） */
function onSpeedChange(v: number) {
  void store.updateSettings({ speed: v })
}

/**
 * **挑战此关**（手动挑战，服务端执行并推进主线进度）。
 *
 * ⚠ 挑战成功后**关闭弹窗**：战斗演出由页面级的 `ChallengeReplay` 面板播放，
 *   弹窗盖在上面的话玩家看不到这场仗（铁律 #27：功能通了还要玩家看得见）。
 */
async function challenge() {
  if (!stage.value) return
  const res = await store.challengeStage(stage.value.id)
  if (!res) return
  if (res.win) {
    store.notify(res.firstClear ? `首次通关 ${stage.value.name}` : `${stage.value.name} 胜利`, 'ok')
  } else {
    store.notify(`${stage.value.name} 挑战失败`, 'warn')
  }
  emit('close')
}

/**
 * **设为挂机目标**（仅已通关关卡可用）。
 *
 * ⚠ 挂机只挂**已通关**内容（永不卡关）⇒ 未通关时按钮禁用并写明原因。
 */
async function setIdleTarget() {
  if (!stage.value || !isCleared.value) return
  const res = await store.setIdleChannel({ channel: 'main', stageId: stage.value.id })
  if (res) store.notify(`挂机目标已设为 ${stage.value.name}`, 'ok')
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog stage-dialog" data-testid="stage-detail-modal">
      <div class="panel-title">
        <span>{{ stage?.name ?? '关卡详情' }}</span>
        <button class="btn btn-sm btn-ghost" data-testid="stage-detail-close" @click="emit('close')">关闭</button>
      </div>

      <template v-if="stage">
        <!-- 概要 -->
        <div class="row-between">
          <div class="tiny muted">
            第 {{ stage.chapter }} 章 · 第 {{ stage.index }} 关
            <span v-if="stage.isBoss" class="boss-tag">BOSS</span>
          </div>
          <span class="tag" :class="isCleared ? 'tag-sr' : ''">{{ isCleared ? '已通关' : '未通关' }}</span>
        </div>
        <p v-if="chapter" class="chapter-intro">{{ chapter.intro }}</p>

        <div class="power-box">
          <div class="row-between tiny">
            <span class="muted">编队战力</span>
            <b>{{ formatPower(powerGap.have) }}</b>
          </div>
          <div class="bar" style="margin: 5px 0 8px">
            <i :style="{ width: `${Math.min(100, powerGap.ratio * 100)}%` }"></i>
          </div>
          <div class="row-between tiny">
            <span class="muted">关卡门槛</span>
            <span>{{ formatPower(powerGap.need) }}</span>
          </div>
          <div class="tiny" style="margin-top: 6px" :class="powerGap.enough ? 'ok-text' : 'warn-text'">
            {{ powerGap.enough ? '战力充足，可推进' : '战力不足，建议提升后再挑战' }}
          </div>
        </div>

        <!-- 掉落预览 -->
        <div class="panel-title" style="margin-top: 12px"><span>掉落预览</span></div>
        <div v-if="drops" class="drop-list">
          <div v-for="row in dropRows" :key="row.key" class="row-between tiny">
            <span class="muted res-label">
              <img class="res-icon" :src="resourceIconPath(row.iconKey ?? 'silver')" :alt="row.label" width="16" height="16" />{{ row.label }}
            </span>
            <b>{{ row.text }}</b>
          </div>
        </div>
        <p class="tiny muted" style="margin: 6px 0 0">
          基础掉落每次结算都会掷一次（挂机同样产出）。首次手动通关额外发放<b>经验书保底</b>与<b>圣杯结晶</b>。
        </p>

        <!-- 敌人 -->
        <div class="panel-title" style="margin-top: 12px">
          <span>敌人</span>
          <span class="tiny muted">属性缩放 ×{{ stage.enemyScale.toFixed(2) }}</span>
        </div>
        <p class="tiny muted" style="margin: 0 0 6px">敌人均为非历史人物形象。</p>
        <div v-for="enemy in enemies" :key="enemy.id" class="list-item">
          <div class="enemy-mark" :class="`el-${enemy.element}`">{{ enemy.element }}</div>
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <b>{{ enemy.name }}</b>
              <span class="tag">{{ enemy.role }}</span>
              <span v-if="enemy.bossMechanic" class="tag tag-sr">特殊机制</span>
            </div>
            <div class="tiny muted" style="margin-top: 2px">
              攻 {{ formatNumber(enemy.baseStats.atk) }} · 防 {{ formatNumber(enemy.baseStats.def) }} ·
              生命 {{ formatNumber(enemy.baseStats.hp) }} · 速 {{ formatNumber(enemy.baseStats.spd) }}
            </div>
          </div>
        </div>

        <!-- 操作 -->
        <div class="row" style="margin-top: 12px; gap: 6px">
          <button class="btn btn-sm" style="flex: 1" @click="previewBattle">战斗预览</button>
          <button
            class="btn btn-sm btn-primary"
            style="flex: 1"
            data-testid="stage-challenge"
            :disabled="!isNext && !isCleared"
            @click="challenge"
          >
            {{ isNext ? '挑战此关' : isCleared ? '再次挑战' : '尚未解锁' }}
          </button>
        </div>
        <div class="row" style="margin-top: 6px; gap: 6px">
          <button
            class="btn btn-sm btn-ghost"
            style="flex: 1"
            data-testid="stage-set-idle"
            :disabled="!isCleared"
            @click="setIdleTarget"
          >
            {{ isIdleTarget ? '已是挂机目标' : isCleared ? '设为挂机目标' : '通关后才能挂机' }}
          </button>
        </div>
        <p v-if="!isCleared" class="tiny muted" style="margin: 6px 0 0">
          挂机只挂<b>已通关</b>的关卡（永不卡关），先手动挑战通关才能设为挂机目标。
        </p>

        <!-- 战斗预览结果 -->
        <template v-if="preview">
          <div class="panel-title" style="margin-top: 12px">
            <span>战斗预览</span>
            <span class="tag" :class="preview.win ? 'tag-sr' : ''">{{ preview.win ? '胜利' : '失败' }}</span>
          </div>
          <BattleCanvas
            :battle="preview"
            :speed="store.battleSpeed"
            :chapter="stage.chapter"
            :skip-anim="store.save.settings.skipAnim"
            @finished="onPreviewFinished"
            @speed-change="onSpeedChange"
          />
          <BattleResultPanel
            v-if="previewFinished"
            class="result-wrap"
            :battle="preview"
            :drops="drops ?? undefined"
          />
        </template>
      </template>

      <div v-else class="empty">未找到该关卡</div>
    </div>
  </div>
</template>

<style scoped>
.stage-dialog {
  max-height: 84vh;
  overflow-y: auto;
}

.chapter-intro {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--c-text-mute);
  line-height: 1.7;
}

.boss-tag {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 10px;
  color: #d98a7a;
  border: 1px solid #6b3a30;
}

.power-box {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}

.ok-text {
  color: var(--c-green);
}

.warn-text {
  color: #e0a06a;
}

.enemy-mark {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  border: 1px solid var(--c-line-2);
  background: var(--c-panel-2);
}

.drop-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.result-wrap {
  margin-top: 10px;
}
</style>
