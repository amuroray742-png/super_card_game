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
 *   ① **套装进度**（12 个套装各 x / 5 件，点一下直达对应遗物副本）；
 *   ② **每日额度**（挂机通道的防通胀闸门；手动挑战不受限）；
 *   ③ **保底进度**（各遗物副本关卡的保底计数）。
 *
 * > 教训：入口下线时，**替代路径必须在同一个位置接上**——
 * > 否则玩家看到的是「仓库空着 + 没有路可走」，整条遗物养成线等于消失。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import {
  RELIC_DEFS,
  RELIC_SETS,
  getRelicMods,
  getSetModsBySetIds,
  relicQuotaLeft,
  relicUpgradeCost,
} from '../../core/systems/relic.ts'
import {
  DUNGEON_INDEX,
  DUNGEON_VARIANT_ORDER,
  dungeonStagesOfVariant,
  findRelicDungeonVariant,
  type DungeonVariant,
} from '../../core/config/dungeons.ts'
import { relicIdsBySet } from '../../core/config/relics.ts'
import { relicTemperRuleHint } from '../utils/relic-hint.ts'
import { RELIC, RELIC_DROP } from '../../core/config/economy.ts'
import { relicIconPath } from '../../core/config/art.ts'
import { ITEM_DEFS, type ItemId } from '../../core/config/items.ts'
import { formatNumber } from '../utils/format'
import type { Rarity, RelicInstance, StatMod } from '../../core/model/types.ts'

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
/** 每页条数 */
const pageSize = ref(60)
/** 选中的遗物（详情面板） */
const selected = ref<RelicInstance | null>(null)
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

const selectedDef = computed(() => (selected.value ? RELIC_DEFS.get(selected.value.defId) ?? null : null))
const selectedSet = computed(() =>
  selectedDef.value ? RELIC_SETS.get(selectedDef.value.setId) ?? null : null,
)

/** 选中遗物的词条（core：主词条随等级缩放） */
const selectedMods = computed<StatMod[]>(() => (selected.value ? getRelicMods(selected.value) : []))

/**
 * 仓库中各套装件数（**服务端口径**，由 store 独家产出）。
 *
 * ⚠ 复用 store 的 `relicSetCounts`（与副本页的套装进度**同一份口径**）——
 *   两处各数一遍的话，玩家会看到「仓库说 3 件、副本页说 2 件」。
 */
const ownedSetCount = computed(() => store.relicSetCounts)

// ─────────────────────────── 遗物副本（遗物的唯一来源） ───────────────────────────

/**
 * **遗物副本的变体列表**（6 个，按配置固定顺序）。
 *
 * ⚠ 套装 → 副本的映射由 core 的 `findRelicDungeonVariant` 独家产出，
 *   表现层不自己遍历变体表（铁律 #3 / #8）。
 */
const relicVariants = computed<DungeonVariant[]>(() =>
  DUNGEON_VARIANT_ORDER.map((id) => DUNGEON_INDEX.get(id))
    .filter((v): v is DungeonVariant => !!v && v.kind === 'relic'),
)

/** 某套装共有几件（配置口径：`relicIdsBySet`） */
function setTotalOf(setId: string): number {
  return relicIdsBySet(setId).length
}

/** 某套装在仓库里已有几件 */
function setCountOf(setId: string): number {
  return ownedSetCount.value.get(setId) ?? 0
}

/**
 * **今日剩余遗物额度**（件）。
 *
 * ⚠ 走 core 的 `relicQuotaLeft`（**唯一一份**，按 UTC 日期键判定）；
 *   时间取**注入时钟** `store.now()`，禁止 `Date.now()`（铁律 #12）。
 */
const quotaLeft = computed(() => relicQuotaLeft(store.save, store.now()))

/** 某关卡的保底计数（连续未出 SSR 的**件数**，随存档落盘） */
function pityOf(stageId: string): number {
  return store.save.relicPity[stageId] ?? 0
}

/** 还差几件必出 SSR */
function pityRemain(stageId: string): number {
  return Math.max(0, RELIC_DROP.PITY_SSR - pityOf(stageId))
}

