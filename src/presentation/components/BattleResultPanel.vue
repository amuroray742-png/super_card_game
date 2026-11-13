<script setup lang="ts">
/**
 * 战后结算（§6.3「结算：回合数 / 伤害统计 / MVP 英灵 / 掉落」）。
 *
 * 数据全部来自 core 产出的 `BattleResult` 与 `DROP_TABLES`：
 * 表现层只读、只排版，不做任何判定（AGENTS.md 铁律 #16）。
 */
import { computed } from 'vue'
import type { BattleResult } from '../../core/model/types.ts'
import type { DropTableDef } from '../../core/config/economy.ts'
import { portraitPath, enemyArtPath } from '../../core/config/art.ts'
import { formatNumber } from '../utils/format'

const props = defineProps<{
  battle: BattleResult
  /** 掉落表（只读展示） */
  drops?: DropTableDef
}>()

/** id → 名册条目（MVP / 伤害统计都要用人名与立绘） */
const rosterById = computed(() => {
  const map: Record<string, (typeof props.battle.roster)[number]> = {}
  for (const u of props.battle.roster) map[u.id] = u
  return map
})

const mvp = computed(() => {
  const id = props.battle.mvpId
  if (!id) return null
  const unit = rosterById.value[id]
  if (!unit) return null
  return {
    name: unit.name,
    art: unit.side === 'ally' ? portraitPath(unit.defId) : enemyArtPath(unit.defId),
    damage: props.battle.damageById[id] ?? 0,
  }
})

/** 伤害统计 Top5 */
const damageRows = computed(() => {
  const rows = Object.entries(props.battle.damageById)
    .map(([id, value]) => ({ id, value, name: rosterById.value[id]?.name ?? id }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
  const max = rows.length > 0 ? rows[0].value : 0
  return rows.map((r) => ({ ...r, ratio: max > 0 ? r.value / max : 0 }))
})

/** 存活我方人数 */
const aliveCount = computed(() => props.battle.survivors.length)
</script>

<template>
  <div class="result-panel">
    <div class="row-between">
      <span class="result-title">战后结算</span>
      <span class="tag" :class="battle.win ? 'tag-sr' : ''">{{ battle.win ? '胜利' : '失败' }}</span>
    </div>

    <div class="row-between tiny">
      <span class="muted">回合数</span>
      <b>{{ battle.rounds }}</b>
    </div>
    <div class="row-between tiny">
      <span class="muted">存活</span>
      <b>{{ aliveCount }} / {{ battle.roster.filter((u) => u.side === 'ally').length }}</b>
    </div>

    <!-- MVP -->
    <div v-if="mvp" class="mvp">
      <img :src="mvp.art" class="mvp-art" width="36" height="36" alt="" />
      <div class="mvp-info">
        <div class="tiny muted">表现最佳</div>
        <b>{{ mvp.name }}</b>
        <div class="tiny muted">造成 {{ formatNumber(mvp.damage) }} 点伤害</div>
      </div>
    </div>

    <!-- 伤害统计 -->
    <div v-if="damageRows.length > 0" class="stats">
      <div class="tiny muted" style="margin-bottom: 4px">伤害统计</div>
      <div v-for="row in damageRows" :key="row.id" class="stat-row">
        <span class="stat-name">{{ row.name }}</span>
        <div class="stat-bar">
          <i :style="{ width: `${row.ratio * 100}%` }"></i>
        </div>
        <span class="stat-value">{{ formatNumber(row.value) }}</span>
      </div>
    </div>

    <!-- 掉落预览 -->
    <div v-if="drops" class="stats">
      <div class="tiny muted" style="margin-bottom: 4px">掉落</div>
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
        <span class="muted">遗物强化石</span>
        <b>{{ drops.relicStones[0] }} ~ {{ drops.relicStones[1] }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">英灵印记</span>
        <b>{{ drops.emblems[0] }} ~ {{ drops.emblems[1] }}</b>
      </div>
    </div>
  </div>
</template>

<style scoped>
.result-panel {
  padding: 10px 12px;
  border: 1px solid var(--c-line);
  border-radius: 10px;
  background: var(--c-bg-2);
}

.result-title {
  font-weight: 700;
}

.mvp {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--c-panel);
}

.mvp-art {
  border-radius: 6px;
  border: 1px solid var(--c-line-2);
  object-fit: cover;
}

.mvp-info {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

.stats {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--c-line);
}

.stat-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.stat-name {
  width: 64px;
  flex: none;
  font-size: 12px;
  color: var(--c-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #151310;
  overflow: hidden;
}

.stat-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, rgba(200, 169, 81, 0.55), rgba(200, 169, 81, 0.95));
}

.stat-value {
  width: 52px;
  flex: none;
  text-align: right;
  font-size: 12px;
  color: var(--c-text);
}
</style>
