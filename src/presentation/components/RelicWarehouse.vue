<script setup lang="ts">
/**
 * 遗物仓库（背包页「遗物」分类的内容组件）。
 *
 * ⚠ **仓库走服务端分页**（`GET /api/relics`）：存档分包后客户端镜像里
 *   只有已装备遗物，仓库可能有数千件，整包拉下来会把每个动作的响应
 *   撑到 MB 级。筛选 / 排序 / 分页条件全部传给服务端，不在前端过滤。
 *
 * 套装件数与生效判定取 core 的 RELIC_SETS / getSetModsBySetIds，组件不另立规则。
 *
 * ⚠ **强化石按档位扣**（资源/背包版本 v10）：强化石分初阶 / 中阶 / 高阶三档，
 *   档位由「目标等级」决定（`relicUpgradeCost`）。名称一律取 `ITEM_DEFS`
 *   （铁律 #8），界面不得就地写中文名。
 *
 * ## 存档 v12：遗物祈愿已下线
 *
 * 「花银两祈愿 1 件遗物」这条路**整条删掉**（core 的动作 `relic.acquire` 已删除），
 * 遗物的**唯一来源**是**遗物副本**（手动挑战 / 遗物挂机通道）。
 * 所以本组件顶部的面板从「祈愿」改成：
 *   ① **遗物副本入口**（遗物的唯一来源，必须显式可达 —— 铁律 #10 / #59）；
 *   ② **图鉴摘要行**（套装集齐数 + 保底还差几件 → 点进 L2「套装与保底」）。
 *
 * > 教训：入口下线时，**替代路径必须在同一个位置接上**——
 * > 否则玩家看到的是「仓库空着 + 没有路可走」，整条遗物养成线等于消失。
 *
 * ## 背包页一屏化 v14：为什么版式变了
 *
 * 旧版从上到下是：套装进度（12 行）→ 每日额度 → 保底进度（18 行）→ 副本入口 →
 * 库存概览 → 批量工具条 → 遗物网格（60 件 = 20 行 ≈ 1760px）→ **详情面板**。
 *
 * 360×640 的内容区只有 534px ⇒ 三块参考信息把真正的网格挤到第三屏，
 * 而「强化 +1」按钮排在 1760px 网格**下面** ⇒ 手机上要滚 3 屏才摸得到操作键。
 *
 * 现在：
 * - 参考信息（套装进度 / 套装效果 / 保底）**下沉到 L2** `/forge/sets`；
 * - L1 只留**吸顶工具条** + **筛选行** + **图鉴摘要行** + **副本入口** + **网格**；
 * - 遗物详情改成**底部抽屉**（`RelicDetailSheet`），点一下就升起来。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import RelicDetailSheet from './RelicDetailSheet.vue'
import { RELIC_DEFS, RELIC_SETS, relicQuotaLeft } from '../../core/systems/relic.ts'
import {
  DUNGEON_INDEX,
  DUNGEON_VARIANT_ORDER,
  dungeonStagesOfVariant,
  type DungeonVariant,
} from '../../core/config/dungeons.ts'
import { relicIdsBySet } from '../../core/config/relics.ts'
import { RELIC, RELIC_DROP } from '../../core/config/economy.ts'
import { relicIconPath } from '../../core/config/art.ts'
import { formatNumber } from '../utils/format'
import type { Rarity, RelicInstance } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

const RARITIES: Rarity[] = ['SSR', 'SR', 'R', 'N']

/** 稀有度筛选（服务端过滤） */
const rarityFilter = ref<Rarity | '全部'>('全部')
/** 套装筛选（服务端过滤） */
const setFilter = ref<string>('全部')
/** 排序：等级高→低 / 等级低→高（服务端排序） */
const sortAsc = ref(false)
/** 当前页码 */
const page = ref(1)
/**
 * 每页条数。
 *
 * ⚠ 60 件 / 页在 360px 下是 3 列 × 20 行 ≈ 1760px —— 翻页要滚很久。
 *   改成 24（8 行 ≈ 800px），手机上翻页更合理。
 */