/**
 * 点某个套装 → **直达产出它的遗物副本**。
 *
 * ⚠ 深链参数用 `?relic=<setId>`：副本页拿到它就高亮那个副本
 *   （`findRelicDungeonVariant` 是套装 → 副本的**唯一**映射）。
 * ⚠ 入口必须**真的可达**（铁律 #10）：套装进度写在仓库里，
 *   点一下就要落到能拿到这件遗物的关卡上，而不是只改个 URL。
 */
function goDungeonOfSet(setId: string) {
  const variant = findRelicDungeonVariant(setId)
  if (!variant) {
    store.notify('该套装暂时没有对应副本', 'warn')
    return
  }
  void router.push({ path: '/dungeon', query: { kind: 'relic', relic: setId } })
}

/** 去遗物副本页（仓库为空时的引导入口） */
function goRelicDungeon() {
  void router.push({ path: '/dungeon', query: { kind: 'relic' } })
}

/** 当前编队已装备的套装 id 列表（用于套装生效件数） */
const teamSetIds = computed<(string | null)[]>(() => {
  const out: (string | null)[] = []
  for (const hero of store.team) {
    const slots = store.equippedMap.get(hero.def.id) ?? []
    for (const r of slots) {
      if (!r) {
        out.push(null)
        continue
      }
      const d = RELIC_DEFS.get(r.defId)
      out.push(d ? d.setId : null)
    }
  }
  return out
})

/** 编队当前生效的套装加成 */
const teamSetMods = computed(() => getSetModsBySetIds(teamSetIds.value))

/** 某套装在编队中的件数 */
function teamCountOf(setId: string): number {
  return teamSetIds.value.filter((id) => id === setId).length
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
  syncSelected()
}

/**
 * 列表刷新后，把选中项同步成新数据。
 *
 * ⚠ 仓库列表是**服务端**的数据：强化后等级变了、锁定后标记变了，
 *   详情面板若还拿着旧对象，就会显示旧等级（实测「强化后按钮仍写 +2」）。
 */
function syncSelected() {
  const uid = selected.value?.uid
  if (!uid) return
  const fresh = store.relicPage.items.find((r) => r.uid === uid)
  // 已被分解 / 移出本页 → 取消选中（详情面板不再显示一件不存在的遗物）
  selected.value = fresh ?? null
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

function selectRelic(relic: RelicInstance) {
  selected.value = relic
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
    syncSelected()
  }
}

async function batchUpgrade() {
  if (checkedUids.value.length === 0) return
  const res = await store.upgradeRelics(checkedUids.value)
  if (res) {
    store.notify(`已强化 ${res.upgraded} 件`, 'ok')
    clearChecked()
    syncSelected()
  }
}

/** 一键分解：清掉 1 级的未锁定未装备件 */
async function decomposeJunk() {
  const res = await store.decomposeByFilter({ maxLevel: RELIC.MIN_LEVEL })
  if (res) {
    store.notify(`已清理 ${res.decomposed} 件低等级遗物`, 'ok')
    clearChecked()
    syncSelected()
  }
}

// ─────────────────────────── 单件操作 ───────────────────────────

/** 目标英灵选择器 */
const heroPickerOpen = ref(false)

/** 某英灵身上的遗物槽 */
function heroSlots(heroId: string): (RelicInstance | null)[] {
  return store.equippedMap.get(heroId) ?? []
}

/** 第一个空槽，没有空槽返回 -1 */
function firstEmptySlot(heroId: string): number {
  return heroSlots(heroId).findIndex((r) => r === null)
}

/** 空槽数量 */
function emptyCount(heroId: string): number {
  return heroSlots(heroId).filter((r) => r === null).length
}

function equipTo(heroId: string) {
  const relic = selected.value
  if (!relic) return
  const slot = firstEmptySlot(heroId)
  if (slot < 0) {
    store.notify('该英灵的遗物槽已满，请先卸下遗物', 'warn')
    return
  }
  store.equip(heroId, slot, relic.uid)
  heroPickerOpen.value = false
  store.notify('已装备遗物', 'ok')
}

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

// ─────────────────────────── 强化 ───────────────────────────

