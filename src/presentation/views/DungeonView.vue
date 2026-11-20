<script setup lang="ts">
/**
 * 材料副本（技能副本 / 强化副本）。
 *
 * ## 定位
 *
 * 副本是**两类材料的唯一来源**（设计稿 §3）：
 *   - 技能副本：产出对应五行的技能材料；
 *   - 强化副本：产出对应档位的强化石。
 *
 * 副本**共用挂机时间账本**：在首页选一个去向（主线 / 技能 / 强化），
 * 本页负责「选变体 + 选难度 + 设为挂机去向」。
 *
 * ⚠ **规则一律取 core**（铁律 #2 / #4）：
 *   - 变体与产出 → `core/config/dungeons.ts`；
 *   - 难度与产量 → `core/config/economy.ts` 的 `DUNGEON_DIFFICULTIES` / `DUNGEON_DROPS`；
 *   - 解锁判定 → `core/systems/dungeons.ts` 的 `dungeonUnlocked`。
 */
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import {
  DUNGEON_VARIANTS,
  dungeonDropAmount,
  dungeonVariantLabel,
  type DungeonKind,
  type DungeonVariant,
} from '../../core/config/dungeons.ts'
import { DUNGEON_DIFFICULTIES, type DungeonDifficultyId } from '../../core/config/economy.ts'
import { dungeonUnlocked } from '../../core/systems/dungeons.ts'
import { ITEM_DEFS } from '../../core/config/items.ts'
import { resourceIconPath } from '../../core/config/art.ts'
import { formatNumber } from '../utils/format'
import type { Element } from '../../core/model/types.ts'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

const ELEMENTS: Element[] = ['金', '木', '水', '火', '土']

