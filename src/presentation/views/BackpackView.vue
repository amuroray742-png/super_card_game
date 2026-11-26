<script setup lang="ts">
/**
 * 背包（**底栏「背包」标签页的内容**）。
 *
 * ⚠ **分类只有 5 个**（设计稿 §4）：
 *   遗物 / 技能材料 / 强化材料 / 经验书 / 卡碎片。
 *
 * ## 单一数据源
 *
 * - 道具名称 / 作用描述 / 图标 key → `core/config/items.ts` 的 `ITEM_DEFS`；
 * - 数值（面额、每级消耗、档位区间、升星所需）→ `core/config/economy.ts`；
 * - 副本解锁与来源 → `core/config/dungeons.ts` + `core/systems/dungeons.ts`。
 * 表现层**不得**就地写中文名或就地写数字（铁律 #4 / #5 / #8）。
 *
 * ## 筛选带在 URL 上
 *
 * 从英灵页 / 遗物页跳进来时要「自动带入相关筛选」（设计稿 §4），
 * 所以分类与筛选条件走 **query**（`?tab=skillMat&element=金`），
 * 刷新、分享、返回都保持得住。
 *
 * ## 背包页一屏化 v14：每个分类的「主操作」都在首屏
 *
 * 360×640 的内容区只有 534px。旧版：
 * - 技能材料把**全部已拥有英灵**平铺成列表（随拥有量线性变长）；
 * - 经验书把**全部英灵**铺成 chip（无上限，wrap 成好几行）；
 * - 强化材料多出一块只有两行的汇总面板。
 *
 * 现在：
 * - 「可使用的英灵」→ **一行摘要 + 底部抽屉**（不跳页、不加深度）；
 * - 投喂的英灵选择 → **「换」按钮 + 抽屉**（L1 只显示当前选中英灵）；
 * - 汇总信息合并进面板标题行。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import RelicWarehouse from '../components/RelicWarehouse.vue'
import {
  ITEM_DEFS,
  ITEM_CATEGORY_NAMES,
  EXP_BOOK_ITEM_EXP,
  itemsOfCategory,
  itemElement,
  type ItemId,
} from '../../core/config/items.ts'
import { ITEM_BY_ELEMENT } from '../../core/config/items.ts'
import { DUNGEON_VARIANTS, dungeonDropAmount } from '../../core/config/dungeons.ts'
import { RELIC, STAR, SKILL, type DungeonDifficultyId, type RelicStoneTierId } from '../../core/config/economy.ts'
import { resourceIconPath } from '../../core/config/art.ts'
import { previewFeed, starUpCost } from '../../core/systems/growth.ts'
import { relicStoneTierForLevel } from '../../core/systems/relic.ts'
import { formatNumber } from '../utils/format'
import type { Element } from '../../core/model/types.ts'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

/** 背包分类（设计稿 §4 的 5 类） */
type BackpackTab = 'relics' | 'skillMat' | 'relicStone' | 'expBook' | 'shards'

const TABS: { key: BackpackTab; label: string }[] = [
  { key: 'relics', label: '遗物' },
  { key: 'skillMat', label: ITEM_CATEGORY_NAMES.skillMat },
  { key: 'relicStone', label: ITEM_CATEGORY_NAMES.relicStone },
  { key: 'expBook', label: ITEM_CATEGORY_NAMES.expBook },
  { key: 'shards', label: '卡碎片' },
]

const TAB_KEYS = TABS.map((t) => t.key)

/** 当前分类（从 URL 读；非法值回落「遗物」） */
const tab = computed<BackpackTab>(() => {
  const raw = route.query.tab
  const value = Array.isArray(raw) ? raw[0] : raw
  return TAB_KEYS.includes(value as BackpackTab) ? (value as BackpackTab) : 'relics'
})

/** 切分类（写回 URL，保持可分享 / 可返回） */
function selectTab(next: BackpackTab) {
  void router.replace({ path: route.path, query: { ...route.query, tab: next } })
}

