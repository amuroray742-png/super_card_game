<script setup lang="ts">
/**
 * 图鉴：英灵 / 遗物 / 敌人三册。
 * 数据源为 core 配置表；未获得的内容以剪影与未解锁标注，不泄露具体数值。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { HEROES } from '../../core/config/heroes/index.ts'
import { ENEMIES } from '../../core/config/enemies.ts'
import { RELIC_DEFS, RELIC_SETS } from '../../core/systems/relic.ts'
import '../../core/config/relics.ts'
import { formatNumber } from '../utils/format'
import type { Rarity } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

type Tab = 'heroes' | 'relics' | 'enemies'
const tab = ref<Tab>('heroes')

const RARITIES: Rarity[] = ['SSR', 'SR', 'R', 'N']

/** 英灵册 */
const heroRarityFilter = ref<Rarity | '全部'>('全部')

const heroList = computed(() =>
  HEROES.filter((h) => rarityFilterOk(h.rarity)).sort((a, b) => {
    const rank: Record<string, number> = { SSR: 3, SR: 2, R: 1, N: 0 }
    const ra = rank[a.rarity] ?? 0
    const rb = rank[b.rarity] ?? 0
    if (rb !== ra) return rb - ra
    return a.region.localeCompare(b.region) || a.name.localeCompare(b.name)
  }),
)

function rarityFilterOk(rarity: Rarity): boolean {
  return heroRarityFilter.value === '全部' || rarity === heroRarityFilter.value
}

function owned(heroId: string): boolean {
  return !!store.save.heroes[heroId]
}

/** 遗物册 */
const relicOwnedCount = computed(() => {
  const map = new Map<string, number>()
  for (const r of store.save.relics) {
    map.set(r.defId, (map.get(r.defId) ?? 0) + 1)
  }
  return map
})

const relicList = computed(() => [...RELIC_DEFS.values()])
const setList = computed(() => [...RELIC_SETS.values()])

/** 某套装包含的遗物 */
function relicsOfSet(setId: string) {
  return relicList.value.filter((r) => r.setId === setId)
}

/** 打开某遗物定义下已获得的一 instance */
function openRelic(defId: string) {
  const inst = store.save.relics.find((r) => r.defId === defId)
  if (!inst) {
    store.notify('尚未获得该遗物', 'warn')
    return
  }
  router.push(`/relic/${inst.uid}`)
}

/** 敌册 */
const enemyList = computed(() => ENEMIES)
</script>

