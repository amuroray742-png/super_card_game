<script setup lang="ts">
/**
 * 推征（首页）：关卡推进 + 挂机 + 战斗回放。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { STAGES } from '../../core/config/stages.ts'
import { getEnemy } from '../../core/config/enemies.ts'
import { runBattle } from '../../core/systems/battle.ts'
import { getBondMods, getTeamPower } from '../../core/systems/team.ts'
import { getHeroSetMods } from '../../core/systems/relic.ts'
import { getHeroPassiveMods } from '../../core/systems/growth.ts'
import { formatNumber, formatPower } from '../utils/format'
import BattleCanvas from '../components/BattleCanvas.vue'
import type { BattleResult } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

const showCanvas = ref(false)
const battle = ref<BattleResult | null>(null)
const canvasRef = ref<InstanceType<typeof BattleCanvas> | null>(null)

const stage = computed(() => store.currentStage)
const chapter = computed(() => Math.ceil(stage.value.id / 31))
const stageName = computed(() => stage.value.name)

const powerGap = computed(() => {
  const need = stage.value.powerRequired
  const have = store.teamPower
  // 未编队时战力为 0，不能做除法（会得到 Infinity）
  if (have <= 0) return { need, have, ratio: 0, enough: false, empty: true }
  return { need, have, ratio: have / Math.max(1, need), enough: have >= need, empty: false }
})

/** 当前章节的关卡列表 */
const chapterStages = computed(() => STAGES.filter((s) => s.chapter === chapter.value))

/** 手动打一场并播放回放 */
function fight() {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  const enemyIds = stage.value.enemyIds
  const enemies = enemyIds.map((id) => getEnemy(id)).filter(Boolean)
  if (enemies.length === 0) return
  const result = runBattle({
    allies: store.team,
    enemies,
    enemyScale: stage.value.enemyScale,
    ctx: {
      mode: 'pve',
      seed: Math.floor(Math.random() * 1e9),
      teamMods: { bond: getBondMods(store.team) },
    },
  })
  battle.value = result
  showCanvas.value = true
  // 回放单位信息
  requestAnimationFrame(() => {
    const units: Record<string, { name: string; side: 'ally' | 'enemy'; hp: number; maxHp: number }> = {}
    for (const hero of store.team) {
      units[hero.def.id] = {
        name: hero.def.name,
        side: 'ally',
        hp: 1,
        maxHp: 1,
      }
    }
    for (const enemy of enemies) {
      units[enemy.id] = { name: enemy.name, side: 'enemy', hp: 1, maxHp: 1 }
    }
    canvasRef.value?.setUnits(units)
    canvasRef.value?.replay()
  })
}

/** 挂机推进 N 场 */
async function idle(battles: number) {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  const res = await store.tickIdle(battles)
  if (res) {
    const r = res.rewards
    const parts = [
      r.silver ? `银两 ${formatNumber(r.silver)}` : '',
      r.exp ? `经验 ${formatNumber(r.exp)}` : '',
      r.skillStones ? `术式结晶 ${r.skillStones}` : '',
      r.relicStones ? `强化石 ${r.relicStones}` : '',
    ].filter(Boolean)
    store.notify(parts.length ? parts.join(' · ') : '推征完成')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-title">推征</div>

    <!-- 当前关卡 -->
    <section class="panel">
      <div class="row-between">
        <div>
          <div class="tiny muted">第 {{ chapter }} 章 · 第 {{ stage.index }} 关</div>
          <div style="font-size: 17px; font-weight: 700; margin-top: 2px">{{ stageName }}</div>
        </div>
        <button class="btn btn-sm btn-ghost" @click="router.push(`/stage/${stage.id}`)">详情 ›</button>
      </div>

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
          <span :class="powerGap.enough ? '' : 'muted'">{{ formatPower(powerGap.need) }}</span>
        </div>
        <div class="tiny" style="margin-top: 6px" :class="powerGap.enough ? 'ok-text' : 'warn-text'">
          {{
            powerGap.empty
              ? '尚未编队，无法推征'
              : powerGap.enough
                ? '战力充足，可推进'
                : `战力不足，尚需 ×${(1 / powerGap.ratio).toFixed(2)}`
          }}
        </div>
      </div>

      <div class="row" style="margin-top: 12px; gap: 6px">
        <button class="btn btn-sm" style="flex: 1" @click="idle(1)">推征 1 场</button>
        <button class="btn btn-sm" style="flex: 1" @click="idle(10)">推征 10 场</button>
        <button class="btn btn-sm btn-primary" style="flex: 1" @click="fight">观战</button>
      </div>
    </section>

    <!-- 战斗回放 -->
    <section v-if="showCanvas" class="panel">
      <div class="panel-title">
        <span>战斗回放</span>
        <button class="btn btn-sm btn-ghost" @click="showCanvas = false">收起</button>
      </div>
      <BattleCanvas ref="canvasRef" :battle="battle" :speed="store.battleSpeed" />
    </section>

    <!-- 本章关卡 -->
    <section class="panel">
      <div class="panel-title">
        <span>第 {{ chapter }} 章 · 关卡</span>
        <span class="tiny muted">已通关 {{ store.clearedStage }} 关</span>
      </div>
      <div class="stage-grid">
        <button
          v-for="s in chapterStages"
          :key="s.id"
          class="stage-cell"
          :class="{
            done: s.id <= store.clearedStage,
            now: s.id === stage.id,
            boss: s.isBoss,
          }"
          @click="router.push(`/stage/${s.id}`)"
        >
          <span class="s-idx">{{ s.index }}</span>
          <span v-if="s.isBoss" class="s-boss">BOSS</span>
        </button>
      </div>
    </section>

    <!-- 编队概览 -->
    <section class="panel">
      <div class="panel-title">
        <span>当前编队</span>
        <button class="btn btn-sm btn-ghost" @click="router.push('/formation')">调整 ›</button>
      </div>
      <div v-if="store.teamEmpty" class="empty">尚未编队，无法推征</div>
      <div v-else class="team-row">
        <div v-for="hero in store.team" :key="hero.def.id" class="team-chip">
          <img
            :src="hero.def.portrait"
            class="portrait"
            :class="`portrait-${hero.def.rarity.toLowerCase()}`"
            width="44"
            height="44"
            loading="lazy"
          />
          <div class="tiny">
            <div>{{ hero.def.name }}</div>
            <div class="muted">Lv{{ hero.state.level }}</div>
          </div>
        </div>
      </div>
      <div v-if="store.bondStates.length" class="bonds">
        <span v-for="b in store.bondStates.filter((x) => x.active)" :key="b.bond.id" class="tag tag-sr">
          {{ b.bond.name }}
        </span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.power-box {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}

.ok-text { color: var(--c-green); }
.warn-text { color: #e0a06a; }

.stage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(46px, 1fr));
  gap: 6px;
}

.stage-cell {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-mute);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}

.stage-cell.done {
  border-color: #4a5f3f;
  background: #232a1e;
  color: #a9c48c;
}

.stage-cell.now {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  box-shadow: 0 0 0 1px rgba(200, 169, 81, 0.3) inset;
}

.stage-cell.boss .s-boss {
  position: absolute;
  bottom: 1px;
  font-size: 8px;
  color: #d98a7a;
  letter-spacing: 0.05em;
}

.team-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.team-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 4px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}

.bonds {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
</style>