// ─────────────────────────── 技能材料 ───────────────────────────

const ELEMENTS: Element[] = ['金', '木', '水', '火', '土']

/** 五行筛选（URL 带） */
const elementFilter = computed<Element>(() => {
  const raw = route.query.element
  const value = Array.isArray(raw) ? raw[0] : raw
  return ELEMENTS.includes(value as Element) ? (value as Element) : '金'
})

function selectElement(next: Element) {
  void router.replace({ path: route.path, query: { ...route.query, tab: 'skillMat', element: next } })
}

/** 技能材料清单（数量取存档，名称取 ITEM_DEFS） */
const skillMats = computed(() =>
  itemsOfCategory('skillMat').map((def) => {
    // ⚠ 五行一律经 core 的 `itemElement()` 反推——**不能**用 `def.id.replace('skillMat','')`
    //   （那是英文 id 后缀 `Fire`，与英灵五行 `火` 对不上 → 筛选置灰、去副本跳错）。
    const element = itemElement(def.id) ?? '金'
    return {
      def,
      element,
      count: store.save.items[def.id] ?? 0,
      heroCount: store.ownedHeroes.filter((h) => h.element === element).length,
    }
  }),
)

/**
 * 某五行副本的每胜产量（普通难度）。
 *
 * ⚠ 存档 v12 起副本有两类产出：材料副本发**堆叠物**（`drop` 有值），
 *   遗物副本发**实例**（`drop === null`）——这里取不到产量就显示「—」，
 *   不能直接解引用（否则模板在遗物副本的道具上会崩）。
 */
function dropPerWin(itemId: ItemId): string {
  const variant = DUNGEON_VARIANTS.find((v) => v.itemId === itemId)
  if (!variant) return '—'
  const drop = dungeonDropAmount(variant, 'normal')
  if (!drop) return '—'
  return drop.min === drop.max ? `${drop.min}` : `${drop.min}~${drop.max}`
}

/**
 * 「可使用的英灵」抽屉是否打开。
 *
 * ⚠ 旧版把**全部**已拥有英灵平铺在技能材料页下方（随拥有量线性变长），
 *   现在收进抽屉：L1 只留一行摘要，点开才看明细。
 */
const usableHeroesOpen = ref(false)

/**
 * 可使用该五行材料的英灵（**当前筛选五行优先**）。
 *
 * ⚠ 排序只为「一眼看到能用的」，不改变任何口径。
 */
const usableHeroes = computed(() => {
  const list = [...store.ownedHeroes]
  const el = elementFilter.value
  return list.sort((a, b) => {
    const aHit = a.element === el ? 0 : 1
    const bHit = b.element === el ? 0 : 1
    if (aHit !== bHit) return aHit - bHit
    return a.name.localeCompare(b.name)
  })
})

// ─────────────────────────── 强化材料 ───────────────────────────

/** 强化石清单 */
const relicStones = computed(() =>
  itemsOfCategory('relicStone').map((def) => {
    const tier = RELIC.STONE_TIERS.find((t) => t.id === def.id)
    return {
      def,
      count: store.save.items[def.id] ?? 0,
      tier,
    }
  }),
)

/**
 * 当前**编队里**能吃这一档石头的遗物数量。
 *
 * ⚠ 客户端镜像里只有**已装备**的遗物（仓库走服务端分页），
 *   所以这里只数编队里的——不拿它冒充「仓库里有多少件可强化」。
 */
const upgradableByTier = computed(() => {
  const map = new Map<string, number>()
  for (const hero of store.team) {
    for (const relic of store.equippedMap.get(hero.def.id) ?? []) {
      if (!relic) continue
      const tier = relicStoneTierForLevel(relic.level + 1)
      if (!tier) continue
      map.set(tier.id, (map.get(tier.id) ?? 0) + 1)
    }
  }
  return map
})

// ─────────────────────────── 经验书 ───────────────────────────

