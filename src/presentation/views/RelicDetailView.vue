<script setup lang="ts">
/**
 * 遗物详情：套装 / 主副词条 / 强化成长 / 强化与分解。
 * 词条数值一律取 core 的 getRelicMods，组件不自行推算。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { RELIC } from '../../core/config/economy.ts'
import { RELIC_DEFS, RELIC_SETS, decomposeValue, getRelicMods, relicUpgradeCost } from '../../core/systems/relic.ts'
import { formatNumber } from '../utils/format'
import type { RelicInstance, StatMod } from '../../core/model/types.ts'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

const uid = computed(() => String(route.params.uid ?? ''))
const relic = computed(() => store.relicsByUid.get(uid.value) ?? null)
const def = computed(() => (relic.value ? RELIC_DEFS.get(relic.value.defId) ?? null : null))
const set = computed(() => (def.value ? RELIC_SETS.get(def.value.setId) ?? null : null))

/** 主词条当前值（core：主词条随强化等级缩放，副词条固定） */
const mainMods = computed<StatMod[]>(() => {
  const r = relic.value
  const d = def.value
  if (!r || !d) return []
  return getRelicMods(r).slice(0, d.mainStats.length)
})

/** 下一级的主词条预览 */
const nextMainMods = computed<StatMod[]>(() => {
  const r = relic.value
  const d = def.value
  if (!r || !d) return []
  if (r.level >= RELIC.MAX_LEVEL) return []
  return getRelicMods({ ...r, level: r.level + 1 }).slice(0, d.mainStats.length)
})

/** 副词条 */
const subMods = computed<StatMod[]>(() => relic.value?.subStats ?? [])

/** 强化消耗 */
const cost = computed(() => (relic.value ? relicUpgradeCost(relic.value.level) : null))

/** 分解返还 */
const back = computed(() => (relic.value ? decomposeValue(relic.value) : null))

/** 装备在哪名英灵身上 */
const owner = computed(() => {
  const r = relic.value
  if (!r) return null
  for (const entry of Object.values(store.save.equipped)) {
    if (entry.relicId === r.uid) return entry.heroId
  }
  return null
})

/** 分解二次确认 */
const confirmOpen = ref(false)

const STAT_NAMES: Record<string, string> = {
  atk: '攻击',
  def: '防御',
  hp: '生命',
  spd: '速度',
  crit: '暴击',
  cdmg: '暴伤',
}

function statName(key: string): string {
  return STAT_NAMES[key] ?? key
}

function statText(mod: StatMod): string {
  return mod.kind === 'pct' ? `${(mod.value * 100).toFixed(1)}%` : formatNumber(mod.value)
}

function upgrade() {
  if (!relic.value) return
  store.upgradeRelic(relic.value.uid)
}

function decompose() {
  if (!relic.value) return
  store.decomposeRelic(relic.value.uid)
  confirmOpen.value = false
  router.back()
}
</script>

