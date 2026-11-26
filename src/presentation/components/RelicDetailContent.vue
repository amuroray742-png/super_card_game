<script setup lang="ts">
/**
 * **遗物详情内容**（抽屉与 `/relic/:uid` 页**共用同一份 UI**）。
 *
 * ## 为什么抽出来
 *
 * 改版前有**两套**遗物详情：
 * - `RelicDetailView.vue`（`/relic/:uid`，图鉴页进来的）：有主副词条 / 分解，**没有**装备与锁定；
 * - `RelicWarehouse.vue` 的内联详情面板：有装备 / 锁定，**没有**副词条与分解。
 *
 * 两套 UI 的内容还不一样 ⇒ 同一件遗物在两个入口看到的信息不同。
 * 现在统一到这一个组件：仓库点开走**底部抽屉**，图鉴进入走**整页**，内容完全一致。
 *
 * ## 数据来源（**永远重新从 store 取**）
 *
 * ⚠ 强化 / 分解 / 锁定之后，服务端会 `loadRelicPage()` + `loadRelicStats()`，
 *   客户端镜像里的旧对象就过期了 —— 历史上出现过「强化后按钮仍写 +2」
 *   （详情面板拿着旧对象，没跟着刷新）。
 * 所以这里**不持有**遗物实例，只持 `uid`，由 computed 现取。
 *
 * ## 口径
 *
 * - 主词条 → core 的 `getRelicMods`（主词条随等级缩放，副词条固定）；
 * - 强化费用与上限 → core 的 `relicUpgradeCost`；
 * - 强化石消耗 → core 的 `RELIC`（按目标等级分档），名称取 `ITEM_DEFS`；
 * - 分解返还 → core 的 `decomposeValue`（**只返银两**）；
 * - 淬炼段提示 → `presentation/utils/relic-hint.ts` 的唯一一份。
 */
import { computed, ref } from 'vue'
import { useGameStore } from '../stores/game'
import {
  RELIC_DEFS,
  RELIC_SETS,
  decomposeValue,
  getRelicMods,
  relicUpgradeCost,
} from '../../core/systems/relic.ts'
import { RELIC } from '../../core/config/economy.ts'
import { ITEM_DEFS, type ItemId } from '../../core/config/items.ts'
import { parseEquipKey } from '../../core/systems/loadout.ts'
import { formatNumber } from '../utils/format'
import { relicTemperRuleHint } from '../utils/relic-hint.ts'
import type { RelicInstance, StatMod } from '../../core/model/types.ts'

const props = defineProps<{
  /** 遗物 uid（**唯一**标识，组件据此实时取最新实例） */
  uid: string
  /**
   * 预取到的实例（详情页从服务端拿到的那件，仓库列表里没有）。
   *
   * ⚠ 只作为**兜底**：store 里能取到活数据时一律用活数据。
   */
  prefetched?: RelicInstance | null
}>()

const emit = defineEmits<{
  /** 动作执行完（内容已自动刷新；外面可以顺手重新取单件） */
  (e: 'changed'): void
  /** 该遗物已被分解（外面应当关掉承载它的面板） */
  (e: 'removed'): void
}>()

const store = useGameStore()

/**
 * 当前遗物实例（**实时**）。
 *
 * 优先级：仓库当前页 → 客户端镜像（已装备件）→ 预取。
 * ⚠ 仓库页 / 镜像里的都是活数据，强化后服务端会重新分页 ⇒ 自动变新。
 */
const relic = computed<RelicInstance | null>(() => {
  const fromPage = store.relicPage.items.find((r) => r.uid === props.uid)
  if (fromPage) return fromPage
  const fromMirror = store.relicsByUid.get(props.uid)
  if (fromMirror) return fromMirror
  return props.prefetched ?? null
})

/** 遗物定义 */
const def = computed(() => (relic.value ? RELIC_DEFS.get(relic.value.defId) ?? null : null))

/** 所属套装 */
const set = computed(() => (def.value ? RELIC_SETS.get(def.value.setId) ?? null : null))

/** 主词条当前值（core：主词条随强化等级缩放，副词条固定） */
const mainMods = computed<StatMod[]>(() => {
  const r = relic.value
  const d = def.value
  if (!r || !d) return []
  return getRelicMods(r).slice(0, d.mainStats.length)
})

