<script setup lang="ts">
/**
 * 关卡详情：章节 / 门槛 / 敌人 / 掉落 / 战斗预览 / 设为挂机目标。
 * 战斗与掉落数据全部取自 core，组件不参与规则判定。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { CHAPTERS, STAGES } from '../../core/config/stages.ts'
import { ENEMY_INDEX, getEnemy } from '../../core/config/enemies.ts'
import { HERO_INDEX } from '../../core/config/heroes/index.ts'
import { DROP_TABLES } from '../../core/config/economy.ts'
import { runBattle } from '../../core/systems/battle.ts'
import { getBondMods } from '../../core/systems/team.ts'
import { formatNumber, formatPower } from '../utils/format'
import type { BattleResult, EnemyDef } from '../../core/model/types.ts'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

const stageId = computed(() => Number(route.params.id ?? 0))
const stage = computed(() => STAGES.find((s) => s.id === stageId.value) ?? null)
const chapter = computed(() => CHAPTERS.find((c) => c.id === stage.value?.chapter) ?? null)

/** 敌人定义（配置保证存在，取用时仍做一次保护） */
const enemies = computed<EnemyDef[]>(() => {
  const ids = stage.value?.enemyIds ?? []
  return ids.map((id) => (ENEMY_INDEX.has(id) ? getEnemy(id) : null)).filter((e): e is EnemyDef => !!e)
})

/** 掉落表预览 */
const drops = computed(() => (stage.value ? DROP_TABLES[stage.value.dropTableId] : null))

/** 战力门槛对比 */
const powerGap = computed(() => {
  const need = stage.value?.powerRequired ?? 0
  const have = store.teamPower
  return { need, have, enough: have >= need, ratio: have / Math.max(1, need) }
})

/** 是否为当前挂机目标 */
const isIdleTarget = computed(() => store.save.idle.currentStage === stage.value?.id)

/** 战斗预览结果 */
const preview = ref<BattleResult | null>(null)

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
    ctx: {
      mode: 'pve',
      seed: Math.floor(Math.random() * 1e9),
      teamMods: { bond: getBondMods(store.team) },
    },
  })
}

function setIdleTarget() {
  if (!stage.value) return
  store.save.idle.currentStage = stage.value.id
  store.persist()
  store.notify(`挂机目标已设为 ${stage.value.name}`, 'ok')
}

function goStage(offset: number) {
  const next = stageId.value + offset
  if (next >= 1 && next <= STAGES.length) router.push(`/stage/${next}`)
}

/** 英灵 id → 名称 */
function heroName(id: string | null): string {
  if (!id) return '—'
  return HERO_INDEX.get(id)?.name ?? id
}
</script>

<template>
  <div class="page">
    <div v-if="!stage" class="empty">
      未找到该关卡<br />
      <span class="tiny">请返回推征重新选择</span>
    </div>

    <template v-else>
      <div class="page-title">{{ stage.name }}</div>

      <!-- 概要 -->
      <section class="panel">
        <div class="row-between">
          <div class="tiny muted">
            第 {{ stage.chapter }} 章 · 第 {{ stage.index }} 关
            <span v-if="stage.isBoss" class="boss-tag">BOSS</span>
          </div>
          <div class="row" style="gap: 6px">
            <button class="btn btn-sm btn-ghost" @click="goStage(-1)">‹ 上一关</button>
            <button class="btn btn-sm btn-ghost" @click="goStage(1)">下一关 ›</button>
          </div>
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

        <div class="row" style="margin-top: 12px; gap: 6px">
          <button class="btn btn-sm" style="flex: 1" @click="previewBattle">战斗预览</button>
          <button class="btn btn-sm btn-primary" style="flex: 1" @click="setIdleTarget">
            {{ isIdleTarget ? '已是挂机目标' : '设为挂机目标' }}
          </button>
        </div>
      </section>

      <!-- 敌人 -->
      <section class="panel">
        <div class="panel-title">
          <span>敌人</span>
          <span class="tiny muted">属性缩放 ×{{ stage.enemyScale.toFixed(2) }}</span>
        </div>
        <p class="tiny muted" style="margin: 0 0 8px">敌人均为非历史人物形象。</p>
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
      </section>

      <!-- 掉落 -->
      <section class="panel">
        <div class="panel-title"><span>掉落预览</span></div>
        <div v-if="drops" class="drop-list">
          <div class="row-between tiny">
            <span class="muted">银两</span>
            <b>{{ formatNumber(drops.silver[0]) }} ~ {{ formatNumber(drops.silver[1]) }}</b>
          </div>
          <div class="row-between tiny">
            <span class="muted">经验</span>
            <b>{{ formatNumber(drops.exp[0]) }} ~ {{ formatNumber(drops.exp[1]) }}</b>
          </div>
          <div class="row-between tiny">
            <span class="muted">术式结晶</span>
            <b>{{ drops.skillStones[0] }} ~ {{ drops.skillStones[1] }}</b>
          </div>
          <div class="row-between tiny">
            <span class="muted">强化石</span>
            <b>{{ drops.relicStones[0] }} ~ {{ drops.relicStones[1] }}</b>
          </div>
          <div class="row-between tiny">
            <span class="muted">英灵印记</span>
            <b>{{ drops.emblems[0] }} ~ {{ drops.emblems[1] }}</b>
          </div>
          <div class="row-between tiny">
            <span class="muted">遗物掉落</span>
            <b>
              <span v-for="d in drops.relicDrop" :key="d.rarity" class="drop-rarity">
                {{ d.rarity }} {{ (d.weight / 100).toFixed(2) }}%
              </span>
            </b>
          </div>
        </div>
        <div v-else class="empty" style="padding: 16px">该关卡暂无掉落数据</div>
      </section>

      <!-- 战斗预览结果 -->
      <section v-if="preview" class="panel">
        <div class="panel-title">
          <span>战斗预览</span>
          <span class="tag" :class="preview.win ? 'tag-sr' : ''">{{ preview.win ? '胜利' : '失败' }}</span>
        </div>
        <div class="row-between tiny">
          <span class="muted">回合数</span>
          <b>{{ preview.rounds }}</b>
        </div>
        <div class="row-between tiny">
          <span class="muted">存活</span>
          <b>{{ preview.survivors.length }} / {{ store.team.length }}</b>
        </div>
        <div class="row-between tiny">
          <span class="muted">表现较佳</span>
          <b>{{ heroName(preview.mvpId) }}</b>
        </div>
        <div class="log">
          <div v-for="(entry, i) in preview.log.slice(-8)" :key="i" class="tiny log-line">
            {{ entry.text }}
          </div>
        </div>
      </section>

      <button class="btn btn-block btn-ghost" @click="router.back()">返回</button>
    </template>
  </div>
</template>

<style scoped>
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

.drop-rarity {
  margin-left: 6px;
  color: var(--c-text-dim);
}

.log {
  margin-top: 8px;
  padding: 8px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
  max-height: 160px;
  overflow-y: auto;
}

.log-line {
  color: var(--c-text-mute);
  line-height: 1.7;
}
</style>