const pageSize = ref(24)
/** 抽屉里打开的遗物 uid（`null` = 抽屉关闭） */
const selectedUid = ref<string | null>(null)
/** 抽屉里那件遗物的兜底快照（它可能已经不在当前页 / 镜像里了） */
const selectedFallback = ref<RelicInstance | null>(null)
/** 批量勾选的 uid 集合 */
const checked = ref<Set<string>>(new Set())

/** 当前页的遗物（服务端返回） */
const relics = computed<RelicInstance[]>(() => store.relicPage.items)
const total = computed(() => store.relicPage.total)
const pages = computed(() => store.relicPage.pages)

/** 库存占用（0..1）：接近上限时提示玩家清理 */
const usage = computed(() => {
  if (RELIC.INVENTORY_CAP <= 0) return 0
  return total.value / RELIC.INVENTORY_CAP
})

/**
 * **今日剩余遗物额度**（件）。
 *
 * ⚠ 走 core 的 `relicQuotaLeft`（**唯一一份**，按 UTC 日期键判定）；
 *   时间取**注入时钟** `store.now()`，禁止 `Date.now()`（铁律 #12）。
 * ⚠ 额度只管**挂机**：手动挑战遗物副本不受限（界面必须写清楚，
 *   否则玩家会以为「额度用尽 = 遗物彻底拿不到」）。
 */
const quotaLeft = computed(() => relicQuotaLeft(store.save, store.now()))

// ─────────────────────────── 遗物副本（遗物的唯一来源） ───────────────────────────

/** 遗物副本的变体列表（6 个，按配置固定顺序） */
const relicVariants = computed<DungeonVariant[]>(() =>
  DUNGEON_VARIANT_ORDER.map((id) => DUNGEON_INDEX.get(id))
    .filter((v): v is DungeonVariant => !!v && v.kind === 'relic'),
)

/**
 * 全部遗物副本关卡（保底进度用）。
 *
 * ⚠ 关卡 id 的唯一出处是 core 的 `dungeonStagesOfVariant`（铁律 #3）。
 */
const relicStages = computed(() =>
  relicVariants.value.flatMap((v) => [...dungeonStagesOfVariant(v.id)]),
)

/** 某关卡的保底计数（连续未出 SSR 的**件数**，随存档落盘） */
function pityOf(stageId: string): number {
  return store.save.relicPity[stageId] ?? 0
}

/**
 * 最近的一个保底还差几件。
 *
 * ⚠ 口径 = 所有遗物副本关卡里**剩余最少**的那个（最乐观的那条线）。
 */
const minPityRemain = computed(() => {
  if (relicStages.value.length === 0) return RELIC_DROP.PITY_SSR
  let min: number = RELIC_DROP.PITY_SSR
  for (const s of relicStages.value) {
    const remain = Math.max(0, RELIC_DROP.PITY_SSR - pityOf(s.id))
    if (remain < min) min = remain
  }
  return min
})

/**
 * 仓库里已**集齐**（5/5 件）的套装数。
 *
 * ⚠ 件数取 `store.relicSetCounts`（**服务端口径**：客户端镜像里只有已装备件）。
 */
const completedSets = computed(() => {
  let n = 0
  for (const set of RELIC_SETS.values()) {
    const owned = store.relicSetCounts.get(set.id) ?? 0
    if (owned >= relicIdsBySet(set.id).length) n += 1
  }
  return n
})

/** 套装总数（配置口径） */
const totalSets = computed(() => RELIC_SETS.size)

/** 去遗物副本页（遗物的唯一来源，入口必须**真的可达** —— 铁律 #10） */
function goRelicDungeon() {
  void router.push({ path: '/dungeon', query: { kind: 'relic' } })
}

/** 去「套装与保底」二级页 */
function goAtlas() {
  void router.push('/forge/sets')
}

// ─────────────────────────── 仓库加载 ───────────────────────────

/** 按当前筛选 / 排序 / 页码重新拉取仓库 */
async function reload(nextPage = page.value) {
  page.value = nextPage
  await store.loadRelicPage({
    page: nextPage,
    size: pageSize.value,
    rarity: rarityFilter.value === '全部' ? undefined : rarityFilter.value,
    setId: setFilter.value === '全部' ? undefined : setFilter.value,
    sort: sortAsc.value ? 'level' : undefined,
  })
  await store.loadRelicStats()
}

