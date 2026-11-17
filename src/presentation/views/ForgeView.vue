<script setup lang="ts">
/**
 * 铸造：遗物仓库与装备管理。
 * 套装件数与生效判定取 core 的 RELIC_SETS / getSetModsBySetIds，组件不另立规则。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { RELIC_DEFS, RELIC_SETS, getRelicMods, getSetModsBySetIds, relicUpgradeCost } from '../../core/systems/relic.ts'
import { relicIconPath } from '../../core/config/art.ts'
import { formatNumber } from '../utils/format'
import type { Rarity, RelicInstance, StatMod } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

const RARITIES: Rarity[] = ['SSR', 'SR', 'R', 'N']

const rarityFilter = ref<Rarity | '全部'>('全部')
const sortByLevel = ref(true)
const selectedUid = ref<string | null>(null)

/** 仓库中的遗物（按筛选与排序） */
const relics = computed<RelicInstance[]>(() => {
  const list = store.save.relics.filter((r) => {
    if (rarityFilter.value === '全部') return true
    return (RELIC_DEFS.get(r.defId)?.rarity ?? 'N') === rarityFilter.value
  })
  const rank: Record<string, number> = { SSR: 3, SR: 2, R: 1, N: 0 }
  return [...list].sort((a, b) => {
    if (sortByLevel.value && b.level !== a.level) return b.level - a.level
    const ra = rank[RELIC_DEFS.get(a.defId)?.rarity ?? 'N'] ?? 0
    const rb = rank[RELIC_DEFS.get(b.defId)?.rarity ?? 'N'] ?? 0
    if (rb !== ra) return rb - ra
    return a.uid.localeCompare(b.uid)
  })
})

const selected = computed(() => (selectedUid.value ? store.relicsByUid.get(selectedUid.value) ?? null : null))
const selectedDef = computed(() => (selected.value ? RELIC_DEFS.get(selected.value.defId) ?? null : null))
const selectedSet = computed(() =>
  selectedDef.value ? RELIC_SETS.get(selectedDef.value.setId) ?? null : null,
)

/** 选中遗物的词条（core：主词条随等级缩放） */
const selectedMods = computed<StatMod[]>(() => (selected.value ? getRelicMods(selected.value) : []))

/** 仓库中各套装件数 */
const ownedSetCount = computed(() => {
  const map = new Map<string, number>()
  for (const r of store.save.relics) {
    const d = RELIC_DEFS.get(r.defId)
    if (!d) continue
    map.set(d.setId, (map.get(d.setId) ?? 0) + 1)
  }
  return map
})

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
  const uid = selectedUid.value
  if (!uid) return
  const slot = firstEmptySlot(heroId)
  if (slot < 0) {
    store.notify('该英灵的遗物槽已满，请先卸下遗物', 'warn')
    return
  }
  store.equip(heroId, slot, uid)
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

/** 强化按钮的可用性与提示（银两 / 强化石不够就把差额写出来） */
const upgradeHint = computed(() => {
  const cost = upgradeCost.value
  if (!cost) return { ok: false, text: '已达最高强化等级' }
  const p = store.save.player
  if (p.silver < cost.silver) {
    return { ok: false, text: `银两不足（${formatNumber(p.silver)} / ${formatNumber(cost.silver)}）` }
  }
  if (p.relicStones < cost.stones) {
    return {
      ok: false,
      text: `强化石不足（${formatNumber(p.relicStones)} / ${formatNumber(cost.stones)}）`,
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
function upgradeSelected() {
  const uid = selectedUid.value
  if (!uid) return
  store.upgradeRelic(uid)
}
</script>

<template>
  <div class="page">
    <div class="page-title">铸造</div>

    <!--
      召唤入口。
      方案 §11 规定「铸造」标签页承载抽卡（卡池 / 概率公示 / 保底进度 / 记录）。
      实现把抽卡拆成了独立路由 /gacha，若此处不放入口，核心循环在游戏内不可达。
    -->
    <section class="panel">
      <div class="panel-title">
        <span>召唤</span>
        <span class="tiny muted">卡池 · 概率公示 · 保底进度</span>
      </div>
      <div class="row-between tiny">
        <span class="muted">圣杯结晶</span>
        <b>{{ formatNumber(store.save.player.crystals) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">抽卡券</span>
        <b>{{ formatNumber(store.save.player.tickets) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">距必出还差</span>
        <b>{{ store.rates.pityRemaining }} 抽</b>
      </div>
      <p v-if="!store.save.gacha.newbieUsed" class="tiny muted" style="margin: 6px 0 0">
        新手保底可用：首次十连保底 1 位传说英灵。
      </p>
      <button class="btn btn-primary btn-block" style="margin-top: 10px" @click="router.push('/gacha')">
        前往召唤
      </button>
    </section>

    <!-- 筛选 -->
    <section class="panel">
      <div class="row-between">
        <div class="tiny muted">遗物仓库</div>
        <button class="btn btn-sm btn-ghost" @click="sortByLevel = !sortByLevel">
          {{ sortByLevel ? '按强化等级' : '按稀有度' }}
        </button>
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
      <div class="tiny muted">共 {{ store.save.relics.length }} 件，当前显示 {{ relics.length }} 件</div>
    </section>

    <!-- 遗物列表 -->
    <section class="panel">
      <div class="panel-title"><span>遗物</span></div>
      <div v-if="relics.length === 0" class="empty">
        仓库暂无遗物<br />
        <span class="tiny">可前往推征获取</span>
      </div>
      <div v-else class="relic-grid">
        <button
          v-for="r in relics"
          :key="r.uid"
          class="relic-cell"
          :class="{ on: selectedUid === r.uid }"
          @click="selectedUid = r.uid"
        >
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
        </button>
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
      <div v-if="upgradeCost" class="tiny muted" style="margin-top: 4px">
        强化消耗：银两 {{ formatNumber(upgradeCost.silver) }} · 强化石 {{ upgradeCost.stones }}
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

.relic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}

.relic-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  text-align: left;
  min-height: 72px;
}

.relic-icon {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: block;
}

.relic-cell.on {
  border-color: var(--c-gold);
  background: #2a2419;
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