<template>
  <div class="page">
    <div v-if="!relic || !def" class="empty">
      未找到该遗物<br />
      <span class="tiny">它可能已被分解</span>
    </div>

    <template v-else>
      <div class="page-title">{{ def.name }}</div>

      <section class="panel">
        <div class="row-between">
          <div>
            <div class="row" style="gap: 6px; flex-wrap: wrap">
              <span class="tag" :class="`tag-${def.rarity.toLowerCase()}`">{{ def.rarity }}</span>
              <span v-if="set" class="tag">{{ set.name }}套</span>
            </div>
            <div class="tiny muted" style="margin-top: 6px">{{ def.desc }}</div>
          </div>
          <div class="lv-box">
            <div class="tiny muted">强化</div>
            <div class="lv-num">+{{ relic.level }}</div>
          </div>
        </div>
        <p v-if="owner" class="tiny muted" style="margin: 10px 0 0">当前装备于该英灵身上。</p>
      </section>

      <!-- 套装 -->
      <section v-if="set" class="panel">
        <div class="panel-title"><span>套装效果</span></div>
        <div class="tiny muted" style="margin-bottom: 6px">{{ set.desc }}</div>
        <div v-for="bonus in set.bonuses" :key="bonus.pieces" class="row-between tiny set-row">
          <span class="muted">{{ bonus.pieces }} 件</span>
          <span>{{ bonus.desc }}</span>
        </div>
      </section>

      <!-- 主词条 -->
      <section class="panel">
        <div class="panel-title">
          <span>主词条</span>
          <span class="tiny muted">每级 +{{ (RELIC.PCT_PER_LEVEL * 100).toFixed(0) }}%</span>
        </div>
        <div v-for="(mod, i) in mainMods" :key="i" class="row-between stat-row">
          <span class="muted">{{ statName(mod.stat) }}</span>
          <span>
            <b>{{ statText(mod) }}</b>
            <span v-if="nextMainMods[i]" class="tiny muted"> → {{ statText(nextMainMods[i]) }}</span>
          </span>
        </div>
      </section>

      <!-- 副词条 -->
      <section class="panel">
        <div class="panel-title"><span>副词条</span></div>
        <div v-if="subMods.length === 0" class="empty" style="padding: 12px">该遗物没有副词条</div>
        <div v-for="(mod, i) in subMods" :key="i" class="row-between stat-row">
          <span class="muted">{{ statName(mod.stat) }}</span>
          <b>{{ statText(mod) }}</b>
        </div>
        <p class="tiny muted" style="margin: 8px 0 0">副词条在生成时定值，强化不改变其数值。</p>
      </section>

      <!-- 强化 / 分解 -->
      <section class="panel">
        <div class="panel-title"><span>养成</span></div>
        <div v-if="cost" class="row-between tiny">
          <span class="muted">下一级消耗</span>
          <b>银两 {{ formatNumber(cost.silver) }} · 强化石 {{ cost.stones }}</b>
        </div>
        <div v-else class="tiny muted">已达最高强化等级。</div>
        <div v-if="back" class="row-between tiny" style="margin-top: 4px">
          <span class="muted">分解返还</span>
          <b>银两 {{ formatNumber(back.silver) }} · 强化石 {{ back.stones }}</b>
        </div>
        <div class="row" style="margin-top: 10px; gap: 6px">
          <button class="btn btn-sm btn-primary" style="flex: 1" :disabled="!cost" @click="upgrade">
            强化
          </button>
          <button class="btn btn-sm btn-danger" style="flex: 1" @click="confirmOpen = true">分解</button>
        </div>
      </section>

      <button class="btn btn-block btn-ghost" @click="router.back()">返回</button>
    </template>

    <!-- 分解二次确认 -->
    <div v-if="confirmOpen" class="mask" @click.self="confirmOpen = false">
      <div class="dialog">
        <div class="panel-title">分解确认</div>
        <p class="tiny muted" style="margin: 0 0 10px">
          分解后该遗物将被移除，装备于英灵身上的对应槽位会同时清空，返还银两与强化石。
        </p>
        <div v-if="back" class="tiny" style="margin-bottom: 10px">
          预计返还：银两 {{ formatNumber(back.silver) }} · 强化石 {{ back.stones }}
        </div>
        <div class="row" style="gap: 8px">
          <button class="btn btn-sm" style="flex: 1" @click="confirmOpen = false">取消</button>
          <button class="btn btn-sm btn-danger" style="flex: 1" @click="decompose">确认分解</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lv-box {
  flex: 0 0 auto;
  text-align: center;
  padding-left: 10px;
}

.lv-num {
  font-size: 22px;
  font-weight: 700;
  color: var(--c-gold-2);
}

.stat-row {
  padding: 5px 0;
  border-bottom: 1px solid var(--c-line);
}

.stat-row:last-child {
  border-bottom: none;
}

.set-row {
  padding: 4px 0;
}
</style>
