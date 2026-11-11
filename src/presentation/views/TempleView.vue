<script setup lang="ts">
/**
 * 圣殿：英灵收藏与筛选。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { HEROES } from '../../core/config/heroes/index.ts'
import { formatNumber } from '../utils/format'
import type { Element, Rarity, Role } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

const roleFilter = ref<Role | '全部'>('全部')
const elementFilter = ref<Element | '全部'>('全部')
const rarityFilter = ref<Rarity | '全部'>('全部')
const keyword = ref('')

const ROLES: Role[] = ['猛将', '统帅', '谋士', '医者', '器者']
const ELEMENTS: Element[] = ['金', '木', '土', '水', '火']
const RARITIES: Rarity[] = ['SSR', 'SR', 'R', 'N']

const owned = computed(() => store.ownedHeroes)

const filtered = computed(() =>
  owned.value.filter((h) => {
    if (roleFilter.value !== '全部' && h.role !== roleFilter.value) return false
    if (elementFilter.value !== '全部' && h.element !== elementFilter.value) return false
    if (rarityFilter.value !== '全部' && h.rarity !== rarityFilter.value) return false
    if (keyword.value.trim() && !h.name.includes(keyword.value.trim())) return false
    return true
  }),
)

const counts = computed(() => {
  const map: Record<string, number> = {}
  for (const h of HEROES) map[h.rarity] = (map[h.rarity] ?? 0) + 1
  return map
})

function levelOf(id: string): number {
  return store.save.heroes[id]?.level ?? 1
}
function starOf(id: string): number {
  return store.save.heroes[id]?.star ?? 1
}
</script>

<template>
  <div class="page">
    <div class="page-title">圣殿</div>

    <!-- 收藏概览 -->
    <section class="panel">
      <div class="row-between">
        <div class="tiny muted">已收藏</div>
        <div class="tiny muted">
          SSR {{ counts.SSR }} · SR {{ counts.SR }} · R {{ counts.R }} · N {{ counts.N }}
        </div>
      </div>
      <div style="font-size: 26px; font-weight: 700; margin-top: 2px">
        {{ owned.length }}
        <span class="tiny muted">/ {{ HEROES.length }}</span>
      </div>
      <div class="bar" style="margin-top: 6px">
        <i :style="{ width: `${(owned.length / HEROES.length) * 100}%` }"></i>
      </div>
      <button class="btn btn-sm btn-primary btn-block" style="margin-top: 10px" @click="router.push('/gacha')">
        前往召唤
      </button>
    </section>

    <!-- 筛选 -->
    <section class="panel">
      <input v-model="keyword" class="search" placeholder="搜索英灵名" />
      <div class="chips">
        <button class="chip" :class="{ on: roleFilter === '全部' }" @click="roleFilter = '全部'">定位</button>
        <button
          v-for="r in ROLES"
          :key="r"
          class="chip"
          :class="{ on: roleFilter === r }"
          @click="roleFilter = r"
        >
          {{ r }}
        </button>
      </div>
      <div class="chips">
        <button class="chip" :class="{ on: elementFilter === '全部' }" @click="elementFilter = '全部'">五行</button>
        <button
          v-for="e in ELEMENTS"
          :key="e"
          class="chip"
          :class="{ on: elementFilter === e }"
          @click="elementFilter = e"
        >
          <span :class="`el-${e}`">{{ e }}</span>
        </button>
      </div>
      <div class="chips">
        <button class="chip" :class="{ on: rarityFilter === '全部' }" @click="rarityFilter = '全部'">稀有度</button>
        <button
          v-for="r in RARITIES"
          :key="r"
          class="chip"
          :class="{ on: rarityFilter === r }"
          @click="rarityFilter = r"
        >
          {{ r }}
        </button>
      </div>
    </section>

    <!-- 列表 -->
    <div v-if="filtered.length === 0" class="empty">
      暂无符合条件的英灵<br />
      <button class="btn btn-sm btn-primary" style="margin-top: 8px" @click="router.push('/gacha')">
        前往召唤获取英灵
      </button>
    </div>
    <div v-else class="hero-grid">
      <button
        v-for="h in filtered"
        :key="h.id"
        class="hero-cell"
        @click="router.push(`/hero/${h.id}`)"
      >
        <img
          :src="h.portrait"
          class="portrait"
          :class="`portrait-${h.rarity.toLowerCase()}`"
          width="72"
          height="72"
          loading="lazy"
        />
        <div class="hero-name">{{ h.name }}</div>
        <div class="tiny muted">{{ h.role }} · <span :class="`el-${h.element}`">{{ h.element }}</span></div>
        <div class="tiny">
          <span class="tag" :class="`tag-${h.rarity.toLowerCase()}`">{{ h.rarity }}</span>
          <span class="lv">Lv{{ levelOf(h.id) }}</span>
        </div>
        <div class="stars">{{ '★'.repeat(starOf(h.id)) }}<span class="dim">{{ '★'.repeat(6 - starOf(h.id)) }}</span></div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.search {
  width: 100%;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  margin-bottom: 8px;
  outline: none;
}

.search:focus {
  border-color: var(--c-line-2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.chip {
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  font-size: 12px;
  color: var(--c-text-dim);
}

.chip.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.hero-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}

.hero-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 4px 8px;
  border-radius: 10px;
  border: 1px solid var(--c-line);
  background: var(--c-panel);
  text-align: center;
}

.hero-name {
  font-size: 13px;
  font-weight: 600;
}

.lv {
  color: var(--c-text-dim);
  margin-left: 4px;
}

.stars {
  font-size: 10px;
  color: var(--c-gold);
  letter-spacing: -1px;
}

.dim {
  color: #4a4438;
}
</style>