/** 经验书清单 */
const expBooks = computed(() =>
  itemsOfCategory('expBook').map((def) => ({
    def,
    count: store.save.items[def.id] ?? 0,
    exp: EXP_BOOK_ITEM_EXP[def.id] ?? 0,
  })),
)

/** 喂书的目标英灵（未选时默认第一个） */
const feedHeroId = ref<string>('')
const feedBookId = ref<ItemId>('expBookSmall')
const feedCount = ref(1)

/** 可喂的英灵（都拥有，且没满级） */
const feedableHeroes = computed(() => store.ownedHeroes)

/** 当前选中的英灵（**定义**：头像 / 名称 / 五行） */
const feedHeroDef = computed(() => {
  const id = feedHeroId.value || feedableHeroes.value[0]?.id || ''
  return id ? (feedableHeroes.value.find((h) => h.id === id) ?? null) : null
})

/** 当前选中英灵的状态（等级 / 技能等级） */
const feedHero = computed(() => {
  const id = feedHeroId.value || feedableHeroes.value[0]?.id || ''
  return id ? store.save.heroes[id] ?? null : null
})

/**
 * 实际能喂的本数（背包里没那么多就按库存截断）。
 *
 * ⚠ **预览与执行必须用同一个数**：`doFeed()` 里是
 *   `Math.min(feedCount, feedAvailable)`——预览若用未截断的 `feedCount`，
 *   就会出现「预览能升 3 级、实际只喂了 1 本」的对不上（铁律 #4）。
 */
const feedAvailable = computed(() => store.save.items[feedBookId.value] ?? 0)

/** 实际会喂的本数（= 预览与执行共用的口径） */
const effectiveFeedCount = computed(() => Math.max(0, Math.min(feedCount.value, feedAvailable.value)))

/**
 * 喂书预览（**core 独家口径**）。
 *
 * ⚠ 表现层不得自己算「喂 N 本升几级」（铁律 #4）。
 */
const feedPreview = computed(() => {
  const hero = feedHero.value
  const book = expBooks.value.find((b) => b.def.id === feedBookId.value)
  if (!hero || !book) return null
  return previewFeed(hero, book.exp, effectiveFeedCount.value)
})

/**
 * 「换英灵」抽屉是否打开。
 *
 * ⚠ 旧版把**全部**英灵铺成 chip（无上限 ⇒ wrap 成好几行，吃掉首屏），
 *   现在 L1 只显示当前选中英灵，点「换」才展开列表。
 */
const feedHeroPickerOpen = ref(false)

function pickFeedHero(heroId: string) {
  feedHeroId.value = heroId
  feedHeroPickerOpen.value = false
}

/** 喂书 */
async function doFeed() {
  const hero = feedHero.value
  if (!hero) return
  const count = effectiveFeedCount.value
  if (count <= 0) {
    store.notify('背包里没有这种经验书', 'warn')
    return
  }
  const res = await store.feedBooks(hero.id, feedBookId.value, count)
  if (res) {
    store.notify(`已投喂 ${res.booksUsed} 本，经验 +${formatNumber(res.applied)}`, 'ok')
  }
}

// ─────────────────────────── 卡碎片 ───────────────────────────

/** 只看「可升星」的英灵 */
const onlyStarable = ref(false)

/** 碎片清单（按英灵分堆） */
const shardRows = computed(() =>
  store.ownedHeroes
    .map((hero) => {
      const state = store.save.heroes[hero.id]
      const shards = store.save.player.shards[hero.id] ?? 0
      const cost = state ? starUpCost(state.star) : null
      return {
        hero,
        state,
        shards,
        cost,
        starable: cost !== null && shards >= cost.shards,
      }
    })
    .filter((row) => (onlyStarable.value ? row.starable : true))
    .sort((a, b) => {
      if (a.starable !== b.starable) return a.starable ? -1 : 1
      if (b.shards !== a.shards) return b.shards - a.shards
      return a.hero.id < b.hero.id ? -1 : 1
    }),
)