/**
 * 选中遗物的强化花费（等级上限时为 null）。
 *
 * ⚠ 花费与上限一律取自 core 的 `relicUpgradeCost`，表现层不自己写数字（铁律 #5）。
 */
const upgradeCost = computed(() =>
  selected.value ? relicUpgradeCost(selected.value.level) : null,
)

/**
 * 强化石消耗文案（**按档位**，名称取 `ITEM_DEFS`）。
 */
const upgradeStoneText = computed(() => {
  const stones = upgradeCost.value?.stones ?? {}
  return Object.entries(stones)
    .map(([id, n]) => `${ITEM_DEFS[id as ItemId]?.name ?? id} ${n}`)
    .join(' · ')
})

/**
 * 淬炼段规则提示（Lv60 以上价格递增、收益递减）。
 *
 * ⚠ 文案与数字走 `presentation/utils/relic-hint.ts` 的唯一一份（铁律 #4 / #27）。
 */
const temperHint = computed(() =>
  selected.value ? relicTemperRuleHint(selected.value.level) : '',
)

/** 强化按钮的可用性与提示（银两 / 强化石不够就把差额写出来） */
const upgradeHint = computed(() => {
  const cost = upgradeCost.value
  if (!cost) return { ok: false, text: '已达最高强化等级' }
  const p = store.save.player
  if (p.silver < cost.silver) {
    return { ok: false, text: `银两不足（${formatNumber(p.silver)} / ${formatNumber(cost.silver)}）` }
  }
  for (const [id, need] of Object.entries(cost.stones)) {
    const owned = store.save.items[id as ItemId] ?? 0
    if (owned < (need ?? 0)) {
      const name = ITEM_DEFS[id as ItemId]?.name ?? id
      return { ok: false, text: `${name}不足（${formatNumber(owned)} / ${formatNumber(need ?? 0)}）` }
    }
  }
  return { ok: true, text: '' }
})

/**
 * 强化到下一级的主词条提升预览。
 *
 * 主词条随强化等级缩放（`getRelicMods`），副词条固定不变——
 * 预览只列**会变**的那些，让玩家点之前就知道收益。
 */
const upgradePreview = computed(() => {
  const s = selected.value
  if (!s || !upgradeCost.value) return []
  const cur = getRelicMods(s)
  const next = getRelicMods({ ...s, level: s.level + 1 })
  const rows: { label: string; from: string; to: string }[] = []
  for (let i = 0; i < next.length; i++) {
    const c = cur[i]
    const n = next[i]
    if (!c || !n || c.value === n.value) continue
    rows.push({ label: statName(n.stat), from: statText(c), to: statText(n) })
  }
  return rows
})

/** 强化选中遗物 */
async function upgradeSelected() {
  const relic = selected.value
  if (!relic) return
  await store.upgradeRelic(relic.uid)
  syncSelected()
}

/** 锁定 / 解锁选中遗物 */
async function toggleLock() {
  const relic = selected.value
  if (!relic) return
  await store.lockRelic(relic.uid, !relic.locked)
  syncSelected()
}
</script>