onMounted(() => {
  void reload(1)
  // ⚠ 刷新一次存档镜像：保底计数（`save.relicPity`）与每日额度都住在存档里，
  //   另一条链路刚打过副本的话，镜像里的计数是旧的 ⇒ 玩家看到过期的保底进度。
  void store.refreshSave()
})

watch(rarityFilter, () => {
  void reload(1)
})
watch(setFilter, () => {
  void reload(1)
})
watch(sortAsc, () => {
  void reload(page.value)
})

// ─────────────────────────── 分页 ───────────────────────────

function prevPage() {
  if (page.value <= 1) return
  void reload(page.value - 1)
}

function nextPage() {
  if (page.value >= pages.value) return
  void reload(page.value + 1)
}

// ─────────────────────────── 选择与批量 ───────────────────────────

/**
 * 打开遗物详情**抽屉**。
 *
 * ⚠ 详情内容由 `RelicDetailContent` 按 uid **实时**从 store 取
 *   （强化后服务端会重新分页 ⇒ 抽屉里的等级自动变新）。
 */
function selectRelic(relic: RelicInstance) {
  selectedFallback.value = relic
  selectedUid.value = relic.uid
}

function closeDetail() {
  selectedUid.value = null
  selectedFallback.value = null
}

function isChecked(uid: string): boolean {
  return checked.value.has(uid)
}

function toggleCheck(uid: string) {
  const next = new Set(checked.value)
  if (next.has(uid)) next.delete(uid)
  else next.add(uid)
  checked.value = next
}

function checkAllOnPage() {
  const next = new Set(checked.value)
  for (const r of relics.value) next.add(r.uid)
  checked.value = next
}

function clearChecked() {
  checked.value = new Set()
}

const checkedCount = computed(() => checked.value.size)

/** 勾选中的遗物（去重后按服务端顺序） */
const checkedUids = computed(() => relics.value.map((r) => r.uid).filter((uid) => checked.value.has(uid)))

async function batchDecompose() {
  if (checkedUids.value.length === 0) return
  const res = await store.decomposeRelics(checkedUids.value)
  if (res) {
    store.notify(`已分解 ${res.decomposed} 件，返还银两 ${formatNumber(res.silver)}`, 'ok')
    clearChecked()
  }
}

async function batchUpgrade() {
  if (checkedUids.value.length === 0) return
  const res = await store.upgradeRelics(checkedUids.value)
  if (res) {
    store.notify(`已强化 ${res.upgraded} 件`, 'ok')
    clearChecked()
  }
}

/** 一键分解：清掉 1 级的未锁定未装备件 */
async function decomposeJunk() {
  const res = await store.decomposeByFilter({ maxLevel: RELIC.MIN_LEVEL })
  if (res) {
    store.notify(`已清理 ${res.decomposed} 件低等级遗物`, 'ok')
    clearChecked()
  }
}
</script>