<template>
  <div class="page">
    <div class="page-title">图鉴</div>

    <!-- 分页 -->
    <section class="panel">
      <div class="tabs-row">
        <button class="tab-btn" :class="{ on: tab === 'heroes' }" @click="tab = 'heroes'">英灵</button>
        <button class="tab-btn" :class="{ on: tab === 'relics' }" @click="tab = 'relics'">遗物</button>
        <button class="tab-btn" :class="{ on: tab === 'enemies' }" @click="tab = 'enemies'">敌人</button>
      </div>
    </section>

    <!-- 英灵册 -->
    <template v-if="tab === 'heroes'">
      <section class="panel">
        <div class="row-between">
          <div class="tiny muted">已收录 {{ Object.keys(store.save.heroes).length }} / {{ HEROES.length }}</div>
          <div class="chips">
            <button class="chip" :class="{ on: heroRarityFilter === '全部' }" @click="heroRarityFilter = '全部'">
              全
            </button>
            <button
              v-for="r in RARITIES"
              :key="r"
              class="chip"
              :class="{ on: heroRarityFilter === r }"
              @click="heroRarityFilter = r"
            >
              {{ r }}
            </button>
          </div>
        </div>
      </section>

      <div class="hero-grid">
        <button
          v-for="h in heroList"
          :key="h.id"
          class="hero-cell"
          :class="{ locked: !owned(h.id) }"
          @click="owned(h.id) && router.push(`/hero/${h.id}`)"
        >
          <img
            :src="h.portrait"
            class="portrait"
            :class="`portrait-${h.rarity.toLowerCase()}`"
            width="72"
            height="72"
            loading="lazy"
          />
          <div class="hero-name">{{ owned(h.id) ? h.name : '未解锁' }}</div>
          <div class="tiny muted">{{ h.role }} · <span :class="`el-${h.element}`">{{ h.element }}</span></div>
          <div class="tiny">
            <span class="tag" :class="`tag-${h.rarity.toLowerCase()}`">{{ h.rarity }}</span>
          </div>
        </button>
      </div>
    </template>

    <!-- 遗物册 -->
    <template v-else-if="tab === 'relics'">
      <section class="panel">
        <div class="row-between">
          <div class="tiny muted">遗物 {{ relicList.length }} 件 · 套装 {{ setList.length }} 套</div>
          <div class="tiny muted">仓库 {{ store.save.relics.length }} 件</div>
        </div>
      </section>

      <section v-for="set in setList" :key="set.id" class="panel">
        <div class="panel-title">
          <span>{{ set.name }}</span>
          <span class="tiny muted">{{ relicsOfSet(set.id).length }} 件</span>
        </div>
        <div class="tiny muted" style="margin-bottom: 6px">{{ set.desc }}</div>
        <div v-for="bonus in set.bonuses" :key="bonus.pieces" class="row-between tiny">
          <span class="muted">{{ bonus.pieces }} 件</span>
          <span>{{ bonus.desc }}</span>
        </div>
        <div class="relic-rows">
          <button
            v-for="r in relicsOfSet(set.id)"
            :key="r.id"
            class="list-item relic-row"
            @click="openRelic(r.id)"
          >
            <div style="flex: 1; min-width: 0">
              <div class="row" style="gap: 6px">
                <span class="tag" :class="`tag-${r.rarity.toLowerCase()}`">{{ r.rarity }}</span>
                <b>{{ r.name }}</b>
              </div>
              <div class="tiny muted" style="margin-top: 2px">{{ r.desc }}</div>
            </div>
            <span class="tiny muted">{{ relicOwnedCount.get(r.id) ?? 0 }} 件</span>
          </button>
        </div>
      </section>
    </template>

    <!-- 敌册 -->
    <template v-else>
      <section class="panel notice">
        <div class="tiny" style="line-height: 1.8; color: var(--c-text-dim)">
          图鉴中的敌人<b>均为非历史人物</b>形象，由灵体、妖异、幻想体与器械造物构成，
          不指向任何真实历史人物或族群。历史人物只作为正面友方出现。
        </div>
      </section>

      <section class="panel">
        <div class="panel-title">
          <span>敌人图鉴</span>
          <span class="tiny muted">{{ enemyList.length }} 个</span>
        </div>
        <div v-for="e in enemyList" :key="e.id" class="list-item">
          <div class="enemy-mark" :class="`el-${e.element}`">{{ e.element }}</div>
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <b>{{ e.name }}</b>
              <span class="tag">{{ e.role }}</span>
              <span v-if="e.bossMechanic" class="tag tag-sr">特殊机制</span>
            </div>
            <div class="tiny muted" style="margin-top: 2px">
              攻 {{ formatNumber(e.baseStats.atk) }} · 防 {{ formatNumber(e.baseStats.def) }} ·
              生命 {{ formatNumber(e.baseStats.hp) }}
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.tabs-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.tab-btn {
  min-height: 40px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  font-size: 13px;
  color: var(--c-text-dim);
}

.tab-btn.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.chips {
  display: flex;
  gap: 4px;
}

.chip {
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  font-size: 11px;
  color: var(--c-text-dim);
  min-height: 26px;
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
  margin-bottom: 12px;
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

.hero-cell.locked {
  opacity: 0.55;
}

.hero-cell.locked .portrait {
  /* 未解锁只做「去色 + 压暗」，不要压到纯黑：
   * AI 卡面是完整画面而非高对比剪影，brightness(0.35) 会把人物细节全部吃掉，
   * 整格看起来像图片加载失败（占位 SVG 剪影时代才用得住这么狠的值）。 */
  filter: grayscale(0.9) brightness(0.62) contrast(0.95);
}

.hero-name {
  font-size: 13px;
  font-weight: 600;
}

.relic-rows {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.relic-row {
  width: 100%;
  text-align: left;
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

.notice {
  border-color: #6b5a2c;
}
</style>