<template>
  <div>
    <!-- 套装进度（点击直达产出它的遗物副本） -->
    <section class="panel">
      <div class="panel-title">
        <span>套装进度</span>
        <span class="tiny muted">点套装 → 去对应副本</span>
      </div>
      <button
        v-for="set in RELIC_SETS.values()"
        :key="set.id"
        class="set-row"
        :data-testid="`relic-set-row-${set.id}`"
        @click="goDungeonOfSet(set.id)"
      >
        <span class="set-row-name">{{ set.name }}</span>
        <span class="tiny muted">{{ setCountOf(set.id) }} / {{ setTotalOf(set.id) }} 件</span>
        <span class="tiny muted set-row-dungeon">
          产出副本：{{ findRelicDungeonVariant(set.id)?.name ?? '—' }}
        </span>
      </button>
    </section>

    <!-- 每日额度（挂机通道的防通胀闸门） -->
    <section class="panel">
      <div class="row-between">
        <span class="tiny muted">今日遗物额度</span>
        <b class="tiny" data-testid="relic-daily-quota">剩余 {{ quotaLeft }} 件</b>
      </div>
      <p class="tiny muted" style="margin: 4px 0 0">
        遗物挂机通道每日最多产出 {{ formatNumber(RELIC_DROP.DAILY_CAP) }} 件；
        <b>手动挑战遗物副本不受额度限制</b>。
      </p>
    </section>

    <!-- 保底进度（各遗物副本关卡） -->
    <section class="panel">
      <div class="panel-title">
        <span>保底进度</span>
        <span class="tiny muted">连续 {{ RELIC_DROP.PITY_SSR }} 件未出 SSR 必出</span>
      </div>
      <div v-for="variant in relicVariants" :key="variant.id" class="pity-block">
        <div class="tiny muted" style="margin-bottom: 2px">{{ variant.name }}</div>
        <div
          v-for="stage in dungeonStagesOfVariant(variant.id)"
          :key="stage.id"
          class="row-between tiny pity-row"
          :data-testid="`relic-pity-row-${stage.id}`"
        >
          <span>{{ stage.name }}</span>
          <span class="muted">再 {{ pityRemain(stage.id) }} 件必出 SSR</span>
        </div>
      </div>
    </section>

    <!-- 遗物副本入口（遗物的唯一来源；铁律 #10：入口必须可达） -->
    <section class="panel">
      <button class="btn btn-primary btn-block" data-testid="relic-go-dungeon" @click="goRelicDungeon">
        去遗物副本获取遗物
      </button>
      <p class="tiny muted" style="margin: 6px 0 0">
        遗物只能从遗物副本获得：主线通关第 1 关即可进入第一个副本，打赢一次即通关。
      </p>
    </section>

    <!-- 库存概览 -->
    <section class="panel">
      <div class="row-between">
        <div class="tiny muted">遗物仓库</div>
        <button class="btn btn-sm btn-ghost" @click="sortAsc = !sortAsc">
          {{ sortAsc ? '等级低→高' : '等级高→低' }}
        </button>
      </div>
      <div class="row-between tiny" style="margin-top: 4px">
        <span class="muted">容量</span>
        <b data-testid="relic-total">
          {{ formatNumber(total) }} / {{ formatNumber(RELIC.INVENTORY_CAP) }}
          <span v-if="usage >= RELIC.INVENTORY_WARN_RATIO" class="warn-text">（接近上限）</span>
        </b>
      </div>
      <div class="cap-bar">
        <div
          class="cap-fill"
          :class="{ warn: usage >= RELIC.INVENTORY_WARN_RATIO }"
          :style="{ width: `${Math.min(100, usage * 100)}%` }"
        ></div>
      </div>
      <div class="chips">
        <button class="chip" :class="{ on: rarityFilter === '全部' }" @click="rarityFilter = '全部'">全部</button>
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
      <div class="chips">
        <button class="chip" :class="{ on: setFilter === '全部' }" @click="setFilter = '全部'">全部套装</button>
        <button
          v-for="set in RELIC_SETS.values()"
          :key="set.id"
          class="chip"
          :class="{ on: setFilter === set.id }"
          @click="setFilter = set.id"
        >
          {{ set.name }}
        </button>
      </div>
      <div class="row-between tiny">
        <span class="muted">共 {{ formatNumber(total) }} 件 · 第 {{ page }} / {{ pages }} 页</span>
        <button class="btn btn-sm btn-ghost" @click="decomposeJunk">一键清理 1 级</button>
      </div>
    </section>

    <!-- 批量工具条 -->
    <section class="panel">
      <div class="row-between">
        <div class="tiny muted">已选 {{ checkedCount }} 件</div>
        <div class="row" style="gap: 6px">
          <button class="btn btn-sm btn-ghost" @click="checkAllOnPage">全选本页</button>
          <button class="btn btn-sm btn-ghost" :disabled="checkedCount === 0" @click="clearChecked">清空</button>
        </div>
      </div>
      <div class="row" style="gap: 6px; margin-top: 8px">
        <button
          class="btn btn-sm"
          style="flex: 1"
          data-testid="relic-batch-upgrade"
          :disabled="checkedCount === 0"
          @click="batchUpgrade"
        >
          批量强化 +1
        </button>
        <button
          class="btn btn-sm btn-danger"
          style="flex: 1"
          data-testid="relic-batch-decompose"
          :disabled="checkedCount === 0"
          @click="batchDecompose"
        >
          批量分解
        </button>
      </div>
      <p class="tiny muted" style="margin: 6px 0 0">
        锁定的遗物不会被批量分解；已装备的会先卸下再分解。
      </p>
    </section>

    <!-- 遗物列表 -->
    <section class="panel">
      <div class="panel-title"><span>遗物</span></div>
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
          :class="{ on: selected?.uid === r.uid }"
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
            <img
              class="relic-icon"
              :src="relicIconPath(r.defId)"
              :alt="RELIC_DEFS.get(r.defId)?.name ?? r.defId"
              width="44"
              height="44"
              loading="lazy"
            />
            <span class="tag" :class="`tag-${(RELIC_DEFS.get(r.defId)?.rarity ?? 'N').toLowerCase()}`">
              {{ RELIC_DEFS.get(r.defId)?.rarity ?? 'N' }}
            </span>
            <span class="relic-name">{{ RELIC_DEFS.get(r.defId)?.name ?? r.defId }}</span>
            <span class="tiny muted">
              {{ RELIC_SETS.get(RELIC_DEFS.get(r.defId)?.setId ?? '')?.name ?? '—' }} · +{{ r.level }}
            </span>
            <span v-if="r.locked" class="tag tag-sr">锁</span>
          </button>
        </div>
      </div>
      <div class="row-between" style="margin-top: 10px">
        <button class="btn btn-sm btn-ghost" :disabled="page <= 1" @click="prevPage">上一页</button>
        <span class="tiny muted">{{ page }} / {{ pages }}</span>
        <button class="btn btn-sm btn-ghost" :disabled="page >= pages" @click="nextPage">下一页</button>
      </div>
    </section>

    <!-- 选中遗物详情 -->
    <section v-if="selected && selectedDef" class="panel">
      <div class="panel-title">
        <span>{{ selectedDef.name }}</span>
        <span class="tag" :class="`tag-${selectedDef.rarity.toLowerCase()}`">{{ selectedDef.rarity }}</span>
      </div>
      <div class="tiny muted" style="margin-bottom: 8px">
        {{ selectedSet?.name ?? '—' }}套 · 强化 +{{ selected.level }}
      </div>
      <div v-for="(mod, i) in selectedMods" :key="i" class="row-between tiny stat-row">
        <span class="muted">{{ statName(mod.stat) }}</span>
        <b>{{ statText(mod) }}</b>
      </div>

      <!-- 强化 -->
      <div class="row" style="gap: 6px; margin-top: 10px">
        <button
          class="btn btn-sm"
          style="flex: 1"
          data-testid="relic-upgrade"
          :disabled="!upgradeHint.ok"
          @click="upgradeSelected"
        >
          强化 +{{ (selected?.level ?? 0) + 1 }}
        </button>
        <button class="btn btn-primary btn-sm" style="flex: 1" @click="heroPickerOpen = true">
          装备到英灵
        </button>
      </div>
      <div class="row" style="gap: 6px; margin-top: 6px">
        <button class="btn btn-sm btn-ghost" style="flex: 1" data-testid="relic-lock" @click="toggleLock">
          {{ selected.locked ? '解除锁定' : '锁定（不会被自动分解）' }}
        </button>
      </div>
      <div v-if="upgradeCost" class="tiny muted" style="margin-top: 4px">
        强化消耗：银两 {{ formatNumber(upgradeCost.silver) }} · {{ upgradeStoneText }}
      </div>
      <div v-if="temperHint" class="tiny muted" style="margin-top: 2px">
        {{ temperHint }}
      </div>
      <div v-if="upgradeCost && !upgradeHint.ok" class="tiny warn-text" style="margin-top: 2px">
        {{ upgradeHint.text }}
      </div>
      <div v-if="upgradePreview.length > 0" class="tiny muted" style="margin-top: 3px">
        强化到 +{{ (selected?.level ?? 0) + 1 }}：
        <span v-for="(row, i) in upgradePreview" :key="row.label">
          <template v-if="i > 0"> · </template>{{ row.label }} {{ row.from }} → {{ row.to }}
        </span>
      </div>
    </section>

    <!-- 套装效果 -->
    <section class="panel">
      <div class="panel-title">
        <span>套装效果</span>
        <span class="tiny muted">编队生效 {{ teamSetMods.length }} 项</span>
      </div>
      <div v-for="set in RELIC_SETS.values()" :key="set.id" class="set-block">
        <div class="row-between">
          <b>{{ set.name }}</b>
          <span class="tiny muted">
            仓库 {{ ownedSetCount.get(set.id) ?? 0 }} · 编队 {{ teamCountOf(set.id) }}
          </span>
        </div>
        <div class="tiny muted" style="margin: 3px 0 4px">{{ set.desc }}</div>
        <div v-for="bonus in set.bonuses" :key="bonus.pieces" class="row-between tiny bonus-row">
          <span class="muted">{{ bonus.pieces }} 件</span>
          <span>
            {{ bonus.desc }}
            <span class="tag" :class="teamCountOf(set.id) >= bonus.pieces ? 'tag-sr' : ''">
              {{ teamCountOf(set.id) >= bonus.pieces ? '生效' : '未生效' }}
            </span>
          </span>
        </div>
      </div>
    </section>

    <!-- 英灵选择器 -->
    <div v-if="heroPickerOpen" class="mask" @click.self="heroPickerOpen = false">
      <div class="dialog">
        <div class="panel-title">
          <span>选择英灵</span>
          <button class="btn btn-sm btn-ghost" @click="heroPickerOpen = false">关闭</button>
        </div>
        <div v-if="store.ownedHeroes.length === 0" class="empty">尚未拥有英灵</div>
        <button
          v-for="hero in store.ownedHeroes"
          :key="hero.id"
          class="list-item pick-row"
          @click="equipTo(hero.id)"
        >
          <img
            :src="hero.portrait"
            class="portrait"
            :class="`portrait-${hero.rarity.toLowerCase()}`"
            width="40"
            height="40"
            loading="lazy"
          />
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <b>{{ hero.name }}</b>
              <span class="tiny muted">{{ hero.role }}</span>
              <span class="tiny" :class="`el-${hero.element}`">{{ hero.element }}</span>
            </div>
            <div class="tiny muted">
              Lv{{ store.save.heroes[hero.id]?.level ?? 1 }} · 空槽 {{ emptyCount(hero.id) }}
            </div>
          </div>
          <span class="tiny" :class="emptyCount(hero.id) > 0 ? 'ok-text' : 'warn-text'">
            {{ emptyCount(hero.id) > 0 ? '装备' : '需卸下' }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

/* 库存占用条 */
.cap-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
  overflow: hidden;
  margin: 6px 0 2px;
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
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
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
  gap: 4px;
  padding: 8px;
  width: 100%;
  text-align: left;
  min-height: 72px;
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
}

.stat-row {
  padding: 4px 0;
  border-bottom: 1px solid var(--c-line);
}

.stat-row:last-child {
  border-bottom: none;
}

.set-block {
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
}

.set-block:last-child {
  border-bottom: none;
}

/* 套装进度行（可点击 → 直达产出它的遗物副本） */
.set-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  width: 100%;
  padding: 6px 0;
  text-align: left;
  border-bottom: 1px solid var(--c-line);
}

.set-row:last-child {
  border-bottom: none;
}

.set-row-name {
  font-size: 13px;
  color: var(--c-text);
}

.set-row-dungeon {
  flex-basis: 100%;
}

/* 保底进度（每个遗物副本一组） */
.pity-block {
  padding: 6px 0;
  border-bottom: 1px solid var(--c-line);
}

.pity-block:last-child {
  border-bottom: none;
}

.pity-row {
  padding: 1px 0;
}

.bonus-row {
  padding: 3px 0;
}

.pick-row {
  width: 100%;
  text-align: left;
}

.ok-text {
  color: var(--c-green);
}

.warn-text {
  color: #e0a06a;
}
</style>