<template>
  <div>
    <!-- ① 吸顶工具条：容量 / 排序 / 一键清理 / 额度 -->
    <div class="sticky-top">
      <div class="row-between">
        <b class="tiny" data-testid="relic-total">
          {{ formatNumber(total) }} / {{ formatNumber(RELIC.INVENTORY_CAP) }}
          <span v-if="usage >= RELIC.INVENTORY_WARN_RATIO" class="warn-text">（接近上限）</span>
        </b>
        <button class="btn btn-sm btn-ghost" data-testid="relic-sort" @click="sortAsc = !sortAsc">
          {{ sortAsc ? '等级低→高' : '等级高→低' }}
        </button>
      </div>
      <div class="cap-bar">
        <div
          class="cap-fill"
          :class="{ warn: usage >= RELIC.INVENTORY_WARN_RATIO }"
          :style="{ width: `${Math.min(100, usage * 100)}%` }"
        ></div>
      </div>
      <div class="row-between">
        <span class="tiny muted" data-testid="relic-daily-quota">
          今日额度 {{ quotaLeft }} 件 · 手动挑战不受限
        </span>
        <button class="btn btn-sm btn-ghost" data-testid="relic-decompose-junk" @click="decomposeJunk">
          一键清理 1 级
        </button>
      </div>
    </div>

    <!-- ② 筛选行（稀有度 + 套装，各一行横向滚动） -->
    <section class="panel filter-panel">
      <div class="scroll-row">
        <button class="chip-sm" :class="{ on: rarityFilter === '全部' }" @click="rarityFilter = '全部'">
          全部
        </button>
        <button
          v-for="r in RARITIES"
          :key="r"
          class="chip-sm"
          :class="{ on: rarityFilter === r }"
          @click="rarityFilter = r"
        >
          {{ r }}
        </button>
      </div>
      <div class="scroll-row" style="margin-top: 6px">
        <button class="chip-sm" :class="{ on: setFilter === '全部' }" @click="setFilter = '全部'">
          全部套装
        </button>
        <button
          v-for="set in RELIC_SETS.values()"
          :key="set.id"
          class="chip-sm"
          :class="{ on: setFilter === set.id }"
          @click="setFilter = set.id"
        >
          {{ set.name }}
        </button>
      </div>
    </section>

    <!-- ③ 图鉴摘要行（套装进度 + 保底 → L2「套装与保底」） -->
    <button class="panel atlas-row" data-testid="relic-atlas-open" @click="goAtlas">
      <span class="tiny">
        套装已集齐 <b>{{ completedSets }}</b> / {{ totalSets }} · 保底再 {{ minPityRemain }} 件必出 SSR
      </span>
      <span class="tiny muted">套装与保底 ›</span>
    </button>

    <!-- ④ 遗物副本入口（遗物的唯一来源；铁律 #10 / #59：入口必须可达） -->
    <button
      class="btn btn-primary btn-block btn-sm"
      style="margin-top: 8px"
      data-testid="relic-go-dungeon"
      @click="goRelicDungeon"
    >
      去遗物副本获取遗物
    </button>

    <!-- ⑤ 遗物列表（**裸网格**：不再套 panel —— 12px 内边距会把首屏又挤掉一行） -->
    <div style="margin-top: 10px">
      <div v-if="store.relicPageError" class="tiny warn-text">{{ store.relicPageError }}</div>
      <div v-else-if="store.relicPageLoading" class="empty">加载中…</div>
      <div v-else-if="relics.length === 0" class="empty">
        仓库暂无遗物<br />
        <span class="tiny">遗物只能从遗物副本获得（主线通关第 1 关即可进入第一个副本）</span>
        <div style="margin-top: 8px">
          <button class="btn btn-sm btn-primary" data-testid="relic-go-dungeon-empty" @click="goRelicDungeon">
            去遗物副本
          </button>
        </div>
      </div>
      <div v-else class="relic-grid">
        <div
          v-for="r in relics"
          :key="r.uid"
          class="relic-cell"
          :class="{ on: selectedUid === r.uid }"
        >
          <label class="check-box">
            <input
              type="checkbox"
              data-testid="relic-check"
              :checked="isChecked(r.uid)"
              @change="toggleCheck(r.uid)"
            />
          </label>
          <button class="relic-open" data-testid="relic-open" @click="selectRelic(r)">
            <span class="relic-icon-wrap">
              <img
                class="relic-icon"
                :src="relicIconPath(r.defId)"
                :alt="RELIC_SETS.get(RELIC_DEFS.get(r.defId)?.setId ?? '')?.name ?? ''"
                width="44"
                height="44"
                loading="lazy"
              />
              <!-- ⚠ 稀有度**贴在图标角上**：单独占一行会把格子撑高 20px，
                   360×640 的首屏就少看得到一行遗物（铁律 #69） -->
              <span class="tag relic-rarity" :class="`tag-${(RELIC_DEFS.get(r.defId)?.rarity ?? 'N').toLowerCase()}`">
                {{ RELIC_DEFS.get(r.defId)?.rarity ?? 'N' }}
              </span>
            </span>
            <span class="relic-name">
              {{ RELIC_DEFS.get(r.defId)?.name ?? r.defId }}
              <span v-if="r.locked" class="tag tag-sr">锁</span>
            </span>
            <span class="tiny muted relic-meta">
              {{ RELIC_SETS.get(RELIC_DEFS.get(r.defId)?.setId ?? '')?.name ?? '—' }} · +{{ r.level }}
            </span>
          </button>
        </div>
      </div>
      <div class="row-between" style="margin-top: 10px">
        <button class="btn btn-sm btn-ghost" :disabled="page <= 1" @click="prevPage">上一页</button>
        <span class="tiny muted">{{ page }} / {{ pages }}</span>
        <button class="btn btn-sm btn-ghost" :disabled="page >= pages" @click="nextPage">下一页</button>
      </div>
    </div>

    <!-- ⑥ 吸底批量条（**只在勾选后出现**，平时不占首屏空间） -->
    <div v-if="checkedCount > 0" class="sticky-bar" data-testid="relic-batch-bar">
      <span class="sticky-left tiny">已选 {{ checkedCount }} 件</span>
      <button class="btn btn-sm btn-ghost" @click="checkAllOnPage">全选本页</button>
      <button class="btn btn-sm btn-ghost" @click="clearChecked">清空</button>
      <button
        class="btn btn-sm"
        data-testid="relic-batch-upgrade"
        :disabled="checkedCount === 0"
        @click="batchUpgrade"
      >
        批量强化 +1
      </button>
      <button
        class="btn btn-sm btn-danger"
        data-testid="relic-batch-decompose"
        :disabled="checkedCount === 0"
        @click="batchDecompose"
      >
        批量分解
      </button>
    </div>

    <!-- ⑦ 遗物详情（底部抽屉：点一下就升起来，操作就在手指底下） -->
    <RelicDetailSheet :uid="selectedUid" :prefetched="selectedFallback" @close="closeDetail" />
  </div>