/** 碎片总量 */
const shardTotal = computed(() =>
  Object.values(store.save.player.shards).reduce((sum, n) => sum + n, 0),
)

/** 拥有碎片的英灵总数（「为什么这么长」要写清楚） */
const shardHeroCount = computed(() => Object.keys(store.save.player.shards).length)

/** 当前分类的合计数量（遗物分类不统计——它按件计） */
const stackTotal = computed(() => {
  if (tab.value === 'relics') return null
  if (tab.value === 'shards') return shardTotal.value
  return itemsOfCategory(tab.value as 'skillMat' | 'relicStone' | 'expBook').reduce(
    (sum, def) => sum + (store.save.items[def.id] ?? 0),
    0,
  )
})

/** 分类切换时同步一次筛选项的默认值 */
watch(
  tab,
  () => {
    if (tab.value === 'expBook') {
      feedBookId.value = 'expBookSmall'
      feedCount.value = 1
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="page">
    <!-- 分类标签（360px 下 5 个**一行排完**：第 5 个不再被切在屏幕外） -->
    <div class="tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab-btn"
        :class="{ on: tab === t.key }"
        :data-testid="`backpack-tab-${t.key}`"
        @click="selectTab(t.key)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 遗物 -->
    <template v-if="tab === 'relics'">
      <RelicWarehouse />
    </template>

    <!-- 技能材料 -->
    <template v-else-if="tab === 'skillMat'">
      <section class="panel">
        <div class="row-between">
          <div class="tiny muted">五行筛选</div>
          <div class="tiny muted">合计 {{ formatNumber(stackTotal ?? 0) }} 个</div>
        </div>
        <div class="scroll-row" style="margin-top: 6px">
          <button
            v-for="el in ELEMENTS"
            :key="el"
            class="chip-sm"
            :class="{ on: elementFilter === el }"
            :data-testid="`backpack-element-${el}`"
            @click="selectElement(el)"
          >
            {{ el }}
          </button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-title">
          <span>技能材料</span>
          <span class="tiny muted">每级消耗 {{ SKILL.MATERIAL_PER_LEVEL }} 个 + 银两 {{ formatNumber(SKILL.SILVER_PER_LEVEL) }}</span>
        </div>
        <div
          v-for="row in skillMats"
          :key="row.def.id"
          class="item-row"
          :class="{ dim: elementFilter !== row.element }"
          :data-testid="`backpack-item-${row.def.id}`"
        >
          <img class="item-icon" :src="resourceIconPath(row.def.iconKey)" :alt="row.def.name" width="36" height="36" loading="lazy" />
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <b>{{ row.def.name }}</b>
              <span class="tiny muted">×{{ formatNumber(row.count) }}</span>
            </div>
            <div class="tiny muted">{{ row.def.source }} · 每胜 {{ dropPerWin(row.def.id) }} 个</div>
          </div>
          <button
            class="btn btn-sm btn-ghost"
            :data-testid="`backpack-go-dungeon-${row.def.id}`"
            @click="router.push(`/dungeon?kind=skill&element=${row.element}`)"
          >
            去副本
          </button>
        </div>
        <p class="tiny muted" style="margin: 8px 0 0">
          材料只在对应五行的副本里产出：先选五行，再选难度；难度越高单场产量越多。
        </p>
      </section>

      <!-- 「可使用的英灵」：一行摘要 + 抽屉（旧版是整列列表，随拥有量线性变长） -->
      <button class="panel atlas-row" data-testid="backpack-usable-heroes-open" @click="usableHeroesOpen = true">
        <span class="tiny">可使用的英灵 <b>{{ usableHeroes.length }}</b> 位</span>
        <span class="tiny muted">查看 ›</span>
      </button>

      <div v-if="usableHeroesOpen" class="sheet-mask" @click.self="usableHeroesOpen = false">
        <div class="sheet" data-testid="backpack-usable-heroes">
          <div class="panel-title">
            <span>可使用的英灵</span>
            <button class="btn btn-sm btn-ghost" data-testid="backpack-usable-heroes-close" @click="usableHeroesOpen = false">
              关闭
            </button>
          </div>
          <div v-if="usableHeroes.length === 0" class="empty">尚未拥有英灵</div>
          <button
            v-for="hero in usableHeroes"
            :key="hero.id"
            class="picker-row"
            :data-testid="`backpack-usable-hero-${hero.id}`"
            @click="router.push(`/hero/${hero.id}`)"
          >
            <img
              :src="hero.portrait"
              class="portrait"
              :class="`portrait-${hero.rarity.toLowerCase()}`"
              width="36"
              height="36"
              loading="lazy"
            />
            <div style="flex: 1; min-width: 0">
              <div class="row" style="gap: 6px">
                <b>{{ hero.name }}</b>
                <span class="tiny" :class="`el-${hero.element}`">{{ hero.element }}</span>
              </div>
              <div class="tiny muted">
                Lv{{ store.save.heroes[hero.id]?.level ?? 1 }} · 技能
                {{ (store.save.heroes[hero.id]?.skillLevels ?? []).join('/') }}
              </div>
            </div>
            <span class="tiny" :class="hero.element === elementFilter ? 'ok-text' : 'muted'">
              {{ hero.element === elementFilter ? '可升技能' : '' }}
            </span>
          </button>
        </div>
      </div>
    </template>

    <!-- 强化材料 -->
    <template v-else-if="tab === 'relicStone'">
      <section class="panel">
        <div class="panel-title">
          <span>遗物强化石</span>
          <span class="tiny muted">合计 {{ formatNumber(stackTotal ?? 0) }} 个</span>
        </div>
        <div
          v-for="row in relicStones"
          :key="row.def.id"
          class="item-row"
          :data-testid="`backpack-item-${row.def.id}`"
        >
          <img class="item-icon" :src="resourceIconPath(row.def.iconKey)" :alt="row.def.name" width="36" height="36" loading="lazy" />
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <b>{{ row.def.name }}</b>
              <span class="tiny muted">×{{ formatNumber(row.count) }}</span>
            </div>
            <div class="tiny muted">
              适用遗物 Lv{{ row.tier?.minLevel }}~{{ row.tier?.maxLevel }} · {{ row.def.source }}
            </div>
            <div class="tiny muted">
              编队内可强化 {{ upgradableByTier.get(row.def.id) ?? 0 }} 件
            </div>
          </div>
          <button
            class="btn btn-sm btn-ghost"
            :data-testid="`backpack-go-dungeon-${row.def.id}`"
            @click="router.push(`/dungeon?kind=enhance&tier=${row.def.id}`)"
          >
            去副本
          </button>
        </div>
        <p class="tiny muted" style="margin: 8px 0 0">
          档位按「<b>目标等级</b>」判定：60 → 61 用中阶石，130 → 131 用高阶石。
        </p>
      </section>
    </template>

    <!-- 经验书 -->
    <template v-else-if="tab === 'expBook'">
      <section class="panel">
        <div class="panel-title">
          <span>通用经验书</span>
          <span class="tiny muted">合计 {{ formatNumber(stackTotal ?? 0) }} 本</span>
        </div>
        <div
          v-for="row in expBooks"
          :key="row.def.id"
          class="item-row"
          :data-testid="`backpack-item-${row.def.id}`"
        >
          <img class="item-icon" :src="resourceIconPath(row.def.iconKey)" :alt="row.def.name" width="36" height="36" loading="lazy" />
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <b>{{ row.def.name }}</b>
              <span class="tiny muted">×{{ formatNumber(row.count) }}</span>
            </div>
            <div class="tiny muted">每本 {{ formatNumber(row.exp) }} 点经验 · {{ row.def.source }}</div>
          </div>
          <button
            class="btn btn-sm"
            :class="{ on: feedBookId === row.def.id }"
            :data-testid="`backpack-pick-book-${row.def.id}`"
            @click="feedBookId = row.def.id"
          >
            选用
          </button>
        </div>
        <p class="tiny muted" style="margin: 8px 0 0">
          经验书全职业通用，由主线产出；喂给英灵后存在英灵身上，境界门槛上的经验不会丢。
        </p>
      </section>

      <!-- 投喂卡：只显示**当前选中英灵**，换人走抽屉（不再平铺全部 chip） -->
      <section class="panel">
        <div class="panel-title"><span>投喂</span></div>
        <div v-if="feedableHeroes.length === 0" class="empty">尚未拥有英灵</div>
        <template v-else>
          <div class="feed-row">
            <img
              :src="feedHeroDef?.portrait"
              class="portrait"
              :class="`portrait-${(feedHeroDef?.rarity ?? 'n').toLowerCase()}`"
              width="36"
              height="36"
              loading="lazy"
            />
            <div style="flex: 1; min-width: 0">
              <div class="row" style="gap: 6px">
                <b>{{ feedHeroDef?.name ?? '—' }}</b>
                <span v-if="feedHeroDef" class="tiny" :class="`el-${feedHeroDef.element}`">
                  {{ feedHeroDef.element }}
                </span>
              </div>
              <div class="tiny muted">
                Lv{{ feedHero?.level ?? 1 }} · 技能 {{ (feedHero?.skillLevels ?? []).join('/') }}
              </div>
            </div>
            <button
              class="btn btn-sm btn-ghost"
              data-testid="backpack-feed-pick-hero"
              @click="feedHeroPickerOpen = true"
            >
              换
            </button>
          </div>
          <div class="row" style="gap: 6px; align-items: center; margin-top: 6px">
            <span class="tiny muted">本数</span>
            <input v-model.number="feedCount" class="input" type="number" min="1" :max="feedAvailable" style="width: 90px" />
            <span class="tiny muted">库存 {{ formatNumber(feedAvailable) }}</span>
          </div>
          <div v-if="feedPreview" class="tiny muted" style="margin-top: 6px">
            预览：投入 {{ formatNumber(feedPreview.applied) }} 经验 · 升 {{ feedPreview.levelsGained }} 级
            <span v-if="feedPreview.blockedByRealm" class="warn-text">（撞到境界门槛，需突破）</span>
            <span v-else-if="feedPreview.expRemaining > 0">（存于该英灵 {{ formatNumber(feedPreview.expRemaining) }} 经验）</span>
          </div>
          <div v-if="feedAvailable <= 0" class="tiny warn-text" style="margin-top: 4px">
            背包里没有这种经验书
          </div>
          <button
            class="btn btn-primary btn-block"
            style="margin-top: 8px"
            data-testid="backpack-feed"
            :disabled="!feedPreview || feedPreview.booksUsed <= 0"
            @click="doFeed"
          >
            投喂
          </button>
        </template>
      </section>

      <!-- 换英灵（抽屉内可滚；旧版是无限 chip） -->
      <div v-if="feedHeroPickerOpen" class="sheet-mask" @click.self="feedHeroPickerOpen = false">
        <div class="sheet" data-testid="backpack-hero-picker">
          <div class="panel-title">
            <span>选择英灵</span>
            <button class="btn btn-sm btn-ghost" data-testid="backpack-hero-picker-close" @click="feedHeroPickerOpen = false">
              关闭
            </button>
          </div>
          <button
            v-for="hero in feedableHeroes"
            :key="hero.id"
            class="picker-row"
            :data-testid="`backpack-pick-hero-${hero.id}`"
            @click="pickFeedHero(hero.id)"
          >
            <img
              :src="hero.portrait"
              class="portrait"
              :class="`portrait-${hero.rarity.toLowerCase()}`"
              width="36"
              height="36"
              loading="lazy"
            />
            <div style="flex: 1; min-width: 0">
              <div class="row" style="gap: 6px">
                <b>{{ hero.name }}</b>
                <span class="tiny" :class="`el-${hero.element}`">{{ hero.element }}</span>
              </div>
              <div class="tiny muted">
                Lv{{ store.save.heroes[hero.id]?.level ?? 1 }} · 技能
                {{ (store.save.heroes[hero.id]?.skillLevels ?? []).join('/') }}
              </div>
            </div>
          </button>
        </div>
      </div>
    </template>

    <!-- 卡碎片 -->
    <template v-else-if="tab === 'shards'">
      <section class="panel">
        <div class="row-between">
          <div class="tiny muted">同名碎片</div>
          <div class="tiny muted">合计 {{ formatNumber(stackTotal ?? 0) }} 个</div>
        </div>
        <div class="scroll-row" style="margin-top: 6px">
          <button class="chip-sm" :class="{ on: !onlyStarable }" @click="onlyStarable = false">全部</button>
          <button class="chip-sm" :class="{ on: onlyStarable }" data-testid="backpack-only-starable" @click="onlyStarable = true">
            可升星
          </button>
        </div>
        <p class="tiny muted" style="margin: 6px 0 0">
          抽到重复英灵会转化为该英灵的同名碎片；每星需要 {{ STAR.SHARDS_PER_STAR }} 个。
          共 {{ shardHeroCount }} 位英灵有碎片。
        </p>
      </section>

      <section class="panel">
        <div class="panel-title"><span>卡碎片</span></div>
        <div v-if="shardRows.length === 0" class="empty">
          暂无碎片<br />
          <span class="tiny">抽到重复英灵即可获得</span>
        </div>
        <button
          v-for="row in shardRows"
          :key="row.hero.id"
          class="list-item pick-row"
          :data-testid="`backpack-shard-${row.hero.id}`"
          @click="router.push(`/hero/${row.hero.id}`)"
        >
          <img
            :src="row.hero.portrait"
            class="portrait"
            :class="`portrait-${row.hero.rarity.toLowerCase()}`"
            width="36"
            height="36"
            loading="lazy"
          />
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <b>{{ row.hero.name }}</b>
              <span class="tag" :class="`tag-${row.hero.rarity.toLowerCase()}`">{{ row.hero.rarity }}</span>
            </div>
            <div class="tiny muted">
              {{ row.state?.star ?? 1 }} 星 · 碎片 {{ formatNumber(row.shards) }}
              <template v-if="row.cost"> · 升星需 {{ row.cost.shards }}</template>
              <template v-else> · 已满星</template>
            </div>
          </div>
          <span class="tiny" :class="row.starable ? 'ok-text' : 'muted'">
            {{ row.starable ? '可升星' : row.cost ? '不足' : '满星' }}
          </span>
        </button>
      </section>
    </template>
  </div>
</template>

<style scoped>
/**
 * 分类 pill 行。
 *
 * ⚠ 360px 宽下 5 个分类必须**一行排完** —— 旧版内边距 12px / 字号 13px，
 *   第 5 个（「卡碎片」）被切在屏幕外，玩家根本不知道还有第 5 类。
 *   收到 8px / 12px 后：16 字 × 12 + 5×16 + 4×6 = 296px < 336px。
 */
.tabs {
  display: flex;
  gap: 5px;
  margin-bottom: 10px;
  overflow-x: auto;
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab-btn {
  flex: 0 0 auto;
  padding: 7px 8px;
  border-radius: 999px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-dim);
  font-size: 12px;
  min-height: 32px;
  white-space: nowrap;
}

.tab-btn.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
}

.item-row:last-child {
  border-bottom: none;
}

.item-row.dim {
  opacity: 0.55;
}

.item-icon {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
  background: #0d0d14;
  flex: 0 0 auto;
}

/** 投喂卡里的「当前英灵」行 */
.feed-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pick-row {
  width: 100%;
  text-align: left;
}

/** 一行摘要（点开抽屉） */
.atlas-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  text-align: left;
  cursor: pointer;
  padding: 8px;
}

.ok-text {
  color: var(--c-green);
}

.warn-text {
  color: #e0a06a;
}
</style>