/** 副词条 */
const subMods = computed<StatMod[]>(() => relic.value?.subStats ?? [])

/** 下一级的主词条预览 */
const nextMainMods = computed<StatMod[]>(() => {
  const r = relic.value
  const d = def.value
  if (!r || !d) return []
  if (r.level >= RELIC.MAX_LEVEL) return []
  return getRelicMods({ ...r, level: r.level + 1 }).slice(0, d.mainStats.length)
})

/** 强化费用（满级时为 null） */
const upgradeCost = computed(() => (relic.value ? relicUpgradeCost(relic.value.level) : null))

/** 强化石消耗文案（**按档位**，名称取 `ITEM_DEFS`） */
const stoneCostText = computed(() => {
  const stones = upgradeCost.value?.stones ?? {}
  return Object.entries(stones)
    .map(([id, n]) => `${ITEM_DEFS[id as ItemId]?.name ?? id} ${n}`)
    .join(' · ')
})

/** 淬炼段规则提示（Lv60 以上价格递增、收益递减） */
const temperHint = computed(() =>
  relic.value ? relicTemperRuleHint(relic.value.level) : '',
)

/** 分解返还（**只返银两**） */
const back = computed(() => (relic.value ? decomposeValue(relic.value) : null))

/** 装备在哪名英灵身上（slot = 槽位号） */
const owner = computed<{ heroId: string; slot: number } | null>(() => {
  const r = relic.value
  if (!r) return null
  for (const [key, entry] of Object.entries(store.save.equipped)) {
    if (entry.relicId !== r.uid) continue
    // ⚠ 槽位 key 的解析走 core 的 `parseEquipKey`（**唯一一份**，铁律 #8）
    const parsed = parseEquipKey(key)
    if (!parsed) continue
    return parsed
  }
  return null
})

/** 强化按钮的可用性与提示（银两 / 强化石不够就把差额写出来） */
const upgradeHint = computed(() => {
  const c = upgradeCost.value
  if (!c) return { ok: false, text: '已达最高强化等级' }
  const p = store.save.player
  if (p.silver < c.silver) {
    return { ok: false, text: `银两不足（${formatNumber(p.silver)} / ${formatNumber(c.silver)}）` }
  }
  for (const [id, need] of Object.entries(c.stones)) {
    const owned = store.save.items[id as ItemId] ?? 0
    if (owned < (need ?? 0)) {
      const name = ITEM_DEFS[id as ItemId]?.name ?? id
      return { ok: false, text: `${name}不足（${formatNumber(owned)} / ${formatNumber(need ?? 0)}）` }
    }
  }
  return { ok: true, text: '' }
})

/** 强化到下一级的主词条提升预览（只列**会变**的那些） */
const upgradePreview = computed(() => {
  const s = relic.value
  if (!s || !upgradeCost.value) return []
  const cur = mainMods.value
  const next = nextMainMods.value
  const rows: { label: string; from: string; to: string }[] = []
  for (let i = 0; i < next.length; i++) {
    const c = cur[i]
    const n = next[i]
    if (!c || !n || c.value === n.value) continue
    rows.push({ label: statName(n.stat), from: statText(c), to: statText(n) })
  }
  return rows
})

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

// ─────────────────────────── 动作 ───────────────────────────

/** 分解二次确认 */
const confirmOpen = ref(false)

/** 抽屉内是否切到「选英灵」视图（**同一个抽屉内换视图**，不叠第二层遮罩） */
const pickerOpen = ref(false)

async function upgrade() {
  const r = relic.value
  if (!r) return
  await store.upgradeRelic(r.uid)
  emit('changed')
}

async function toggleLock() {
  const r = relic.value
  if (!r) return
  await store.lockRelic(r.uid, !r.locked)
  emit('changed')
}

async function decompose() {
  const r = relic.value
  if (!r) return
  await store.decomposeRelic(r.uid)
  confirmOpen.value = false
  // ⚠ 分解之后这件遗物**不存在了** ⇒ 承载它的面板必须关掉
  emit('removed')
}

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