</template>

<style scoped>
/* 库存占用条 */
.cap-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
  overflow: hidden;
}

.cap-fill {
  height: 100%;
  background: var(--c-gold);
  transition: width 0.2s ease;
}

.cap-fill.warn {
  background: #d4763a;
}

.relic-grid {
  display: grid;
  /* ⚠ **3 列**（不是 `auto-fill` + 104px）：360px 下容器只有 ~310px，
     104px 的下限只能排 2 列 ⇒ 首屏只看得到 4 件。
     88px 的下限排 3 列（每格 ~98px），首屏能看到 6 件（铁律 #69）。 */
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 6px;
}

.relic-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  border-radius: 10px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
}

.relic-cell.on {
  border-color: var(--c-gold);
  background: #2a2419;
}

.check-box {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 1;
  line-height: 1;
}

.relic-open {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 6px;
  width: 100%;
  text-align: left;
}

/** 图标 + 稀有度角标（角标贴在图标上，不单独占一行） */
.relic-icon-wrap {
  position: relative;
  display: block;
  line-height: 0;
}

.relic-rarity {
  position: absolute;
  right: -2px;
  bottom: -2px;
  font-size: 10px;
  padding: 0 4px;
  line-height: 14px;
}

.relic-icon {
  width: 44px;
  height: 44px;
  /* ⚠ 不再圆形裁切：AI 遗物图是方形满幅的实物立绘，
     50% 圆裁会把长柄武器的杆与刃尖切掉（铁律 #8 换图不破的同类问题）。 */
  border-radius: 6px;
  object-fit: cover;
  display: block;
  background: #0d0d14;
}

.relic-name {
  font-size: 12px;
  color: var(--c-text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relic-meta {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 筛选行（面板内边距压到 8px：12px 会把首屏又挤掉一行） */
.filter-panel {
  padding: 8px;
  margin-bottom: 8px;
}

/* 图鉴摘要行（点进 L2「套装与保底」） */
.atlas-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  text-align: left;
  cursor: pointer;
  padding: 8px;
  margin-bottom: 0;
}

.warn-text {
  color: #e0a06a;
}
</style>