function queryValue(key: string): string | undefined {
  const raw = route.query[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : undefined
}

/** 副本种类 */
const kind = computed<DungeonKind>(() => (queryValue('kind') === 'enhance' ? 'enhance' : 'skill'))

/** 难度 */
const difficulty = computed<DungeonDifficultyId>(() => {
  const raw = queryValue('difficulty')
  return DUNGEON_DIFFICULTIES.some((d) => d.id === raw) ? (raw as DungeonDifficultyId) : 'easy'
})

/** 当前种类下的变体清单 */
const variants = computed(() => DUNGEON_VARIANTS.filter((v) => v.kind === kind.value))

/** 当前选中的变体（由 URL 的 element / tier 决定） */
const selectedVariant = computed<DungeonVariant | null>(() => {
  const list = variants.value
  if (kind.value === 'skill') {
    const el = queryValue('element')
    return list.find((v) => v.element === el) ?? list[0] ?? null
  }
  const tier = queryValue('tier')
  return list.find((v) => v.tier === tier) ?? list[0] ?? null
})

/**
 * 解锁判定（core 独家口径）。
 *
 * ⚠ **强化副本的解锁线必须用服务端统计的仓库最高等级**：
 *   客户端镜像里 `save.relics` 只有**已装备**件（存档分包），
 *   仓库里那件 Lv60 的客户端看不见 → 直接用 `save.relics` 会把
 *   「已解锁」误判成「未解锁」（玩家明明有 Lv60 却点不了按钮）。
 *   服务端的存档里有全仓库遗物，core 会自行从 `save.relics` 取，
 *   客户端则显式传 `relicStats.maxLevel`。
 */
const unlock = computed(() => {
  const v = selectedVariant.value
  if (!v) return null
  if (v.kind === 'enhance' && !store.relicStatsLoaded) {
    // 还没读到仓库统计 → 不能给结论（否则会误判成「未解锁」）
    return {
      unlocked: false,
      reason: store.offline ? '离线状态下读不到仓库信息' : '正在读取仓库信息…',
      hintRoute: 'forge',
    }
  }
  return dungeonUnlocked(store.save, v, { maxRelicLevel: store.relicStats.maxLevel })
})

/** 各难度的每胜产量 */
const yields = computed(() => {
  const v = selectedVariant.value
  if (!v) return []
  return DUNGEON_DIFFICULTIES.map((d) => ({
    id: d.id,
    name: d.name,
    chapter: d.chapter,
    amount: dungeonDropAmount(v, d.id),
  }))
})

/** 当前变体的持有量 */
const owned = computed(() =>
  selectedVariant.value ? store.save.items[selectedVariant.value.itemId] ?? 0 : 0,
)

/**
 * 进页面先拉一次仓库统计。
 *
 * ⚠ 强化副本的解锁线要「仓库里的最高等级」，而客户端镜像里只有已装备遗物 →
 *   这份统计只能问服务端（`GET /api/relics/stats`）。
 */
onMounted(() => {
  void store.loadRelicStats()
})

function switchKind(next: DungeonKind) {
  void router.replace({
    path: route.path,
    query: next === 'skill' ? { kind: 'skill', element: '金', difficulty: difficulty.value } : { kind: 'enhance', tier: 'relicStoneTier1', difficulty: difficulty.value },
  })
}

function selectVariant(v: DungeonVariant) {
  void router.replace({
    path: route.path,
    query: {
      kind: v.kind,
      ...(v.kind === 'skill' ? { element: v.element } : { tier: v.tier }),
      difficulty: difficulty.value,
    },
  })
}

function selectDifficulty(next: DungeonDifficultyId) {
  void router.replace({
    path: route.path,
    query: {
      kind: kind.value,
      ...(selectedVariant.value?.kind === 'skill'
        ? { element: selectedVariant.value.element }
        : { tier: selectedVariant.value?.tier }),
      difficulty: next,
    },
  })
}

/** 设为挂机去向（服务端会先结清旧去向） */
async function setAsIdleTarget() {
  const v = selectedVariant.value
  if (!v) return
  const res = await store.setIdleTarget(
    v.kind === 'skill'
      ? { kind: 'skill', element: v.element as Element, difficulty: difficulty.value }
      : { kind: 'enhance', tier: v.tier as never, difficulty: difficulty.value },
  )
  if (res) {
    store.notify('挂机去向已切换到本副本', 'ok')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-title">材料副本</div>

    <!-- 种类切换 -->
    <div class="tabs">
      <button class="tab-btn" :class="{ on: kind === 'skill' }" data-testid="dungeon-kind-skill" @click="switchKind('skill')">
        技能副本
      </button>
      <button class="tab-btn" :class="{ on: kind === 'enhance' }" data-testid="dungeon-kind-enhance" @click="switchKind('enhance')">
        强化副本
      </button>
    </div>

    <!-- 变体清单 -->
    <section class="panel">
      <div class="panel-title">
        <span>{{ kind === 'skill' ? '五行技能副本' : '强化石副本' }}</span>
        <span class="tiny muted">共用同一份挂机时间</span>
      </div>
      <div class="chips">
        <button
          v-for="v in variants"
          :key="v.id"
          class="chip"
          :class="{ on: selectedVariant?.id === v.id }"
          :data-testid="`dungeon-variant-${v.id}`"
          @click="selectVariant(v)"
        >
          {{ dungeonVariantLabel(v) }}
        </button>
      </div>
      <p class="tiny muted" style="margin: 6px 0 0">
        {{ kind === 'skill' ? '五行常驻开放' : '三档定向选择' }}：选好变体后在下方设定难度。
      </p>
    </section>

    <!-- 当前副本 -->
    <section v-if="selectedVariant" class="panel">
      <div class="row-between">
        <div class="row" style="gap: 8px">
          <img
            class="item-icon"
            :src="resourceIconPath(ITEM_DEFS[selectedVariant.itemId].iconKey)"
            :alt="ITEM_DEFS[selectedVariant.itemId].name"
            width="36"
            height="36"
            loading="lazy"
          />
          <div>
            <div style="font-weight: 700">{{ selectedVariant.name }}</div>
            <div class="tiny muted">产出 {{ ITEM_DEFS[selectedVariant.itemId].name }} · 持有 {{ formatNumber(owned) }}</div>
          </div>
        </div>
        <span class="tag" :class="unlock?.unlocked ? 'tag-sr' : ''">
          {{ unlock?.unlocked ? '已解锁' : '未解锁' }}
        </span>
      </div>
      <p v-if="unlock && !unlock.unlocked" class="tiny warn-text" style="margin: 8px 0 0">
        {{ unlock.reason }}
      </p>

      <!-- 难度 -->
      <div class="chips" style="margin-top: 10px">
        <button
          v-for="d in yields"
          :key="d.id"
          class="chip"
          :class="{ on: difficulty === d.id }"
          :data-testid="`dungeon-difficulty-${d.id}`"
          @click="selectDifficulty(d.id)"
        >
          {{ d.name }} · 每胜 {{ d.amount.min === d.amount.max ? d.amount.min : `${d.amount.min}~${d.amount.max}` }}
        </button>
      </div>
      <p class="tiny muted" style="margin: 0">
        难度取材第 {{ DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.chapter }} 章主线关卡，
        难度越高单场产量越多，但战力门槛也越高。
      </p>

      <!-- 设为挂机去向 -->
      <div class="row" style="gap: 6px; margin-top: 10px">
        <button
          class="btn btn-primary btn-sm"
          style="flex: 1"
          data-testid="dungeon-set-target"
          :disabled="!unlock?.unlocked"
          @click="setAsIdleTarget"
        >
          设为挂机去向
        </button>
        <button class="btn btn-sm btn-ghost" style="flex: 1" @click="router.push('/expedition')">
          返回主线
        </button>
      </div>
      <p class="tiny muted" style="margin: 6px 0 0">
        切换去向时，服务端会先按<b>旧去向</b>结清这段时间的收益，再开始新的去向。
      </p>
    </section>

    <!-- 说明 -->
    <section class="panel">
      <div class="panel-title"><span>规则</span></div>
      <ul class="rules">
        <li>副本胜利<b>只</b>发所选的五行材料或石档，不发银两、经验、遗物。</li>
        <li>副本进度与主线记录<b>分开记账</b>，不会推进主线首通。</li>
        <li>战败即停本次结算，并给出「降一档难度」的建议。</li>
        <li>技能材料只用于对应五行的技能升级；强化石只用于对应等级区间的遗物强化。</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.tab-btn {
  flex: 1;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-dim);
  font-size: 13px;
  min-height: 34px;
}

.tab-btn.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}

.chip {
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  font-size: 12px;
  color: var(--c-text-dim);
  min-height: 28px;
}

.chip.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.item-icon {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
  background: #0d0d14;
  flex: 0 0 auto;
}

.rules {
  margin: 0;
  padding-left: 18px;
  color: var(--c-text-dim);
  font-size: 12px;
  line-height: 1.7;
}

.warn-text {
  color: #e0a06a;
}
</style>