/** 装备到某英灵（占第一个空槽） */
function equipTo(heroId: string) {
  const r = relic.value
  if (!r) return
  const slot = firstEmptySlot(heroId)
  if (slot < 0) {
    store.notify('该英灵的遗物槽已满，请先卸下遗物', 'warn')
    return
  }
  void store.equip(heroId, slot, r.uid)
  pickerOpen.value = false
  store.notify('已装备遗物', 'ok')
  emit('changed')
}

/** 从某英灵上卸下 */
function unequipFrom(heroId: string) {
  const r = relic.value
  if (!r) return
  void store.unequip(heroId, owner.value?.slot ?? 0)
  pickerOpen.value = false
  store.notify('已卸下遗物', 'ok')
  emit('changed')
}
</script>

<template>
  <div v-if="!relic || !def" class="empty">
    未找到该遗物<br />
    <span class="tiny">它可能已被分解</span>
  </div>

  <!-- 选英灵视图（与详情**同一个容器**内切换，不叠第二层遮罩） -->
  <template v-else-if="pickerOpen">
    <div class="panel-title">
      <span>装备到英灵</span>
      <button class="btn btn-sm btn-ghost" data-testid="relic-picker-back" @click="pickerOpen = false">
        返回详情
      </button>
    </div>
    <div v-if="store.ownedHeroes.length === 0" class="empty">尚未拥有英灵</div>
    <button
      v-for="hero in store.ownedHeroes"
      :key="hero.id"
      class="picker-row"
      :data-testid="`relic-picker-hero-${hero.id}`"
      @click="owner?.heroId === hero.id ? unequipFrom(hero.id) : equipTo(hero.id)"
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
          <span class="tiny muted">{{ hero.role }}</span>
          <span class="tiny" :class="`el-${hero.element}`">{{ hero.element }}</span>
        </div>
        <div class="tiny muted">
          Lv{{ store.save.heroes[hero.id]?.level ?? 1 }} · 空槽 {{ emptyCount(hero.id) }}
        </div>
      </div>
      <span class="tiny" :class="owner?.heroId === hero.id ? 'ok-text' : emptyCount(hero.id) > 0 ? 'ok-text' : 'warn-text'">
        {{ owner?.heroId === hero.id ? '卸下' : emptyCount(hero.id) > 0 ? '装备' : '需卸下' }}
      </span>
    </button>
  </template>

  <!-- 详情视图 -->
  <template v-else>
    <div class="panel-title">
      <span>{{ def.name }}</span>
      <span class="row" style="gap: 6px">
        <span class="tag" :class="`tag-${def.rarity.toLowerCase()}`">{{ def.rarity }}</span>
        <span class="tag">{{ set?.name ?? '—' }}套</span>
      </span>
    </div>

    <div class="row-between" style="margin-bottom: 6px">
      <span class="tiny muted">{{ def.desc }}</span>
      <span class="lv-box">
        <span class="tiny muted">强化</span>
        <span class="lv-num">+{{ relic.level }}</span>
      </span>
    </div>
    <p v-if="owner" class="tiny muted" style="margin: 0 0 6px">
      当前装备在该英灵身上。
    </p>

    <!-- 主词条（带下一级预览） -->
    <div class="tiny muted" style="margin-bottom: 2px">
      主词条 · 每级 +{{ (RELIC.PCT_PER_LEVEL * 100).toFixed(0) }}%
    </div>
    <div v-for="(mod, i) in mainMods" :key="i" class="row-between tiny stat-row">
      <span class="muted">{{ statName(mod.stat) }}</span>
      <span>
        <b>{{ statText(mod) }}</b>
        <span v-if="nextMainMods[i]" class="tiny muted"> → {{ statText(nextMainMods[i]) }}</span>
      </span>
    </div>

    <!-- 强化（**首屏必须能看到按钮**） -->
    <div class="row" style="gap: 6px; margin-top: 8px">
      <button
        class="btn btn-sm btn-primary"
        style="flex: 1"
        data-testid="relic-upgrade"
        :disabled="!upgradeHint.ok"
        @click="upgrade"
      >
        强化 +{{ (relic.level ?? 0) + 1 }}
      </button>
      <button
        class="btn btn-sm"
        style="flex: 1"
        data-testid="relic-equip"
        @click="pickerOpen = true"
      >
        装备到英灵
      </button>
    </div>
    <div v-if="upgradeCost" class="tiny muted" style="margin-top: 4px">
      强化消耗：银两 {{ formatNumber(upgradeCost.silver) }} · {{ stoneCostText }}
    </div>
    <div v-if="temperHint" class="tiny muted" style="margin-top: 2px">
      {{ temperHint }}
    </div>
    <div v-if="upgradeCost && !upgradeHint.ok" class="tiny warn-text" style="margin-top: 2px">
      {{ upgradeHint.text }}
    </div>
    <div v-if="upgradePreview.length > 0" class="tiny muted" style="margin-top: 3px">
      强化到 +{{ (relic.level ?? 0) + 1 }}：
      <span v-for="(row, i) in upgradePreview" :key="row.label">
        <template v-if="i > 0"> · </template>{{ row.label }} {{ row.from }} → {{ row.to }}
      </span>
    </div>

    <!-- 锁定 -->
    <button
      class="btn btn-sm btn-ghost btn-block"
      style="margin-top: 6px"
      data-testid="relic-lock"
      @click="toggleLock"
    >
      {{ relic.locked ? '解除锁定' : '锁定（不会被自动分解）' }}
    </button>

    <!-- 副词条（往下滚才看到：它是参考信息，不占首屏） -->
    <div class="tiny muted" style="margin-top: 10px">副词条</div>
    <div v-if="subMods.length === 0" class="tiny muted">该遗物没有副词条</div>
    <div v-for="(mod, i) in subMods" :key="i" class="row-between tiny stat-row">
      <span class="muted">{{ statName(mod.stat) }}</span>
      <b>{{ statText(mod) }}</b>
    </div>

    <!-- 套装效果 -->
    <div v-if="set" class="tiny muted" style="margin-top: 10px">{{ set.name }}套</div>
    <div v-if="set" class="tiny muted" style="margin: 2px 0 4px">{{ set.desc }}</div>
    <div v-for="bonus in set?.bonuses ?? []" :key="bonus.pieces" class="row-between tiny bonus-row">
      <span class="muted">{{ bonus.pieces }} 件</span>
      <span>{{ bonus.desc }}</span>
    </div>

    <!-- 分解（**只返银两**，不返强化石） -->
    <div v-if="back" class="row-between tiny" style="margin-top: 10px">
      <span class="muted">分解返还</span>
      <b>银两 {{ formatNumber(back.silver) }}</b>
    </div>
    <button
      class="btn btn-sm btn-danger btn-block"
      style="margin-top: 6px"
      data-testid="relic-decompose"
      @click="confirmOpen = true"
    >
      分解
    </button>
    <p class="tiny muted" style="margin: 6px 0 0">
      分解后该遗物将被移除，装备于英灵身上的对应槽位会同时清空，返还银两（不返还副本材料）。
    </p>

    <!-- 分解二次确认 -->
    <div v-if="confirmOpen" class="mask" @click.self="confirmOpen = false">
      <div class="dialog">
        <div class="panel-title">分解确认</div>
        <p class="tiny muted" style="margin: 0 0 10px">
          分解后该遗物将被移除，装备于英灵身上的对应槽位会同时清空，返还银两（不返还副本材料）。
        </p>
        <div v-if="back" class="tiny" style="margin-bottom: 10px">
          预计返还：银两 {{ formatNumber(back.silver) }}
        </div>
        <div class="row" style="gap: 8px">
          <button class="btn btn-sm" style="flex: 1" @click="confirmOpen = false">取消</button>
          <button class="btn btn-sm btn-danger" style="flex: 1" data-testid="relic-decompose-confirm" @click="decompose">
            确认分解
          </button>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.lv-box {
  flex: 0 0 auto;
  text-align: center;
  padding-left: 10px;
}

.lv-num {
  font-size: 20px;
  font-weight: 700;
  color: var(--c-gold-2);
}

.stat-row {
  padding: 4px 0;
  border-bottom: 1px solid var(--c-line);
}

.stat-row:last-child {
  border-bottom: none;
}

.bonus-row {
  padding: 3px 0;
}

.ok-text {
  color: var(--c-green);
}

.warn-text {
  color: #e0a06a;
}
</style>
